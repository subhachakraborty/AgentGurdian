// src/services/auditService.ts — Immutable Audit Log writes
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export interface CreateAuditLogParams {
  userId: string;
  agentId?: string;
  connectionId?: string;
  service: string;
  actionType: string;
  tier: string;
  status: string;
  payloadHash?: string;
  metadata?: any;
  approvedByUserId?: string;
  approvedByIp?: string;
  stepUpVerified?: boolean;
}

export async function createAuditLog(params: CreateAuditLogParams) {
  try {
    const auditLog = await prisma.auditLog.create({
      data: {
        userId: params.userId,
        agentId: params.agentId,
        connectionId: params.connectionId,
        service: params.service as any,
        actionType: params.actionType,
        tier: params.tier as any,
        status: params.status as any,
        payloadHash: params.payloadHash,
        metadata: params.metadata ?? undefined,
        approvedByUserId: params.approvedByUserId,
        approvedByIp: params.approvedByIp,
        stepUpVerified: params.stepUpVerified ?? false,
      },
    });

    logger.info('Audit log created', {
      auditLogId: auditLog.id,
      service: params.service,
      actionType: params.actionType,
      tier: params.tier,
      status: params.status,
    });

    return auditLog;
  } catch (err: any) {
    logger.error('Failed to create audit log', { error: err.message, params });
    throw err;
  }
}

export async function getAuditLogs(
  userId: string,
  filters: {
    service?: string;
    tier?: string;
    status?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }
) {
  const where: any = { userId };

  if (filters.service) where.service = filters.service.toUpperCase();
  if (filters.tier) where.tier = filters.tier.toUpperCase();
  if (filters.status) where.status = filters.status.toUpperCase();
  if (filters.from || filters.to) {
    where.executedAt = {};
    if (filters.from) where.executedAt.gte = filters.from;
    if (filters.to) where.executedAt.lte = filters.to;
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { executedAt: 'desc' },
      take: filters.limit ?? 50,
      skip: filters.offset ?? 0,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { logs, total };
}

export async function getAuditStats(userId: string) {
  const [totalActions, byTier, byService, byStatus, last7Days] = await Promise.all([
    prisma.auditLog.count({ where: { userId } }),
    prisma.auditLog.groupBy({
      by: ['tier'],
      where: { userId },
      _count: true,
    }),
    prisma.auditLog.groupBy({
      by: ['service'],
      where: { userId },
      _count: true,
    }),
    prisma.auditLog.groupBy({
      by: ['status'],
      where: { userId },
      _count: true,
    }),
    prisma.$queryRaw`
      SELECT DATE("executedAt") as date, COUNT(*)::int as count
      FROM "AuditLog"
      WHERE "userId" = ${userId}
        AND "executedAt" >= NOW() - INTERVAL '7 days'
      GROUP BY DATE("executedAt")
      ORDER BY date ASC
    ` as Promise<{ date: Date; count: number }[]>,
  ]);

  return {
    totalActions,
    byTier: Object.fromEntries(byTier.map((b: any) => [b.tier, b._count])),
    byService: Object.fromEntries(byService.map((b: any) => [b.service, b._count])),
    byStatus: Object.fromEntries(byStatus.map((b: any) => [b.status, b._count])),
    last7DaysTrend: (last7Days || []).map((d: any) => ({
      date: d.date?.toISOString?.() ?? d.date,
      count: d.count,
    })),
  };
}
