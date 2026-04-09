# Agent Guardian Developer Docs v1.2

**Audience:** Engineers who already have the app running and need architecture, data flow, and precise code pointers — not step-by-step onboarding.

**Pair with:** [README.md](README.md) for first-time setup, CLI usage, and troubleshooting.

**Last updated:** April 2026

---

## Contents

1. [Overview](#1-overview)
2. [Monorepo Layout](#2-monorepo-layout)
3. [Technology Stack](#3-technology-stack)
4. [Runtime Architecture](#4-runtime-architecture)
5. [Core Domain Model (Database Schema)](#5-core-domain-model-database-schema)
6. [Action and Tier Model](#6-action-and-tier-model)
7. [Request Lifecycles](#7-request-lifecycles)
8. [Auth Model](#8-auth-model)
9. [API Surface](#9-api-surface)
10. [Real-Time Events (Socket.IO)](#10-real-time-events-socketio)
11. [Supported Service Actions](#11-supported-service-actions)
12. [Environment Variables](#12-environment-variables)
13. [Local Development Workflow](#13-local-development-workflow)
14. [Testing and CI](#14-testing-and-ci)
15. [Implementation Notes and Caveats](#15-implementation-notes-and-caveats)
16. [Connecting Services & Auth0 Token Vault](#16-connecting-services--auth0-token-vault)
17. [Production Agent: Auth0 M2M Action](#17-production-agent-auth0-m2m-action)
18. [Acting User Resolution](#18-acting-user-resolution)
19. [Integrating with Other Agent Frameworks](#19-integrating-with-other-agent-frameworks)
20. [Production Deployment Outline](#20-production-deployment-outline)
21. [Summary](#21-summary)

---

## 1. Overview

Agent Guardian is a full-stack TypeScript monorepo that adds a trust and approval layer between an AI agent and user-connected services. Every action the agent requests is classified into one of three risk tiers and routed through the correct execution path before any side-effect occurs.

| Tier | Behaviour |
|---|---|
| `AUTO` | Execute immediately — token fetched, provider called, audit log written |
| `NUDGE` | Create a `PendingAction`, cache the payload in Redis, start a 60-second BullMQ timeout, notify the user via Socket.IO + Web Push |
| `STEP_UP` | Block execution; issue a challenge URL for Auth0 MFA; verify `acr`/`amr` claims in the resulting JWT before executing |

**Key invariants enforced by the system:**

- OAuth tokens are **never stored** in the application database. Auth0 Token Vault holds all provider credentials; they are fetched on demand.
- Action payloads are **never persisted** in the database. Only a SHA-256 hash reaches `AuditLog`. The actual payload lives in Redis with a TTL and is deleted immediately after execution or denial.
- `AuditLog` rows are **immutable** — no UPDATE or DELETE operations.

---

## 2. Monorepo Layout

```text
AgentGuardian/
├── agent/                     Standalone AI agent CLI process
│   └── src/
│       ├── index.ts           readline REPL + LLM loop (entry point)
│       ├── auth/
│       │   ├── getAgentToken.ts       M2M client-credentials flow + in-memory cache
│       │   └── resolveActingUser.ts   Calls GET /api/v1/agent/whoami
│       ├── guardian/
│       │   └── waitForApproval.ts     Polls /action/:id/status (3s interval, exp backoff)
│       └── llm/
│           ├── client.ts      OpenRouter API wrapper (OpenAI-compatible SDK)
│           ├── tools.ts       execute_action tool JSON schema for the LLM
│           └── executeTool.ts Calls Guardian API, handles EXECUTED/PENDING/MFA responses
│
├── apps/
│   ├── api/                   Express + Socket.IO server (port 3001)
│   │   ├── prisma/
│   │   │   ├── schema.prisma  Full PostgreSQL schema
│   │   │   └── seed.ts        Database seed
│   │   └── src/
│   │       ├── app.ts         Express app: CORS, middleware chain, route mounting
│   │       ├── index.ts       HTTP server boot, Socket.IO setup, BullMQ worker start
│   │       ├── socket.ts      Socket.IO server + user room management
│   │       ├── config/
│   │       │   ├── env.ts     Zod-validated environment schema (fails fast on start)
│   │       │   └── auth0.ts   Auth0 Management API client singleton
│   │       ├── lib/
│   │       │   ├── prisma.ts  PrismaClient singleton
│   │       │   ├── redis.ts   ioredis singleton
│   │       │   ├── queue.ts   BullMQ queue definitions (nudge-actions, action-execution)
│   │       │   ├── logger.ts  Winston/Pino logger
│   │       │   └── webPush.ts VAPID Web Push sender
│   │       ├── middleware/
│   │       │   ├── auth.ts          JWT RS256 verification (express-oauth2-jwt-bearer)
│   │       │   ├── agentAuth.ts     getActingUserId / getAgentId extractors
│   │       │   ├── stepUpAuth.ts    MFA claim verification (acr/amr) + dev bypass
│   │       │   ├── rateLimit.ts     30 agent actions/min · 100 general/min
│   │       │   ├── errorHandler.ts  Global error middleware
│   │       │   └── requestLogger.ts Per-request logging
│   │       ├── routes/
│   │       │   ├── auth.ts          /auth/me, /logout, /push-subscription
│   │       │   ├── connections.ts   OAuth connect flow + revoke
│   │       │   ├── permissions.ts   Tier CRUD
│   │       │   ├── agent.ts         Main action endpoint + nudge/step-up resolution
│   │       │   └── audit.ts         Audit log read
│   │       ├── services/
│   │       │   ├── orchestrator.ts      Central dispatch: AUTO / NUDGE / STEP_UP
│   │       │   ├── tierClassifier.ts    DB config lookup → DEFAULT_TIER_MAP → STEP_UP
│   │       │   ├── tokenVault.ts        Auth0 Token Vault token fetcher + fallback
│   │       │   ├── auditService.ts      Immutable AuditLog writes, stats aggregation
│   │       │   ├── nudgeService.ts      PendingAction CRUD + BullMQ lifecycle
│   │       │   ├── notificationService.ts  Socket.IO + Web Push emissions
│   │       │   └── executors/
│   │       │       ├── index.ts     Router: service → executor function
│   │       │       ├── github.ts    11 GitHub REST operations + owner auto-resolution
│   │       │       ├── gmail.ts     Gmail REST operations
│   │       │       ├── slack.ts     Slack Web API operations
│   │       │       └── notion.ts    Notion API operations
│   │       └── workers/
│   │           └── nudgeWorker.ts   BullMQ consumer: fires on nudge TTL expiry
│   │
│   └── web/                   React 18 + Vite SPA (port 5173)
│       └── src/
│           ├── App.tsx              Routing, Auth0 provider, token getter setup
│           ├── api/client.ts        Axios + Auth0 token request interceptor
│           ├── pages/
│           │   ├── Dashboard.tsx    Stats bar, activity feed, nudge cards, step-up modal
│           │   ├── Connections.tsx  Service connection management (per-card loading state)
│           │   ├── Permissions.tsx  Per-action tier configuration
│           │   ├── AuditLog.tsx     Filterable, paginated audit table
│           │   ├── Callback.tsx     Auth0 redirect handler
│           │   ├── StepUpTrigger.tsx  Redirect to Auth0 MFA challenge
│           │   └── StepUpComplete.tsx Execute approved step-up action post-MFA
│           ├── components/          layout/, connections/, dashboard/, permissions/
│           └── hooks/               useConnections, usePermissions, useActivityFeed,
│                                    useNudges, usePushNotifications
│
└── packages/
    └── shared/                Consumed by both apps/api and agent
        └── src/
            ├── index.ts
            ├── constants/     DEFAULT_TIER_MAP, SERVICE_ACTIONS, ACTION_DESCRIPTIONS,
            │                  SERVICE_CONNECTION_MAP, NUDGE_TIMEOUT_MS (60 000 ms)
            └── types/         ActionTier enum (AUTO | NUDGE | STEP_UP)
```

---

## 3. Technology Stack

### Frontend (`apps/web`)
- React 18, Vite, TypeScript, Tailwind CSS
- TanStack Query (React Query), Zustand
- `@auth0/auth0-react`, `socket.io-client`

### Backend (`apps/api`)
- Node.js, Express, TypeScript
- Prisma ORM + PostgreSQL
- Redis (ioredis), BullMQ
- Socket.IO, Zod, Winston
- `express-oauth2-jwt-bearer`, Auth0 Node SDK

### Agent (`agent`)
- TypeScript, OpenAI Node SDK (pointed at OpenRouter)

### Local Infrastructure
- `docker-compose.yml` — PostgreSQL on 5432, Redis on 6379

**What this repo does NOT use:** `shadcn/ui`, Vercel AI SDK, LangChain, Prisma Accelerate.

---

## 4. Runtime Architecture

### Boot Sequence (`apps/api/src/index.ts`)

```
1. prisma.$connect()          — fail fast if DB unreachable
2. createServer(app)          — wrap Express in Node HTTP server
3. setupSocketIO(httpServer)  — attach Socket.IO, register user rooms
4. startNudgeWorker()         — start BullMQ consumer on 'nudge-actions'
5. httpServer.listen(PORT)    — default 3001
```

### Request Middleware Chain (`app.ts`)

```
helmet → cors → express.json (10 MB) → requestLogger → generalLimiter (100/min)
→ route handlers
→ errorHandler (global)
```

### High-Level Data Flow

```
┌──────────────────────────────────────────────────────┐
│  Auth0 Cloud                                         │
│  · Universal Login (PKCE)     · Token Vault          │
│  · M2M Client Credentials     · MFA / Step-Up        │
│  · Auth Actions (custom JWT claims)                  │
└──────────────────┬───────────────────────────────────┘
                   │ JWKS (RS256)
        ┌──────────▼───────────┐
        │   Express API :3001  │
        │  ┌─────────────────┐ │
        │  │  Orchestrator   │ │ ← classifyTier → handleAutoTier
        │  │                 │ │                → handleNudgeTier
        │  │                 │ │                → handleStepUpTier
        │  └────────┬────────┘ │
        │           │          │
        │   ┌───────┼───────┐  │
        │   ▼       ▼       ▼  │
        │  PG    Redis   Socket │
        │  (DB)  (BullMQ) (.IO) │
        └──────────┬───────────┘
                   │
         ┌─────────┴──────────┐
         ▼                    ▼
   🤖 Agent CLI          💻 Dashboard SPA
   (M2M JWT)             (PKCE JWT)
```

---

## 5. Core Domain Model (Database Schema)

Full schema: [`apps/api/prisma/schema.prisma`](apps/api/prisma/schema.prisma)

### `User`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | Internal ID |
| `auth0UserId` | String UNIQUE | Auth0 `sub` claim |
| `email` | String UNIQUE | |
| `displayName` | String? | |
| `avatarUrl` | String? | |
| `pushSubscription` | JSON? | Web Push endpoint object |
| `updatedAt` | DateTime | Refreshed on every `/auth/me` — used for dev agent user resolution |

### `ServiceConnection`

| Column | Type | Notes |
|---|---|---|
| `userId` | FK | |
| `service` | Enum | `GMAIL \| GITHUB \| SLACK \| NOTION` |
| `status` | Enum | `ACTIVE \| REVOKED` |
| `connectedAt/lastUsedAt/revokedAt` | DateTime? | |

> ⚠️ **No OAuth tokens are stored here.** Auth0 Token Vault holds all provider credentials.

Constraint: `@@unique([userId, service])` — one row per user per service.

### `PermissionConfig`

| Column | Type | Notes |
|---|---|---|
| `userId/service/actionType` | Composite UNIQUE | One row per triple |
| `tier` | Enum | `AUTO \| NUDGE \| STEP_UP` |

Overrides the system default for a specific `(user, service, actionType)`.

### `AuditLog` *(immutable)*

| Column | Type | Notes |
|---|---|---|
| `userId/agentId` | String | Who triggered it |
| `service/actionType/tier` | Enums | What was requested |
| `status` | Enum | `EXECUTED \| APPROVED \| DENIED \| EXPIRED \| FAILED \| STEP_UP_VERIFIED \| PENDING` |
| `payloadHash` | String? | SHA-256 of payload — not the payload itself |
| `metadata` | JSON? | Non-sensitive context (e.g. issue number returned) |
| `approvedByUserId/approvedByIp` | String? | Accountability fields |
| `stepUpVerified` | Boolean | True when MFA was completed |

Indexes on `(userId, executedAt)`, `(userId, service)`, `(agentId)`.

### `PendingAction`

| Column | Type | Notes |
|---|---|---|
| `userId/agentId` | String | |
| `service/actionType/tier` | Enums | |
| `status` | Enum | `PENDING_APPROVAL \| APPROVED \| DENIED \| EXPIRED` |
| `payloadHash` | String | SHA-256 only |
| `displaySummary` | String | Human-readable description shown in dashboard |
| `bullJobId` | String? | BullMQ job ID for cancellation |
| `expiresAt` | DateTime | 60s for NUDGE, 5 min for STEP_UP |
| `resolvedAt/resolvedByUserId/resolvedByIp/resolvedByDevice` | Various | Accountability |
| `stepUpVerified` | Boolean | |

> ℹ️ The actual payload is stored in Redis under `nudge:payload:{id}` with a TTL, not in this table.

---

## 6. Action and Tier Model

### Classification Algorithm (`tierClassifier.ts`)

```typescript
classifyTier(userId, service, actionType):
  1. prisma.permissionConfig.findUnique({ userId, service, actionType })
     → Found: return config.tier
  2. DEFAULT_TIER_MAP[service.toUpperCase()][actionType]
     → Found: return default tier
  3. Unknown → return ActionTier.STEP_UP   // fail-safe
```

Canonical defaults: [`packages/shared/src/constants/`](packages/shared/src/constants/)

### Default Tier Map (representative)

| Action | Default Tier |
|---|---|
| `github.read_repositories` / `read_issues` / `read_prs` / `read_branches` / `read_code` | `AUTO` |
| `github.create_issue` / `comment_issue` / `open_pr` | `NUDGE` |
| `github.close_issue` / `merge_pr` / `merge_to_main` / `delete_branch` | `STEP_UP` |
| `gmail.read_emails` / `search_emails` | `AUTO` |
| `gmail.send` / `send_to_external` / `delete_email` / `send_bulk` | `STEP_UP` |
| `slack.read_channels` / `read_messages` / `read_dms` | `AUTO` |
| `slack.post_message` / `send_dm` / `post_to_general` / `create_channel` | `NUDGE` |
| `notion.read_pages` / `search_pages` | `AUTO` |
| `notion.create_page` / `update_page` | `NUDGE` |
| `notion.delete_page` / `share_page` | `STEP_UP` |

---

## 7. Request Lifecycles

All lifecycles begin in `POST /api/v1/agent/action` in [`routes/agent.ts`](apps/api/src/routes/agent.ts) and continue in [`services/orchestrator.ts`](apps/api/src/services/orchestrator.ts).

### Middleware Chain for `POST /agent/action`

```
requireAuth                   ← RS256 JWT verification
requireAgentOrDashboard       ← dual-path: M2M (agent:act scope) or human (sub claim)
agentActionLimiter            ← 30 req/min per sub/IP
Zod validation                ← service, actionType, payload, displaySummary
prisma.user.findUnique(auth0UserId)
orchestrateAction(...)
```

### 7.1 AUTO

```
handleAutoTier(params, payloadHash)
  │
  ├─ getServiceToken(userId, service)      ← Auth0 Token Vault
  │    raises ServiceNotConnectedError (404) or TokenExpiredError (401)
  │    on 401: auto-marks ServiceConnection as REVOKED
  │
  ├─ executeServiceAction(service, actionType, token, payload)
  │    ← calls GitHub/Gmail/Slack/Notion REST API directly
  │
  ├─ createAuditLog({ status: 'EXECUTED' })
  │
  ├─ emitActivityUpdate(userId, auditLog)  ← Socket.IO
  │
  └─ return { tier: 'AUTO', status: 'EXECUTED', auditLogId, data }
```

### 7.2 NUDGE

```
handleNudgeTier(params, payloadHash)
  │
  ├─ createNudgeAction(...)
  │    ├─ prisma.pendingAction.create({ status: 'PENDING_APPROVAL', expiresAt: now+60s })
  │    ├─ redis.setex(`nudge:payload:${id}`, 180, JSON.stringify(payload))
  │    └─ nudgeQueue.add('nudge-timeout', data, { jobId: id, delay: 60_000 })
  │
  ├─ notifyUser()
  │    ├─ io.to(auth0UserId).emit('nudge:request', { pendingAction })  ← Socket.IO
  │    └─ sendPushNotification(user.pushSubscription, ...)             ← Web Push
  │
  ├─ createAuditLog({ status: 'PENDING' })
  │
  └─ return { tier: 'NUDGE', status: 'PENDING_APPROVAL', jobId, expiresAt }

On APPROVE (POST /action/:jobId/approve):
  approveNudgeAction()  ← update DB, remove BullMQ job
  executeApprovedAction(jobId, ...)
    ├─ getServiceToken(...)
    ├─ redis.get(`nudge:payload:${jobId}`)  ← retrieve payload
    ├─ executeServiceAction(...)
    ├─ redis.del(`nudge:payload:${jobId}`)  ← clean up
    ├─ createAuditLog({ status: 'EXECUTED' })
    └─ emitActivityUpdate() + emitNudgeResolved()

On DENY (POST /action/:jobId/deny):
  denyNudgeAction()  ← update DB, remove BullMQ job, del Redis key
  createAuditLog({ status: 'DENIED' })
  emitNudgeResolved()

On TIMEOUT (BullMQ fires after 60s):
  nudgeWorker checks status still PENDING_APPROVAL
  → update DB to EXPIRED
  → createAuditLog({ status: 'EXPIRED' })
  → redis.del(`nudge:payload:${id}`)
  → emitNudgeExpired()
```

### 7.3 STEP_UP

```
handleStepUpTier(params, payloadHash)
  │
  ├─ prisma.pendingAction.create({ tier: 'STEP_UP', expiresAt: now+5min })
  │
  ├─ redis.setex(`nudge:payload:${id}`, 360, JSON.stringify(payload))  ← 6-min TTL
  │
  ├─ Generate challengeUrl:
  │    https://{domain}/authorize?
  │      acr_values=http://schemas.openid.net/pape/policies/2007/06/multi-factor
  │      &client_id=...&response_type=code&redirect_uri=.../callback
  │      &state={stepUp:true, jobId}
  │
  ├─ notifyUser() + emitStepUpRequired()   ← Dashboard shows StepUpModal
  │
  └─ return { tier: 'STEP_UP', status: 'AWAITING_MFA', jobId, challengeUrl }

On MFA complete → StepUpComplete.tsx → POST /action/:jobId/step-up
  requireStepUp middleware:
    decode access token (and x-id-token header as fallback)
    check: acr includes MFA_ACR, OR amr === 'mfa', OR amr array includes 'mfa'
    DEV bypass: if NODE_ENV=development AND token.iat >= now-300s → pass (logged as warning)
    fail: 403 { error: 'step_up_required', challengeUrl }

  → update PendingAction(status: APPROVED, stepUpVerified: true)
  → executeApprovedAction(jobId, resolvingUserId, resolvingIp, stepUpVerified=true)
  → createAuditLog({ status: 'STEP_UP_VERIFIED' })
  → emitStepUpCompleted()
```

---

## 8. Auth Model

### 8.1 Dashboard Login (Human Users)

- **Flow:** Auth0 Universal Login, Authorization Code + PKCE
- **Frontend:** `@auth0/auth0-react` — in-memory token cache, `getAccessTokenSilently()`
- **API client:** Axios request interceptor calls `getAccessTokenSilently()` and injects `Authorization: Bearer {token}`
- **On login:** `App.tsx` calls `GET /api/v1/auth/me` → finds or creates the User row in PostgreSQL, refreshes `updatedAt`

### 8.2 API JWT Validation

[`middleware/auth.ts`](apps/api/src/middleware/auth.ts) — `express-oauth2-jwt-bearer`:

```typescript
auth({
  audience: env.AUTH0_AUDIENCE,
  issuerBaseURL: `https://${env.AUTH0_DOMAIN}`,
  tokenSigningAlg: 'RS256',
  jwksUri: `https://${env.AUTH0_DOMAIN}/.well-known/jwks.json`,
  cacheMaxAge: 5 * 60 * 1000,   // 5-minute JWKS cache
})
```

**Scope guard** (`requireScope(scope)`): returns HTTP 403 (never 401) when the required scope is absent.

**User ID extraction** (`getUserId(req)`): reads `req.auth.payload.sub`.

### 8.3 Agent M2M Authentication

**Token acquisition** ([`agent/src/auth/getAgentToken.ts`](agent/src/auth/getAgentToken.ts)):

```typescript
POST https://{domain}/oauth/token
{
  grant_type: 'client_credentials',
  client_id: AGENT_AUTH0_CLIENT_ID,
  client_secret: AGENT_AUTH0_CLIENT_SECRET,
  audience: AUTH0_AUDIENCE,
  scope: 'agent:act'
}
```

Token is cached in memory; refreshed 60 seconds before expiry to avoid clock-skew failures.

**Dual-path middleware** (`requireAgentOrDashboard` in `routes/agent.ts`):

```
If scope includes 'agent:act':
  → Production: read https://agentguardian.com/userId custom claim from JWT
  → Development (fallback): prisma.user.findFirst({ orderBy: { updatedAt: 'desc' } })
  → Set req.actingUserId, req.agentId = 'agent-cli'

Else (human dashboard token):
  → req.actingUserId = payload.sub
  → req.agentId = 'dashboard'
```

### 8.4 Step-Up MFA Verification

[`middleware/stepUpAuth.ts`](apps/api/src/middleware/stepUpAuth.ts):

MFA ACR value: `http://schemas.openid.net/pape/policies/2007/06/multi-factor`

Checks (in order):
1. Access token `acr` claim includes MFA ACR, **OR**
2. Access token `amr` claim is `'mfa'` (string) or array containing `'mfa'`, **OR**
3. Same checks on the `x-id-token` header (ID token passed separately by `StepUpComplete.tsx`)

**Development bypass:** if `NODE_ENV === 'development'` AND `token.iat >= now - 300s`, the check passes with a warning log. This is scoped to the dev environment only — do not rely on it in production.

### 8.5 Service Connection OAuth Flow

```
GET /api/v1/connections/:service/authorize
  → Builds Auth0 authorize URL with:
       connection = SERVICE_CONNECTION_MAP[service]
       redirect_uri = API_BASE_URL/api/v1/connections/callback   ← BACKEND, not frontend
       state = { service, userId: auth0UserId }

User completes OAuth → Auth0 links identity → redirects to backend callback:

GET /api/v1/connections/callback?code=...&state=...
  → Parse state → find user → prisma.serviceConnection.upsert(status: 'ACTIVE')
  → Redirect to FRONTEND_URL/connections?connected={service}

DELETE /api/v1/connections/:service
  → Update DB to REVOKED
  → auth0Management.users.unlink({ id, provider, user_id })  ← removes IDP identity
  → redis/emitConnectionRevoked()
```

### 8.6 Token Vault Token Retrieval

[`services/tokenVault.ts`](apps/api/src/services/tokenVault.ts):

```typescript
getServiceToken(userId, service):
  1. Resolve auth0UserId from internal userId (DB lookup if no '|' separator)
  2. Primary: auth0Management.tokenVault.getToken({ userId: auth0UserId, connection })
  3. Fallback (SDK compat): auth0Management.users.get({ id }) → identities.find(i => i.provider === connection) → i.access_token
  4. On 404 → throw ServiceNotConnectedError
  5. On 401 → markConnectionRevoked() in DB, throw TokenExpiredError
```

The fallback requires the Management API application to have`read:user_idp_tokens` scope.

---

## 9. API Surface

### Authentication

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/auth/health` | None | Health check — returns `{ status: 'ok', timestamp }` |
| `GET` | `/api/v1/auth/me` | JWT | Find-or-create user; upserts profile from JWT claims |
| `POST` | `/api/v1/auth/logout` | JWT | Server-side log only (JWTs are stateless) |
| `POST` | `/api/v1/auth/push-subscription` | JWT | Save Web Push subscription to `user.pushSubscription` |

### Connections

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/connections` | JWT | All 4 services with status (even NOT_CONNECTED ones) |
| `GET` | `/api/v1/connections/:service/authorize` | JWT | Returns `{ authUrl }` — client redirects to it |
| `GET` | `/api/v1/connections/callback` | None | OAuth callback; DB upsert; redirect to frontend |
| `DELETE` | `/api/v1/connections/:service` | JWT | Revoke + unlink Auth0 identity |

### Permissions

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/permissions` | JWT | Full matrix: system defaults merged with user overrides |
| `PUT` | `/api/v1/permissions` | JWT | Bulk upsert: `{ configs: [{ service, actionType, tier }] }` |
| `PUT` | `/api/v1/permissions/:service/:action` | JWT | Single upsert: `{ tier }` |
| `GET` | `/api/v1/permissions/defaults` | JWT | System `DEFAULT_TIER_MAP` as flat array |
| `DELETE` | `/api/v1/permissions/:service` | JWT | Delete all `PermissionConfig` rows for this service → reverts to defaults |

### Agent

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/agent/action` | JWT (M2M or human) | Main action entry point |
| `GET` | `/api/v1/agent/pending` | JWT | Live PENDING_APPROVAL actions for current user |
| `GET` | `/api/v1/agent/action/:jobId/status` | JWT | Poll status; auto-expires if past `expiresAt` |
| `POST` | `/api/v1/agent/action/:jobId/approve` | JWT | Approve NUDGE; executes immediately |
| `POST` | `/api/v1/agent/action/:jobId/deny` | JWT | Deny NUDGE; cleans up Redis |
| `POST` | `/api/v1/agent/action/:jobId/step-up` | JWT + MFA claim | Execute STEP_UP after MFA |
| `GET` | `/api/v1/agent/whoami` | JWT + `agent:act` | Resolve acting user for agent |

**`POST /api/v1/agent/action` — request body schema (Zod validated):**

```typescript
{
  service:        'gmail' | 'github' | 'slack' | 'notion',
  actionType:     string,   // regex: /^[a-z_.]+$/, max 100 chars
  payload:        Record<string, unknown>,   // optional
  displaySummary: string,   // 1–500 chars, shown in nudge notifications
}
```

**Response by tier:**

| Tier | HTTP | Body |
|---|---|---|
| AUTO | 200 | `{ tier, status: 'EXECUTED', auditLogId, data }` |
| NUDGE | 202 | `{ tier, status: 'PENDING_APPROVAL', jobId, expiresAt }` |
| STEP_UP | 202 | `{ tier, status: 'AWAITING_MFA', jobId, challengeUrl }` |
| Error | 4xx/5xx | `{ error, message }` |

### Audit

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/audit` | JWT | Paginated logs; query params: `service`, `tier`, `status`, `from`, `to`, `limit`, `offset` |
| `GET` | `/api/v1/audit/stats` | JWT | `{ totalActions, byTier, byService, byStatus, last7DaysTrend }` |

**Rate limits:**

| Limiter | Window | Max | Key |
|---|---|---|---|
| `agentActionLimiter` | 60s | 30 | `payload.sub` or IP |
| `generalLimiter` | 60s | 100 | `payload.sub` or IP |

---

## 10. Real-Time Events (Socket.IO)

Server setup: [`apps/api/src/socket.ts`](apps/api/src/socket.ts)

Users join a room keyed by their Auth0 `sub` (`socket.on('join', (userId) => socket.join(userId))`). All `io.to(auth0UserId).emit(...)` calls are per-user scoped.

### Server → Client Events

| Event | Emitted when | Payload |
|---|---|---|
| `nudge:request` | NUDGE action created | `{ pendingAction }` |
| `nudge:resolved` | User approved or denied | `{ jobId, status, resolvedBy }` |
| `nudge:expired` | BullMQ timeout fired | `{ jobId }` |
| `stepup:required` | STEP_UP action created | `{ jobId, challengeUrl }` |
| `stepup:completed` | MFA verified + executed | `{ jobId, auditLog }` |
| `activity:new` | Any action completes | `{ auditLog }` |
| `connection:revoked` | Service token revoked | `{ service }` |

### Web Push (VAPID)

Sent on NUDGE and STEP_UP creation (in addition to Socket.IO). Payload:

```typescript
{
  displaySummary: string,
  jobId:          string,
  expiresAt:      Date,
}
```

Register subscription via `POST /api/v1/auth/push-subscription`.

### Transports

Socket.IO is configured with `transports: ['websocket', 'polling']`. CORS origin is `FRONTEND_URL`.

---

## 11. Supported Service Actions

### GitHub — 13 actions

| Action | Tier | Notes |
|---|---|---|
| `github.read_repositories` | AUTO | Lists authenticated user's repos |
| `github.read_issues` | AUTO | `?state=open&per_page=20` |
| `github.read_prs` | AUTO | `?state=open&per_page=20` |
| `github.read_code` | AUTO | Fetches file contents by path |
| `github.read_branches` | AUTO | Lists branches |
| `github.create_issue` | NUDGE | `title, body, labels?` |
| `github.comment_issue` | NUDGE | `issueNumber, body` |
| `github.open_pr` | NUDGE | `title, body, head, base` |
| `github.close_issue` | STEP_UP | `issueNumber` |
| `github.merge_pr` / `merge_to_main` | STEP_UP | `prNumber, mergeMethod?` |
| `github.delete_branch` | STEP_UP | `branch` |

**Owner auto-resolution:** If `payload.owner` is omitted, the executor calls `GET https://api.github.com/user` with the user's token and uses `response.login` as the owner. This covers "my repo" use cases.

**Caveats:** `github.push_code` is a stub placeholder — it has no real git transport implementation.

### Gmail — 8 actions

`gmail.read_emails`, `gmail.search_emails`, `gmail.read_attachments`, `gmail.send_email` (`STEP_UP`), `gmail.reply_email`, `gmail.send_to_external` (`STEP_UP`), `gmail.delete_email` (`STEP_UP`), `gmail.send_bulk` (`STEP_UP`)

### Slack — 6 actions

`slack.read_channels` (AUTO), `slack.read_messages` (AUTO), `slack.read_dms` (AUTO), `slack.post_message` (NUDGE), `slack.send_dm` (NUDGE), `slack.post_to_general` (NUDGE), `slack.create_channel` (NUDGE)

### Notion — 4 actions

`notion.read_pages` (AUTO), `notion.search_pages` (AUTO), `notion.create_page` (NUDGE), `notion.update_page` (NUDGE), `notion.delete_page` (STEP_UP), `notion.share_page` (STEP_UP — may return informational response rather than a full workspace mutation)

---

## 12. Environment Variables

### API (`apps/api/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | `redis://localhost:6379` | Redis URL |
| `AUTH0_DOMAIN` | Yes | — | Auth0 tenant (e.g. `your-tenant.us.auth0.com`) |
| `AUTH0_AUDIENCE` | Yes | — | API identifier (e.g. `https://api.agentguardian.com`) |
| `AUTH0_CLIENT_ID` | Yes | — | SPA / regular web app client ID (used for OAuth connection redirect URLs) |
| `AUTH0_M2M_CLIENT_ID` | Yes | — | Management API M2M client ID |
| `AUTH0_M2M_CLIENT_SECRET` | Yes | — | Management API M2M client secret |
| `FRONTEND_URL` | Yes | `http://localhost:5173` | CORS origin + OAuth callback redirect target |
| `API_BASE_URL` | Yes | `http://localhost:3001` | Self-reference for OAuth `redirect_uri` |
| `VAPID_PUBLIC_KEY` | Optional | — | Web Push VAPID public key |
| `VAPID_PRIVATE_KEY` | Optional | — | Web Push VAPID private key |
| `OPENROUTER_API_KEY` | Optional | — | Used by the agent process, not the API |
| `NODE_ENV` | Optional | `development` | Set to `production` to disable dev fallbacks |
| `PORT` | Optional | `3001` | API listen port |

### Web (`apps/web/.env`)

| Variable | Required | Description |
|---|---|---|
| `VITE_AUTH0_DOMAIN` | Yes | Auth0 tenant domain |
| `VITE_AUTH0_CLIENT_ID` | Yes | SPA client ID |
| `VITE_AUTH0_AUDIENCE` | Yes | Must match `AUTH0_AUDIENCE` exactly |
| `VITE_API_BASE_URL` | Yes | API base URL (e.g. `http://localhost:3001`) |

> ℹ️ `VITE_*` variables are baked into the static bundle at build time. Rebuild after any change.

### Agent (`agent/.env`)

| Variable | Required | Description |
|---|---|---|
| `AUTH0_DOMAIN` | Yes | Auth0 tenant domain |
| `AUTH0_AUDIENCE` | Yes | Must match API audience |
| `AGENT_AUTH0_CLIENT_ID` | Yes | Agent M2M client ID |
| `AGENT_AUTH0_CLIENT_SECRET` | Yes | Agent M2M client secret |
| `GUARDIAN_API_URL` | Yes | API URL (default: `http://localhost:3001`) |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key |
| `OPENROUTER_MODEL` | Optional | Default: `openai/gpt-4o-mini` |

---

## 13. Local Development Workflow

Full setup steps: [README.md](README.md). Engineer-only quick reference:

```bash
npm install
docker-compose up -d             # PostgreSQL + Redis
cp .env.example apps/api/.env && cp .env.example apps/web/.env && cp agent/.env.example agent/.env
# fill in Auth0 credentials
npm run db:migrate
npm run db:seed
npm run dev                      # API :3001 + Web :5173
# second terminal:
npm run dev -w agent
```

**Critical startup order:**
1. API + web running
2. **Log in via the dashboard** — this calls `/auth/me` and creates your user row
3. Connect at least one service via **Connections**
4. Start the CLI agent

Skipping step 2 causes the agent's `whoami` to return 404 in development mode.

**Useful scripts:**

| Command | Purpose |
|---|---|
| `npm run db:studio` | Open Prisma Studio (visual DB browser) |
| `npm run db:migrate` | Run pending migrations |
| `npm run type-check` | TypeScript check without emit (all workspaces) |
| `npm run lint` | ESLint on `.ts` / `.tsx` |
| `npm run test` | Vitest (`--passWithNoTests` at root) |

---

## 14. Testing and CI

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on push and pull_request (Node 20):

```
npm ci → build packages/shared → type-check → lint → test
```

No integration tests yet — the test suite currently relies on unit tests with mocked dependencies. E2E coverage with a real Auth0 tenant and database is a future work item.

---

## 15. Implementation Notes and Caveats

- **`npm run dev` does not start the agent.** Start the agent in a second terminal.
- **User rows are lazy-created** via `GET /api/v1/auth/me`. Until this endpoint is hit (dashboard login), the agent cannot resolve the acting user in development mode.
- **Redis payload TTLs:** NUDGE payloads have a 180s (3-minute) TTL. STEP_UP payloads have a 360s (6-minute) TTL. The approval windows are 60s and 5 minutes respectively — the extra buffer is intentional to prevent race conditions.
- **NUDGE payload is deleted after execution.** If you call `executeApprovedAction` twice for the same job, the second call will have an empty payload. This is intentional — payloads are one-shot.
- **Auth0 Token Vault SDK compatibility:** The primary path calls `auth0Management.tokenVault.getToken()`. If the SDK version does not expose this method, the code catches the TypeError and falls back to reading `user.identities[n].access_token` via the Management API. The fallback requires `read:user_idp_tokens` scope on the Management API M2M application.
- **`github.push_code` is a stub.** It returns a metadata-only response; no actual git transport is implemented.
- **`notion.share_page`** may return an informational response rather than executing a full workspace permission mutation, depending on the Notion API version and OAuth scopes.
- **Dev step-up bypass is time-bounded.** Tokens issued more than 5 minutes ago will fail the bypass check even in development — re-authenticate to get a fresh token.
- **The `displaySummary` field is user-facing.** The LLM constructs this string; it appears verbatim in dashboard nudge cards and push notification bodies. Ensure it does not expose sensitive payload details.
- **All service cards sharing the loading spinner** was a known bug (fixed April 2026): `connectService.isPending` was global across all `ServiceCard` components. Now each card tracks its own `connectingService` state.

---

## 16. Connecting Services & Auth0 Token Vault

**Auth0 setup (per social connection):**

1. Auth0 Dashboard → **Authentication → Social** → create or edit the connection (GitHub, Google/Gmail, Slack, Notion).
2. Enable **Token Vault** (or "Store Tokens", depending on tenant version) on each connection.
3. Set scopes:
   - **GitHub:** `repo`, `read:user`, `user:email`
   - **Google (Gmail):** `https://www.googleapis.com/auth/gmail.modify`
   - **Slack:** `channels:read`, `chat:write`, `users:read`, `im:read`
   - **Notion:** per Notion's OAuth documentation
4. Management API M2M application → **APIs → Auth0 Management API → Scopes** → grant `read:user_idp_tokens`.

**Verify connections:**

```bash
# Get a Management API token
curl -s -X POST https://$AUTH0_DOMAIN/oauth/token \
  -H 'content-type: application/json' \
  -d "{\"client_id\":\"$AUTH0_M2M_CLIENT_ID\",\"client_secret\":\"$AUTH0_M2M_CLIENT_SECRET\",\"audience\":\"https://$AUTH0_DOMAIN/api/v2/\",\"grant_type\":\"client_credentials\"}" \
  | jq .access_token

# List connections
curl -s -H "Authorization: Bearer $MGMT_TOKEN" \
  "https://$AUTH0_DOMAIN/api/v2/connections" | jq '.[].name'
```

**Operational notes:**

- Revoking inside Agent Guardian calls `users.unlink()`, which removes the IDP identity immediately. Any subsequent token fetch for that service will throw `ServiceNotConnectedError`.
- Revoking directly at the provider (e.g. in GitHub settings) does not update the AgentGuardian database. The connection will show as ACTIVE until a token fetch fails and triggers the auto-revoke path.
- Connection state persists across API restarts (stored in PostgreSQL).

---

## 17. Production Agent: Auth0 M2M Action

The agent uses the **client credentials** grant with scope `agent:act`. For production, bind the agent to a specific human user by injecting a custom claim.

**Claim names (must match exactly between code and Auth0 Action):**

| Claim | Value | Where in code |
|---|---|---|
| `https://agentguardian.com/userId` | Auth0 `sub` of the human user | `routes/agent.ts`, `requireAgentOrDashboard` |
| `https://agentguardian.com/agentId` | Identifier for this agent process | Same |

**Auth0 Action setup:**

1. Auth0 Dashboard → **Actions → Library → Build Custom**
2. Trigger: **Machine to Machine**, runtime: Node 18+
3. Add the action to **Actions → Flows → Machine to Machine**
4. Deploy

**Example Action (adapt for your tenant):**

```javascript
exports.onExecuteCredentialsExchange = async (event, api) => {
  const AGENT_CLIENT_ID = 'YOUR_AGENT_M2M_CLIENT_ID';

  // Only inject claims for the agent application
  if (event.client.client_id !== AGENT_CLIENT_ID) return;

  // Hard-code for single-user, or read from client metadata for multi-user
  const userId = 'YOUR_AUTH0_USER_ID';  // e.g. 'github|12345678'

  api.accessToken.setCustomClaim('https://agentguardian.com/userId', userId);
  api.accessToken.setCustomClaim('https://agentguardian.com/agentId', 'agent-cli-prod');
};
```

**Finding the user's Auth0 ID:**
- Dashboard: `GET /api/v1/auth/me` response → `auth0UserId`
- Auth0 Dashboard: **User Management → Users** → copy `user_id`

**Multi-agent setup:** create separate Auth0 M2M applications per agent. Use `event.client.client_id` to route to the correct user claim in the Action. A single Action can handle all agents.

---

## 18. Acting User Resolution

Resolution happens in a single path: [`agent/src/auth/resolveActingUser.ts`](agent/src/auth/resolveActingUser.ts) → `GET /api/v1/agent/whoami`.

**Server-side logic (`GET /api/v1/agent/whoami`):**

```
1. Check JWT for custom claim: https://agentguardian.com/userId
   → Found + user exists in DB: return that user  ← PRODUCTION PATH

2. If NODE_ENV === 'development':
   → prisma.user.findFirst({ orderBy: { updatedAt: 'desc' } })
   → Return most recently active user             ← DEVELOPMENT PATH

3. Neither: 404 { error: 'no_acting_user', message: '...' }
```

**Development tip:** Log in as the intended user in the dashboard. The `/auth/me` call refreshes `updatedAt`, making that user the "most recent" and therefore the one the agent resolves to.

**Do not** use `AGENT_ACTING_AUTH0_USER_ID` environment variable headers — this mechanism was removed. The single resolution path above is authoritative.

---

## 19. Integrating with Other Agent Frameworks

Any system that can make HTTP requests can route actions through Agent Guardian.

### Core Pattern

```typescript
// Step 1: Get an M2M token (cache it; refresh 60s before expiry)
const tokenRes = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    grant_type: 'client_credentials',
    client_id: AGENT_AUTH0_CLIENT_ID,
    client_secret: AGENT_AUTH0_CLIENT_SECRET,
    audience: AUTH0_AUDIENCE,
    scope: 'agent:act',
  }),
});
const { access_token } = await tokenRes.json();

// Step 2: Route action through Guardian instead of calling provider directly
const res = await fetch(`${GUARDIAN_API_URL}/api/v1/agent/action`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${access_token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    service: 'github',
    actionType: 'github.create_issue',
    payload: { owner: 'acme', repo: 'backend', title: 'Fix bug', body: 'Details' },
    displaySummary: 'Create issue "Fix bug" in acme/backend',
  }),
});

const data = await res.json();
// data.status: 'EXECUTED' | 'PENDING_APPROVAL' | 'AWAITING_MFA' | 'FAILED'
```

### Handling Deferred Actions

```typescript
if (data.status === 'EXECUTED') {
  return data.data;  // immediate result
}

if (data.status === 'PENDING_APPROVAL') {
  // NUDGE: poll until resolved
  while (true) {
    await sleep(3000);
    const status = await fetch(`${GUARDIAN_API_URL}/api/v1/agent/action/${data.jobId}/status`, {
      headers: { 'Authorization': `Bearer ${access_token}` }
    }).then(r => r.json());

    if (status.status === 'APPROVED') return status.data;
    if (['DENIED', 'EXPIRED'].includes(status.status)) throw new Error(status.status);
  }
}

if (data.status === 'AWAITING_MFA') {
  // STEP_UP: notify user to visit data.challengeUrl
  // Poll similarly — resolves when user completes MFA in dashboard
}
```

Or subscribe to Socket.IO events: `nudge:resolved`, `nudge:expired`, `stepup:completed`.

### Compatible Frameworks

- **LangGraph / LangChain** — wrap Guardian API calls in custom tool nodes
- **CrewAI** — implement Guardian-backed tools in crew agents
- **AutoGPT** — replace direct provider SDK calls with Guardian endpoints
- **n8n** — HTTP Request nodes + webhook for Socket.IO events
- **Custom Python agents** — same REST API, any HTTP client

---

## 20. Production Deployment Outline

**Topology:** Reverse proxy (Nginx/Caddy) on 443 → Node API process → PostgreSQL + Redis (managed services or Docker Compose on the same host). Never expose the API port, PostgreSQL, or Redis directly to the internet.

**API startup:**

```bash
npm run build                           # build packages/shared → API
cd apps/api
NODE_ENV=production npx prisma migrate deploy
node dist/index.js                      # or use PM2 / systemd
```

**Web (static SPA):**

```bash
cd apps/web
npm run build                           # outputs to dist/
# Serve dist/ via Nginx static files or CDN
```

Rebuild the web bundle after any `VITE_*` environment variable change.

**Auth0 production URLs to register:**

- Allowed Callback URLs: `https://your-domain.com/callback`
- Allowed Logout URLs: `https://your-domain.com`
- Allowed Web Origins: `https://your-domain.com`
- OAuth connection callback: Auth0 handles this automatically via `redirect_uri` in the authorize URL

**Health check:**

```bash
curl -s https://your-domain.com/api/v1/auth/health
# → { "status": "ok", "timestamp": "...", "service": "agent-guardian-api" }
```

**Production environment checklist:**

- `NODE_ENV=production` — disables dev agent user fallback and dev step-up bypass
- `FRONTEND_URL` — public HTTPS origin, no trailing slash
- `API_BASE_URL` — public HTTPS API origin
- `AUTH0_M2M_CLIENT_ID` / `AUTH0_M2M_CLIENT_SECRET` — Management API credentials with `read:user_idp_tokens` scope
- Token Vault enabled on all social connections in Auth0
- VAPID keys configured for Web Push (optional but recommended)
- Auth0 M2M Action deployed and injecting `https://agentguardian.com/userId` claim into agent tokens
- TLS certificate on the reverse proxy (Let's Encrypt / cloud LB)

---

## 21. Summary

Agent Guardian provides:

- **Dashboard** — Auth0 login, per-service connections, per-action tier configuration, real-time nudge approval, MFA step-up, audit log with stats
- **API** — JWT validation for both human and M2M tokens, tier classification, three-path orchestration, Auth0 Token Vault integration, BullMQ timeout workers, Socket.IO + Web Push notifications, immutable audit trail
- **Agent CLI** — Auth0 M2M authentication, LLM (OpenRouter) with the `execute_action` tool, approval polling, git context awareness
- **Shared package** — canonical action catalog, default tier map, service→connection mapping consumed by both API and agent

All provider credentials flow through Auth0 Token Vault; the application database never holds raw OAuth tokens. Action payloads are ephemeral (Redis TTL); only their SHA-256 hash is persisted. Unknown action types default to `STEP_UP` — the system fails closed.
