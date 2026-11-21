import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { Role } from '@seas/shared';
import { prisma } from '../prisma';
import { logger } from '../utils/logger';

export interface AuthenticatedUser {
  id: string;
  role: Role;
  phoneNumber: string;
  adminMfaVerified?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Validates JWT access token
 */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.substring(7);

  try {
    const payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }) as AuthenticatedUser;
    req.user = {
      id: payload.id,
      role: payload.role,
      phoneNumber: payload.phoneNumber,
      adminMfaVerified: payload.adminMfaVerified === true,
    };
    return next();
  } catch (error: any) {
    logger.warn('Token validation failed', { message: error.message });
    return res.status(401).json({ error: 'Invalid or expired access token' });
  }
}

/**
 * Enforces ADMIN role server-side
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (req.user.role !== Role.ADMIN) {
    return res.status(403).json({ error: 'Access forbidden: Administrator privileges required' });
  }

  return next();
}

/**
 * Records admin actions into AuditLog without raw emergency content
 */
export async function logAdminAction(actorId: string | undefined, action: string, targetId?: string) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: actorId || null,
        action,
        targetId: targetId || null,
      },
    });
  } catch (err: any) {
    logger.error('Failed to write to AuditLog', { action, error: err.message });
  }
}

/**
 * Rate limiter for OTP requests (IP-based)
 * Maximum 5 OTP requests per 10 minutes per IP
 */
export const otpIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OTP requests from this network. Please try again later.' },
  skip: () => config.env === 'test',
});

const skipInTests = () => config.env === 'test';

/** Broad safety net for every endpoint: 300 requests/minute per IP. */
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
  skip: (req) => skipInTests() || req.path === '/health' || req.path === '/api/health',
});

/** OTP verification: 20 attempts / 10 min / IP (each code is additionally capped at 5 guesses). */
export const otpVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please try again later.' },
  skip: skipInTests,
});

/** Token refresh: 30 / 10 min / IP. */
export const refreshLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many refresh attempts. Please try again later.' },
  skip: skipInTests,
});

/**
 * SOS creation: 20 / hour per USER (after authenticate). Each alert sends SMS to every
 * contact, so this caps cost and abuse. Offline-queue replays of one alert count too.
 */
export const alertCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || 'anonymous',
  message: { error: 'Too many alerts triggered. Please try again later.', code: 'ALERT_RATE_LIMIT' },
  skip: skipInTests,
  // Only genuinely new alerts (201) and client errors count. Idempotent replays (200) and
  // server-side 5xx failures are excluded, so the offline queue retrying one real emergency
  // can never lock the user out of sending it.
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => !(res.statusCode === 201 || (res.statusCode >= 400 && res.statusCode < 500)),
});

/**
 * MFA enforcement for ADMIN operations
 */
export function requireAdminMfa(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== Role.ADMIN) return res.status(403).json({ error: 'Administrator privileges required' });
  if (!req.user.adminMfaVerified) {
    return res.status(403).json({ error: 'Administrator MFA verification required', code: 'ADMIN_MFA_REQUIRED' });
  }
  return next();
}