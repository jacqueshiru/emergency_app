import { prisma } from '../prisma';
import { DeliveryStatus, AlertProcessingStatus } from '@seas/shared';
import { emitDeliveryUpdated, emitResolutionUpdated } from './socket';
import { logger } from '../utils/logger';

const TERMINAL = [DeliveryStatus.DELIVERED, DeliveryStatus.FAILED] as string[];

export interface TransitionExtra {
  providerMessageId?: string | null;
  lastErrorCode?: string | null;
  attempts?: number;
  lastAttemptAt?: Date;
  nextRetryAt?: Date | null;
  claimedAt?: Date | null;
  deviceVerified?: boolean;
}

/**
 * The ONLY place AlertDelivery.status may be written after creation.
 * Atomic conditional update: a terminal state (DELIVERED/FAILED) is never overwritten,
 * regardless of which writer (SMS send path, webhook, worker) gets here first.
 * Returns true if the write applied; false means a terminal state was already reached
 * (the guarantee working — not an error).
 */
export async function transitionDeliveryStatus(
  deliveryId: string,
  newStatus: DeliveryStatus,
  extra: TransitionExtra = {}
): Promise<boolean> {
  const { count } = await prisma.alertDelivery.updateMany({
    where: { id: deliveryId, status: { notIn: TERMINAL } },
    data: { status: newStatus, ...extra },
  });

  if (count === 0) {
    logger.info('Delivery transition skipped: terminal state already reached', { deliveryId, attempted: newStatus });
    return false;
  }

  const delivery = await prisma.alertDelivery.findUnique({
    where: { id: deliveryId },
    include: { alert: { select: { userId: true } } },
  });
  if (delivery) {
    emitDeliveryUpdated(delivery, delivery.alertId, delivery.alert.userId);
    if (TERMINAL.includes(newStatus)) await finalizeAlertIfDone(delivery.alertId);
  }
  return true;
}

/**
 * Alert.status -> COMPLETED once no delivery is PENDING/SENT.
 * Atomic: only the writer that flips it from a non-COMPLETED status emits the event.
 */
export async function finalizeAlertIfDone(alertId: string): Promise<void> {
  const active = await prisma.alertDelivery.count({
    where: { alertId, status: { in: [DeliveryStatus.PENDING, DeliveryStatus.SENT] } },
  });
  if (active > 0) return;

  const { count } = await prisma.alert.updateMany({
    where: { id: alertId, status: { not: AlertProcessingStatus.COMPLETED } },
    data: { status: AlertProcessingStatus.COMPLETED },
  });
  if (count === 0) return;

  const completed = await prisma.alert.findUnique({
    where: { id: alertId },
    include: { deliveries: true, user: { select: { id: true, name: true, phoneNumber: true } } },
  });
  if (completed) emitResolutionUpdated(completed);
  logger.info('Alert deliveries completed', { alertId });
}
