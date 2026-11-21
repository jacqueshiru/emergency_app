import { prisma } from '../prisma';
import { smsService } from './sms';
import { deliveryConfig, smsConfig } from '../config';
import { GATEWAY_ID_PREFIX, getGatewayMessage } from './smsGateway';
import { logger } from '../utils/logger';
import { DeliveryStatus, AlertProcessingStatus, AlertResolutionStatus } from '@seas/shared';
import { transitionDeliveryStatus } from './deliveryState';
import { sanitizeDisplayName } from '../utils/text';

/** Delay before the next attempt, given how many attempts have already been made. */
export function backoffDelayMs(attemptsMade: number): number {
  const { backoffMs } = deliveryConfig;
  return backoffMs[Math.min(Math.max(attemptsMade - 1, 0), backoffMs.length - 1)];
}

function buildMessage(alert: {
  locationAvailable: boolean;
  latitude: number | null;
  longitude: number | null;
  delayed: boolean;
  triggeredAt: Date;
  user: { name: string };
}): string {
  const location =
    alert.locationAvailable && alert.latitude != null && alert.longitude != null
      ? `Location: https://maps.google.com/?q=${alert.latitude},${alert.longitude}`
      : 'Location: Unavailable / Not provided.';
  const delay = alert.delayed ? ` [Delayed alert: Triggered at ${alert.triggeredAt.toISOString()}]` : '';
  return `EMERGENCY ALERT: ${sanitizeDisplayName(alert.user.name, 30) || 'A user'} has triggered an SOS!${delay} ${location} - Smart Emergency Alert System`;
}

/**
 * Atomically claim one due delivery. Only one worker tick can win: the updateMany's
 * WHERE clause is the lock. Claim also bumps `attempts`, so a crash mid-send still
 * counts the attempt and a stale claim becomes re-claimable after claimTtlMs.
 */
async function claim(id: string, now: Date): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - deliveryConfig.claimTtlMs);
  const { count } = await prisma.alertDelivery.updateMany({
    where: {
      id,
      status: DeliveryStatus.PENDING,
      AND: [
        { OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }] },
        { OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
      ],
    },
    data: { claimedAt: now, lastAttemptAt: now, attempts: { increment: 1 } },
  });
  return count === 1;
}

async function processDelivery(id: string): Promise<void> {
  const delivery = await prisma.alertDelivery.findUnique({
    where: { id },
    include: { alert: { include: { user: { select: { name: true } } } } },
  });
  if (!delivery || delivery.status !== DeliveryStatus.PENDING) return;

  // A cancelled alert (false alarm) must never keep texting contacts, including queued retries.
  // Recorded as FAILED with a clear reason so the status stays honest: nothing was sent.
  if (delivery.alert.resolutionStatus === AlertResolutionStatus.CANCELLED) {
    await transitionDeliveryStatus(id, DeliveryStatus.FAILED, {
      lastErrorCode: 'Alert was cancelled before this message was sent',
      nextRetryAt: null,
      claimedAt: null,
    });
    return;
  }

  await prisma.alert.updateMany({
    where: { id: delivery.alertId, status: AlertProcessingStatus.CREATED },
    data: { status: AlertProcessingStatus.PROCESSING },
  });

  let errorText: string | null = null;
  try {
    const result = await smsService.sendSms(delivery.contactPhoneSnapshot, buildMessage(delivery.alert));
    if (result.success) {
      await transitionDeliveryStatus(id, DeliveryStatus.SENT, {
        providerMessageId: result.messageId ?? null,
        lastErrorCode: null,
        nextRetryAt: null,
        claimedAt: null,
      });
      return;
    }
    errorText = result.error || 'Gateway dispatch failed';
  } catch (err: any) {
    errorText = err?.message || 'Dispatch error';
  }

  // Failure path: retry with backoff, or give up at the cap.
  if (delivery.attempts >= deliveryConfig.maxAttempts) {
    await transitionDeliveryStatus(id, DeliveryStatus.FAILED, {
      lastErrorCode: `Gave up after ${delivery.attempts} attempts: ${errorText}`.slice(0, 250),
      nextRetryAt: null,
      claimedAt: null,
    });
  } else {
    await transitionDeliveryStatus(id, DeliveryStatus.PENDING, {
      lastErrorCode: `Attempt ${delivery.attempts} failed: ${errorText}`.slice(0, 250),
      nextRetryAt: new Date(Date.now() + backoffDelayMs(delivery.attempts)),
      claimedAt: null,
    });
  }
}

