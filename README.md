# Agent Guardian

Agent Guardian is a **trust layer for AI agents** that act on a user's behalf. It sits between an agent process and third-party APIs, classifies every requested action into one of three risk tiers, and enforces the correct approval flow before any side-effect occurs.

**In this repo**

| Piece | Location | Role |
|---|---|---|
| **Dashboard** | `apps/web` | React SPA — login, connect services, tune per-action tiers, approve or step-up actions, audit history |
| **API** | `apps/api` | Express REST + Socket.IO — Auth0 integration, tier classification, orchestration, token vault, audit logging, provider execution |
| **CLI Agent** | `agent` | OpenRouter-backed LLM with a readline REPL that routes all tool calls through the Guardian API |
| **Shared** | `packages/shared` | Enums (`ActionTier`), default tier map, action catalog, service→connection mapping |

---

## Trust Model

| Tier | Trigger | Behaviour |
|---|---|---|
| 🟢 `AUTO` | Action is classified safe | Executes **immediately** — token fetched, provider called, audit log written, activity feed updated in real time |
| 🟡 `NUDGE` | Action is medium-risk | Held for **60 seconds**. Payload is cached in Redis. User receives a Socket.IO + Web Push notification and can approve or deny. BullMQ fires a timeout job if no action is taken. |
| 🔴 `STEP_UP` | Action is high-risk | Blocked. User must complete **MFA** in the dashboard. The API verifies `acr`/`amr` claims in the resulting JWT before executing. |

> **OAuth tokens are never stored in this application's database.** Auth0 Token Vault holds all provider credentials; they are fetched on demand per action.

> **Action payloads are never persisted.** Only a SHA-256 hash reaches the database. Actual payloads live in Redis with a TTL and are deleted immediately after execution.

### Default Action Tiers

| Action | Default Tier |
|---|---|
| `github.read_repositories` / `read_issues` / `read_prs` / `read_branches` / `read_code` | `AUTO` |
| `github.create_issue` / `comment_issue` / `open_pr` | `NUDGE` |
| `github.close_issue` / `merge_pr` / `merge_to_main` / `delete_branch` | `STEP_UP` |
| `gmail.read_emails` / `search_emails` | `AUTO` |
| `gmail.send` / `gmail.create_draft` | `STEP_UP` |
| `slack.read_messages` / `read_channels` | `AUTO` |
| `slack.post_message` / `create_channel` | `NUDGE` |
| `notion.read_page` / `search_pages` | `AUTO` |
| `notion.create_page` / `update_page` | `NUDGE` |

Full catalog: [`packages/shared/src/constants/`](packages/shared/src/constants/)

---

## Repo Layout

```text
AgentGuardian/
├── agent/                  standalone AI agent CLI
│   └── src/
│       ├── index.ts        readline REPL + LLM loop
│       ├── auth/           M2M token acquisition + whoami resolution
│       ├── guardian/       waitForApproval polling helper
│       └── llm/            OpenRouter client, tool schema, executeTool
│
├── apps/
│   ├── api/                Express + Socket.IO server (port 3001)
│   │   ├── prisma/         schema.prisma + seed
│   │   └── src/
│   │       ├── config/     env validation (Zod), Auth0 Management client
│   │       ├── lib/        Prisma, Redis, BullMQ queues, logger, Web Push
│   │       ├── middleware/  JWT auth, agentAuth, stepUpAuth, rateLimit
│   │       ├── routes/     auth, connections, permissions, agent, audit
│   │       ├── services/   orchestrator, tierClassifier, tokenVault,
│   │       │               auditService, nudgeService, notificationService,
│   │       │               executors/ (github, gmail, slack, notion)
│   │       └── workers/    nudgeWorker (BullMQ consumer)
│   │
│   └── web/                React 18 + Vite SPA (port 5173)
│       └── src/
│           ├── api/        Axios client with Auth0 token interceptor
│           ├── pages/      Dashboard, Connections, Permissions, AuditLog,
│           │               Callback, StepUpTrigger, StepUpComplete
│           ├── components/ layout, connections, dashboard, permissions
│           └── hooks/      useConnections, usePermissions, useActivityFeed,
│                           useNudges, usePushNotifications
│
└── packages/
    └── shared/             ActionTier enum, DEFAULT_TIER_MAP, SERVICE_ACTIONS,
                            ACTION_DESCRIPTIONS, SERVICE_CONNECTION_MAP, NUDGE_TIMEOUT_MS
```

