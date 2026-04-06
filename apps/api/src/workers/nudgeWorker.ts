import { Worker, Job } from 'bullmq';
import { redis } from '../lib/redis';
import { prisma } from '../lib/prisma';
import { createAuditLog } from '../services/auditService';
import { emitNudgeExpired } from '../services/notificationService';
import { logger } from '../lib/logger';

export function startNudgeWorker() {
  const worker = new Worker(
    'nudge-actions',
    async (job: Job) => {
      const { pendingActionId, userId } = job.data;

      logger.info('Nudge timeout fired', { pendingActionId });

      // Check if already resolved
      const pending = await prisma.pendingAction.findUnique({
        where: { id: pendingActionId },
      });

      if (!pending) {
        logger.warn('Pending action not found during timeout', { pendingActionId });
        return;
      }

      // Only expire if still pending
      if (pending.status === 'PENDING_APPROVAL') {
        await prisma.pendingAction.update({
          where: { id: pendingActionId },
          data: {
            status: 'EXPIRED',
            resolvedAt: new Date(),
          },
        });

        // Create audit log for expiry
        await createAuditLog({
          userId: pending.userId,
          agentId: pending.agentId,
          service: pending.service,
          actionType: pending.actionType,
          tier: pending.tier,
          status: 'EXPIRED',
          payloadHash: pending.payloadHash,
        });

        // Clean up Redis payload to prevent memory leak
        await redis.del(`nudge:payload:${pendingActionId}`);

        // Notify via Socket.io
        emitNudgeExpired(userId, pendingActionId);

        logger.info('Nudge action expired', { pendingActionId, userId });
      }
    },
    {
      connection: redis,
      concurrency: 5,
    }
  );

  worker.on('completed', (job) => {
    logger.debug('Nudge worker job completed', { jobId: job.id });
  });

  worker.on('failed', (job, err) => {
    logger.error('Nudge worker job failed', { jobId: job?.id, error: err.message });
  });

  logger.info('Nudge worker started');
  return worker;
}
