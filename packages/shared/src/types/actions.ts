// ─── Service Types ──────────────────────────────────────
export enum ServiceType {
  GMAIL = 'GMAIL',
  GITHUB = 'GITHUB',
  SLACK = 'SLACK',
  NOTION = 'NOTION',
}

// ─── Action Tiers ───────────────────────────────────────
export enum ActionTier {
  AUTO = 'AUTO',
  NUDGE = 'NUDGE',
  STEP_UP = 'STEP_UP',
}

// ─── Action Intent ──────────────────────────────────────
// Submitted by the agent when requesting an action
export interface ActionIntent {
  service: ServiceType;
  actionType: string;
  payload?: Record<string, unknown>;
  displaySummary: string;
}

// ─── Action Response Statuses ───────────────────────────
export type ActionResponseStatus =
  | 'EXECUTED'
  | 'PENDING_APPROVAL'
  | 'AWAITING_MFA'
  | 'DENIED'
  | 'EXPIRED'
  | 'FAILED';

// ─── Action Response ────────────────────────────────────
export interface ActionResponse {
  tier: ActionTier;
  status: ActionResponseStatus;
  auditLogId?: string;
  jobId?: string;
  expiresAt?: string;
  challengeUrl?: string;
  error?: string;
  data?: unknown;
}

// ─── Nudge Job States ───────────────────────────────────
export type NudgeStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'DENIED'
  | 'EXPIRED'
  | 'EXECUTED'
  | 'FAILED';

// ─── Service Connection Map ─────────────────────────────
export const SERVICE_CONNECTION_MAP: Record<ServiceType, string> = {
  [ServiceType.GMAIL]: 'google-gmail',
  [ServiceType.GITHUB]: 'github',
  [ServiceType.SLACK]: 'slack',
  [ServiceType.NOTION]: 'notion',
};

// ─── Service Display Names ──────────────────────────────
export const SERVICE_DISPLAY_NAMES: Record<ServiceType, string> = {
  [ServiceType.GMAIL]: 'Gmail',
  [ServiceType.GITHUB]: 'GitHub',
  [ServiceType.SLACK]: 'Slack',
  [ServiceType.NOTION]: 'Notion',
};

// ─── Tier Emoji Map ─────────────────────────────────────
export const TIER_EMOJI: Record<ActionTier, string> = {
  [ActionTier.AUTO]: '🟢',
  [ActionTier.NUDGE]: '🟡',
  [ActionTier.STEP_UP]: '🔴',
};