---

## Tech Stack

| Layer | Technologies |
|---|---|
| **Frontend** | React 18, Vite, Tailwind CSS, TanStack Query (React Query), Auth0 React SDK, Socket.IO client |
| **Backend** | Node.js, Express, TypeScript, Prisma ORM, PostgreSQL, Redis, BullMQ, Socket.IO, Zod, Winston |
| **Agent** | TypeScript, OpenAI SDK (pointed at OpenRouter) |
| **Auth** | Auth0 Universal Login (PKCE), Auth0 M2M Client Credentials, Auth0 Management API, Token Vault |

---

## Prerequisites

- **Node.js 20+**
- **Docker** (or compatible) for PostgreSQL + Redis via Compose
- An **Auth0 tenant** with:
  - SPA App (Dashboard) — PKCE, callback `http://localhost:5173/callback`
  - API resource — audience matches `AUTH0_AUDIENCE`
  - M2M App (Management) — for Token Vault operations
  - M2M App (Agent) — `agent:act` scope
  - OAuth social connections: GitHub, Google (Gmail), Slack, Notion with **Token Vault** / **Store Tokens** enabled
- **OpenRouter** API key for the CLI agent

---

## Quick Start

### 1. Install

```bash
git clone <repo-url>
cd AgentGuardian
npm install
```

### 2. Start infrastructure

```bash
docker-compose up -d
# or: npm run docker:up
```

Starts PostgreSQL on `5432` and Redis on `6379`.

### 3. Configure environment

```bash
cp .env.example apps/api/.env
cp .env.example apps/web/.env
cp agent/.env.example agent/.env
```

#### API (`apps/api/.env`) — required variables

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/agent_guardian
REDIS_URL=redis://localhost:6379

AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_AUDIENCE=https://api.agentguardian.com
AUTH0_CLIENT_ID=<SPA_or_regular_web_app_client_id>
AUTH0_M2M_CLIENT_ID=<management_m2m_client_id>
AUTH0_M2M_CLIENT_SECRET=<management_m2m_client_secret>

FRONTEND_URL=http://localhost:5173
API_BASE_URL=http://localhost:3001

# Optional — Web Push (VAPID)
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
```

#### Web (`apps/web/.env`) — only VITE_ variables

```bash
VITE_AUTH0_DOMAIN=your-tenant.us.auth0.com
VITE_AUTH0_CLIENT_ID=<spa_client_id>
VITE_AUTH0_AUDIENCE=https://api.agentguardian.com
VITE_API_BASE_URL=http://localhost:3001
```

#### Agent (`agent/.env`)

```bash
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_AUDIENCE=https://api.agentguardian.com
AGENT_AUTH0_CLIENT_ID=<agent_m2m_client_id>
AGENT_AUTH0_CLIENT_SECRET=<agent_m2m_client_secret>
GUARDIAN_API_URL=http://localhost:3001
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=openai/gpt-4o-mini
```

### 4. Prepare the database

```bash
npm run db:migrate
npm run db:seed
```

### 5. Run the API and dashboard

```bash
npm run dev
```

- **Dashboard:** `http://localhost:5173`
- **API:** `http://localhost:3001`

### 6. Log in via the dashboard

Visit `http://localhost:5173` and sign in with Auth0. The app immediately calls `GET /api/v1/auth/me`, which **finds or creates** your user row in PostgreSQL. This step is required before the CLI agent can resolve who it's acting on behalf of.

### 7. Connect at least one service

Open **Connections** → click **Connect** on GitHub (or another provider) → complete the OAuth consent screen. Once you see **Connected**, the agent can call that service.

