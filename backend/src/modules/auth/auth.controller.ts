import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../../prisma';
import { normalizePhoneNumber } from '../../utils/phone';
import { hashToken, generateOtp, generateRefreshToken } from '../../utils/hash';
import { smsService } from '../../services/sms';
import { config, deliveryConfig, devOtpAllowed } from '../../config';
import { sanitizeDisplayName } from '../../utils/text';
import { logger } from '../../utils/logger';
import { Role } from '@seas/shared';
import { generateTotpSecret, verifyTotp } from '../../utils/totp';

// Phone-based rate limiter map (in-memory sliding window for phone cooldown)
const phoneCooldownMap = new Map<string, { lastRequested: number; count: number }>();

export class AuthController {
  /**
   * Request OTP
   * POST /auth/otp/request
   */
  async requestOtp(req: Request, res: Response) {
    try {
      const { phoneNumber, name } = req.body;
      if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
      }

      let normalizedPhone: string;
      try {
        normalizedPhone = normalizePhoneNumber(phoneNumber);
      } catch (err: any) {
        return res.status(400).json({ error: err.message });
      }

      // Phone-level rate limit & cooldown: 60s cooldown, max 5 requests per 10 mins
      const now = Date.now();
      const phoneRecord = phoneCooldownMap.get(normalizedPhone);
      if (config.env !== 'test' && phoneRecord) {
        if (now - phoneRecord.lastRequested < 60 * 1000) {
          const waitSecs = Math.ceil((60 * 1000 - (now - phoneRecord.lastRequested)) / 1000);
          return res.status(429).json({ error: `Please wait ${waitSecs} seconds before requesting a new code` });
        }
        if (now - phoneRecord.lastRequested < 10 * 60 * 1000 && phoneRecord.count >= 5) {
          return res.status(429).json({ error: 'Too many OTP requests for this number. Please wait 10 minutes.' });
        }
      }

      // Supersede previous unconsumed OTPs for this phone
      await prisma.otpRequest.updateMany({
        where: {
          phoneNumber: normalizedPhone,
          consumedAt: null,
        },
        data: {
          consumedAt: new Date(), // supersede
        },
      });

      // Generate 6-digit OTP
      const plainOtp = generateOtp();
      const codeHash = hashToken(plainOtp);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes validity

      await prisma.otpRequest.create({
        data: {
          phoneNumber: normalizedPhone,
          codeHash,
          expiresAt,
          attempts: 0,
        },
      });

      // Update cooldown tracking
      const currentCount = (phoneRecord && (now - phoneRecord.lastRequested < 10 * 60 * 1000)) ? phoneRecord.count + 1 : 1;
      phoneCooldownMap.set(normalizedPhone, { lastRequested: now, count: currentCount });

      // Send SMS
      const smsMessage = `Your SEAS emergency system verification code is: ${plainOtp}. Valid for 5 minutes. Do not share this code.`;
      const smsResult = await smsService.sendSms(normalizedPhone, smsMessage);

      logger.info('OTP generated and dispatched', {
        phoneNumber: normalizedPhone,
        smsStatus: smsResult.status,
      });

      if (!smsResult.success && !devOtpAllowed()) {
        logger.error('OTP SMS failed', { phoneNumber: normalizedPhone, error: smsResult.error });
        return res.status(502).json({
          error: 'We could not send the verification code. Please try again shortly.',
          code: 'OTP_SMS_FAILED',
        });
      }

      // Dev convenience only when explicitly enabled and no real SMS provider is configured.
      if (devOtpAllowed() && config.env !== 'test') {
        logger.debug(`[DEV ONLY] OTP for ${normalizedPhone.slice(0, 4)}***${normalizedPhone.slice(-3)}: ${plainOtp}`);
      }

      return res.status(200).json({
        success: true,
        message: 'Verification code sent',
        // Test automation receives the code; browser/development clients never receive it.
        ...(config.env === 'test' ? { devCode: plainOtp } : {}),
      });
    } catch (error: any) {
      logger.error('Error in requestOtp', { error: error.message });
      return res.status(500).json({ error: 'Failed to process OTP request' });
    }
  }

  /**
   * Verify OTP
   * POST /auth/otp/verify
   */
  async verifyOtp(req: Request, res: Response) {
    try {
      const { phoneNumber, code, name } = req.body;
      if (!phoneNumber || !code) {
        return res.status(400).json({ error: 'Phone number and verification code are required' });
      }

      let normalizedPhone: string;
      try {
        normalizedPhone = normalizePhoneNumber(phoneNumber);
      } catch (err: any) {
        return res.status(400).json({ error: err.message });
      }

      // Latest OTP for this phone, in ANY state, so each failure mode can be reported distinctly.
      const otpRequest = await prisma.otpRequest.findFirst({
        where: { phoneNumber: normalizedPhone },
        orderBy: { createdAt: 'desc' },
      });

      if (!otpRequest) {
        return res.status(400).json({ error: 'No verification code was requested for this number', code: 'OTP_NOT_FOUND' });
      }
      if (otpRequest.consumedAt) {
        // Used already, or superseded by a newer request / exhausted attempts.
        return res.status(400).json({
          error: 'This code is no longer valid. Please request a new code.',
          code: 'OTP_CONSUMED',
        });
      }
      if (otpRequest.expiresAt.getTime() <= Date.now()) {
        return res.status(400).json({ error: 'This code has expired. Please request a new code.', code: 'OTP_EXPIRED' });
      }
      const maxAttempts = deliveryConfig.otpMaxAttempts;
      if (otpRequest.attempts >= maxAttempts) {
        // Locked even if this guess would have been correct; a fresh otp/request is required.
        return res.status(429).json({
          error: 'Maximum verification attempts exceeded. Please request a new code.',
          code: 'OTP_MAX_ATTEMPTS',
        });
      }

      const inputHash = hashToken(String(code).trim());
      if (inputHash !== otpRequest.codeHash) {
        // Atomic increment, bounded by the cap: concurrent wrong guesses cannot exceed maxAttempts.
        const { count } = await prisma.otpRequest.updateMany({
          where: { id: otpRequest.id, consumedAt: null, attempts: { lt: maxAttempts } },
          data: { attempts: { increment: 1 } },
        });
        if (count === 0) {
          return res.status(429).json({
            error: 'Maximum verification attempts exceeded. Please request a new code.',
            code: 'OTP_MAX_ATTEMPTS',
          });
        }
        // Generic message: don't reveal how many attempts remain.
        return res.status(400).json({ error: 'Incorrect verification code', code: 'OTP_INCORRECT' });
      }

      // Correct code: single-use, claimed atomically. Also re-checks the cap so a correct
      // guess racing past the limit is still rejected.
      const claimed = await prisma.otpRequest.updateMany({
        where: { id: otpRequest.id, consumedAt: null, attempts: { lt: maxAttempts }, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (claimed.count === 0) {
        return res.status(400).json({ error: 'This code is no longer valid. Please request a new code.', code: 'OTP_CONSUMED' });
      }

      // Upsert User (Role cannot be self-assigned — always defaults to USER)
      let user = await prisma.user.findUnique({
        where: { phoneNumber: normalizedPhone },
      });

      if (!user) {
        user = await prisma.user.create({
          data: {
            phoneNumber: normalizedPhone,
            name: sanitizeDisplayName(name, 40) || `User ${normalizedPhone.slice(-4)}`,
            role: Role.USER, // Enforce USER role
          },
        });
        logger.info('New user registered', { userId: user.id });
      } else if (sanitizeDisplayName(name, 40) && user.name.startsWith('User ')) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { name: sanitizeDisplayName(name, 40) },
        });
      }

      // Generate JWT Access Token
      const accessToken = jwt.sign(
        { id: user.id, role: user.role, phoneNumber: user.phoneNumber, adminMfaVerified: user.role !== Role.ADMIN ? true : false },
        config.jwt.secret,
        { algorithm: 'HS256', expiresIn: config.jwt.accessExpiresIn as any }
      );

      // Generate Refresh Token & Session
      const rawRefreshToken = generateRefreshToken();
      const tokenHash = hashToken(rawRefreshToken);
      const expiresAt = new Date(Date.now() + config.jwt.refreshExpiresDays * 24 * 60 * 60 * 1000);

      await prisma.refreshSession.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
        },
      });

      return res.status(200).json({
        accessToken,
        refreshToken: rawRefreshToken,
        user: {
          id: user.id,
          phoneNumber: user.phoneNumber,
          name: user.name,
          role: user.role,
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
        },
      });
    } catch (error: any) {
      logger.error('Error in verifyOtp', { error: error.message });
      return res.status(500).json({ error: 'Failed to verify OTP' });
    }
  }

  /**
   * Refresh Access Token
   * POST /auth/refresh
   */
  async refresh(req: Request, res: Response) {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) {
        return res.status(400).json({ error: 'Refresh token is required' });
      }

      const tokenHash = hashToken(refreshToken);
      const session = await prisma.refreshSession.findUnique({
        where: { tokenHash },
        include: { user: true },
      });

      if (!session || session.revokedAt !== null || session.expiresAt < new Date()) {
        return res.status(401).json({ error: 'Refresh token is invalid or has expired' });
      }

      // Generate fresh access token
      const accessToken = jwt.sign(
        {
          id: session.user.id,
          role: session.user.role,
          phoneNumber: session.user.phoneNumber,
          adminMfaVerified: session.user.role !== Role.ADMIN
            ? true
            : Boolean(session.adminMfaVerifiedAt),
        },
        config.jwt.secret,
        { algorithm: 'HS256', expiresIn: config.jwt.accessExpiresIn as any }
      );

      return res.status(200).json({ accessToken });
    } catch (error: any) {
      logger.error('Error in refresh', { error: error.message });
      return res.status(500).json({ error: 'Failed to refresh access token' });
    }
  }

  /**
   * Revoke Refresh Token
   * POST /auth/refresh/revoke
   */
  async revokeRefresh(req: Request, res: Response) {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) {
        return res.status(400).json({ error: 'Refresh token is required' });
      }

      const tokenHash = hashToken(refreshToken);
      await prisma.refreshSession.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      return res.status(204).send();
    } catch (error: any) {
      logger.error('Error in revokeRefresh', { error: error.message });
      return res.status(500).json({ error: 'Failed to revoke refresh token' });
    }
  }

  /**
   * Admin: Revoke all refresh tokens for a user
   * POST /auth/refresh/revoke-all
   */
  async revokeAllUserTokens(req: Request, res: Response) {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      await prisma.refreshSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      return res.status(204).send();
    } catch (error: any) {
      logger.error('Error in revokeAllUserTokens', { error: error.message });
      return res.status(500).json({ error: 'Failed to revoke user tokens' });
    }
  }

  /**
   * Admin: Force password reset for a user (on next login)
   * POST /auth/password/reset
   */
  async adminForcePasswordReset(req: Request, res: Response) {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      await prisma.user.update({
        where: { id: userId },
        data: { passwordResetRequired: true },
      });

      return res.status(204).send();
    } catch (error: any) {
      logger.error('Error in adminForcePasswordReset', { error: error.message });
      return res.status(500).json({ error: 'Failed to force password reset' });
    }
  }

  /**
   * Admin: Set or unset admin MFA verification for a user
   * POST /auth/admin-mfa
   */
  async adminSetMfa(req: Request, res: Response) {
    try {
      const { userId, enabled } = req.body;
      if (enabled === undefined || userId === undefined) {
        return res.status(400).json({ error: 'User ID and enabled status are required' });
      }

      await prisma.user.update({
        where: { id: userId },
        data: { adminMfaEnabled: enabled, adminMfaVerifiedAt: enabled ? new Date() : null },
      });

      return res.status(204).send();
    } catch (error: any) {
      logger.error('Error in adminSetMfa', { error: error.message });
      return res.status(500).json({ error: 'Failed to set admin MFA' });
    }
  }

  /**
   * Admin: Get MFA status for a user
   * GET /auth/admin-mfa/:userId
   */
  async adminGetMfaStatus(req: Request, res: Response) {
    try {
      const { userId } = req.params;
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { adminMfaEnabled: true, adminMfaVerifiedAt: true },
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.status(200).json({
        enabled: user.adminMfaEnabled,
        verified: user.adminMfaVerifiedAt !== null,
      });
    } catch (error: any) {
      logger.error('Error in adminGetMfaStatus', { error: error.message });
      return res.status(500).json({ error: 'Failed to get MFA status' });
    }
  }

  /**
   * Admin: Generate a new TOTP secret for a user
   * POST /auth/totp/generate
   */
  async adminGenerateTotp(req: Request, res: Response) {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Generate a new TOTP secret
      const secret = generateTotpSecret();

      // Update the user's TOTP secret
      await prisma.user.update({
        where: { id: userId },
        data: { totpSecret: secret, totpEnabled: true },
      });

      return res.status(200).json({ secret });
    } catch (error: any) {
      logger.error('Error in adminGenerateTotp', { error: error.message });
      return res.status(500).json({ error: 'Failed to generate TOTP secret' });
    }
  }

  /**
   * Admin: Validate a TOTP code for a user
   * POST /auth/totp/validate
   */
  async adminValidateTotp(req: Request, res: Response) {
    try {
      const { userId, code } = req.body;
      if (!userId || !code) {
        return res.status(400).json({ error: 'User ID and TOTP code are required' });
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user || !user.totpSecret) {
        return res.status(404).json({ error: 'User or TOTP secret not found' });
      }

      // Validate the TOTP code
      const isValid = verifyTotp(user.totpSecret, code);

      return res.status(200).json({ valid: isValid });
    } catch (error: any) {
      logger.error('Error in adminValidateTotp', { error: error.message });
      return res.status(500).json({ error: 'Failed to validate TOTP code' });
    }
  }

  /**
   * Admin: Disable TOTP for a user
   * POST /auth/totp/disable
   */
  async adminDisableTotp(req: Request, res: Response) {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      await prisma.user.update({
        where: { id: userId },
        data: { totpEnabled: false, totpSecret: null },
      });

      return res.status(204).send();
    } catch (error: any) {
      logger.error('Error in adminDisableTotp', { error: error.message });
      return res.status(500).json({ error: 'Failed to disable TOTP' });
    }
  }

  /**
   * Export account data
   * POST /auth/data/export
   */
  async exportMyData(req: Request, res: Response) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        include: {
          contacts: true,
          alerts: { include: { deliveries: true } },
          refreshSessions: { select: { id: true, createdAt: true, expiresAt: true, revokedAt: true } },
        },
      });
      if (!user) return res.status(404).json({ error: 'User not found' });
      const exportData = {
        exportedAt: new Date().toISOString(),
        user: {
          id: user.id,
          phoneNumber: user.phoneNumber,
          name: user.name,
          role: user.role,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
        contacts: user.contacts,
        alerts: user.alerts,
        sessions: user.refreshSessions,
      };
      res.setHeader('Content-Disposition', 'attachment; filename="seas-data-export.json"');
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(JSON.stringify(exportData, null, 2));
    } catch (error: any) {
      logger.error('Error exporting account data', { error: error.message, userId: req.user!.id });
      return res.status(500).json({ error: 'Failed to export account data' });
    }
  }

  /**
   * Delete account
   * POST /auth/account/delete
   */
  async deleteMyAccount(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const { confirmation } = req.body ?? {};
      if (confirmation !== 'DELETE') {
        return res.status(400).json({ error: 'Send confirmation "DELETE" to remove the account', code: 'DELETE_CONFIRMATION_REQUIRED' });
      }
      await prisma.user.delete({ where: { id: userId } });
      logger.info('User account deleted', { userId });
      return res.status(200).json({ success: true, message: 'Account and associated data deleted' });
    } catch (error: any) {
      logger.error('Error deleting account', { error: error.message, userId: req.user!.id });
      return res.status(500).json({ error: 'Failed to delete account' });
    }
  }

  /**
   * Setup administrator MFA
   * POST /auth/admin-mfa/setup
   */
  async setupAdminMfa(req: Request, res: Response) {
    try {
      if (req.user!.role !== Role.ADMIN) return res.status(403).json({ error: 'Administrator privileges required' });
      const secret = generateTotpSecret();
      await prisma.user.update({ where: { id: req.user!.id }, data: { adminMfaSecret: secret, adminMfaEnabled: false } });
      return res.status(200).json({ secret, otpauth: `otpauth://totp/SEAS-Admin:${encodeURIComponent(req.user!.phoneNumber)}?secret=${secret}&issuer=SEAS` });
    } catch (error: any) {
      return res.status(500).json({ error: 'Failed to set up administrator MFA' });
    }
  }

  /**
   * Verify administrator MFA
   * POST /auth/admin-mfa/verify
   */
  async verifyAdminMfa(req: Request, res: Response) {
    try {
      if (req.user!.role !== Role.ADMIN) return res.status(403).json({ error: 'Administrator privileges required' });
      const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
      if (!user?.adminMfaSecret) return res.status(400).json({ error: 'MFA setup is required first', code: 'ADMIN_MFA_SETUP_REQUIRED' });
      const code = String(req.body?.code ?? '').replace(/\s/g, '');
      if (!verifyTotp(user.adminMfaSecret, code)) return res.status(401).json({ error: 'Invalid MFA code', code: 'INVALID_MFA_CODE' });
      await prisma.user.update({ where: { id: user.id }, data: { adminMfaEnabled: true } });
      await prisma.refreshSession.updateMany({
        where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { adminMfaVerifiedAt: new Date() },
      });
      const accessToken = jwt.sign(
        { id: user.id, role: user.role, phoneNumber: user.phoneNumber, adminMfaVerified: true },
        config.jwt.secret,
        { algorithm: 'HS256', expiresIn: config.jwt.accessExpiresIn as any }
      );
      return res.status(200).json({ success: true, accessToken });
    } catch (error: any) {
      return res.status(500).json({ error: 'Failed to verify administrator MFA' });
    }
  }

  /**
   * Logout
   * POST /auth/logout
   */
  async logout(req: Request, res: Response) {
    try {
      const { refreshToken } = req.body ?? {};
      if (refreshToken) {
        await prisma.refreshSession.updateMany({
          where: { tokenHash: hashToken(refreshToken), revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      return res.status(200).json({ success: true });
    } catch (error: any) {
      logger.error('Error in logout', { error: error.message });
      return res.status(500).json({ error: 'Failed to log out' });
    }
  }
}

export const authController = new AuthController();
