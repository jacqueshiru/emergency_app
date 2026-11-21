import { Request, Response } from 'express';
import { prisma } from '../../prisma';
import { logAdminAction } from '../../middleware/auth';
import { logger } from '../../utils/logger';
import { AlertProcessingStatus, AlertResolutionStatus } from '@seas/shared';

export class AdminController {
  /**
   * GET /admin/alerts
   * Filterable by status, resolutionStatus, date range
   * Logged in AuditLog (without emergency coordinates/text)
   */
  async getAlerts(req: Request, res: Response) {
    try {
      const adminId = req.user!.id;
      const { status, resolutionStatus, from, to } = req.query;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 200);
      const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

      const whereClause: any = {};
      if (status && Object.values(AlertProcessingStatus).includes(status as AlertProcessingStatus)) {
        whereClause.status = status;
      }
      if (resolutionStatus && Object.values(AlertResolutionStatus).includes(resolutionStatus as AlertResolutionStatus)) {
        whereClause.resolutionStatus = resolutionStatus;
      }
      // Invalid dates are ignored (Prisma throws on Invalid Date, which surfaced as a 500).
      const fromDate = from ? new Date(String(from)) : null;
      const toDate = to ? new Date(String(to)) : null;
      const validFrom = fromDate && !isNaN(fromDate.getTime()) ? fromDate : null;
      const validTo = toDate && !isNaN(toDate.getTime()) ? toDate : null;
      if (validFrom || validTo) {
        whereClause.triggeredAt = {};
        if (validFrom) whereClause.triggeredAt.gte = validFrom;
        if (validTo) whereClause.triggeredAt.lte = validTo;
      }

      const alerts = await prisma.alert.findMany({
        where: whereClause,
        include: {
          user: {
            select: { id: true, name: true, phoneNumber: true },
          },
          deliveries: true,
        },
        orderBy: { triggeredAt: 'desc' },
        take: limit,
        skip: offset,
      });

      // Write to AuditLog: non-negotiable constraint #6 & #9
      await logAdminAction(adminId, 'DASHBOARD_ALERTS_VIEWED');

      return res.status(200).json(alerts);
    } catch (error: any) {
      logger.error('Error in admin getAlerts', { error: error.message });
      return res.status(500).json({ error: 'Failed to retrieve admin alerts' });
    }
  }

  /**
   * GET /admin/users
   */
  async getUsers(req: Request, res: Response) {
    try {
      const adminId = req.user!.id;

      const users = await prisma.user.findMany({
        include: {
          _count: {
            select: {
              contacts: true,
              alerts: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });

      await logAdminAction(adminId, 'ADMIN_USERS_VIEWED');

      const sanitizedUsers = users.map((u) => ({
        id: u.id,
        phoneNumber: u.phoneNumber,
        name: u.name,
        role: u.role,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        contactsCount: u._count.contacts,
        alertsCount: u._count.alerts,
      }));

      return res.status(200).json(sanitizedUsers);
    } catch (error: any) {
      logger.error('Error in admin getUsers', { error: error.message });
      return res.status(500).json({ error: 'Failed to retrieve users' });
    }
  }

  /**
   * GET /admin/audit-logs
   */
  async getAuditLogs(req: Request, res: Response) {
    try {
      const logs = await prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      return res.status(200).json(logs);
    } catch (error: any) {
      logger.error('Error in admin getAuditLogs', { error: error.message });
      return res.status(500).json({ error: 'Failed to retrieve audit logs' });
    }
  }
}

export const adminController = new AdminController();