See [Connecting OAuth Services](#connecting-oauth-services) if anything fails.

### 8. Start the CLI agent

```bash
npm run dev -w agent
```

```text
User> list my GitHub repositories
User> create an issue titled "Fix the login bug" in my-repo
User> merge PR 12 in my-repo
User> exit
```

---

## API Route Reference

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/auth/health` | None | Health check |
| `GET` | `/api/v1/auth/me` | JWT | Find-or-create user, return profile + active connections |
| `POST` | `/api/v1/auth/logout` | JWT | Server-side log (JWTs are stateless) |
| `POST` | `/api/v1/auth/push-subscription` | JWT | Register Web Push subscription |
| `GET` | `/api/v1/connections` | JWT | List all 4 services with connection status |
| `GET` | `/api/v1/connections/:service/authorize` | JWT | Generate Auth0 OAuth authorization URL |
| `GET` | `/api/v1/connections/callback` | None | OAuth callback → DB upsert → redirect to dashboard |
| `DELETE` | `/api/v1/connections/:service` | JWT | Revoke + unlink identity from Auth0 Token Vault |
| `GET` | `/api/v1/permissions` | JWT | Full permission matrix (system defaults + user overrides) |
| `PUT` | `/api/v1/permissions` | JWT | Bulk upsert tier overrides |
| `PUT` | `/api/v1/permissions/:service/:action` | JWT | Single tier override |
| `GET` | `/api/v1/permissions/defaults` | JWT | System default tier map |
| `DELETE` | `/api/v1/permissions/:service` | JWT | Reset a service to system defaults |
| `POST` | `/api/v1/agent/action` | JWT (M2M or human) | **Main action endpoint** — classifies and orchestrates |
| `GET` | `/api/v1/agent/pending` | JWT | List live pending nudge actions for the current user |
| `GET` | `/api/v1/agent/action/:jobId/status` | JWT | Poll action status |
| `POST` | `/api/v1/agent/action/:jobId/approve` | JWT | Approve a NUDGE action |
| `POST` | `/api/v1/agent/action/:jobId/deny` | JWT | Deny a NUDGE action |
| `POST` | `/api/v1/agent/action/:jobId/step-up` | JWT + MFA claim | Execute after MFA verification |
| `GET` | `/api/v1/agent/whoami` | JWT + `agent:act` | Resolve which user the agent acts on behalf of |
| `GET` | `/api/v1/audit` | JWT | Paginated, filterable audit logs |
| `GET` | `/api/v1/audit/stats` | JWT | Aggregated stats by tier / service / status |

**Rate limits:** 30 agent actions / minute per user · 100 general requests / minute per user.

---

## How the Agent Resolves the Acting User

| Mode | Behaviour |
|---|---|
| **Development (default)** | Log in at `http://localhost:5173` once. `/auth/me` upserts your user and refreshes `updatedAt`. The agent calls `GET /api/v1/agent/whoami`, which picks the **most recently active** user by `updatedAt`. No user ID configuration needed. |
| **Production** | Create an Auth0 M2M Actions script that injects `https://agentguardian.com/userId` (the human's Auth0 `sub`) and `https://agentguardian.com/agentId` into the M2M JWT. The API reads these claims directly. |

**Wrong user in dev?** Log in as the intended account so their `updatedAt` becomes the newest. Full Auth0 Action code is in [`AgentGuardian_DeveloperDocs_v1.2.md`](AgentGuardian_DeveloperDocs_v1.2.md).

---

## Repository-Aware GitHub Behaviour

If you run the agent from inside a local git repository, it reads `remote.origin.url` and injects that repo as ambient context into the system prompt:

```bash
cd /path/to/my-project
npm run dev -w /path/to/AgentGuardian/agent
```

- `"create an issue in this repo"` → uses the detected repo
- `"open a PR in other-repo"` → uses that repo name
- `"merge PR 42 in acme-org/backend"` → uses explicit owner + repo

If `owner` is omitted, the GitHub executor auto-resolves it from the GitHub access token (`GET /user`).

---

## Connecting OAuth Services

OAuth connections go through Auth0. The dashboard's **Connect** button redirects to Auth0, which handles the provider consent and stores the IDP access token in Token Vault. The app's database **only records connection state** (ACTIVE / REVOKED); it never holds provider tokens.

**To enable Token Vault on a connection:**
In Auth0 → Connections → (your social connection) → enable **Store Tokens / Token Vault**.

**Dashboard flow:**
1. Go to `http://localhost:5173` and sign in.
2. **Connections** → **Connect** on each provider.
3. Complete the provider OAuth consent screen → you should see **Connected**.
4. Start the agent.

**Recovery table:**

| Problem | What to do |
|---|---|
| Agent says service is not connected | Connect the service in the dashboard (same Auth0 account the agent resolves to). |
| Token expired / `TokenExpiredError` | Connections → **Revoke** → **Connect** again to force a fresh OAuth flow. |
| "Empty" or missing token from Auth0 | Confirm Token Vault is enabled on the connection and the Management API `read:user_idp_tokens` permission is granted; reconnect. |
| Connected in UI but actions still fail | Revoke, wait a few seconds, reconnect to force a new OAuth grant. |
| User not found (agent or API) | Log into the dashboard once so `/auth/me` creates your user row. |

---

## Real-Time Notification Stack

When an action is classified as NUDGE or STEP_UP, the API delivers notifications through three layers in order:

| Layer | Delivery | Condition |
|---|---|---|
| **Socket.IO** | Instant | Dashboard tab must be open |
| **Web Push (VAPID)** | Instant | Any browser tab must be open; push subscription must be registered |
| **CLI polling** | Every 3s | Agent polls `/action/:jobId/status` regardless |

**Socket.IO events emitted by the server:**

| Event | When |
|---|---|
| `nudge:request` | NUDGE action created — shows approval card |
| `nudge:resolved` | User approved or denied |
| `nudge:expired` | 60s timer fired without resolution |
| `stepup:required` | STEP_UP action created — shows MFA modal |
| `stepup:completed` | MFA verified and action executed |
| `activity:new` | Any action completes — updates activity feed |
| `connection:revoked` | Service token revoked — refreshes connections page |

---

## Example Approval Flows

### AUTO — runs immediately

```text
User> show me my GitHub repositories
🤖 Agent: Here are your repositories: ...
```

### NUDGE — 60-second veto window

```text
User> create an issue titled "Fix auth bug" in my-repo

⏸️  Action requires approval (Tier: NUDGE)
   🟡 Waiting for user approval via Dashboard (60 seconds)...

[Dashboard shows: "Create issue: Fix auth bug" — Approve / Deny]

User clicks Approve →

✅ Action was approved and executed.
🤖 Agent: Issue #43 has been created successfully.
```

### STEP_UP — MFA required

```text
User> merge PR 12 in my-repo

⏸️  Action requires approval (Tier: STEP_UP)
   🔴 This is a HIGH-RISK action requiring MFA verification
   📱 Open the dashboard and complete MFA to proceed
   ⏳ Waiting up to 5 minutes...

[Dashboard shows Step-Up modal with "Verify with MFA" button]
[User completes MFA in Auth0]

✅ Action was approved and executed.
🤖 Agent: PR #12 has been merged successfully.
```

---

## Database Schema (Summary)

| Table | Purpose |
|---|---|
| `User` | Auth0 user, email, Web Push subscription |
| `ServiceConnection` | Connection status per service (ACTIVE / REVOKED). **No tokens stored.** |
| `PermissionConfig` | User's tier overrides per (service, actionType). One row per triple. |
| `AuditLog` | **Immutable.** Every action — executed, denied, expired, step-up verified. Includes SHA-256 payload hash, approver IP, MFA flag. |
| `PendingAction` | Live NUDGE / STEP_UP actions awaiting user decision. Payload hash stored; payload itself in Redis with TTL. |

---

## Security Properties

- **JWTs are stateless RS256** — verified via JWKS endpoint, signature cache is 5 minutes.
- **Agent scope isolation** — M2M tokens carry only `agent:act`; no Management API access.
- **Payload never persists** — Redis key for the payload is deleted immediately after execution or denial.
- **Audit logs are immutable** — `AuditLog` rows have no UPDATE or DELETE operations.
- **MFA enforced server-side** — `requireStepUp` middleware verifies `acr`/`amr` claims; passing a non-MFA token returns HTTP 403.
- **Token Vault revocation** — `DELETE /connections/:service` calls `auth0Management.users.unlink()`, immediately removing the IDP identity and revoking further token fetches.
- **Dev-mode MFA bypass is time-bounded** — only tokens issued within the last 5 minutes are accepted; no permanent bypass.

---

## npm Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start API + Web concurrently |
| `npm run dev:api` / `npm run dev:web` | Start one app individually |
| `npm run dev -w agent` | Start the CLI agent |
| `npm run build` | Shared → API → Web production build |
| `npm run type-check` | TypeScript check without emit |
| `npm run lint` | ESLint on `.ts` / `.tsx` |
| `npm run test` | Vitest |
| `npm run db:migrate` | Prisma migrate dev |
| `npm run db:seed` | Seed the database |
| `npm run db:studio` | Open Prisma Studio |
| `npm run docker:up` / `npm run docker:down` | Compose helpers |

CI runs `build` (shared), `type-check`, `lint`, and `test` on push and pull requests.

---

## Troubleshooting

| Symptom | What to try |
|---|---|
| Agent cannot resolve acting user | Log into `http://localhost:5173` so `/auth/me` creates/refreshes your user row. |
| Agent acts as the wrong user (dev) | Log in as the intended account to refresh `updatedAt`; it becomes the most-recent. |
| Agent token fetch failed | Check `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AGENT_AUTH0_CLIENT_ID`, `AGENT_AUTH0_CLIENT_SECRET` in `agent/.env` and the Auth0 M2M app settings. |
| "Service not connected" error | Use **Connections** in the dashboard to connect or reconnect the provider. |
| Token expired / `TokenExpiredError` | Revoke and reconnect the provider in the dashboard. |
| `read:user_idp_tokens` missing | Add this scope to the Management API M2M app in Auth0. |
| Step-up MFA not triggering | Confirm MFA is enabled on the Auth0 tenant (`Policies → MFA`). |
| Step-up always fails in dev | Dev bypass only applies to tokens issued within 5 minutes — re-authenticate. |
| Connected in UI but actions fail | Revoke → wait a few seconds → reconnect to force a new IDP authorization grant. |
| All service cards show loading spinner at once | Fixed: the loading state is now per-card, not global. Update to latest code. |
| Wrong GitHub repo used | Name the repo explicitly: `"create issue in owner/repo"`. Owner auto-resolves from the GitHub token if omitted. |
| `401 Unauthorized` from API | Your JWT audience may be wrong — check `VITE_AUTH0_AUDIENCE` matches `AUTH0_AUDIENCE`. |

---

## Integrating with Other Agent Frameworks

Any agent that can make HTTP requests can route actions through Guardian instead of calling provider APIs directly.

```typescript
// Without Guardian — direct API call, no approval, no audit
await octokit.issues.create({ owner, repo, title, body });

// With Guardian — classified, approved, audited
const response = await fetch(`${GUARDIAN_API_URL}/api/v1/agent/action`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${agentM2MToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    service: 'github',
    actionType: 'github.create_issue',
    payload: { owner, repo, title, body },
    displaySummary: `Create issue "${title}" in ${repo}`,
  }),
});

const data = await response.json();
// data.status: 'EXECUTED' | 'PENDING_APPROVAL' | 'AWAITING_MFA' | 'FAILED'
// data.jobId: poll GET /api/v1/agent/action/:jobId/status for deferred actions
```

**Compatible with:** LangGraph / LangChain (custom tools), CrewAI (Guardian-backed tools), AutoGPT (replace direct API calls), n8n (HTTP Request nodes), any custom agent runtime.

**Handling deferred actions:**
- `EXECUTED` → result is in `data.data`
- `PENDING_APPROVAL` (NUDGE) → poll `/status` or subscribe to `Socket.IO nudge:resolved`
- `AWAITING_MFA` (STEP_UP) → send `data.challengeUrl` to the user; poll `/status` or subscribe to `stepup:completed`

---

## Further Reading

- **[AgentGuardian_DeveloperDocs_v1.2.md](AgentGuardian_DeveloperDocs_v1.2.md)** — full API reference, Auth0 Token Vault setup, M2M Action code, production deployment notes, known caveats.

---

## License

MIT
