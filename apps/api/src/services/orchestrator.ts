// src/services/orchestrator.ts — Core tier routing logic (Section 3.2.3)
import { classifyTier } from './tierClassifier';
import { createAuditLog } from './auditService';
import { createNudgeAction } from './nudgeService';
import { getServiceToken, ServiceNotConnectedError, TokenExpiredError } from './tokenVault';
import { notifyUser, emitActivityUpdate, emitStepUpRequired } from './notificationService';
import { executeServiceAction } from './executors';
import { ActionTier } from '@agent-guardian/shared';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import crypto from 'crypto';
import { env } from '../config/env';

export interface OrchestrateActionParams {
  userId: string;
  agentId: string;
  service: string;
  actionType: string;
  payload?: Record<string, unknown>;
  displaySummary: string;
}

export interface OrchestrateResult {
  tier: string;
  status: string;
  auditLogId?: string;
  jobId?: string;
  expiresAt?: string;
  challengeUrl?: string;
  error?: string;
  data?: unknown;
}

export async function orchestrateAction(
  params: OrchestrateActionParams
): Promise<OrchestrateResult> {
  const { userId, agentId, service, actionType, payload, displaySummary } = params;

  // 1. Classify the action tier
  const tier = await classifyTier(userId, service, actionType);

  logger.info('Action classified', {
    userId, service, actionType, tier,
  });

  const payloadHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload ?? {}))
    .digest('hex');

  // 2. Route based on tier
  switch (tier) {
    case ActionTier.AUTO:
      return handleAutoTier(params, payloadHash);

    case ActionTier.NUDGE:
      return handleNudgeTier(params, payloadHash);

    case ActionTier.STEP_UP:
      return handleStepUpTier(params, payloadHash);

    default:
      return {
        tier: 'STEP_UP',
        status: 'FAILED',
        error: `Unknown tier: ${tier}`,
      };
  }
}

// ─── AUTO Tier — Silent Execution ───────────────────────
async function handleAutoTier(
  params: OrchestrateActionParams,
  payloadHash: string
): Promise<OrchestrateResult> {
  const { userId, agentId, service, actionType, payload } = params;

  try {
    // Fetch token from Token Vault
    const token = await getServiceToken(userId, service as any);

    // Execute the action
    const result = await executeServiceAction(
      service as any,
      actionType,
      token,
      payload
    );

    // Write audit log
    const auditLog = await createAuditLog({
      userId,
      agentId,
      service: service.toUpperCase(),
      actionType,
      tier: 'AUTO',
      status: 'EXECUTED',
      payloadHash,
      metadata: result?.metadata,
    });

    // Emit to activity feed
    emitActivityUpdate(userId, auditLog);

    return {
      tier: 'AUTO',
      status: 'EXECUTED',
      auditLogId: auditLog.id,
      data: result?.data,
    };
  } catch (err: any) {
    if (err instanceof ServiceNotConnectedError || err instanceof TokenExpiredError) {
      const auditLog = await createAuditLog({
        userId, agentId,
        service: service.toUpperCase(),
        actionType, tier: 'AUTO',
        status: 'FAILED',
        payloadHash,
        metadata: { error: err.message },
      });
      return { tier: 'AUTO', status: 'FAILED', error: err.message, auditLogId: auditLog.id };
    }
    throw err;
  }
}

// ─── NUDGE Tier — Async Approval ────────────────────────
async function handleNudgeTier(
  params: OrchestrateActionParams,
  payloadHash: string
): Promise<OrchestrateResult> {
  const { userId, agentId, service, actionType, payload, displaySummary } = params;

  // Create pending action + BullMQ job
  const pendingAction = await createNudgeAction({
    userId,
    agentId,
    service,
    actionType,
    payload,
    displaySummary,
  });

  // Notify user via all channels
  await notifyUser({
    userId,
    pendingAction: {
      ...pendingAction,
      service,
      actionType,
      tier: 'NUDGE',
    },
  });

  // Create audit log entry for the pending action
  await createAuditLog({
    userId, agentId,
    service: service.toUpperCase(),
    actionType, tier: 'NUDGE',
    status: 'PENDING', // Will be updated when resolved
    payloadHash,
    metadata: { displaySummary },
  });

  return {
    tier: 'NUDGE',
    status: 'PENDING_APPROVAL',
    jobId: pendingAction.id,
    expiresAt: pendingAction.expiresAt.toISOString(),
  };
}

