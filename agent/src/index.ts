// agent/src/index.ts — Demo Agent with OpenRouter
// Simulates an AI agent using Agent Guardian's action pipeline

import { getAgentToken } from './auth/getAgentToken';
import { waitForApproval } from './guardian/waitForApproval';

const GUARDIAN_API = process.env.GUARDIAN_API_URL || 'http://localhost:3001';
const DEMO_GITHUB_OWNER = process.env.DEMO_GITHUB_OWNER || 'Vikk-17';
const DEMO_GITHUB_REPO = process.env.DEMO_GITHUB_REPO || 'Test';
const DEMO_GITHUB_BRANCH = process.env.DEMO_GITHUB_BRANCH || 'test-branch';

interface ActionResult {
  tier: string;
  status: string;
  auditLogId?: string;
  jobId?: string;
  expiresAt?: string;
  challengeUrl?: string;
  error?: string;
  data?: unknown;
}

interface GithubIssueLike {
  number: number;
  title: string;
  html_url?: string;
}

interface GithubBranch {
  name: string;
}

async function submitAction(
  token: string,
  action: { service: string; actionType: string; payload?: any; displaySummary: string }
): Promise<ActionResult> {
  const actingUserEmail = process.env.AGENT_ACTING_USER_EMAIL;
  const actingAuth0UserId = process.env.AGENT_ACTING_AUTH0_USER_ID;
  const resp = await fetch(`${GUARDIAN_API}/api/v1/agent/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(actingUserEmail ? { 'x-agent-user-email': actingUserEmail } : {}),
      ...(actingAuth0UserId ? { 'x-agent-auth0-user-id': actingAuth0UserId } : {}),
    },
    body: JSON.stringify(action),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Action failed (${resp.status}): ${err.message || resp.statusText}`);
  }

  return resp.json();
}

function printActionStatus(label: string, result: ActionResult) {
  console.log(`${label}`);
  console.log(`   → Tier: ${result.tier} | Status: ${result.status}`);
  if (result.error) {
    console.log(`   → Error: ${result.error}`);
  }
}

function ensureExecuted(stepName: string, result: ActionResult) {
  if (result.status !== 'EXECUTED') {
    throw new Error(`${stepName} did not execute successfully`);
  }
}

function printBranchSummary(label: string, data: unknown) {
  const branches = Array.isArray(data) ? (data as GithubBranch[]) : [];
  console.log(`   → ${label}: ${branches.length}`);
  for (const branch of branches.slice(0, 10)) {
    console.log(`     ${branch.name}`);
  }
}

function hasBranch(data: unknown, branchName: string) {
  const branches = Array.isArray(data) ? (data as GithubBranch[]) : [];
  return branches.some((branch) => branch.name === branchName);
}

async function waitForBranchDeletion(token: string, branchName: string, timeoutMs: number = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const branches = await submitAction(token, {
      service: 'github',
      actionType: 'github.read_branches',
      payload: {
        owner: DEMO_GITHUB_OWNER,
        repo: DEMO_GITHUB_REPO,
      },
      displaySummary: `Read branches from ${DEMO_GITHUB_OWNER}/${DEMO_GITHUB_REPO} after step-up verification`,
    });

    if (branches.status === 'EXECUTED' && !hasBranch(branches.data, branchName)) {
      return branches;
      }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return null;
}

async function waitForStepUpResolution(token: string, jobId: string, timeoutMs: number = 5 * 60 * 1000) {
  const result = await waitForApproval(jobId, token, timeoutMs);

  // In the current backend flow, STEP_UP jobs may briefly surface as APPROVED
  // before the downstream delete operation becomes observable. Treat that as
  // a valid continuation state and verify via the actual branch list next.
  if (result.status === 'APPROVED' || result.status === 'STEP_UP_VERIFIED') {
    return result;
  }

  return result;
}

// ─── Demo: "Prep My Week" Task ──────────────────────────
async function runDemoTask() {
  console.log('\n🤖 Agent Guardian Demo Agent');
  console.log('═'.repeat(50));
  console.log(`Repo: ${DEMO_GITHUB_OWNER}/${DEMO_GITHUB_REPO}\n`);

  const token = await getAgentToken();

  if (!process.env.AGENT_ACTING_USER_EMAIL && !process.env.AGENT_ACTING_AUTH0_USER_ID) {
    throw new Error(
      'Set AGENT_ACTING_USER_EMAIL or AGENT_ACTING_AUTH0_USER_ID in agent/.env so the demo agent acts as the same connected dashboard user.'
    );
  }

  const beforeBranches = await submitAction(token, {
    service: 'github',
    actionType: 'github.read_branches',
    payload: {
      owner: DEMO_GITHUB_OWNER,
      repo: DEMO_GITHUB_REPO,
    },
    displaySummary: `Read branches from ${DEMO_GITHUB_OWNER}/${DEMO_GITHUB_REPO} before step-up test`,
  });
  printActionStatus('🌿 Step 1: Read branches before STEP-UP action', beforeBranches);
  ensureExecuted('Step 1', beforeBranches);
  printBranchSummary('Branches before request', beforeBranches.data);

  if (!hasBranch(beforeBranches.data, DEMO_GITHUB_BRANCH)) {
    throw new Error(`Branch '${DEMO_GITHUB_BRANCH}' was not found before deletion test`);
  }

  console.log('');
  console.log(`🔴 Step 2: Request branch deletion (${DEMO_GITHUB_BRANCH})`);

  const deleteBranch = await submitAction(token, {
    service: 'github',
    actionType: 'github.delete_branch',
    payload: {
      owner: DEMO_GITHUB_OWNER,
      repo: DEMO_GITHUB_REPO,
      branch: DEMO_GITHUB_BRANCH,
    },
    displaySummary: `Delete branch ${DEMO_GITHUB_BRANCH} in ${DEMO_GITHUB_OWNER}/${DEMO_GITHUB_REPO}`,
  });
  printActionStatus('🗑️ STEP-UP request submitted', deleteBranch);

  if (deleteBranch.status !== 'AWAITING_MFA' || !deleteBranch.jobId || !deleteBranch.challengeUrl) {
    throw new Error('Expected github.delete_branch to return AWAITING_MFA with a jobId and challengeUrl');
  }

  console.log('   → Complete MFA from the dashboard modal, or open this URL manually:');
  console.log(`   → ${deleteBranch.challengeUrl}`);
  const approval = await waitForStepUpResolution(token, deleteBranch.jobId, 5 * 60 * 1000);
  console.log(`   → Step-up result: ${approval.status}`);

  if (approval.status !== 'APPROVED' && approval.status !== 'STEP_UP_VERIFIED') {
    console.log('\n⚠️ Branch was not deleted.');
    console.log('═'.repeat(50));
    return;
  }

  const afterBranches = await waitForBranchDeletion(token, DEMO_GITHUB_BRANCH);
  if (!afterBranches) {
    throw new Error(`Step-up succeeded but branch '${DEMO_GITHUB_BRANCH}' still appears in the branch list`);
  }

  console.log('');
  printActionStatus('✅ Step 3: Verify branch deletion', afterBranches);
  ensureExecuted('Step 3', afterBranches);
  printBranchSummary('Branches after deletion', afterBranches.data);
  console.log(`   → Deleted branch: ${DEMO_GITHUB_BRANCH}`);

  console.log('\n✅ Demo task complete!');
  console.log('═'.repeat(50));
}

// Run
runDemoTask().catch((err) => {
  console.error('❌ Demo agent error:', err.message);
  process.exit(1);
});
