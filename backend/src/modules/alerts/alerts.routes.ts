import { Router } from 'express';
import { alertsController } from './alerts.controller';
import { authenticate, alertCreateLimiter } from '../../middleware/auth';

const router = Router();

router.use(authenticate);

router.post('/', alertCreateLimiter, (req, res) => alertsController.createAlert(req, res));
router.get('/', (req, res) => alertsController.getMyAlerts(req, res));
router.get('/:id', (req, res) => alertsController.getAlertById(req, res));
router.post('/:id/device-reports', (req, res) => alertsController.reportDeviceDeliveries(req, res));
router.patch('/:id/resolve', (req, res) => alertsController.resolveAlert(req, res));
router.patch('/:id/cancel', (req, res) => alertsController.cancelAlert(req, res));

export const alertsRoutes = router;
