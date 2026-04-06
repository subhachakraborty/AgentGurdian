# Agent Guardian

Agent Guardian is a **trust layer** for AI agents that act on a user’s behalf. It sits between an agent and third-party APIs, classifies each requested action into `AUTO`, `NUDGE`, or `STEP_UP`, and enforces the right approval flow before anything executes.

**In this repo**

| Piece | Role |
|--------|------|
| **Dashboard** (`apps/web`) | Login, connect services, tune permissions, approve or step-up actions, audit history |
| **API** (`apps/api`) | Auth0 integration, tier classification, orchestration, audit logging, provider execution |
| **CLI agent** (`agent`) | OpenRouter-backed LLM that routes tool calls through the Guardian API |

## Trust model

| Tier | Behavior |
|------|----------|
| `AUTO` | Safe actions run immediately |
| `NUDGE` | Sensitive actions wait for approval in a **60-second** window |
| `STEP_UP` | High-risk actions need **MFA-backed** confirmation before execution |

OAuth tokens are fetched on demand; raw provider tokens are **not** stored in the app database.

## Prerequisites

- **Node.js 20+** (matches [CI](.github/workflows/ci.yml))
- **Docker** (or compatible runtime) for PostgreSQL and Redis via Compose
- An **Auth0** tenant with SPA + API + M2M apps and OAuth connections (see [Connecting OAuth services](#connecting-oauth-services))
- **OpenRouter** API key for the CLI agent

## Documentation

- **[README.md](README.md)** (this file): setup, OAuth connections, CLI, acting-user behavior, troubleshooting.
- **[AgentGuardian_DeveloperDocs_v1.2.md](AgentGuardian_DeveloperDocs_v1.2.md)**: architecture, API reference, Auth0 Token Vault and M2M Action details, production deployment notes, implementation caveats.
- **[DEPLOY_EC2_DEMO.md](DEPLOY_EC2_DEMO.md)**: concrete single-instance AWS EC2 deployment flow for the web app, API, Dockerized Postgres/Redis, Nginx, and systemd.

## Repo layout

```text
apps/web        React + Vite dashboard
apps/api        Express + Prisma API
agent           CLI agent
packages/shared Shared enums, defaults, and action metadata
```

## Tech stack

- **Frontend:** React 18, Vite, Tailwind CSS, TanStack Query, Zustand, Auth0 React SDK, Socket.IO client
- **Backend:** Node.js, Express, TypeScript, Prisma, PostgreSQL, Redis, BullMQ, Socket.IO, Zod, Winston
- **Agent:** TypeScript, OpenAI SDK → OpenRouter
- **Auth:** Auth0 Universal Login, Auth0 Management API, Token Vault–style service token retrieval

## Quick start

### 1. Install dependencies

```bash
git clone <your-fork-or-upstream-url>
cd <repo-directory>
npm install
```

### 2. Start local infrastructure

```bash
docker-compose up -d
# or: npm run docker:up
```

This starts PostgreSQL and Redis for the API.

### 3. Configure environment

```bash
cp .env.example apps/api/.env
cp .env.example apps/web/.env
cp agent/.env.example agent/.env
```

Fill in at minimum:

- **API** (`apps/api/.env`): Auth0 domain, audience, client IDs, M2M secrets, database URL, Redis URL
- **Web** (`apps/web/.env`): Only the `VITE_*` variables (Auth0 SPA client, API URLs)
- **Agent** (`agent/.env`): Agent M2M credentials and `OPENROUTER_API_KEY`

The root `/.env.example` contains both API and web variables. When copying to `apps/web/.env`, you only need to configure the `VITE_*` entries.

### 4. Prepare the database

```bash
npm run db:migrate
npm run db:seed
```

### 5. Run the dashboard and API

```bash
npm run dev
```

- **Web:** `http://localhost:5173`
- **API:** `http://localhost:3001`

### 6. Log in via the dashboard

Log in once at `http://localhost:5173`. The app calls `/api/v1/auth/me`, which creates or refreshes your local user record (needed for **development-mode** CLI user resolution).

### 7. Connect a service

Open **Connections** and authorize at least one provider (e.g. GitHub, Gmail, Slack, Notion). See [Connecting OAuth services](#connecting-oauth-services) if anything fails.

### 8. Start the CLI agent

```bash
npm run dev -w agent
```

## Root npm scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | API + web (concurrent) |
| `npm run dev:api` / `npm run dev:web` | One app only |
| `npm run build` | Shared → API → web production build |
| `npm run type-check` | TypeScript without emit |
| `npm run lint` | ESLint on `.ts` / `.tsx` |
| `npm run test` | Vitest |
| `npm run db:migrate` / `npm run db:seed` / `npm run db:studio` | Prisma (via `apps/api`) |
| `npm run docker:up` / `npm run docker:down` | Compose helpers |

CI runs `build` (shared), `type-check`, `lint`, and `test` on push and pull requests.

## Agent CLI

The agent is interactive and acts on behalf of the **resolved** user (see below).

Example:

```text
User> list my GitHub repositories
User> create an issue in my-repo
User> exit
```

| Script | Use |
|--------|-----|
| `npm run dev -w agent` | Run the agent (loads `agent/.env`) |
| `npm run start -w agent` | Same as `dev` |
| `npm run dev:watch -w agent` | Watch mode while editing agent code |

### Agent environment (`agent/.env`)

```bash
AUTH0_DOMAIN=your-tenant.us.auth0.com
# Must match your Auth0 API identifier (often a URL, e.g. https://api.example.com)
AUTH0_AUDIENCE=<CUSTOM_AUTH0_AUDIENCE>
AGENT_AUTH0_CLIENT_ID=your_m2m_client_id
AGENT_AUTH0_CLIENT_SECRET=your_m2m_client_secret
GUARDIAN_API_URL=http://localhost:3001
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=openai/gpt-4o-mini
```

## How the agent resolves the acting user

| Mode | Behavior |
|------|----------|
| **Development (default)** | After you log in, `GET /api/v1/auth/me` upserts your user and refreshes `updatedAt`. The agent calls `GET /api/v1/agent/whoami`, which picks the **most recently active** user. No user ID in `agent/.env` is required. |
| **Production** | In an Auth0 **Machine-to-Machine** credentials-exchange Action, set a custom claim whose **name** matches **`USER_ID_CLAIM`** in [`apps/api/src/middleware/agentAuth.ts`](apps/api/src/middleware/agentAuth.ts) and whose **value** is the Auth0 user id (e.g. `github|123`). If you change the string in code, update the Action to match. |

**Wrong user in dev:** log into the dashboard as the account you want; that refreshes `updatedAt`. **Explicit production binding:** full Action code and steps are in [AgentGuardian_DeveloperDocs_v1.2.md](AgentGuardian_DeveloperDocs_v1.2.md) (Auth0 M2M Action section).

## Repository-aware GitHub behavior

If you run the agent inside another git repo, it reads `remote.origin.url` for ambient GitHub context:

```bash
cd /path/to/my-project
npm run dev -w /path/to/<this-repo>/agent
```

Examples: `create an issue in this repo`, `open a PR in other-repo`, `merge PR 42 in owner/repo`. If `owner` is omitted, the backend may infer it from the GitHub token.

## Supported services

Gmail, GitHub, Slack, Notion.

Default action tiers: [packages/shared/src/constants/defaults.ts](packages/shared/src/constants/defaults.ts).

### GitHub actions used in the agent flow

- `github.read_repositories`, `github.read_issues`, `github.read_prs`, `github.read_code`, `github.read_branches`
- `github.create_issue`, `github.comment_issue`, `github.open_pr`, `github.merge_pr`, `github.merge_to_main`, `github.push_code`, `github.close_issue`, `github.delete_branch`

Full catalog: same `defaults.ts` file and [AgentGuardian_DeveloperDocs_v1.2.md](AgentGuardian_DeveloperDocs_v1.2.md).

## Connecting OAuth services

Provider OAuth goes through Auth0; **access tokens are not stored in this app’s database**—connection state is local, tokens come from Auth0 (Token Vault–style retrieval in the API). In Auth0, enable **Token Vault** (or equivalent) on each social connection you use (GitHub, Google for Gmail, Slack, Notion) and grant the Management API access your tenant needs to read tokens (see Developer Docs).

**Dashboard flow**

1. Open `http://localhost:5173` and sign in.  
2. **Connections** → **Connect** on each provider you need.  
3. Complete the provider’s consent screen; you should see **Connected**.  
4. Run the agent.

**If the agent says a service is not connected:** connect that service in the dashboard first (same Auth0 user you intend the agent to use).

**Typical recovery**

| Problem | What to do |
|---------|------------|
| Token expired / revoked | Connections → **Revoke**, then **Connect** again to re-authorize. |
| “Empty” or missing token from Auth0 | Confirm Token Vault is enabled on the connection and Management API permissions are correct; reconnect from the dashboard. |
| Connected in UI but actions fail | Revoke, wait a few seconds, connect again to force a fresh OAuth flow. |
| User not found / agent cannot resolve user | Log into the dashboard once so `/auth/me` creates your user row. |

## Example approval flows

### `AUTO`

```text
User> show me my GitHub repositories
→ Agent reads data and returns the result immediately.
```

### `NUDGE`

```text
User> create an issue titled "Fix bug" in my-repo
→ Action is pending approval.
→ User approves in the dashboard.
→ Action runs and the agent sees the result.
```

### `STEP_UP`

```text
User> merge PR #42 in my-repo
→ Action requires elevated confirmation.
→ User completes MFA-backed approval in the dashboard.
→ Action runs after verification.
```

## Architecture (high level)

```text
Dashboard → Auth0 login → Guardian API
CLI agent → M2M token → Guardian API
Guardian API → classify tier → fetch service token → execute provider action
Guardian API → PostgreSQL + Redis + Socket.IO (state, audit, approvals)
```

## Development notes

- `npm run dev` starts **API + web only**; start the CLI separately.
- Unknown actions default to `STEP_UP` in `classifyTier()`.
- Connection metadata lives in PostgreSQL; raw provider tokens do not.
- GitHub `owner` can be inferred when the LLM omits it.

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| Agent cannot resolve user | Log into the dashboard at `http://localhost:5173` so `/auth/me` refreshes your profile. |
| Agent acts as the wrong user (dev) | Log in as the intended user so their `updatedAt` is newest, or use production M2M + Action (Developer Docs). |
| Agent token fetch failed | Check `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AGENT_AUTH0_CLIENT_ID`, `AGENT_AUTH0_CLIENT_SECRET` in `agent/.env` and Auth0 M2M app settings. |
| Service not connected | Use **Connections** in the dashboard to connect or reconnect. |
| Token expired / bad token | Revoke and reconnect the provider; see [Connecting OAuth services](#connecting-oauth-services). |
| Wrong GitHub repo | Name the repo explicitly or use `owner/repo`. |
| Watch mode flickers | Prefer `npm run dev -w agent`; use `dev:watch` only when editing agent code. |

## Integrating with AI agent frameworks

Agent Guardian can serve as a **middleware trust layer** for AI agents built with popular frameworks. The architecture allows any agent that can make HTTP requests to route actions through Guardian for classification, approval, and audited execution.

### Compatible frameworks

Agent Guardian's REST API can integrate with:

- **LangGraph** / **LangChain** - wrap Guardian API calls in custom tools
- **CrewAI** - implement Guardian-backed tools in crew agents
- **AutoGPT** - replace direct API calls with Guardian endpoints
- **n8n** - use HTTP Request nodes to call Guardian API
- **Custom agents** - integrate via REST API

### Integration approach

Instead of calling provider APIs directly, agents route actions through Guardian:

```typescript
// Direct call (without Guardian):
await octokit.issues.create({ owner, repo, title, body });

// Via Guardian (with approval flow):
const response = await fetch(`${GUARDIAN_API_URL}/api/v1/agent/action`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${agentToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    service: 'github',
    actionType: 'github.create_issue',
    payload: { owner, repo, title, body }
  })
});
```

### Authentication

1. Create an Auth0 **Machine-to-Machine** application with `agent:act` scope
2. Fetch a token using client credentials grant
3. Use the `access_token` in the `Authorization: Bearer` header
4. Bind to a user via Auth0 M2M Action (see [How the agent resolves the acting user](#how-the-agent-resolves-the-acting-user))

### Handling approval flows

- **AUTO** actions return results immediately
- **NUDGE** actions return `{ status: 'pending', jobId: '...' }` — poll `GET /api/v1/agent/action/:jobId/status` or use Socket.IO
- **STEP_UP** actions return `{ status: 'pending', challengeUrl: '...' }` — user must complete MFA in the dashboard

For long-running workflows, implement polling or Socket.IO listeners in your framework's async execution layer.

## License

MIT
