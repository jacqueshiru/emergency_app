import { Router } from 'express';
import { webhooksController } from './webhooks.controller';

const router = Router();

router.post('/africastalking/delivery', (req, res) => webhooksController.handleDeliveryReport(req, res));

export const webhooksRoutes = router;
