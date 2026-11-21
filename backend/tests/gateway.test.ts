import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../src/prisma';
import { smsConfig } from '../src/config';
import { sendViaGateway, getGatewayMessage } from '../src/services/smsGateway';
import { reconcileGatewayDeliveries } from '../src/services/deliveryWorker';
import { DeliveryStatus, Role } from '@seas/shared';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const original = { ...smsConfig, gateway: { ...smsConfig.gateway } };

beforeEach(() => {
  smsConfig.provider = 'gateway';
  smsConfig.gateway.url = 'http://192.168.1.50:8080/';
  smsConfig.gateway.username = 'phoneuser';
  smsConfig.gateway.password = 'phonepass';
});
afterEach(() => {
  vi.unstubAllGlobals();
  smsConfig.provider = original.provider;
  Object.assign(smsConfig.gateway, original.gateway);
});

describe('SMS gateway client', () => {
  it('sends with basic auth and delivery report, and prefixes the message id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ id: 'abc123', state: 'Pending' }, 202));
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendViaGateway('+254700000111', 'hello');
    expect(res.success).toBe(true);
    expect(res.messageId).toBe('gw:abc123');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://192.168.1.50:8080/message');
    expect(init.headers.Authorization).toBe('Basic ' + Buffer.from('phoneuser:phonepass').toString('base64'));
    const body = JSON.parse(init.body);
    expect(body.phoneNumbers).toEqual(['+254700000111']);
    expect(body.textMessage.text).toBe('hello');
    expect(body.withDeliveryReport).toBe(true);
  });

  it('falls back to /messages when /message is 404', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ id: 'zzz' }, 202));
    vi.stubGlobal('fetch', fetchMock);
    const res = await sendViaGateway('+254700000111', 'hi');
    expect(res.success).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe('http://192.168.1.50:8080/messages');
  });

  it('reports bad credentials, unreachable phone, and missing config clearly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 401)));
    expect((await sendViaGateway('+254700000111', 'x')).error).toMatch(/credentials/);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const down = await sendViaGateway('+254700000111', 'x');
    expect(down.success).toBe(false);
    expect(down.error).toMatch(/Cannot reach/);

    smsConfig.gateway.password = '';
    expect((await sendViaGateway('+254700000111', 'x')).error).toMatch(/not configured/);
  });

  it('returns null when the phone is unreachable while checking status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    expect(await getGatewayMessage('abc')).toBeNull();
  });
});

describe('gateway status reconciliation', () => {
  let userId: string;
  beforeAll(async () => {
    const user = await prisma.user.create({ data: { phoneNumber: '+254733000001', name: 'GW', role: Role.USER } });
    userId = user.id;
  });

  async function sentDelivery(attempts = 1) {
    const alert = await prisma.alert.create({
      data: { userId, idempotencyKey: `gw-${Math.random()}`, locationAvailable: false },
    });
    return prisma.alertDelivery.create({
      data: {
        alertId: alert.id, contactNameSnapshot: 'C', contactPhoneSnapshot: '+254700000222',
        providerMessageId: 'gw:msg-1', status: DeliveryStatus.SENT, attempts, lastAttemptAt: new Date(),
      },
    });
  }

  it('marks DELIVERED when the phone reports Delivered', async () => {
    const d = await sentDelivery();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ id: 'msg-1', state: 'Delivered' })));
    await reconcileGatewayDeliveries();
    expect((await prisma.alertDelivery.findUnique({ where: { id: d.id } }))?.status).toBe(DeliveryStatus.DELIVERED);
  });

  it('re-queues with backoff when the phone reports Failed (under the attempt cap)', async () => {
    const d = await sentDelivery(1);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ id: 'msg-1', state: 'Failed', reason: 'No service' })));
    await reconcileGatewayDeliveries();
    const row = await prisma.alertDelivery.findUnique({ where: { id: d.id } });
    expect(row?.status).toBe(DeliveryStatus.PENDING);
    expect(row?.lastErrorCode).toContain('No service');
    expect(row!.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('gives up with FAILED at the attempt cap', async () => {
    const d = await sentDelivery(5);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ id: 'msg-1', state: 'Failed' })));
    await reconcileGatewayDeliveries();
    const row = await prisma.alertDelivery.findUnique({ where: { id: d.id } });
    expect(row?.status).toBe(DeliveryStatus.FAILED);
    expect(row?.lastErrorCode).toContain('Gave up');
  });

  it('leaves SENT untouched when the phone is unreachable', async () => {
    const d = await sentDelivery();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await reconcileGatewayDeliveries();
    expect((await prisma.alertDelivery.findUnique({ where: { id: d.id } }))?.status).toBe(DeliveryStatus.SENT);
  });
});
