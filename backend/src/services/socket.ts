import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config, corsOriginOption } from '../config';
import { logger } from '../utils/logger';
import { Role } from '@seas/shared';

let io: SocketIOServer | null = null;

export function initSocketServer(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: corsOriginOption(),
      methods: ['GET', 'POST'],
    },
  });

  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
    if (!token) {
      // Allow unauthenticated connection but without joining admin rooms
      return next();
    }

    try {
      const decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }) as { id: string; role: Role; phoneNumber: string };
      socket.data.user = decoded;
      if (decoded.role === Role.ADMIN) {
        socket.join('admin-room');
        logger.info('Admin socket joined admin-room', { userId: decoded.id });
      }
      socket.join(`user:${decoded.id}`);
      return next();
    } catch {
      // Invalid token, proceed as guest
      return next();
    }
  });

  io.on('connection', (socket: Socket) => {
    logger.debug('Socket connected', { socketId: socket.id });

    socket.on('join:admin', () => {
      if (socket.data.user?.role === Role.ADMIN) {
        socket.join('admin-room');
      }
    });

    socket.on('disconnect', () => {
      logger.debug('Socket disconnected', { socketId: socket.id });
    });
  });

  return io;
}

export function getSocketIO(): SocketIOServer | null {
  return io;
}

export function emitNewAlert(alert: any) {
  if (!io) return;
  // Broadcast to admin room
  io.to('admin-room').emit('alert:new', alert);
  // Also broadcast to the alerting user's room
  if (alert.userId) {
    io.to(`user:${alert.userId}`).emit('alert:updated', alert);
  }
}

export function emitDeliveryUpdated(delivery: any, alertId: string, userId?: string) {
  if (!io) return;
  io.to('admin-room').emit('alert:delivery-updated', { alertId, delivery });
  if (userId) {
    io.to(`user:${userId}`).emit('alert:delivery-updated', { alertId, delivery });
  }
}

export function emitResolutionUpdated(alert: any) {
  if (!io) return;
  io.to('admin-room').emit('alert:resolution-updated', alert);
  if (alert.userId) {
    io.to(`user:${alert.userId}`).emit('alert:resolution-updated', alert);
  }
}
