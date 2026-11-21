import { Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../../prisma';
import { logger } from '../../utils/logger';
import { DeliveryStatus } from '@seas/shared';
import { deliveryConfig } from '../../config';
import { transitionDeliveryStatus } from '../../services/deliveryState';

function secretMatches(provided: unknown): boolean {
  const expected = deliveryConfig.webhookSecret;
  if (typeof provided !== 'string' || !expected) return false;
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export class WebhooksController {
  /**
   * POST /webhooks/africastalking/delivery
   * Authenticated with WEBHOOK_SECRET (header `x-webhook-secret` or `?token=`), checked
   * before any DB access. All status writes go through transitionDeliveryStatus, which
   * enforces idempotency and anti-regression atomically.
   */
  async handleDeliveryReport(req: Request, res: Response) {
    // Fail closed: an unconfigured secret must not leave the endpoint open.
    if (!deliveryConfig.webhookSecret) {
      logger.error('WEBHOOK_SECRET is not configured; rejecting webhook');
      return res.status(503).json({ error: 'Webhook not configured' });
    }
    const provided = req.get('x-webhook-secret') ?? (typeof req.query.token === 'string' ? req.query.token : undefined);
    if (!secretMatches(provided)) {
      logger.warn('Webhook rejected: invalid or missing secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const { id: providerMessageId, status, failureReason } = req.body || {};
      if (!providerMessageId) {
        return res.status(400).json({ error: 'Missing provider message id' });
      }

      const delivery = await prisma.alertDelivery.findFirst({
        where: { providerMessageId },
        select: { id: true, status: true, lastErrorCode: true },
      });
      if (!delivery) {
        // 200 so the provider doesn't retry unknown messages forever.
        return res.status(200).json({ received: true, note: 'Delivery not found in SEAS database' });
      }

      const normalized = String(status || '').toLowerCase();
      let target: DeliveryStatus | null = null;
      let lastErrorCode: string | null | undefined;
      if (normalized === 'success') {
        target = DeliveryStatus.DELIVERED;
      } else if (normalized === 'failed' || normalized === 'rejected') {
        target = DeliveryStatus.FAILED;
        lastErrorCode = failureReason || `Provider status: ${status}`;
      } else if (normalized === 'sent' || normalized === 'buffered') {
        target = DeliveryStatus.SENT;
      }
      if (!target) {
        return res.status(200).json({ received: true, note: 'Unrecognized status ignored' });
      }

      const applied = await transitionDeliveryStatus(
        delivery.id,
        target,
        lastErrorCode !== undefined ? { lastErrorCode } : {}
      );
      return res.status(200).json(
        applied ? { received: true, status: target } : { received: true, note: 'Terminal state preserved' }
      );
    } catch (error: any) {
      logger.error('Error in handleDeliveryReport', { error: error.message });
      return res.status(500).json({ error: 'Failed to process delivery report' });
    }
  }
}

export const webhooksController = new WebhooksController();
