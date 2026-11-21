import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { authRoutes } from './modules/auth/auth.routes';
import { contactsRoutes } from './modules/contacts/contacts.routes';
import { alertsRoutes } from './modules/alerts/alerts.routes';
import { adminRoutes } from './modules/admin/admin.routes';
import { webhooksRoutes } from './modules/webhooks/webhooks.routes';
import { logger } from './utils/logger';
import { corsOriginOption } from './config';
import { globalLimiter } from './middleware/auth';

export function createApp() {
  const app = express();

  // Security middlewares
  // Behind a reverse proxy (Render, Nginx, ...) set TRUST_PROXY=1 so rate limits see real client IPs.
  if (process.env.TRUST_PROXY) app.set('trust proxy', parseInt(process.env.TRUST_PROXY, 10) || 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: corsOriginOption(), credentials: true }));
  app.use(globalLimiter);

  // Parsers (support JSON and form-urlencoded for SMS webhooks); small bodies only
  app.use(express.json({ limit: '20kb' }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));

  // Request redaction logging middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug(`${req.method} ${req.path}`, {
      query: req.query,
      body: req.body,
    });
    next();
  });

  // Health check endpoint
  const healthHandler = (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'seas-backend',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  };

  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  // Mount routes on both root and /api for seamless proxying
  app.use('/auth', authRoutes);
  app.use('/api/auth', authRoutes);

  app.use('/contacts', contactsRoutes);
  app.use('/api/contacts', contactsRoutes);

  app.use('/alerts', alertsRoutes);
  app.use('/api/alerts', alertsRoutes);

  app.use('/admin', adminRoutes);
  app.use('/api/admin', adminRoutes);

  app.use('/webhooks', webhooksRoutes);
  app.use('/api/webhooks', webhooksRoutes);

  // 404 Handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
  });

  // Global Error Handler
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled server error', { error: err.message, stack: err.stack });
    res.status(err.status || 500).json({
      error: 'An internal server error occurred',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  });

  return app;
}
