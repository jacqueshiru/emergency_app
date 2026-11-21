import { Router } from 'express';
import { authController } from './auth.controller';
import { authenticate, otpIpLimiter, otpVerifyLimiter, refreshLimiter } from '../../middleware/auth';

const router = Router();

router.post('/otp/request', otpIpLimiter, (req, res) => authController.requestOtp(req, res));
router.post('/otp/verify', otpVerifyLimiter, (req, res) => authController.verifyOtp(req, res));
router.post('/refresh', refreshLimiter, (req, res) => authController.refresh(req, res));
router.post('/logout', (req, res) => authController.logout(req, res));
router.get('/me/export', authenticate, (req, res) => authController.exportMyData(req, res));
router.delete('/me', authenticate, (req, res) => authController.deleteMyAccount(req, res));
router.post('/admin/mfa/setup', authenticate, (req, res) => authController.setupAdminMfa(req, res));
router.post('/admin/mfa/verify', authenticate, (req, res) => authController.verifyAdminMfa(req, res));

export const authRoutes = router;
