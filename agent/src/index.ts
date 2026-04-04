// agent/src/index.ts — Demo Agent with OpenRouter
// Simulates an AI agent using Agent Guardian's action pipeline

import { getAgentToken } from './auth/getAgentToken';
import { waitForApproval } from './guardian/waitForApproval';

const GUARDIAN_API = 'http://localhost:3001';

interface ActionResult {
  tier: string;
  status: string;
  auditLogId?: string;
  jobId?: string;
  expiresAt?: string;
  challengeUrl?: string;
  error?: string;
}

async function submitAction(
  token: string,
  action: { service: string; actionType: string; payload?: any; displaySummary: string }
): Promise<ActionResult> {
  const resp = await fetch(`${GUARDIAN_API}/api/v1/agent/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(action),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Action failed (${resp.status}): ${err.message || resp.statusText}`);
  }

  return resp.json();
}

// ─── Demo: "Prep My Week" Task ──────────────────────────
async function runDemoTask() {
  // console.log('\n🤖 Agent Guardian Demo Agent');
  // console.log('═'.repeat(50));
  // console.log('Task: "Prep my week — read my emails and tasks, summarize, and send to my team."\n');

  const token = await getAgentToken();

  // // Step 1: Read emails (AUTO — should execute silently)
  // console.log('📧 Step 1: Reading emails...');
  // const readEmails = await submitAction(token, {
  //   service: 'gmail',
  //   actionType: 'gmail.read_emails',
  //   payload: { maxResults: 5 },
  //   displaySummary: 'Read recent 5 emails for weekly summary',
  // });
  // console.log(`   → Tier: ${readEmails.tier} | Status: ${readEmails.status}`);

  // // Step 2: Read Notion tasks (AUTO)
  // console.log('\n📝 Step 2: Reading Notion tasks...');
  // const readTasks = await submitAction(token, {
  //   service: 'notion',
  //   actionType: 'notion.read_pages',
  //   payload: { pageSize: 10 },
  //   displaySummary: 'Read task list from Notion',
  // });
  // console.log(`   → Tier: ${readTasks.tier} | Status: ${readTasks.status}`);

  // // Step 3: Post to Slack (NUDGE — will require approval)
  // console.log('\n💬 Step 3: Posting summary to Slack...');
  // const slackPost = await submitAction(token, {
  //   service: 'slack',
  //   actionType: 'slack.post_to_channel',
  //   payload: { channel: '#team-updates', text: 'Weekly summary: ...' },
  //   displaySummary: 'Post weekly summary to #team-updates on Slack',
  // });
  // console.log(`   → Tier: ${slackPost.tier} | Status: ${slackPost.status}`);

  // if (slackPost.status === 'PENDING_APPROVAL' && slackPost.jobId) {
  //   console.log(`   ⏳ Waiting for human approval (job: ${slackPost.jobId})...`);
  //   const resolved = await waitForApproval(slackPost.jobId, token);
  //   console.log(`   → Resolved: ${resolved.status}`);
  //   if (resolved.status === 'DENIED' || resolved.status === 'EXPIRED') {
  //     console.log('   ⛔ Slack post was denied/expired — skipping.');
  //   }
  // }

  // Step 4: Close GitHub issue (STEP-UP — will require MFA)
  // console.log('\n🔒 Step 4: Closing weekly review GitHub issue...');
  // const closeIssue = await submitAction(token, {
  //   service: 'github',
  //   actionType: 'github.close_issue',
  //   payload: { owner: 'my-org', repo: 'tasks', issueNumber: 42 },
  //   displaySummary: 'Close "Weekly Review" issue #42 on GitHub',
  // });
  // console.log(`   → Tier: ${closeIssue.tier} | Status: ${closeIssue.status}`);

  // if (closeIssue.status === 'AWAITING_MFA' && closeIssue.jobId) {
  //   console.log(`   🔐 Waiting for MFA verification (job: ${closeIssue.jobId})...`);
  //   const resolved = await waitForApproval(closeIssue.jobId, token);
  //   console.log(`   → Resolved: ${resolved.status}`);
  // }



  console.log('\n🔒 Step 4: Closing weekly review GitHub issue...');
  const closeIssue = await submitAction(token, {
    service: 'github',
    actionType: 'github.close_issue',
    payload: { owner: 'my-org', repo: 'tasks', issueNumber: 42 },
    displaySummary: 'Close "Weekly Review" issue #42 on GitHub',
  });
  console.log(`   → Tier: ${closeIssue.tier} | Status: ${closeIssue.status}`);

  if (closeIssue.status === 'AWAITING_MFA' && closeIssue.jobId) {
    console.log(`   🔐 Waiting for MFA verification (job: ${closeIssue.jobId})...`);
    const resolved = await waitForApproval(closeIssue.jobId, token);
    console.log(`   → Resolved: ${resolved.status}`);
  }

  console.log('\n✅ Demo task complete!');
  console.log('═'.repeat(50));
}

// Run
runDemoTask().catch((err) => {
  console.error('❌ Demo agent error:', err.message);
  process.exit(1);
});
