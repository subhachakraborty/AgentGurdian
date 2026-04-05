import * as readline from 'readline';
import { execSync } from 'child_process';
import OpenAI from 'openai';
import { openai, MODEL } from './llm/client';
import { guardianTool } from './llm/tools';
import { executeGuardianAction } from './llm/executeTool';
import { getAgentToken } from './auth/getAgentToken';
import { resolveActingUser } from './auth/resolveActingUser';
import 'dotenv/config';

const API_URL = process.env.GUARDIAN_API_URL || 'http://localhost:3001';

// Discover context from the local Git codebase
function discoverGitContext() {
  try {
    const originUrl = execSync('git config --get remote.origin.url').toString().trim();
    // Handles git@github.com:user/repo.git and https://github.com/user/repo.git
    const match = originUrl.match(/github\.com[:/](.+?)\/(.+?)(\.git)?$/);
    if (match) return { owner: match[1], repo: match[2] };
  } catch (e) {
    return null;
  }
  return null;
}

async function main() {
  console.log('🤖 Starting Agent Guardian LLM CLI...');

  // 1. Setup Auth
  const agentToken = await getAgentToken();
  const user = await resolveActingUser(agentToken);
  const gitContext = discoverGitContext();

  console.log(`🔑 Agent token acquired`);
  console.log(`👤 Acting as: ${user.email} (${user.auth0UserId})`);
  if (gitContext) console.log(`📂 Active Workspace Detected: ${gitContext.owner}/${gitContext.repo}`);
  console.log(`🧠 Model: ${MODEL}`);
  console.log(`\nChat session started. Type 'exit' to quit.\n`);

  // 2. Setup LLM Message History
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are a helpful AI assistant connected to Agent Guardian.
You can help the user manage their connected services via the execute_action tool.
When the user asks you to take an action, use the tool. DO NOT ask the user for permission before calling the tool, because Agent Guardian will securely intercept and request human approval via its Trust Layer automatically. Just confidently call the tool.
CRITICAL: You need the 'repo' name for all GitHub actions. The 'owner' field is optional—if you leave it empty or undefined, the backend will automatically inject the GitHub username of the currently logged-in user! You only need to provide 'owner' if the user specifically asks to act on someone else's repository.

AMBIENT CONTEXT:
The user is currently executing this agent from a terminal located inside a local codebase:
- Default Owner/Username: ${gitContext ? gitContext.owner : 'UNKNOWN'}
- Default Repository: ${gitContext ? gitContext.repo : 'UNKNOWN'}
If the user asks you to modify "this repo", "my repo", or doesn't specify an owner/repository, intelligently use the Default Owner and Default Repository provided above!

If the tool returns a success indicating it was approved, tell the user it was completed.
If the tool returns that it failed or was rejected, tell the user.

Currently supported Github actionTypes for the execute_action tool:
- github.read_repositories (payload: {})
- github.read_branches (payload: { owner?, repo })
- github.read_issues (payload: { owner?, repo })
- github.read_prs (payload: { owner?, repo })
- github.read_code (payload: { owner, repo, path })
- github.create_issue (payload: { owner, repo, title, body, labels? })
- github.comment_issue (payload: { owner, repo, issueNumber, body })
- github.close_issue (payload: { owner, repo, issueNumber })
- github.open_pr (payload: { owner, repo, title, body, head, base })
- github.merge_pr (payload: { owner, repo, prNumber, mergeMethod? })
- github.delete_branch (payload: { owner, repo, branch })
`
    }
  ];

  // 3. Setup CLI
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'User> '
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input.toLowerCase() === 'exit') {
      rl.close();
      return;
    }

    messages.push({ role: 'user', content: input });

    try {
      let isDone = false;
      while (!isDone) {
        
        const response = await openai.chat.completions.create({
          model: MODEL,
          messages,
          tools: [guardianTool],
          tool_choice: 'auto',
        });

        const message = response.choices[0]!.message;
        messages.push(message);

        // Does the LLM want to call a tool?
        if (message.tool_calls && message.tool_calls.length > 0) {
          for (const toolCall of message.tool_calls) {
            if (toolCall.type === 'function' && toolCall.function.name === 'execute_action') {
              const args = JSON.parse(toolCall.function.arguments);
              
              // 4. Pass execution to Agent Guardian!
              const result = await executeGuardianAction(agentToken, API_URL, user.auth0UserId, args);
              
              // 5. Append result so the LLM knows what happened
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: result
              });
            }
          }
        } else {
          // No tools called, the LLM just replied with text
          if (message.content) {
            console.log(`\n🤖 Agent: ${message.content}\n`);
          }
          isDone = true;
        }
      }
    } catch (e: any) {
      console.error(`\n❌ Error communicating with OpenRouter: ${e.message}\n`);
    }

    rl.prompt();
  }).on('close', () => {
    console.log('Closing session.');
    process.exit(0);
  });
}

main().catch(console.error);
