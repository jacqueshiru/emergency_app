import { Request, Response } from 'express';
import { prisma } from '../../prisma';
import { emitNewAlert, emitResolutionUpdated } from '../../services/socket';
import { transitionDeliveryStatus } from '../../services/deliveryState';
import { kickDeliveryWorker } from '../../services/deliveryWorker';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import {
  Role,
  AlertProcessingStatus,
  AlertResolutionStatus,
  DeliveryStatus,
} from '@seas/shared';
import crypto from 'crypto';

const ALERT_INCLUDE = {
  deliveries: true,
  user: { select: { id: true, name: true, phoneNumber: true } },
} as const;

/** Ownership is enforced by the query itself: non-admins can only ever match their own rows. */
function ownedWhere(req: Request) {
  const { id } = req.params;
  return req.user!.role === Role.ADMIN ? { id } : { id, userId: req.user!.id };
}

export class AlertsController {
  /**
   * POST /alerts
   * Creates an emergency alert and dispatches delivery to all saved contacts.
   * Atomic transaction + idempotency + server-side contact fetching.
   */
  async createAlert(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const {
        idempotencyKey,
        latitude,
        longitude,
        accuracy,
        locationAvailable,
        triggeredAt: clientTriggeredAt,
        sentByDevice,
        deviceDeliveries,
        recipientTier,
      } = req.body;
      // The phone already texted the contacts from its own SIM; we only record it.
      const deviceMode = sentByDevice === true;

      if (!idempotencyKey || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(idempotencyKey)) {
        return res.status(400).json({ error: 'idempotencyKey is required (1-100 letters, digits, . _ : -)' });
      }

      // Fast path: sequential replay of the same key (scoped to this user).
      const existingAlert = await prisma.alert.findFirst({
        where: { idempotencyKey, userId },
        include: ALERT_INCLUDE,
      });
      if (existingAlert) {
        return res.status(200).json(existingAlert);
      }
      // A key already used by a DIFFERENT user must never leak that user's alert.
      if (await prisma.alert.findUnique({ where: { idempotencyKey }, select: { id: true } })) {
        return res.status(409).json({ error: 'idempotencyKey already in use' });
      }

      // Server-side duplicate-SOS guard: one OPEN alert per user at a time.
      // (Skipped for phone-sent alerts: the SMS is already out, this is only the record.)
      const openAlert = deviceMode
        ? null
        : await prisma.alert.findFirst({
            where: { userId, resolutionStatus: AlertResolutionStatus.OPEN },
            include: ALERT_INCLUDE,
          });
      if (openAlert) {
        // A concurrent request with the SAME key just created this alert: that's a replay, not a duplicate SOS.
        if (openAlert.idempotencyKey === idempotencyKey) {
          return res.status(200).json(openAlert);
        }
        return res.status(409).json({
          error: 'You already have an active alert. Resolve or cancel it before triggering a new one.',
          code: 'ALERT_ALREADY_OPEN',
          alert: openAlert,
        });
      }

      // Never trust recipients from the client body.
      const userContacts = await prisma.emergencyContact.findMany({
        where: {
          userId,
          consentStatus: 'OPTED_IN',
          ...(recipientTier === 'CRITICAL' || recipientTier === 'EVERYDAY' ? { tier: recipientTier } : {}),
        },
      });
      if (userContacts.length === 0) {
        return res.status(400).json({
          error: 'Cannot trigger alert: You have no emergency contacts configured. Please add at least one emergency contact before initiating an SOS.',
          code: 'NO_CONTACTS',
        });
      }

      // triggeredAt / delayed flag (offline queue staleness); all comparisons in UTC epoch ms.
      const now = new Date();
      let triggeredAt = now;
      let delayed = false;
      if (clientTriggeredAt) {
        const parsedTime = new Date(clientTriggeredAt);
        if (!isNaN(parsedTime.getTime())) {
          // Clock skew guard: a client timestamp in the future is clamped to now.
          triggeredAt = parsedTime.getTime() > now.getTime() ? now : parsedTime;
          const diffMinutes = (now.getTime() - triggeredAt.getTime()) / 60000;
          if (diffMinutes >= config.staleAlertThresholdMinutes) delayed = true;
        }
      }

      // Location is optional and never blocks alert creation.
      const hasValidCoords = Boolean(
        locationAvailable &&
        typeof latitude === 'number' && typeof longitude === 'number' &&
        !isNaN(latitude) && !isNaN(longitude) &&
        latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
      );
      const accuracyValue =
        hasValidCoords && typeof accuracy === 'number' && isFinite(accuracy) && accuracy >= 0 ? accuracy : null;

      // Phone-sent alerts: map the phone's per-contact results onto the server's own contact list.
      const deviceReports = new Map<string, { status: DeliveryStatus; error: string | null }>();
      if (deviceMode && Array.isArray(deviceDeliveries)) {
        for (const r of deviceDeliveries.slice(0, 50)) {
          if (r && typeof r.contactId === 'string' && ['SENT', 'DELIVERED', 'FAILED'].includes(r.status)) {
            deviceReports.set(r.contactId, {
              status: r.status as DeliveryStatus,
              error: typeof r.error === 'string' && r.error ? r.error.slice(0, 200) : null,
            });
          }
        }
      }
      const deviceRows = userContacts.map((contact) => {
        const r = deviceReports.get(contact.id);
        return {
          contact,
          status: r ? r.status : DeliveryStatus.FAILED,
          error: r
            ? (r.status === 'FAILED' ? r.error || 'Send failed on the phone' : null)
            : 'Not sent from the phone (contact was not on the device)',
        };
      });
      const deviceHasActive = deviceRows.some((r) => r.status === 'SENT');
      const deviceProofNonce = deviceMode ? crypto.randomBytes(32).toString('hex') : null;

      try {
        const created = await prisma.$transaction(async (tx) => {
          const alert = await tx.alert.create({
            data: {
              userId,
              idempotencyKey,
              latitude: hasValidCoords ? latitude : null,
              longitude: hasValidCoords ? longitude : null,
              accuracy: accuracyValue,
              locationAvailable: hasValidCoords,
              triggeredAt,
              delayed,
              status: deviceMode
                ? (deviceHasActive ? AlertProcessingStatus.PROCESSING : AlertProcessingStatus.COMPLETED)
                : AlertProcessingStatus.CREATED,
              resolutionStatus: AlertResolutionStatus.OPEN,
              deviceProofNonce,
            },
          });
          await tx.alertDelivery.createMany({
            data: deviceMode
              ? deviceRows.map((r) => ({
                  alertId: alert.id,
                  contactId: r.contact.id,
                  contactNameSnapshot: r.contact.name,
                  contactPhoneSnapshot: r.contact.phoneNumber,
                  relationshipSnapshot: r.contact.relationship,
                  channel: 'device-sms',
                  status: r.status,
                  lastErrorCode: r.error,
                  attempts: 1,
                  lastAttemptAt: new Date(),
                }))
              : userContacts.map((contact) => ({
              alertId: alert.id,
              contactId: contact.id,
              contactNameSnapshot: contact.name,
              contactPhoneSnapshot: contact.phoneNumber,
              relationshipSnapshot: contact.relationship,
              channel: 'sms',
              status: DeliveryStatus.PENDING,
              attempts: 0,
            })),
          });
          if (deviceProofNonce) {
            await tx.alert.update({
              where: { id: alert.id },
              data: { deviceProofNonce },
            });
          }
          return alert;
        });

        const fullAlert = await prisma.alert.findUnique({ where: { id: created.id }, include: ALERT_INCLUDE });
        emitNewAlert(fullAlert);
        // Server-sent alerts: the deliveries are durable DB rows the worker picks up (also after a restart).
        if (!deviceMode) kickDeliveryWorker();
        return res.status(201).json(fullAlert);
      } catch (err: any) {
        // Concurrent request with the same idempotency key lost the unique-constraint race.
        if (err?.code === 'P2002') {
          const winner = await prisma.alert.findFirst({
            where: { idempotencyKey, userId },
            include: ALERT_INCLUDE,
          });
          if (winner) return res.status(200).json(winner);
          return res.status(409).json({ error: 'idempotencyKey already in use' });
        }
        throw err;
      }
    } catch (error: any) {
      logger.error('Error in createAlert', { error: error.message });
      return res.status(500).json({ error: 'Failed to create emergency alert' });
    }
  }

  /**
   * GET /alerts
   * Retrieve alerts triggered by the authenticated user
   */
  async getMyAlerts(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const alerts = await prisma.alert.findMany({
        where: { userId },
        include: {
          deliveries: true,
        },
        orderBy: { triggeredAt: 'desc' },
        take: 100,
      });

      return res.status(200).json(alerts);
    } catch (error: any) {
      logger.error('Error in getMyAlerts', { error: error.message });
      return res.status(500).json({ error: 'Failed to retrieve alerts' });
    }
  }

  /**
   * GET /alerts/:id
   * Retrieve alert status with live deliveries
   */
  async getAlertById(req: Request, res: Response) {
    try {
      const alert = await prisma.alert.findFirst({
        where: ownedWhere(req),
        include: ALERT_INCLUDE,
      });
      // Not found and not-yours are indistinguishable by design (no id enumeration).
      if (!alert) {
        return res.status(404).json({ error: 'Alert not found' });
      }

      return res.status(200).json(alert);
    } catch (error: any) {
      logger.error('Error in getAlertById', { error: error.message });
      return res.status(500).json({ error: 'Failed to retrieve alert' });
    }
  }

  /**
   * PATCH /alerts/:id/resolve
   * Marks resolutionStatus = RESOLVED
   */
  async resolveAlert(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { count } = await prisma.alert.updateMany({
        where: { ...ownedWhere(req), resolutionStatus: AlertResolutionStatus.OPEN },
        data: { resolutionStatus: AlertResolutionStatus.RESOLVED, resolvedAt: new Date() },
      });
      const updated = await prisma.alert.findFirst({ where: ownedWhere(req), include: ALERT_INCLUDE });
      if (!updated) return res.status(404).json({ error: 'Alert not found' });
      if (count === 1) {
        emitResolutionUpdated(updated);
        logger.info('Alert marked as RESOLVED', { alertId: id, resolvedBy: req.user!.id });
      }
      return res.status(200).json(updated); // already-resolved is idempotent
    } catch (error: any) {
      logger.error('Error in resolveAlert', { error: error.message });
      return res.status(500).json({ error: 'Failed to resolve alert' });
    }
  }

  /**
   * PATCH /alerts/:id/cancel
   * Restricted: Triggering user within 5 minutes, or ADMIN afterward.
   */
  async cancelAlert(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const where: any = { ...ownedWhere(req), resolutionStatus: AlertResolutionStatus.OPEN };
      if (req.user!.role !== Role.ADMIN) {
        // 5-minute cancellation window, enforced inside the same atomic write.
        where.triggeredAt = { gte: new Date(Date.now() - 5 * 60 * 1000) };
      }
      const { count } = await prisma.alert.updateMany({
        where,
        data: { resolutionStatus: AlertResolutionStatus.CANCELLED, resolvedAt: new Date() },
      });

      const alert = await prisma.alert.findFirst({ where: ownedWhere(req), include: ALERT_INCLUDE });
      if (!alert) return res.status(404).json({ error: 'Alert not found' });
      if (count === 0) {
        if (alert.resolutionStatus !== AlertResolutionStatus.OPEN) {
          return res.status(200).json(alert); // already closed: idempotent
        }
        return res.status(400).json({
          error: 'Cancellation window expired (5 minutes). Please mark the alert as RESOLVED instead.',
        });
      }
      // Stop queued SMS right away (the worker also re-checks before every send).
      const stillPending = await prisma.alertDelivery.findMany({
        where: { alertId: alert.id, status: DeliveryStatus.PENDING },
        select: { id: true },
      });
      for (const d of stillPending) {
        await transitionDeliveryStatus(d.id, DeliveryStatus.FAILED, {
          lastErrorCode: 'Alert was cancelled before this message was sent',
          nextRetryAt: null,
          claimedAt: null,
        });
      }
      const refreshed = (await prisma.alert.findFirst({ where: ownedWhere(req), include: ALERT_INCLUDE })) ?? alert;
      emitResolutionUpdated(refreshed);
      logger.info('Alert CANCELLED', { alertId: id, cancelledBy: req.user!.id });
      return res.status(200).json(refreshed);
    } catch (error: any) {
      logger.error('Error in cancelAlert', { error: error.message });
      return res.status(500).json({ error: 'Failed to cancel alert' });
    }
  }

  /**
   * POST /alerts/:id/device-reports
   * The phone reports later SMS delivery results for deliveries IT sent (channel "device-sms").
   * Ownership is part of the query; server-sent deliveries can't be touched through this route.
   */
  async reportDeviceDeliveries(req: Request, res: Response) {
    try {
      const reports = req.body?.reports;
      if (!Array.isArray(reports) || reports.length === 0 || reports.length > 50) {
        return res.status(400).json({ error: 'reports must be a non-empty array (max 50)' });
      }
      const alert = await prisma.alert.findFirst({
        where: { id: req.params.id, userId: req.user!.id },
        select: { id: true, deviceProofNonce: true },
      });
      if (!alert) return res.status(404).json({ error: 'Alert not found' });
      const nonce = req.body?.deviceProofNonce;
      if (!alert.deviceProofNonce || typeof nonce !== 'string' || nonce !== alert.deviceProofNonce) {
        return res.status(403).json({ error: 'Invalid or missing device proof nonce', code: 'DEVICE_PROOF_INVALID' });
      }

      let updated = 0;
      for (const r of reports) {
        if (!r || typeof r.contactId !== 'string' || !['DELIVERED', 'FAILED'].includes(r.status)) continue;
        const delivery = await prisma.alertDelivery.findFirst({
          where: { alertId: alert.id, contactId: r.contactId, channel: 'device-sms' },
          select: { id: true },
        });
        if (!delivery) continue;
        const ok = await transitionDeliveryStatus(delivery.id, r.status as DeliveryStatus, {
          lastErrorCode: r.status === 'FAILED' ? String(r.error || 'Delivery failed').slice(0, 200) : null,
          deviceVerified: true,
        });
        if (ok) updated++;
      }
      return res.status(200).json({ updated });
    } catch (error: any) {
      logger.error('Error in reportDeviceDeliveries', { error: error.message });
      return res.status(500).json({ error: 'Failed to record delivery reports' });
    }
  }
}

export const alertsController = new AlertsController();
