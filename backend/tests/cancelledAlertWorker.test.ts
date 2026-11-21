import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pure unit test: Prisma and the SMS provider are mocked, so it needs no database.
vi.mock('../src/prisma', () => ({
  prisma: {
    alertDelivery: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    alert: { updateMany: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock('../src/services/sms', () => ({ smsService: { sendSms: vi.fn() } }));
vi.mock('../src/services/socket', () => ({
  emitDeliveryUpdated: vi.fn(),
  emitResolutionUpdated: vi.fn(),
  emitNewAlert: vi.fn(),
}));

import { prisma } from '../src/prisma';
import { smsService } from '../src/services/sms';
import { runDeliveryPass } from '../src/services/deliveryWorker';
import { DeliveryStatus } from '@seas/shared';

const db = prisma as any;

function deliveryRow(resolutionStatus: string) {
  return {
    id: 'd1',
    alertId: 'a1',
    status: DeliveryStatus.PENDING,
    attempts: 1,
    contactPhoneSnapshot: '+254711000111',
    alert: {
      id: 'a1',
      userId: 'u1',
      resolutionStatus,
      locationAvailable: false,
      latitude: null,
      longitude: null,
      delayed: false,
      triggeredAt: new Date(),
      user: { name: 'Test User' },
    },
  };
}

describe('delivery worker vs cancelled alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.alertDelivery.findMany.mockResolvedValue([{ id: 'd1' }]);
    db.alertDelivery.updateMany.mockResolvedValue({ count: 1 }); // claim + transition both apply
    db.alertDelivery.count.mockResolvedValue(0);
    db.alert.updateMany.mockResolvedValue({ count: 1 });
    db.alert.findUnique.mockResolvedValue({ id: 'a1', userId: 'u1', deliveries: [] });
  });

  it('does NOT send SMS for a cancelled alert and records the delivery as FAILED with a reason', async () => {
    const row = deliveryRow('CANCELLED');
    db.alertDelivery.findUnique.mockResolvedValue(row);

    await runDeliveryPass();

    expect(smsService.sendSms).not.toHaveBeenCalled();
    const failedWrite = db.alertDelivery.updateMany.mock.calls.find(
      ([arg]: any[]) => arg.data?.status === DeliveryStatus.FAILED
    );
    expect(failedWrite).toBeTruthy();
    expect(failedWrite[0].data.lastErrorCode).toMatch(/cancelled/i);
  });

  it('still sends SMS for an OPEN alert', async () => {
    const row = deliveryRow('OPEN');
    db.alertDelivery.findUnique.mockResolvedValue(row);
    (smsService.sendSms as any).mockResolvedValue({ success: true, messageId: 'm1', status: 'SENT' });

    await runDeliveryPass();

    expect(smsService.sendSms).toHaveBeenCalledTimes(1);
    const sentWrite = db.alertDelivery.updateMany.mock.calls.find(
      ([arg]: any[]) => arg.data?.status === DeliveryStatus.SENT
    );
    expect(sentWrite).toBeTruthy();
  });
});