const lastGatewayPoll = new Map<string, number>();

/**
 * Gateway webhooks need a public HTTPS URL, so instead we poll the phone for the state of
 * messages it accepted: Delivered -> DELIVERED, Failed -> retry with backoff (or FAILED at the cap).
 * Fresh messages are polled every pass; older ones at most once a minute.
 */
export async function reconcileGatewayDeliveries(now = new Date()): Promise<number> {
  if (smsConfig.provider !== 'gateway') return 0;

  const rows = await prisma.alertDelivery.findMany({
    where: {
      status: DeliveryStatus.SENT,
      providerMessageId: { startsWith: GATEWAY_ID_PREFIX },
      lastAttemptAt: { gte: new Date(now.getTime() - 6 * 3_600_000) },
    },
    orderBy: { updatedAt: 'asc' },
    take: 50,
  });

  let changed = 0;
  for (const row of rows) {
    const ageMs = now.getTime() - (row.lastAttemptAt?.getTime() ?? now.getTime());
    const last = lastGatewayPoll.get(row.id) ?? 0;
    if (ageMs > 5 * 60_000 && now.getTime() - last < 60_000) continue;
    lastGatewayPoll.set(row.id, now.getTime());

    const info = await getGatewayMessage(row.providerMessageId!.slice(GATEWAY_ID_PREFIX.length));
    if (!info) continue; // phone/gateway unreachable: try again next pass

    if (info.state === 'Delivered') {
      if (await transitionDeliveryStatus(row.id, DeliveryStatus.DELIVERED, { lastErrorCode: null })) changed++;
    } else if (info.state === 'Failed' || info.state === 'Cancelled') {
      const reason = `Gateway reported ${info.state.toLowerCase()}${info.reason ? `: ${info.reason}` : ''}`.slice(0, 250);
      if (row.attempts >= deliveryConfig.maxAttempts) {
        await transitionDeliveryStatus(row.id, DeliveryStatus.FAILED, { lastErrorCode: `Gave up after ${row.attempts} attempts. ${reason}`.slice(0, 250), nextRetryAt: null, claimedAt: null });
      } else {
        await transitionDeliveryStatus(row.id, DeliveryStatus.PENDING, { lastErrorCode: reason, nextRetryAt: new Date(now.getTime() + backoffDelayMs(row.attempts)), claimedAt: null });
      }
      changed++;
    }
  }
  return changed;
}

/** One polling pass. Safe to call concurrently and at startup (the DB is the queue). */
export async function runDeliveryPass(now = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - deliveryConfig.claimTtlMs);
  const due = await prisma.alertDelivery.findMany({
    where: {
      status: DeliveryStatus.PENDING,
      AND: [
        { OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
        { OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }] },
      ],
    },
    select: { id: true },
    orderBy: { updatedAt: 'asc' },
    take: 50,
  });

  let processed = 0;
  for (const { id } of due) {
    try {
      if (!(await claim(id, now))) continue;
      await processDelivery(id);
      processed++;
    } catch (err: any) {
      logger.error('Delivery worker error', { deliveryId: id, error: err?.message });
    }
  }
  try {
    await reconcileGatewayDeliveries(now);
  } catch (err: any) {
    logger.error('Gateway reconcile error', { error: err?.message });
  }
  return processed;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let rerun = false;

/**
 * Runs passes until no one asked for another while we were busy. A kick that arrives
 * mid-pass sets `rerun` instead of being dropped, so new alerts never wait for the next poll.
 */
async function tick() {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    do {
      rerun = false;
      await runDeliveryPass();
    } while (rerun);
  } catch (err: any) {
    logger.error('Delivery worker tick failed', { error: err?.message });
  } finally {
    running = false;
  }
}

/** Starts the worker. The immediate first pass doubles as restart recovery. */
export function startDeliveryWorker(): void {
  if (timer) return;
  void tick();
  timer = setInterval(() => void tick(), deliveryConfig.pollIntervalMs);
  timer.unref?.();
}

export function stopDeliveryWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Called right after alert creation so the first send doesn't wait for the next poll. */
export function kickDeliveryWorker(): void {
  void tick();
}
