import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/prisma';
import { runDeliveryPass } from '../src/services/deliveryWorker';
import { Role, DeliveryStatus, AlertProcessingStatus, AlertResolutionStatus } from '@seas/shared';

const app = createApp();
const WEBHOOK_HEADERS = { 'x-webhook-secret': 'test-webhook-secret' };

async function closeOpenAlerts() {
  await prisma.alert.updateMany({
    where: { resolutionStatus: AlertResolutionStatus.OPEN },
    data: { resolutionStatus: AlertResolutionStatus.RESOLVED },
  });
}

// Drive the delivery worker explicitly (deterministic) and wait until it has recorded the
// provider id. On timeout, report the delivery rows so the cause is visible.
async function waitForSent(alertId: string) {
  for (let i = 0; i < 40; i++) {
    await runDeliveryPass();
    const d = await prisma.alertDelivery.findFirst({ where: { alertId, providerMessageId: { not: null } } });
    if (d) return d;
    await new Promise((r) => setTimeout(r, 100));
  }
  const rows = await prisma.alertDelivery.findMany({ where: { alertId } });
  throw new Error('delivery worker did not send in time: ' + JSON.stringify(rows));
}

describe('SEAS End-to-End Workflow & Acceptance Criteria', () => {
  const userPhone = '+254700000001';
  const contactPhone = '+254700000002';
  let accessToken: string;
  let adminAccessToken: string;
  let testUserId: string;

  beforeAll(async () => {
    // Clean test data
    await prisma.alertDelivery.deleteMany({});
    await prisma.alert.deleteMany({});
    await prisma.emergencyContact.deleteMany({});
    await prisma.refreshSession.deleteMany({});
    await prisma.otpRequest.deleteMany({});
    await prisma.user.deleteMany({});
  });

  describe('Phase 1: Auth & Contacts', () => {
    it('requests OTP and generates a valid hashed code', async () => {
      const res = await request(app)
        .post('/auth/otp/request')
        .send({ phoneNumber: userPhone, name: 'Alice Test' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const otpRecord = await prisma.otpRequest.findFirst({
        where: { phoneNumber: userPhone, consumedAt: null },
      });
      expect(otpRecord).not.toBeNull();
      expect(otpRecord?.codeHash).toBeDefined();
    });

    it('verifies OTP, issues JWT access token, and sets up user profile', async () => {
      // In dev mode when AT_API_KEY is unset, devCode is provided
      const reqRes = await request(app)
        .post('/auth/otp/request')
        .send({ phoneNumber: userPhone, name: 'Alice Test' });

      const devCode = reqRes.body.devCode;
      expect(devCode).toBeDefined();

      const verifyRes = await request(app)
        .post('/auth/otp/verify')
        .send({ phoneNumber: userPhone, code: devCode, name: 'Alice Test' });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.accessToken).toBeDefined();
      expect(verifyRes.body.refreshToken).toBeDefined();
      expect(verifyRes.body.user.role).toBe(Role.USER); // Role cannot be self-assigned

      accessToken = verifyRes.body.accessToken;
      testUserId = verifyRes.body.user.id;
    });

    it('creates an emergency contact for the authenticated user', async () => {
      const res = await request(app)
        .post('/contacts')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          name: 'Bob Family',
          phoneNumber: contactPhone,
          relationship: 'Brother',
        });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Bob Family');
      expect(res.body.phoneNumber).toBe(contactPhone);
    });

    it('rejects duplicate contact phone numbers for the same user (409)', async () => {
      const res = await request(app)
        .post('/contacts')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          name: 'Bob Duplicate',
          phoneNumber: contactPhone,
          relationship: 'Brother',
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already exists');
    });

    it('rejects adding own phone number as an emergency contact (400)', async () => {
      const res = await request(app)
        .post('/contacts')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          name: 'Self Contact',
          phoneNumber: userPhone,
          relationship: 'Self',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('cannot add your own phone number');
    });
  });

  describe('Phase 2: SOS Workflow & Constraints', () => {
    it('rejects alert creation if user has no contacts', async () => {
      // Register a new user without contacts
      const loneUserPhone = '+254700000099';
      const reqRes = await request(app)
        .post('/auth/otp/request')
        .send({ phoneNumber: loneUserPhone });

      const verifyRes = await request(app)
        .post('/auth/otp/verify')
        .send({ phoneNumber: loneUserPhone, code: reqRes.body.devCode });

      const loneToken = verifyRes.body.accessToken;

      const alertRes = await request(app)
        .post('/alerts')
        .set('Authorization', `Bearer ${loneToken}`)
        .send({
          idempotencyKey: 'test-key-no-contacts',
          locationAvailable: true,
          latitude: -1.2921,
          longitude: 36.8219,
        });

      expect(alertRes.status).toBe(400);
      expect(alertRes.body.code).toBe('NO_CONTACTS');
    });

    it('creates alert with locationAvailable: false without dropping or blocking (Constraint #1)', async () => {
      await closeOpenAlerts();
      const res = await request(app)
        .post('/alerts')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          idempotencyKey: 'test-key-no-loc-1',
          locationAvailable: false,
          latitude: null,
          longitude: null,
        });

      expect(res.status).toBe(201);
      expect(res.body.locationAvailable).toBe(false);
      expect(res.body.latitude).toBeNull();
      expect(res.body.longitude).toBeNull();
      expect(res.body.deliveries.length).toBe(1);
      expect(res.body.deliveries[0].contactPhoneSnapshot).toBe(contactPhone);
    });

    it('deduplicates replays with the same idempotency key (Constraint #3)', async () => {
      await closeOpenAlerts();
      const idempotencyKey = 'test-key-dedup-1';

      const firstRes = await request(app)
        .post('/alerts')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          idempotencyKey,
          locationAvailable: true,
          latitude: -1.2921,
          longitude: 36.8219,
        });

      expect(firstRes.status).toBe(201);
      const firstId = firstRes.body.id;

      // Replay identical idempotency key
      const secondRes = await request(app)
        .post('/alerts')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          idempotencyKey,
          locationAvailable: true,
          latitude: -1.2921,
          longitude: 36.8219,
        });

      expect(secondRes.status).toBe(200); // 200 returned for existing deduplicated alert
      expect(secondRes.body.id).toBe(firstId);

      // Verify in DB that only 1 record exists
      const alertsInDb = await prisma.alert.findMany({ where: { idempotencyKey } });
      expect(alertsInDb.length).toBe(1);
    });
  });

  describe('Phase 3: SMS Delivery & Webhook Anti-Regression', () => {
    it('processes delivery webhook and updates status to DELIVERED', async () => {
      await closeOpenAlerts();
      // Create an alert to test delivery
      const res = await request(app)
        .post('/alerts')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          idempotencyKey: 'test-key-webhook-1',
          locationAvailable: true,
          latitude: -1.2921,
          longitude: 36.8219,
        });

      const delivery = await waitForSent(res.body.id);
      const providerMessageId = delivery.providerMessageId!;

      // Africa's Talking sends delivery webhook: status "Success"
      const webhookRes = await request(app)
        .post('/webhooks/africastalking/delivery')
        .set(WEBHOOK_HEADERS)
        .send({
          id: providerMessageId,
          status: 'Success',
          phoneNumber: contactPhone,
        });

      expect(webhookRes.status).toBe(200);
      expect(webhookRes.body.status).toBe(DeliveryStatus.DELIVERED);

      const updated = await prisma.alertDelivery.findUnique({ where: { id: delivery.id } });
      expect(updated?.status).toBe(DeliveryStatus.DELIVERED);

      // Alert status should now transition to COMPLETED because all deliveries are terminal
      const updatedAlert = await prisma.alert.findUnique({ where: { id: res.body.id } });
      expect(updatedAlert?.status).toBe(AlertProcessingStatus.COMPLETED);
    });

    it('prevents terminal state from being regressed by stale/duplicate webhook (Constraint #2)', async () => {
      const delivery = await prisma.alertDelivery.findFirst({
        where: { status: DeliveryStatus.DELIVERED },
      });
      expect(delivery).not.toBeNull();

      // Older/duplicate event arrives saying "Sent"
      const webhookRes = await request(app)
        .post('/webhooks/africastalking/delivery')
        .set(WEBHOOK_HEADERS)
        .send({
          id: delivery?.providerMessageId,
          status: 'Sent',
          phoneNumber: delivery?.contactPhoneSnapshot,
        });

      expect(webhookRes.status).toBe(200);
      expect(webhookRes.body.note).toContain('Terminal state preserved');

      // Verify database record remained DELIVERED
      const checkRecord = await prisma.alertDelivery.findUnique({ where: { id: delivery!.id } });
      expect(checkRecord?.status).toBe(DeliveryStatus.DELIVERED);
    });
  });

  describe('Phase 4: Admin Dashboard & Audit Logs', () => {
    beforeAll(async () => {
      // Create admin user
      const adminPhone = '+254700000088';
      const adminUser = await prisma.user.create({
        data: {
          phoneNumber: adminPhone,
          name: 'Chief Admin',
          role: Role.ADMIN,
        },
      });

      const tokenRes = await request(app)
        .post('/auth/otp/request')
        .send({ phoneNumber: adminPhone });

      const verifyRes = await request(app)
        .post('/auth/otp/verify')
        .send({ phoneNumber: adminPhone, code: tokenRes.body.devCode });

      adminAccessToken = verifyRes.body.accessToken;
    });

    it('allows ADMIN to fetch alerts and writes to AuditLog', async () => {
      const initialLogsCount = await prisma.auditLog.count({
        where: { action: 'DASHBOARD_ALERTS_VIEWED' },
      });

      const res = await request(app)
        .get('/admin/alerts')
        .set('Authorization', `Bearer ${adminAccessToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const afterLogsCount = await prisma.auditLog.count({
        where: { action: 'DASHBOARD_ALERTS_VIEWED' },
      });
      expect(afterLogsCount).toBeGreaterThan(initialLogsCount);
    });

    it('rejects regular non-admin user from admin routes (403)', async () => {
      const res = await request(app)
        .get('/admin/alerts')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(403);
    });
  });
});