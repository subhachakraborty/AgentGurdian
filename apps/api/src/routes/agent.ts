// src/routes/agent.ts — Agent Action Routes (Section 6.4)
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireAgentAuth, getActingUserId, getAgentId } from '../middleware/agentAuth';
import { requireStepUp } from '../middleware/stepUpAuth';
import { agentActionLimiter } from '../middleware/rateLimit';
import { orchestrateAction, executeApprovedAction } from '../services/orchestrator';
import { approveNudgeAction, denyNudgeAction, getPendingAction, getUserPendingActions } from '../services/nudgeService';
import { createAuditLog } from '../services/auditService';
import { emitNudgeResolved, emitActivityUpdate } from '../services/notificationService';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { z } from 'zod';

const router = Router();

// ─── Zod Schemas (Section 11.4) ─────────────────────────
const actionIntentSchema = z.object({
  service: z.enum(['gmail', 'github', 'slack', 'notion']),
  actionType: z.string().min(1).max(100).regex(/^[a-z_.]+$/),
  payload: z.record(z.unknown()).optional(),
  displaySummary: z.string().min(1).max(500),
});

// POST /api/v1/agent/action — Primary action endpoint
function requireAgentOrDashboard(req: Request, res: Response, next: import('express').NextFunction) {
  const payload = (req as any).auth?.payload;
  const scopes = ((payload?.scope as string) ?? '').split(' ');
  
  if (scopes.includes('agent:act')) {
    // M2M agent token path - use requireAgentAuth
    return requireAgentAuth(req, res, next);
  }
  
  // Human dashboard path - set acting user ID from sub claim
  (req as any).actingUserId = payload?.sub;
  (req as any).agentId = 'dashboard';
  next();
}

router.post(
  '/action',
  requireAuth,
  requireAgentOrDashboard,
  agentActionLimiter,
  async (req: Request, res: Response) => {
    try {
      // Validate request body
      const result = actionIntentSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Invalid request', details: result.error.issues });
      }

      // Get user identity — supports both human and agent tokens
      const userId = getActingUserId(req);
      const agentId = getAgentId(req) || 'dashboard';

      if (!userId) {
        return res.status(401).json({ error: 'No user identity' });
      }

      // Find internal user
      const user = await prisma.user.findUnique({ where: { auth0UserId: userId } });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const { service, actionType, payload, displaySummary } = result.data;

      // Orchestrate the action
      const orchestrationResult = await orchestrateAction({
        userId: user.id,
        agentId,
        service,
        actionType,
        payload,
        displaySummary,
      });

      // Return appropriate HTTP status
      if (orchestrationResult.status === 'PENDING_APPROVAL' || orchestrationResult.status === 'AWAITING_MFA') {
        return res.status(202).json(orchestrationResult);
      }

      res.json(orchestrationResult);
    } catch (err: any) {
      logger.error('Agent action error', { error: err.message });
      res.status(500).json({ error: 'internal_error', message: err.message });
    }
  }
);

// GET /api/v1/agent/pending — List current pending nudge actions for dashboard user
router.get('/pending', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth0UserId = (req as any).auth?.payload?.sub as string | undefined;
    if (!auth0UserId) {
      return res.status(401).json({ error: 'No user identity' });
    }

    const user = await prisma.user.findUnique({ where: { auth0UserId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const pendingActions = await getUserPendingActions(user.id);
    res.json(pendingActions);
  } catch (err: any) {
    logger.error('Pending actions fetch error', { error: err.message });
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// GET /api/v1/agent/action/:jobId/status — Poll action status
router.get('/action/:jobId/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const pending = await getPendingAction(jobId);

    if (!pending) {
      return res.status(404).json({ error: 'not_found', message: 'Action not found' });
    }

    // Check if expired
    if (pending.status === 'PENDING_APPROVAL' && new Date() > pending.expiresAt) {
      await prisma.pendingAction.update({
        where: { id: jobId },
        data: { status: 'EXPIRED', resolvedAt: new Date() },
      });
      return res.json({ status: 'EXPIRED', jobId });
    }

    res.json({
      status: pending.status,
      jobId: pending.id,
      expiresAt: pending.expiresAt.toISOString(),
      resolvedAt: pending.resolvedAt?.toISOString(),
      resolvedByUserId: pending.resolvedByUserId,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// POST /api/v1/agent/action/:jobId/approve — Approve NUDGE action
router.post('/action/:jobId/approve', requireAuth, async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const resolvingUserId = (req as any).auth?.payload?.sub as string;
    const resolvingIp = req.ip ?? (req.socket?.remoteAddress) ?? 'unknown';
    const resolvingDevice = req.headers['user-agent'] ?? 'unknown';

    // Approve the pending action
    const updated = await approveNudgeAction(jobId, resolvingUserId, resolvingIp, resolvingDevice);

    // Execute the approved action
    const execResult = await executeApprovedAction(
      jobId,
      resolvingUserId,
      resolvingIp,
      false
    );

    // Emit resolution to dashboard
    emitNudgeResolved(updated.userId, jobId, 'APPROVED', resolvingUserId);

    res.json({ status: 'APPROVED', jobId, execution: execResult });
  } catch (err: any) {
    logger.error('Approve action error', { error: err.message, jobId: req.params.jobId });
    res.status(400).json({ error: 'approve_failed', message: err.message });
  }
});

// POST /api/v1/agent/action/:jobId/deny — Deny NUDGE action
router.post('/action/:jobId/deny', requireAuth, async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const resolvingUserId = (req as any).auth?.payload?.sub as string;
    const resolvingIp = req.ip ?? (req.socket?.remoteAddress) ?? 'unknown';
    const resolvingDevice = req.headers['user-agent'] ?? 'unknown';

    const updated = await denyNudgeAction(jobId, resolvingUserId, resolvingIp, resolvingDevice);

    // Create audit log for denial
    await createAuditLog({
      userId: updated.userId,
      agentId: updated.agentId,
      service: updated.service,
      actionType: updated.actionType,
      tier: updated.tier,
      status: 'DENIED',
      payloadHash: updated.payloadHash,
      approvedByUserId: resolvingUserId,
      approvedByIp: resolvingIp,
    });

    emitNudgeResolved(updated.userId, jobId, 'DENIED', resolvingUserId);

    res.json({ status: 'DENIED', jobId });
  } catch (err: any) {
    logger.error('Deny action error', { error: err.message, jobId: req.params.jobId });
    res.status(400).json({ error: 'deny_failed', message: err.message });
  }
});

// POST /api/v1/agent/action/:jobId/step-up — Execute after MFA verification
router.post(
  '/action/:jobId/step-up',
  requireAuth,
  requireStepUp,
  async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;
      const resolvingUserId = (req as any).auth?.payload?.sub as string;
      const resolvingIp = req.ip ?? (req.socket?.remoteAddress) ?? 'unknown';

      // Update pending action
      await prisma.pendingAction.update({
        where: { id: jobId },
        data: {
          status: 'APPROVED',
          resolvedAt: new Date(),
          resolvedByUserId: resolvingUserId,
          resolvedByIp: resolvingIp,
          stepUpVerified: true,
        },
      });

      // Execute with step-up verification
      const execResult = await executeApprovedAction(
        jobId,
        resolvingUserId,
        resolvingIp,
        true // stepUpVerified
      );

      res.json({ status: 'STEP_UP_VERIFIED', jobId, execution: execResult });
    } catch (err: any) {
      logger.error('Step-up action error', { error: err.message, jobId: req.params.jobId });
      res.status(400).json({ error: 'step_up_failed', message: err.message });
    }
  }
);

export default router;