// ─── STEP-UP Tier — MFA Gate ────────────────────────────
async function handleStepUpTier(
  params: OrchestrateActionParams,
  payloadHash: string
): Promise<OrchestrateResult> {
  const { userId, agentId, service, actionType, payload, displaySummary } = params;

  // Create pending action for step-up
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minute window
  const pendingAction = await prisma.pendingAction.create({
    data: {
      userId,
      agentId,
      service: service.toUpperCase() as any,
      actionType,
      tier: 'STEP_UP',
      status: 'PENDING_APPROVAL',
      payloadHash,
      displaySummary,
      expiresAt,
    },
  });

  // Persist payload to Redis so executeApprovedAction can retrieve it after MFA.
  // Use the same key scheme and a TTL that covers the 5-minute MFA window + buffer.
  if (payload && Object.keys(payload).length > 0) {
    await redis.setex(
      `nudge:payload:${pendingAction.id}`,
      360, // 6 minutes — covers the 5-min MFA window with a safety buffer
      JSON.stringify(payload)
    );
  }

  // Generate challenge URL
  const challengeUrl = `https://${env.AUTH0_DOMAIN}/authorize?` +
    `client_id=${encodeURIComponent(env.AUTH0_CLIENT_ID)}&` +
    `audience=${encodeURIComponent(env.AUTH0_AUDIENCE)}&` +
    `scope=openid&` +
    `acr_values=${encodeURIComponent('http://schemas.openid.net/pape/policies/2007/06/multi-factor')}&` +
    `response_type=code&` +
    `redirect_uri=${encodeURIComponent(env.FRONTEND_URL + '/callback')}&` +
    `state=${encodeURIComponent(JSON.stringify({ stepUp: true, jobId: pendingAction.id }))}`;

  // Emit step-up required event
  emitStepUpRequired(userId, pendingAction.id, challengeUrl);

  return {
    tier: 'STEP_UP',
    status: 'AWAITING_MFA',
    jobId: pendingAction.id,
    challengeUrl,
  };
}

// ─── Execute Approved Action (called after approval) ────
export async function executeApprovedAction(
  pendingActionId: string,
  approvedByUserId?: string,
  approvedByIp?: string,
  stepUpVerified?: boolean
): Promise<OrchestrateResult> {
  const pending = await prisma.pendingAction.findUnique({
    where: { id: pendingActionId },
  });

  if (!pending) {
    throw new Error('Pending action not found');
  }

  try {
    // Fetch token from Token Vault
    const service = pending.service.toLowerCase() as any;
    const token = await getServiceToken(pending.userId, service);

    // Retrieve payload from Redis
    const rawPayload = await redis.get(`nudge:payload:${pendingActionId}`);
    const reconstructedPayload = rawPayload ? JSON.parse(rawPayload) : {};

    // Clean up Redis key after retrieval
    await redis.del(`nudge:payload:${pendingActionId}`);

    // Execute the action with actual payload
    const result = await executeServiceAction(
      service,
      pending.actionType,
      token,
      reconstructedPayload
    );

    // Create audit log
    const auditLog = await createAuditLog({
      userId: pending.userId,
      agentId: pending.agentId,
      service: pending.service,
      actionType: pending.actionType,
      tier: pending.tier,
      status: stepUpVerified ? 'STEP_UP_VERIFIED' : 'EXECUTED',
      payloadHash: pending.payloadHash,
      approvedByUserId,
      approvedByIp,
      stepUpVerified: stepUpVerified ?? false,
    });

    // Emit update
    emitActivityUpdate(pending.userId, auditLog);

    return {
      tier: pending.tier,
      status: 'EXECUTED',
      auditLogId: auditLog.id,
    };
  } catch (err: any) {
    const auditLog = await createAuditLog({
      userId: pending.userId,
      agentId: pending.agentId,
      service: pending.service,
      actionType: pending.actionType,
      tier: pending.tier,
      status: 'FAILED',
      payloadHash: pending.payloadHash,
      metadata: { error: err.message },
      approvedByUserId,
      stepUpVerified: stepUpVerified ?? false,
    });

    return {
      tier: pending.tier,
      status: 'FAILED',
      error: err.message,
      auditLogId: auditLog.id,
    };
  }
}
