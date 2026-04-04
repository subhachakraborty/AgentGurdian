// agent/src/index.ts — Demo Agent with OpenRouter
// Simulates an AI agent using Agent Guardian's action pipeline

import { getAgentToken } from './auth/getAgentToken';
import { waitForApproval } from './guardian/waitForApproval';

const GUARDIAN_API = process.env.GUARDIAN_API_URL || 'http://localhost:3001';
const DEMO_GITHUB_OWNER = process.env.DEMO_GITHUB_OWNER || 'subhachakraborty';
const DEMO_GITHUB_REPO = process.env.DEMO_GITHUB_REPO || 'AgentGuardian';

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

function printIssueLikeSummary(label: string, data: unknown) {
  const items = Array.isArray(data) ? (data as GithubIssueLike[]) : [];
  console.log(`   → ${label}: ${items.length}`);

  const preview = items.slice(0, 3);
  for (const item of preview) {
    console.log(`     #${item.number} ${item.title}`);
  }
}

function buildDemoIssue() {
  const timestamp = new Date().toISOString();
  return {
    title: `[Agent Guardian Demo] NUDGE issue ${timestamp}`,
    body: [
      'This issue was requested by the Agent Guardian demo agent.',
      '',
      `Created at: ${timestamp}`,
      `Repo: ${DEMO_GITHUB_OWNER}/${DEMO_GITHUB_REPO}`,
      '',
      'This action should require human approval before execution.',
    ].join('\n'),
  };
}

function findCreatedIssue(data: unknown, title: string) {
  const items = Array.isArray(data) ? (data as GithubIssueLike[]) : [];
  return items.find((item) => item.title === title);
}

async function waitForCreatedIssue(token: string, title: string, timeoutMs: number = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const issues = await submitAction(token, {
      service: 'github',
      actionType: 'github.read_issues',
      payload: {
        owner: DEMO_GITHUB_OWNER,
        repo: DEMO_GITHUB_REPO,
      },
      displaySummary: `Read open issues from ${DEMO_GITHUB_OWNER}/${DEMO_GITHUB_REPO} after nudge approval`,
    });

    if (issues.status === 'EXECUTED') {
      const createdIssue = findCreatedIssue(issues.data, title);
      if (createdIssue) {
        return { issues, createdIssue };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return null;
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

  const beforeIssues = await submitAction(token, {
    service: 'github',
    actionType: 'github.read_issues',
    payload: {
      owner: DEMO_GITHUB_OWNER,
      repo: DEMO_GITHUB_REPO,
    },
    displaySummary: `Read open issues from ${DEMO_GITHUB_OWNER}/${DEMO_GITHUB_REPO} before nudge test`,
  });
  printActionStatus('📋 Step 1: Read open issues before NUDGE action', beforeIssues);
  ensureExecuted('Step 1', beforeIssues);
  printIssueLikeSummary('Open issues before request', beforeIssues.data);

  const demoIssue = buildDemoIssue();
  console.log('');
  console.log('🟡 Step 2: Request issue creation (NUDGE)');
  console.log(`   → Title: ${demoIssue.title}`);

  const createIssue = await submitAction(token, {
    service: 'github',
    actionType: 'github.create_issue',
    payload: {
      owner: DEMO_GITHUB_OWNER,
      repo: DEMO_GITHUB_REPO,
      title: demoIssue.title,
      body: demoIssue.body,
    },
    displaySummary: `Create demo issue in ${DEMO_GITHUB_OWNER}/${DEMO_GITHUB_REPO}`,
  });
  printActionStatus('📝 NUDGE request submitted', createIssue);

  if (createIssue.status !== 'PENDING_APPROVAL' || !createIssue.jobId) {
    throw new Error('Expected github.create_issue to return PENDING_APPROVAL with a jobId');
  }

  console.log(`   → Approve this action from the dashboard within 60 seconds (job: ${createIssue.jobId})`);
  const approval = await waitForApproval(createIssue.jobId, token);
  console.log(`   → Approval result: ${approval.status}`);

  if (approval.status !== 'APPROVED') {
    console.log('\n⚠️ Issue was not created.');
    console.log('═'.repeat(50));
    return;
  }

  const verification = await waitForCreatedIssue(token, demoIssue.title);
  if (!verification) {
    throw new Error('Approval succeeded but the demo issue was not found after waiting for GitHub to reflect the change');
  }

  const { issues: afterIssues, createdIssue } = verification;
  console.log('');
  printActionStatus('✅ Step 3: Verify created issue', afterIssues);
  ensureExecuted('Step 3', afterIssues);

  console.log(`   → Created issue: #${createdIssue.number} ${createdIssue.title}`);
  if (createdIssue.html_url) {
    console.log(`   → URL: ${createdIssue.html_url}`);
  }

  console.log('\n✅ Demo task complete!');
  console.log('═'.repeat(50));
}

// Run
runDemoTask().catch((err) => {
  console.error('❌ Demo agent error:', err.message);
  process.exit(1);
});
