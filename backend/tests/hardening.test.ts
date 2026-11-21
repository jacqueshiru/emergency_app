import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { prisma } from '../src/prisma';
import { config } from '../src/config';
import { hashToken } from '../src/utils/hash';
import { smsService } from '../src/services/sms';
import { transitionDeliveryStatus } from '../src/services/deliveryState';
import { runDeliveryPass, backoffDelayMs } from '../src/services/deliveryWorker';
import { DeliveryStatus, Role } from '@seas/shared';

const app = createApp();
const SECRET = { 'x-webhook-secret': 'test-webhook-secret' };

async function makeUser(phone: string) {
  const user = await prisma.user.create({ data: { phoneNumber: phone, name: `U${phone.slice(-3)}`, role: Role.USER } });
  await prisma.emergencyContact.create({
    data: { userId: user.id, name: 'C', phoneNumber: `+2547${phone.slice(-8, -1)}9` },
  });
  const token = jwt.sign({ id: user.id, role: user.role, phoneNumber: phone }, config.jwt.secret, { expiresIn: '15m' });
  return { user, token };
}

async function makeDelivery(alertUserId: string, data: Partial<{ status: string; attempts: number }> = {}) {
  const alert = await prisma.alert.create({
    data: { userId: alertUserId, idempotencyKey: `k-${Math.random()}`, locationAvailable: false },
  });
  return prisma.alertDelivery.create({
    data: {
      alertId: alert.id, contactNameSnapshot: 'C', contactPhoneSnapshot: '+254700000999',
      providerMessageId: `pm-${Math.random()}`, ...data,
    },
  });
}

beforeAll(async () => {
  await prisma.alertDelivery.deleteMany({});
  await prisma.alert.deleteMany({});
  await prisma.emergencyContact.deleteMany({});
  await prisma.otpRequest.deleteMany({});
  await prisma.refreshSession.deleteMany({});
  await prisma.user.deleteMany({});
});

describe('Fix #2 webhook authenticity', () => {
   it('returns 401 and changes nothing when the secret is missing or wrong', async () => {
    const { user } = await makeUser('+254711000010');
    const d = await makeDelivery(user.id, { status: 'SENT' });
    const body = { id: d.providerMessageId, status: 'Success' };
    const a = await request(app).post('/webhooks/africastalking/delivery').send(body);
    const b = await request(app).post('/webhooks/africastalking/delivery').set('x-webhook-secret', 'nope').send(body);
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    const after = await prisma.alertDelivery.findUnique({ where: { id: d.id } });
    expect(after?.status).toBe('SENT'); // an unauthenticated call must not reach the DB write
  });
  it('accepts the secret as a ?token= query param', async () => {
    const res = await request(app).post('/webhooks/africastalking/delivery?token=test-webhook-secret').send({ id: 'unknown', status: 'Success' });
    expect(res.status).toBe(200);
  });
});

describe('Fix #3 atomic delivery transitions', () => {
  it('never regresses DELIVERED to SENT, in either write ordering', async () => {
    const { user } = await makeUser('+254711000001');
    for (const order of ['sent-first', 'delivered-first'] as const) {
      const d = await makeDelivery(user.id);
      const writes = [
        () => transitionDeliveryStatus(d.id, DeliveryStatus.SENT, { providerMessageId: d.providerMessageId }),
        () => transitionDeliveryStatus(d.id, DeliveryStatus.DELIVERED),
      ];
      if (order === 'delivered-first') writes.reverse();
      await Promise.all(writes.map((w) => w()));
      const final = await prisma.alertDelivery.findUnique({ where: { id: d.id } });
      expect(final?.status).toBe(DeliveryStatus.DELIVERED);
    }
  });

  it('a late SENT after DELIVERED is a no-op returning false', async () => {
    const { user } = await makeUser('+254711000002');
    const d = await makeDelivery(user.id);
    expect(await transitionDeliveryStatus(d.id, DeliveryStatus.DELIVERED)).toBe(true);
    expect(await transitionDeliveryStatus(d.id, DeliveryStatus.SENT)).toBe(false);
  });
});

