// src/services/nudgeService.ts — BullMQ job lifecycle for NUDGE tier
import { prisma } from '../lib/prisma';
import { nudgeQueue } from '../lib/queue';
import { logger } from '../lib/logger';
import { NUDGE_TIMEOUT_MS } from '@agent-guardian/shared';
import { redis } from '../lib/redis';
import crypto from 'crypto';

export interface CreateNudgeParams {
  userId: string;
  agentId: string;
  service: string;
  actionType: string;
  payload?: Record<string, unknown>;
  displaySummary: string;
}

export async function createNudgeAction(params: CreateNudgeParams) {
  const expiresAt = new Date(Date.now() + NUDGE_TIMEOUT_MS);
  const payloadHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(params.payload ?? {}))
    .digest('hex');

  // Create pending action in DB
  const pendingAction = await prisma.pendingAction.create({
    data: {
      userId: params.userId,
      agentId: params.agentId,
      service: params.service.toUpperCase() as any,
      actionType: params.actionType,
      tier: 'NUDGE',
      status: 'PENDING_APPROVAL',
      payloadHash,
      displaySummary: params.displaySummary,
      expiresAt,
    },
  });

  // Store payload in Redis with 70s TTL (60s veto window + buffer)
  // Await this write so an approval cannot race ahead of payload persistence.
  if (params.payload && Object.keys(params.payload).length > 0) {
    await redis.setex(
      `nudge:payload:${pendingAction.id}`,
      70,
      JSON.stringify(params.payload)
    );
  }

  // Create BullMQ job with delayed processing (waits for approval or expiry)
  const job = await nudgeQueue.add(
    'nudge-timeout',
    {
      pendingActionId: pendingAction.id,
      userId: params.userId,
      service: params.service,
      actionType: params.actionType,
      payload: params.payload,
    },
    {
      jobId: pendingAction.id,
      delay: NUDGE_TIMEOUT_MS, // Job fires after 60s if not resolved
    }
  );

  // Update pending action with BullMQ job ID
  await prisma.pendingAction.update({
    where: { id: pendingAction.id },
    data: { bullJobId: job.id },
  });

  logger.info('Nudge action created', {
    pendingActionId: pendingAction.id,
    userId: params.userId,
    actionType: params.actionType,
    expiresAt: expiresAt.toISOString(),
  });

  return pendingAction;
}

export async function approveNudgeAction(
  jobId: string,
  resolvedByUserId: string,
  resolvedByIp: string,
  resolvedByDevice: string
) {
  const pendingAction = await prisma.pendingAction.findUnique({
    where: { id: jobId },
  });

  if (!pendingAction) {
    throw new Error('Pending action not found');
  }

  if (pendingAction.status !== 'PENDING_APPROVAL') {
    throw new Error(`Action already resolved: ${pendingAction.status}`);
  }

  if (new Date() > pendingAction.expiresAt) {
    await prisma.pendingAction.update({
      where: { id: jobId },
      data: { status: 'EXPIRED', resolvedAt: new Date() },
    });
    throw new Error('Action has expired');
  }

  // Update pending action
  const updated = await prisma.pendingAction.update({
    where: { id: jobId },
    data: {
      status: 'APPROVED',
      resolvedAt: new Date(),
      resolvedByUserId,
      resolvedByIp,
      resolvedByDevice,
    },
  });

  // Remove the timeout job since the action is approved
  const bullJob = await nudgeQueue.getJob(jobId);
  if (bullJob) {
    await bullJob.remove();
  }

  logger.info('Nudge action approved', { jobId, resolvedByUserId });
  return updated;
}

export async function denyNudgeAction(
  jobId: string,
  resolvedByUserId: string,
  resolvedByIp: string,
  resolvedByDevice: string
) {
  const pendingAction = await prisma.pendingAction.findUnique({
    where: { id: jobId },
  });

  if (!pendingAction) {
    throw new Error('Pending action not found');
  }

  if (pendingAction.status !== 'PENDING_APPROVAL') {
    throw new Error(`Action already resolved: ${pendingAction.status}`);
  }

  const updated = await prisma.pendingAction.update({
    where: { id: jobId },
    data: {
      status: 'DENIED',
      resolvedAt: new Date(),
      resolvedByUserId,
      resolvedByIp,
      resolvedByDevice,
    },
  });

  // Remove the timeout job
  const bullJob = await nudgeQueue.getJob(jobId);
  if (bullJob) {
    await bullJob.remove();
  }

  logger.info('Nudge action denied', { jobId, resolvedByUserId });
  return updated;
}

export async function expireNudgeAction(jobId: string) {
  const updated = await prisma.pendingAction.update({
    where: { id: jobId },
    data: {
      status: 'EXPIRED',
      resolvedAt: new Date(),
    },
  });

  logger.info('Nudge action expired', { jobId });
  return updated;
}

export async function getPendingAction(jobId: string) {
  return prisma.pendingAction.findUnique({
    where: { id: jobId },
  });
}

export async function getUserPendingActions(userId: string) {
  return prisma.pendingAction.findMany({
    where: {
      userId,
      status: 'PENDING_APPROVAL',
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });
}
