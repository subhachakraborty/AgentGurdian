import { waitForApproval } from '../guardian/waitForApproval';

export async function executeGuardianAction(
  token: string,
  apiUrl: string,
  userId: string,
  args: { service: string; actionType: string; payload: any; displaySummary: string; [key: string]: any }
) {
  // LLM hallucination safeguard: If the LLM places parameters at the root instead of inside 'payload'
  if (!args.payload) {
    args.payload = {};
    if (args.repo) args.payload.repo = args.repo;
    if (args.owner) args.payload.owner = args.owner;
    if (args.branch) args.payload.branch = args.branch;
  }

  console.log(`📦 Payload: ${JSON.stringify(args.payload)}`);
  
  const reqBody = {
    service: args.service,
    actionType: args.actionType,
    payload: args.payload,
    displaySummary: args.displaySummary,
  };

  const res = await fetch(`${apiUrl}/api/v1/agent/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-agent-auth0-user-id': userId
    },
    body: JSON.stringify(reqBody)
  });

  if (!res.ok) {
    let errText = await res.text();
    try { errText = JSON.parse(errText).message || errText; } catch {}
    return `Error from Agent Guardian API: ${res.status} - ${errText}`;
  }

  const data = await res.json();
  
  if (data.status === 'EXECUTED') {
    console.log(`✅ Action executed immediately (Tier: ${data.tier})`);
    return `Success: ${JSON.stringify(data.data)}`;
  } 
  
  if (data.status === 'PENDING_APPROVAL' || data.status === 'AWAITING_MFA') {
    console.log(`⏸️  Action requires Human Approval. (Tier: ${data.tier})`);
    console.log(`   Waiting for user to approve via Dashboard...`);
    
    try {
      const finalResult = await waitForApproval(data.jobId, token);
      console.log(`✅ Action was approved and executed.`);
      return `Success: Action was human-approved and executed. Result: ${JSON.stringify(finalResult)}`;
    } catch (e: any) {
      console.log(`❌ Action failed or was rejected: ${e.message}`);
      return `Execution stopped: ${e.message}`;
    }
  }

  return `Unknown status returned from Guardian: ${data.status}`;
}
