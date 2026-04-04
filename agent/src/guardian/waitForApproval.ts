// agent/src/guardian/waitForApproval.ts
// Polling protocol with exponential backoff (Section 16.6)

const GUARDIAN_API = process.env.GUARDIAN_API_URL || 'http://localhost:3001';

type ApprovalStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'DENIED'
  | 'EXPIRED'
  | 'EXECUTED';

interface PollResult {
  status: ApprovalStatus;
  auditLogId?: string;
  error?: string;
}

export async function waitForApproval(
  jobId: string,
  agentToken: string,
  timeoutMs: number = 70_000,
  intervalMs: number = 3_000
): Promise<PollResult> {
  const deadline = Date.now() + timeoutMs;
  let backoff = intervalMs;

  while (Date.now() < deadline) {
    await sleep(backoff);

    const resp = await fetch(
      `${GUARDIAN_API}/api/v1/agent/action/${jobId}/status`,
      { headers: { Authorization: `Bearer ${agentToken}` } }
    );

    if (!resp.ok) {
      throw new Error(`Status poll failed: ${resp.status}`);
    }

    const data: PollResult = await resp.json();

    if (data.status !== 'PENDING_APPROVAL') {
      return data; // Terminal state — stop polling
    }

    // Exponential backoff: 3s → 5s → 8s → cap at 10s
    backoff = Math.min(backoff * 1.5, 10_000);
  }

  return { status: 'EXPIRED', error: 'Client-side timeout exceeded' };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
