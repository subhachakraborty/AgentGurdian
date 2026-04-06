# Agent Guardian Developer Docs v1.2

**Audience:** Engineers who already have the app running and need **architecture, data flow, and code pointers** — not step-by-step onboarding.

**Pair with:** [README.md](README.md) for first-time setup, CLI usage, and troubleshooting.

**Last updated:** April 2026 (repo root)

---

## Contents

1. [Overview](#1-overview)
2. [Monorepo layout](#2-monorepo-layout)
3. [Technology stack](#3-current-technology-stack)
4. [Runtime architecture](#4-high-level-runtime-architecture)
5. [Core domain model](#5-core-domain-model)
6. [Action and tier model](#6-action-and-tier-model)
7. [Request lifecycles](#7-request-lifecycles)
8. [Auth model](#8-auth-model)
9. [API surface](#9-api-surface)
10. [Real-time events](#10-real-time-events)
11. [Supported service actions](#11-supported-service-actions)
12. [Environment variables](#12-environment-variables)
13. [Local development workflow](#13-local-development-workflow)
14. [Testing and CI](#14-testing-and-ci)
15. [Implementation notes and caveats](#15-current-implementation-notes-and-caveats)
16. [Recommended reading](#16-recommended-reading-in-this-repo)
17. [Connecting services & Auth0 Token Vault](#17-connecting-services--auth0-token-vault)
18. [Production agent: Auth0 M2M Action](#18-production-agent-auth0-m2m-action)
19. [Acting user resolution (implementation notes)](#19-acting-user-resolution-implementation-notes)
20. [Production deployment outline](#20-production-deployment-outline)
21. [Summary](#21-summary)

---

## 1. Overview

Agent Guardian is a full-stack TypeScript monorepo that adds a trust and approval layer between an AI agent and user-connected services. The system receives an action request, classifies it into one of three tiers, and then either executes immediately, waits for user approval, or requires MFA-backed confirmation.

| Tier | Behavior |
|------|----------|
| `AUTO` | Execute immediately |
| `NUDGE` | Wait for user approval within a **60-second** window |
| `STEP_UP` | Require MFA-aware confirmation before execution |

**Runtime surfaces**

| Path | Role |
|------|------|
| `apps/web` | React dashboard |
| `apps/api` | Express API and orchestration |
| `agent` | CLI agent that calls the API |

---

## 2. Monorepo layout

```text
.
├── apps
│   ├── api
│   │   ├── prisma
│   │   └── src
│   └── web
│       └── src
├── agent
│   └── src
├── packages
│   └── shared
└── docs
```

**Primary code entry points**

| File | Responsibility |
|------|----------------|
| `apps/api/src/app.ts` | Express app and route mounting |
| `apps/api/src/routes/*.ts` | HTTP API |
| `apps/api/src/services/orchestrator.ts` | Tier routing and execution flow |
| `apps/api/prisma/schema.prisma` | Persistence model |
| `packages/shared/src/constants/defaults.ts` | Default tiers and action catalog |
| `agent/src/index.ts` | CLI loop and tool execution |

---

## 3. Current technology stack

### Frontend

- React 18, Vite, TypeScript, Tailwind CSS
- TanStack Query, Zustand
- `@auth0/auth0-react`, `socket.io-client`

### Backend

- Node.js, Express, TypeScript, Prisma, PostgreSQL
- Redis, BullMQ, Socket.IO, Zod, Winston
- `express-oauth2-jwt-bearer`, Auth0 Node SDK

### Agent

- TypeScript, OpenAI Node SDK → OpenRouter-compatible chat completions

### Local infrastructure

- `docker-compose.yml` — PostgreSQL and Redis

**Drift vs. older internal drafts**

- The repo does not use `shadcn/ui`.
- The agent does not use Vercel AI SDK or LangChain.
- **CI:** GitHub Actions runs on every push and PR (see [§14](#14-testing-and-ci)).

---

## 4. High-level runtime architecture

```text
User Browser -> Auth0 -> React Dashboard
                           |
                           v
                    Express API
                           |
          +----------------+----------------+
          |                |                |
          v                v                v
     PostgreSQL         Redis/BullMQ     Socket.IO
                           |
                           v
                    Approval timeouts

CLI Agent -> Auth0 M2M token -> Express API -> third-party service executors
```

**Service executors:** Gmail, GitHub, Slack, Notion.

---

## 5. Core domain model

Defined in [apps/api/prisma/schema.prisma](apps/api/prisma/schema.prisma).

### `User`

Local user keyed by `auth0UserId`. Created or refreshed via `GET /api/v1/auth/me` after dashboard login.

### `ServiceConnection`

Connection or revoked state per user. **Does not** store raw OAuth tokens.

### `PermissionConfig`

User overrides for `(user, service, actionType) → tier`.

### `AuditLog`

Immutable history: service, action type, tier, outcome, payload hash, approver metadata, step-up verification flag.

### `PendingAction`

Tracks `NUDGE` and `STEP_UP` actions awaiting resolution.

---

## 6. Action and tier model

Canonical actions and default tiers: [packages/shared/src/constants/defaults.ts](packages/shared/src/constants/defaults.ts).

**Examples**

- GitHub reads → often `AUTO`
- GitHub issue/PR creation → often `NUDGE`
- GitHub merge/delete → often `STEP_UP`
- Unknown actions → `STEP_UP` in `classifyTier()` (fail-safe)

**Classifier order**

1. User-specific `PermissionConfig`
2. `DEFAULT_TIER_MAP`
3. Unknown → `STEP_UP`

---

## 7. Request lifecycles

### 7.1 `AUTO`

Implemented in `handleAutoTier()` in [apps/api/src/services/orchestrator.ts](apps/api/src/services/orchestrator.ts).

1. Classify the action  
2. Fetch a short-lived service token  
3. Execute the provider action  
4. Write an `EXECUTED` audit log  
5. Emit a Socket.IO activity update  

If token retrieval fails:

- `404` → `ServiceNotConnectedError`
- `401` → `TokenExpiredError` and connection marked revoked

### 7.2 `NUDGE`

Implemented across:

- [apps/api/src/services/orchestrator.ts](apps/api/src/services/orchestrator.ts)
- [apps/api/src/services/nudgeService.ts](apps/api/src/services/nudgeService.ts)
- [apps/api/src/workers/nudgeWorker.ts](apps/api/src/workers/nudgeWorker.ts)

1. Create `PendingAction`  
2. Hash the payload  
3. Store payload in Redis: `nudge:payload:<jobId>` (~70s TTL)  
4. BullMQ job with **60s** delay  
5. Socket.IO (+ optional web push)  
6. `PENDING` audit log  
7. Approve → execute → `EXECUTED`; deny → `DENIED`; timeout → `EXPIRED`  

### 7.3 `STEP_UP`

Implemented in [apps/api/src/services/orchestrator.ts](apps/api/src/services/orchestrator.ts) and [apps/api/src/middleware/stepUpAuth.ts](apps/api/src/middleware/stepUpAuth.ts).

1. Create `PendingAction` with a **5-minute** window  
2. Persist payload in Redis if needed  
3. Return `challengeUrl` (e.g. `/step-up?jobId=...`)  
4. Frontend completes step-up UX → `POST /api/v1/agent/action/:jobId/step-up`  
5. Middleware validates MFA-related claims before execution  
6. Success writes audit with `stepUpVerified = true`  

**Development:** `requireStepUp()` may include a **fresh-token bypass** when Auth0 MFA claims are missing — **local demos only**, not a production guarantee.

---

## 8. Auth model

### 8.1 Dashboard login

`@auth0/auth0-react`: Universal Login, Authorization Code + PKCE, in-memory token cache, refresh tokens enabled.

After login, `/api/v1/auth/me` upserts the local user and refreshes `updatedAt` (used for **dev** agent user resolution).

### 8.2 API JWT validation

[apps/api/src/middleware/auth.ts](apps/api/src/middleware/auth.ts) — `express-oauth2-jwt-bearer`.

### 8.3 CLI agent authentication

- Client credentials: [agent/src/auth/getAgentToken.ts](agent/src/auth/getAgentToken.ts), scope `agent:act`
- Acting user: [agent/src/auth/resolveActingUser.ts](agent/src/auth/resolveActingUser.ts)
  - **Production:** M2M token must include the custom claim keyed by `USER_ID_CLAIM` in [apps/api/src/middleware/agentAuth.ts](apps/api/src/middleware/agentAuth.ts) (same string as in your Auth0 Action)
  - **Development:** most recently active dashboard user
  - **GitHub:** when run inside another git repo, ambient context from `remote.origin.url` helps resolve “this repo” style phrases
- Resolution endpoint: `GET /api/v1/agent/whoami`

### 8.4 Service connection and token retrieval

- `GET /api/v1/connections/:service/authorize`, callback, `DELETE` for disconnect

Token retrieval: [apps/api/src/services/tokenVault.ts](apps/api/src/services/tokenVault.ts)

1. Map internal user → `auth0UserId`  
2. Try `auth0Management.tokenVault.getToken(...)`  
3. If unavailable, fallback via Management API user fetch + identity token  
4. Clear errors if token missing or service not connected  

The code targets Token Vault semantics but includes a **Management API fallback** for real SDK behavior.

---

## 9. API surface

Routes mounted in [apps/api/src/app.ts](apps/api/src/app.ts).

### Auth

- `GET /api/v1/auth/health`
- `GET /api/v1/auth/me`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/push-subscription`

### Connections

- `GET /api/v1/connections`
- `GET /api/v1/connections/:service/authorize`
- `GET /api/v1/connections/callback`
- `DELETE /api/v1/connections/:service`

### Permissions

- `GET /api/v1/permissions`
- `PUT /api/v1/permissions`
- `PUT /api/v1/permissions/:service/:action`
- `GET /api/v1/permissions/defaults`
- `DELETE /api/v1/permissions/:service`

### Agent

- `POST /api/v1/agent/action`
- `GET /api/v1/agent/pending`
- `GET /api/v1/agent/action/:jobId/status`
- `POST /api/v1/agent/action/:jobId/approve`
- `POST /api/v1/agent/action/:jobId/deny`
- `POST /api/v1/agent/action/:jobId/step-up`
- `GET /api/v1/agent/whoami`

### Audit

- `GET /api/v1/audit`
- `GET /api/v1/audit/stats`
- `GET /api/v1/audit/:auditLogId`

---

## 10. Real-time events

Server: [apps/api/src/socket.ts](apps/api/src/socket.ts)  
Client: [apps/web/src/lib/socket.ts](apps/web/src/lib/socket.ts) — `join` with Auth0 `sub`.

**Server → dashboard (examples)**

- `activity:new`, `nudge:request`, `nudge:resolved`, `nudge:expired`
- `stepup:required`, `stepup:completed`, `connection:revoked`

---

## 11. Supported service actions

### Gmail

`gmail.read_emails`, `gmail.search_emails`, `gmail.read_attachments`, `gmail.send_email`, `gmail.reply_email`, `gmail.send_to_external`, `gmail.delete_email`, `gmail.send_bulk`

### GitHub

`github.read_repositories`, `github.read_issues`, `github.read_prs`, `github.read_code`, `github.read_branches`, `github.create_issue`, `github.comment_issue`, `github.open_pr`, `github.merge_pr`, `github.merge_to_main`, `github.push_code`, `github.delete_branch`, `github.close_issue`

### Slack

`slack.read_channels`, `slack.read_dms`, `slack.post_to_channel`, `slack.send_dm`, `slack.post_to_general`, `slack.create_channel`

### Notion

`notion.read_pages`, `notion.update_page`, `notion.create_page`, `notion.delete_page`, `notion.share_page`

**Caveats**

- `github.push_code` — placeholder; no real git transport  
- `notion.share_page` — may return an informational response rather than a full workspace share mutation  

---

## 12. Environment variables

- Root template: [.env.example](.env.example) (copy to `apps/api/.env` and `apps/web/.env`)
- Agent: [agent/.env.example](agent/.env.example)

**Commonly required**

- `DATABASE_URL`, `REDIS_URL`
- `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID`, `AUTH0_M2M_CLIENT_ID`, `AUTH0_M2M_CLIENT_SECRET`
- `FRONTEND_URL`, web `VITE_*` URLs and Auth0 IDs
- Agent: `AGENT_AUTH0_CLIENT_ID`, `AGENT_AUTH0_CLIENT_SECRET`, `GUARDIAN_API_URL`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`

The root `.env.example` may also document optional dev overrides (e.g. acting-user hints for demos). Binding rules for the CLI user are covered in [README.md](README.md) and [§18–§19](#18-production-agent-auth0-m2m-action) below.

---

## 13. Local development workflow

Operator steps live in [README.md](README.md). Minimal sequence:

```bash
npm install
docker-compose up -d
cp .env.example apps/api/.env
cp .env.example apps/web/.env
cp agent/.env.example agent/.env
npm run db:migrate
npm run db:seed
npm run dev
```

Agent (second terminal):

```bash
npm run dev -w agent
```

**Order matters**

1. API + web running  
2. Log in to the dashboard  
3. Connect at least one provider  
4. Start the CLI agent  

Skipping step 2 breaks **development** user resolution for the agent.

---

## 14. Testing and CI

| Command | Purpose |
|---------|---------|
| `npm run test` | Vitest (`--passWithNoTests` at root) |
| `npm run lint` | ESLint on `.ts` / `.tsx` |
| `npm run type-check` | Shared build + API + web `tsc --noEmit` |

**GitHub Actions** ([.github/workflows/ci.yml](.github/workflows/ci.yml)): `npm ci` → build `packages/shared` → `type-check` → `lint` → `test` on **push** and **pull_request** (Node 20).

---

## 15. Current implementation notes and caveats

- Root `npm run dev` does **not** start the agent.
- Health check: `GET /api/v1/auth/health`.
- User rows are lazy-created via `/auth/me`.
- Redis holds short-lived pending payloads, not long-lived secrets.
- PostgreSQL holds connection state and audit metadata, not raw provider tokens.
- Unknown action types fail closed to `STEP_UP`.
- End-to-end behavior depends on Auth0 tenant configuration and Management API capabilities.

---

## 16. Recommended reading in this repo

| Document | Use for |
|----------|---------|
| [README.md](README.md) | Setup, OAuth connections, CLI, acting user, troubleshooting |
| This file (`AgentGuardian_DeveloperDocs_v1.2.md`) | Architecture, API, Token Vault, M2M Action, deployment, internals |

---

## 17. Connecting services & Auth0 Token Vault

End users connect Gmail, GitHub, Slack, and Notion from the dashboard (**Connections**). The API stores **connection status** in PostgreSQL; **raw OAuth tokens are not persisted in the app DB**—tokens are obtained at runtime via Auth0 (Token Vault API when available, with a Management API fallback in [apps/api/src/services/tokenVault.ts](apps/api/src/services/tokenVault.ts)).

**Auth0 dashboard (typical)**

1. **Authentication → Social**: create or edit connections for GitHub, Google (Gmail), Slack, Notion as required.  
2. Enable **Token Vault** (or your tenant’s equivalent) per connection so tokens remain manageable in Auth0.  
3. Scopes (examples—align with your provider apps): GitHub `repo`, `read:user`, `user:email`; Google `https://www.googleapis.com/auth/gmail.modify`; Slack `channels:read`, `chat:write`, `users:read`; Notion per Notion’s OAuth docs.  
4. Ensure the Auth0 Management API application used by the API can read user tokens / identities as required (`read:user_idp_tokens` or equivalent for your setup).

**Verify connections**

```bash
curl -s -H "Authorization: Bearer $MGMT_TOKEN" \
  "https://$AUTH0_DOMAIN/api/v2/connections"
```

You should see your connections; Token Vault–enabled connections should reflect that in the payload your tenant returns.

**Operational notes**

- Revoking in the dashboard keeps app state consistent; revoking only at GitHub/Google/Slack/Notion may leave stale “connected” rows until you reconnect through Guardian.  
- Connections persist across app restarts.  
- Per-user: each dashboard user has their own connections.

---

## 18. Production agent: Auth0 M2M Action

The CLI uses the **client credentials** grant ([agent/src/auth/getAgentToken.ts](agent/src/auth/getAgentToken.ts)) with scope `agent:act`. For production, bind the agent to a specific Auth0 user by injecting a custom claim into the M2M access token.

**Claim**

- **Key:** must match `USER_ID_CLAIM` in [apps/api/src/middleware/agentAuth.ts](apps/api/src/middleware/agentAuth.ts). The repo default is a namespaced URI; if you fork, change the constant and your Action in lockstep.
- **Value:** Auth0 user id (e.g. `auth0|…`, `github|…`)

**Action setup (Auth0)**

1. **Actions → Library → Build Custom** — trigger **Machine to Machine**, runtime Node 18+.  
2. **Actions → Flows → Machine to Machine** — add the action to the flow and deploy.

**Example action** (replace placeholders; restrict to your agent M2M client id):

```javascript
exports.onExecuteCredentialsExchange = async (event, api) => {
  const AGENT_CLIENT_ID = 'YOUR_AGENT_M2M_CLIENT_ID';

  if (event.client.client_id !== AGENT_CLIENT_ID) {
    return;
  }

  const userId = 'YOUR_AUTH0_USER_ID'; // e.g. from User Management, or metadata in multi-tenant designs

  // Must match USER_ID_CLAIM in apps/api/src/middleware/agentAuth.ts
  const USER_ID_CLAIM = 'https://agentguardian.com/userId';
  api.accessToken.setCustomClaim(USER_ID_CLAIM, userId);
};
```

**Find `userId`**

- Dashboard: `GET /api/v1/auth/me` response includes `auth0UserId`.  
- Auth0 Dashboard: **User Management → Users → user_id**.

The API reads this claim in `GET /api/v1/agent/whoami` when present; otherwise it falls back to development behavior (most recently active user). Multi-agent or multi-tenant patterns can use separate M2M apps, client metadata, or external lookups—keep the claim as the single source of truth for “who the agent acts as.”

---

## 19. Acting user resolution (implementation notes)

- **Single resolution path:** [agent/src/auth/resolveActingUser.ts](agent/src/auth/resolveActingUser.ts) calls `GET /api/v1/agent/whoami` — no `x-agent-auth0-user-id` header on tool calls.  
- **API:** [apps/api/src/routes/agent.ts](apps/api/src/routes/agent.ts) — `whoami` selects the user from the M2M claim when present, else the user with the latest `updatedAt` (dashboard login refreshes this via `/auth/me`).  
- **Middleware:** [apps/api/src/middleware/agentAuth.ts](apps/api/src/middleware/agentAuth.ts) validates the agent JWT; user binding is not duplicated via ad hoc headers.

Do not set legacy `AGENT_ACTING_AUTH0_USER_ID` in agent env for normal operation; use production claims or dev “most recent user” behavior.

---

## 20. Production deployment outline

Typical single-host layout: **reverse proxy (e.g. Nginx)** on `443`, **Node** running the compiled API (`npm run build` then `node apps/api/dist/index.js` or `npm start -w apps/api`), **PostgreSQL** and **Redis** on localhost (Docker Compose is fine) or managed services. **Do not** expose Postgres, Redis, or the raw API port to the public internet—only `80`/`443` on the proxy.

**Environment**

- API: `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, Auth0 domain/audience/clients, `FRONTEND_URL` = public HTTPS origin (no path), Token Vault base URL if used, VAPID keys if using push.  
- Web build: `VITE_*` must use the **public** API and socket URLs (often same origin as the site if the proxy routes `/api` and Socket.IO). Rebuild the frontend after any `VITE_*` change.

**Database**

From `apps/api` with production `DATABASE_URL`:

```bash
npx prisma migrate deploy
```

(Use your team’s migration policy; `prisma db push` is for bootstrap only when migrations are not yet committed.)

**Health check**

```bash
curl -s https://your-domain/api/v1/auth/health
```

(`GET /api/v1/auth/health` — see [apps/api/src/routes/auth.ts](apps/api/src/routes/auth.ts).)

**Auth0 application URLs**

Register callback, logout, web origin, and CORS entries for your production domain (e.g. `https://app.example.com/callback`). Connection OAuth return paths must match how the API registers redirects (see connection routes).

**TLS**

Use Let’s Encrypt (e.g. Certbot with Nginx) or your cloud load balancer’s certificate.

**Deploy loop (conceptual)**

```bash
git pull
npm ci
npm run build
cd apps/api && npx prisma migrate deploy && cd ../..
sudo systemctl restart your-api-service   # or equivalent
```

---

## 21. Integrating with AI agent frameworks

Agent Guardian's API design allows it to serve as a **middleware trust layer** for AI agents built with various frameworks. Any agent capable of making HTTP requests can route actions through Guardian for tier classification, approval orchestration, and audited execution.

### 21.1 Integration architecture

```text
AI Agent Framework (LangGraph, CrewAI, AutoGPT, n8n, etc.)
    |
    v
Guardian API (/api/v1/agent/action)
    |
    +---> Tier classification (AUTO/NUDGE/STEP_UP)
    +---> Approval flow (if needed)
    +---> Provider execution (GitHub, Gmail, Slack, Notion)
    +---> Audit logging
```

### 21.2 Core integration pattern

The key is replacing direct provider SDK calls with Guardian API requests:

**Without Guardian**
```typescript
await githubClient.issues.create({ owner, repo, title, body });
```

**With Guardian**
```typescript
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

### 21.3 Compatible frameworks

- **LangChain / LangGraph** - implement custom tools that call Guardian API
- **CrewAI** - wrap Guardian API calls in crew agent tools
- **AutoGPT** - route actions through Guardian endpoints
- **n8n** - use HTTP Request nodes with Guardian API
- **Custom TypeScript/Python agents** - direct HTTP integration

### 21.4 Authentication setup

**1. Create Auth0 M2M application**

- Auth0 Dashboard → Applications → Create Application → Machine to Machine
- Authorize for your Guardian API
- Grant `agent:act` scope

**2. Fetch access token**

```bash
curl -X POST https://YOUR_TENANT.auth0.com/oauth/token \
  -H 'content-type: application/json' \
  -d '{
    "client_id": "YOUR_M2M_CLIENT_ID",
    "client_secret": "YOUR_M2M_CLIENT_SECRET",
    "audience": "YOUR_API_IDENTIFIER",
    "grant_type": "client_credentials"
  }'
```

**3. Bind agent to user (production)**

Create an Auth0 Action (Machine to Machine flow):

```javascript
exports.onExecuteCredentialsExchange = async (event, api) => {
  if (event.client.client_id !== 'YOUR_AGENT_M2M_CLIENT_ID') return;
  
  const userId = 'auth0|123456'; // or from client metadata
  api.accessToken.setCustomClaim('https://agentguardian.com/userId', userId);
};
```

See [§18](#18-production-agent-auth0-m2m-action) for full details.

### 21.5 Handling approval flows

| Tier | Response | Framework action |
|------|----------|------------------|
| `AUTO` | `{ status: 'executed', result: {...} }` | Return result immediately |
| `NUDGE` | `{ status: 'pending', jobId: '...' }` | Poll `GET /api/v1/agent/action/:jobId/status` or use Socket.IO |
| `STEP_UP` | `{ status: 'pending', challengeUrl: '...' }` | Notify user to complete MFA in dashboard |

For `NUDGE` and `STEP_UP` actions, implement polling (check status every 1-2 seconds) or Socket.IO listeners (`nudge:resolved`, `nudge:expired`, `stepup:completed`) in your framework's async execution layer.

### 21.6 Available actions

All actions from [§11](#11-supported-service-actions) can be routed through Guardian:

- **GitHub:** 13 actions (read repos, create issues, merge PRs, etc.)
- **Gmail:** 8 actions (read, send, reply, delete emails)
- **Slack:** 6 actions (read channels, post messages, create channels)
- **Notion:** 4 actions (read, create, update, delete pages)

Default tiers: [packages/shared/src/constants/defaults.ts](packages/shared/src/constants/defaults.ts)

### 21.7 Benefits

- **Unified approval UX:** users approve actions in one dashboard regardless of agent framework
- **Audit trail:** all actions logged with tier, outcome, timestamp, payload hash
- **Fail-safe defaults:** unknown actions default to `STEP_UP`
- **Token management:** OAuth tokens retrieved on-demand, not stored in agent code
- **Framework-agnostic:** works with any system that can make HTTP requests



---

## 22. Summary

The implementation provides:

- A dashboard for login, permissions, connections, approvals, and audit history  
- An API that classifies tiers, orchestrates execution, and integrates Auth0 + providers  
- A CLI agent using Auth0 M2M, acting-user resolution, and OpenRouter
