import crypto from 'crypto';
import { config } from '../config';

const SALT = config.jwt.secret || 'default-seas-salt';

/**
 * Deterministic hash for token lookup (e.g. refresh sessions and OTP codes)
 */
export function hashToken(token: string): string {
  return crypto.createHmac('sha256', SALT).update(token).digest('hex');
}

/**
 * Generate a cryptographically random 6-digit numeric OTP
 */
export function generateOtp(): string {
  const num = crypto.randomInt(100000, 1_000_000); // upper bound is exclusive: 100000..999999
  return num.toString();
}

/**
 * Generates an opaque refresh token
 */
export function generateRefreshToken(): string {
  return crypto.randomBytes(40).toString('hex');
}
