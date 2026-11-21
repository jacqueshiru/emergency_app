import { Router } from 'express';
import { adminController } from './admin.controller';
import { authenticate, requireAdmin, requireAdminMfa } from '../../middleware/auth';

const router = Router();

router.use(authenticate);
router.use(requireAdmin);
router.use(requireAdminMfa);

router.get('/alerts', (req, res) => adminController.getAlerts(req, res));
router.get('/users', (req, res) => adminController.getUsers(req, res));
router.get('/audit-logs', (req, res) => adminController.getAuditLogs(req, res));

export const adminRoutes = router;
