import { prisma } from '../prisma';
import { logger } from '../utils/logger';

const DEFAULT_RETENTION_DAYS = 365;
let timer: NodeJS.Timeout | null = null;

export async function runRetentionCleanup(): Promise<void> {
  const days = Math.max(30, Number(process.env.DATA_RETENTION_DAYS || DEFAULT_RETENTION_DAYS));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [alerts, otp, sessions, audit] = await Promise.all([
    prisma.alert.deleteMany({ where: { triggeredAt: { lt: cutoff } } }),
    prisma.otpRequest.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.refreshSession.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: cutoff } }] } }),
    prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);
  logger.info('Data retention cleanup completed', {
    retentionDays: days,
    alertsDeleted: alerts.count,
    otpDeleted: otp.count,
    sessionsDeleted: sessions.count,
    auditDeleted: audit.count,
  });
}

export function startRetentionCleanup(): void {
  if (timer) return;
  void runRetentionCleanup().catch((error) => logger.error('Data retention cleanup failed', { error: error.message }));
  timer = setInterval(() => {
    void runRetentionCleanup().catch((error) => logger.error('Data retention cleanup failed', { error: error.message }));
  }, 24 * 60 * 60 * 1000);
  timer.unref();
}

export function stopRetentionCleanup(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
