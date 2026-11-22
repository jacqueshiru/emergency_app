import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '5000', 10),
  databaseUrl: process.env.DATABASE_URL || '',
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-jwt-secret-replace-in-production-seas',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-replace-in-production-seas',
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresDays: parseInt(process.env.JWT_REFRESH_EXPIRES_DAYS || '30', 10),
  },
  africasTalking: {
    username: process.env.AT_USERNAME || 'sandbox',
    apiKey: process.env.AT_API_KEY || '',
    senderId: process.env.AT_SENDER_ID || '',
  },
  staleAlertThresholdMinutes: parseInt(process.env.STALE_ALERT_THRESHOLD_MINUTES || '10', 10),
  corsOrigin: process.env.CORS_ORIGIN || '*',
};

export const deliveryConfig = {
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  maxAttempts: parseInt(process.env.DELIVERY_MAX_ATTEMPTS || '5', 10),
  // delay before retry N (index = attempts already made - 1): 30s, 2m, 10m, 30m
  backoffMs: [30_000, 120_000, 600_000, 1_800_000],
  claimTtlMs: 60_000, // a claim older than this is considered abandoned (crashed worker)
  pollIntervalMs: parseInt(process.env.DELIVERY_POLL_MS || '5000', 10),
  otpMaxAttempts: 5,
};

/**
 * SMS provider selection.
 *  - "africastalking" (default): existing behaviour (mocks the send when AT_API_KEY is empty).
 *  - "gateway": your own Android phone running "SMS Gateway for Android".
 * Mutable on purpose so tests can switch provider.
 */
export const smsConfig = {
  provider: (process.env.SMS_PROVIDER || 'africastalking').toLowerCase(),
  gateway: {
    // Local mode: http://<phone-local-ip>:8080   Cloud mode: https://api.sms-gate.app/3rdparty/v1
    url: process.env.SMS_GATEWAY_URL || '',
    username: process.env.SMS_GATEWAY_USERNAME || '',
    password: process.env.SMS_GATEWAY_PASSWORD || '',
    timeoutMs: parseInt(process.env.SMS_GATEWAY_TIMEOUT_MS || '10000', 10),
  },
};

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------
const DEFAULT_SECRETS = new Set([
  'dev-jwt-secret-replace-in-production-seas',
  'dev-refresh-secret-replace-in-production-seas',
]);

/** True when OTP messages go out through a real provider (so dev shortcuts must be off). */
export function hasRealSmsProvider(): boolean {
  if (smsConfig.provider === 'gateway') return true;
  return Boolean(config.africasTalking.apiKey);
}

/**
 * Whether the OTP may be returned in the API response / written to logs (dev convenience).
 * Never implicit: needs NODE_ENV=test, or NODE_ENV=development PLUS ALLOW_DEV_OTP=true,
 * and never when a real SMS provider is configured. A missing NODE_ENV on a server
 * (which defaults to "development") therefore cannot expose OTPs.
 */
export function devOtpAllowed(): boolean {
  if (hasRealSmsProvider()) return false;
  if (config.env === 'production') return false;
  if (config.env === 'test') return true;
  return smsConfig.provider === 'mock' || process.env.ALLOW_DEV_OTP === 'true';
}

/** Allowed browser origins. `true` (reflect) only outside production with CORS_ORIGIN unset or "*". */
export function allowedOrigins(): string[] | true {
  const raw = (config.corsOrigin || '').trim();
  if (!raw || raw === '*') return true;
  return raw.split(',').map((o) => o.trim()).filter(Boolean);
}

/**
 * Origins the Android (Capacitor) WebView calls from. The app is served from https://localhost
 * (capacitor.config.json: androidScheme "https"), so without these every request from the phone fails CORS
 * and the app only shows "Network error". Set ALLOW_NATIVE_APP_ORIGINS=false to opt out.
 */
export const NATIVE_APP_ORIGINS = ['https://localhost', 'capacitor://localhost', 'http://localhost'];

/** CORS/Socket.IO origin option: the configured web origins plus the native app's own origins. */
export function corsOriginOption(): string[] | true {
  const base = allowedOrigins();
  if (base === true || process.env.ALLOW_NATIVE_APP_ORIGINS === 'false') return base;
  return Array.from(new Set([...base, ...NATIVE_APP_ORIGINS]));
}

/** Returns the list of problems that make the current configuration unsafe for production. */
export function securityProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  const jwtSecret = env.JWT_SECRET || '';
  if (!jwtSecret || DEFAULT_SECRETS.has(jwtSecret) || jwtSecret.length < 32) {
    problems.push('JWT_SECRET must be set to a random value of at least 32 characters');
  }
  if (!env.CORS_ORIGIN || env.CORS_ORIGIN.trim() === '*') {
    problems.push('CORS_ORIGIN must list your real frontend origin(s), not "*"');
  }
  if (env.ALLOW_DEV_OTP === 'true') {
    problems.push('ALLOW_DEV_OTP must not be enabled in production');
  }
  if (!hasRealSmsProvider()) {
    problems.push('No real SMS provider configured (set SMS_PROVIDER=gateway with credentials, or AT_API_KEY)');
  }
  if (!env.WEBHOOK_SECRET || env.WEBHOOK_SECRET.length < 16) {
    problems.push('WEBHOOK_SECRET must be set (16+ characters)');
  }
  return problems;
}

/** Call at startup. In production an unsafe config stops the server; elsewhere it only warns. */
export function assertSecureConfig(): void {
  const problems = securityProblems();
  if (config.env === 'production') {
    if (problems.length) {
      throw new Error('Refusing to start with an insecure production configuration:\n - ' + problems.join('\n - '));
    }
    return;
  }
  if (config.env !== 'test' && DEFAULT_SECRETS.has(process.env.JWT_SECRET || '') ) {
    console.warn('[SECURITY] Using the built-in development JWT secret. Set JWT_SECRET before deploying.');
  }
}

export const limits = {
  maxContactsPerUser: parseInt(process.env.MAX_CONTACTS_PER_USER || '10', 10),
};