describe('Fix #4 durable delivery worker', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { sendSpy = vi.spyOn(smsService, 'sendSms'); });
  afterEach(() => sendSpy.mockRestore());

  it('picks up a PENDING delivery left behind (restart recovery)', async () => {
    sendSpy.mockResolvedValue({ success: true, messageId: 'recovered-1', status: 'SENT' });
    const { user } = await makeUser('+254711000003');
    const d = await makeDelivery(user.id, { status: 'PENDING' });
    await runDeliveryPass();
    const after = await prisma.alertDelivery.findUnique({ where: { id: d.id } });
    expect(after?.status).toBe(DeliveryStatus.SENT);
    expect(after?.providerMessageId).toBe('recovered-1');
  });

  it('retries with backoff on failure, then gives up with a readable error', async () => {
    sendSpy.mockResolvedValue({ success: false, status: 'FAILED', error: 'gateway down' });
    const { user } = await makeUser('+254711000004');
    const d = await makeDelivery(user.id);
    await runDeliveryPass();
    let row = await prisma.alertDelivery.findUnique({ where: { id: d.id } });
    expect(row?.status).toBe(DeliveryStatus.PENDING);
    expect(row?.attempts).toBe(1);
    expect(row?.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
    expect(backoffDelayMs(1)).toBe(30_000);

    // Not due yet -> not retried
    await runDeliveryPass();
    expect((await prisma.alertDelivery.findUnique({ where: { id: d.id } }))?.attempts).toBe(1);

    // Fast-forward through the remaining attempts
    for (let i = 0; i < 6; i++) {
      await runDeliveryPass(new Date(Date.now() + (i + 1) * 3_600_000));
    }
    row = await prisma.alertDelivery.findUnique({ where: { id: d.id } });
    expect(row?.status).toBe(DeliveryStatus.FAILED);
    expect(row?.attempts).toBe(5);
    expect(row?.lastErrorCode).toContain('Gave up');
  });

  it('never double-sends when two passes overlap', async () => {
    sendSpy.mockResolvedValue({ success: true, messageId: 'once', status: 'SENT' });
    const { user } = await makeUser('+254711000005');
    await makeDelivery(user.id);
    await Promise.all([runDeliveryPass(), runDeliveryPass()]);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

describe('Fix #5 idempotency & ownership', () => {
  it('parallel POST /alerts with one key yields one alert and no 500s', async () => {
    const { token } = await makeUser('+254711000006');
    const send = () => request(app).post('/alerts').set('Authorization', `Bearer ${token}`)
      .send({ idempotencyKey: 'parallel-key', locationAvailable: false });
    const results = await Promise.all([send(), send(), send()]);
    results.forEach((r) => expect([200, 201]).toContain(r.status));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await prisma.alert.count({ where: { idempotencyKey: 'parallel-key' } })).toBe(1);
  });

  it('blocks a second SOS while one is OPEN (409)', async () => {
    const { token } = await makeUser('+254711000007');
    const post = (k: string) => request(app).post('/alerts').set('Authorization', `Bearer ${token}`).send({ idempotencyKey: k, locationAvailable: false });
    expect((await post('open-1')).status).toBe(201);
    const second = await post('open-2');
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ALERT_ALREADY_OPEN');
  });

  it("returns 404 for another user's alert on GET, resolve and cancel", async () => {
    const a = await makeUser('+254711000008');
    const b = await makeUser('+254711000009');
    const created = await request(app).post('/alerts').set('Authorization', `Bearer ${a.token}`).send({ idempotencyKey: 'own-1', locationAvailable: false });
    const id = created.body.id;
    const hdr = { Authorization: `Bearer ${b.token}` };
    expect((await request(app).get(`/alerts/${id}`).set(hdr)).status).toBe(404);
    expect((await request(app).patch(`/alerts/${id}/resolve`).set(hdr)).status).toBe(404);
    expect((await request(app).patch(`/alerts/${id}/cancel`).set(hdr)).status).toBe(404);
    const still = await prisma.alert.findUnique({ where: { id } });
    expect(still?.resolutionStatus).toBe('OPEN');
  });
});

describe('Fix #6 OTP failure reporting', () => {
  const phone = '+254722000001';
  const seed = (over: Record<string, unknown> = {}) =>
    prisma.otpRequest.create({
      data: { phoneNumber: phone, codeHash: hashToken('123456'), expiresAt: new Date(Date.now() + 300_000), ...over },
    });
  const verify = (code: string) => request(app).post('/auth/otp/verify').send({ phoneNumber: phone, code });
  beforeEach(async () => { await prisma.otpRequest.deleteMany({ where: { phoneNumber: phone } }); });

  it('reports expired, consumed, and wrong codes distinctly', async () => {
    await seed({ expiresAt: new Date(Date.now() - 1000) });
    expect((await verify('123456')).body.code).toBe('OTP_EXPIRED');

    await prisma.otpRequest.deleteMany({ where: { phoneNumber: phone } });
    await seed({ consumedAt: new Date() });
    expect((await verify('123456')).body.code).toBe('OTP_CONSUMED');

    await prisma.otpRequest.deleteMany({ where: { phoneNumber: phone } });
    await seed();
    const wrong = await verify('000000');
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('OTP_INCORRECT');
    expect(JSON.stringify(wrong.body)).not.toMatch(/remaining/i);
  });

  it('concurrent wrong guesses never record more than the cap, and a correct code after the cap is rejected', async () => {
    const otp = await seed();
    await Promise.all(Array.from({ length: 12 }, () => verify('000000')));
    expect((await prisma.otpRequest.findUnique({ where: { id: otp.id } }))?.attempts).toBe(5);
    const late = await verify('123456');
    expect(late.status).toBe(429);
    expect(late.body.code).toBe('OTP_MAX_ATTEMPTS');
  });
});
