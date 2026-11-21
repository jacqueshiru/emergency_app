import http from 'http';
import { createApp } from './app';
import { config, assertSecureConfig } from './config';
import { initSocketServer } from './services/socket';
import { startDeliveryWorker, stopDeliveryWorker } from './services/deliveryWorker';
import { startRetentionCleanup, stopRetentionCleanup } from './services/retention';
import { logger } from './utils/logger';

try {
  assertSecureConfig();
} catch (err: any) {
  console.error(err.message);
  process.exit(1);
}

const app = createApp();
const httpServer = http.createServer(app);

// Initialize real-time Socket.io
initSocketServer(httpServer);

httpServer.listen(config.port, () => {
  logger.info(`SEAS Backend running on port ${config.port} [${config.env}]`);
  logger.info(`Health check available at http://localhost:${config.port}/health`);
  // DB-backed delivery queue; first pass also recovers deliveries stranded by a restart.
  startDeliveryWorker();
  startRetentionCleanup();
});

function shutdown() {
  stopDeliveryWorker();
  httpServer.close(() => process.exit(0));
  // Open keep-alive / websocket connections would otherwise keep the process alive forever.
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
