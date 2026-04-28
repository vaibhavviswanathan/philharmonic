# Philharmonic — Self-hosted Coding-Agent Task Manager on Cloudflare

**Spec version:** 1.0
**Audience:** an autonomous Claude Code agent building this end-to-end with no human supervision.
**Reading order:** read this whole document before writing any code. Then build in the order given in §17. Verify each milestone against §18 before moving to the next.

---

## 0. What you are building

A single, self-hosted web app deployed entirely on Cloudflare that lets a small team:

1. Create and triage coding tasks in a kanban-style UI.
2. Mark a task "ready" and have an autonomous Claude agent implement it: clone the repo, write code, run tests, open a pull request, and attach proof of work.
3. Watch the agent's progress live in the browser (status, comments, PR link, preview URLs).
4. Approve or send back the result.

This is a Cloudflare-native re-imagining of OpenAI's Symphony, with Linear replaced by a hosted task tracker and Codex replaced by Claude.

This spec is **prescriptive**. Where it makes a decision (library, schema, route shape), follow that decision. Do not substitute alternatives without an extremely good reason. If you find yourself wanting to deviate, write the deviation and reasoning into a `DEVIATIONS.md` so the next reader can see it.

---

## 0.5. Open-source readiness — "Deploy to Cloudflare" button

This repo is intended to be open-sourced and deployable to anyone's Cloudflare account in two clicks. There are two installation paths and **both must work**:

### Path A — One-click (the README's primary CTA)

A "Deploy to Cloudflare" button at the top of the README pointing at `https://deploy.workers.cloudflare.com/?url=https://github.com/<ORG>/philharmonic`. When clicked, Cloudflare:

1. Forks the repo into the user's GitHub account.
2. Reads `wrangler.jsonc` and provisions all declared resources automatically (D1, R2, KV, Secrets Store).
3. Prompts the user for any secrets declared via `secrets_store_secrets`.
4. Builds (using the `build` script) and deploys.
5. Connects the new GitHub fork to Workers Builds for ongoing CI/CD.

### Path B — Manual (`pnpm bootstrap && pnpm deploy`)

A TypeScript script at `scripts/bootstrap.ts` that does the equivalent locally for users cloning the repo manually. It uses the Wrangler CLI under the hood — same outcome, same end state.

### Constraints both paths must honor

- **`wrangler.jsonc` lives at the repository root.** Not in `apps/worker/`. The Deploy button does not handle subdirectories well in monorepos, and a root-level config keeps the auto-provisioner happy.
- **Resource IDs use the empty-string placeholder pattern.** For example, `"database_id": ""` for D1. The Deploy button's auto-provisioner detects empty IDs and fills them in with newly created resources. The bootstrap script does the same via `wrangler d1 create` and writes the result back.
- **All required secrets are declared in `secrets_store_secrets`** so the Deploy UI knows to prompt for them. Don't use ad-hoc `wrangler secret put` for user-supplied secrets — those won't be discoverable.
- **The build command (`pnpm build`) must succeed from a fresh clone** with no Cloudflare state. It should not assume any resource exists. This means: don't run migrations during build, don't call wrangler, don't read from D1.
- **The repo must include a clean `LICENSE` file (MIT).**
- **No PII, no secrets, no internal URLs in the repo.** Use `<YOUR_TEAM>` / `<YOUR_DOMAIN>` placeholders that the README and Deploy UI explain how to fill.

### Things the user does manually after Deploy

These cannot be automated by either path:

- Configure Cloudflare Access in the dashboard, point at the deployed Worker hostname.
- Set the `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` vars (instructed in the README and the post-deploy welcome screen of the Philharmonic app itself).
- Optional: bind a custom domain.

Document both paths and the manual follow-up clearly in the README.

---

## 1. Philosophy and non-goals

**Philosophy**

- The user manages tasks, not agents. Once a task is "ready", the platform owns the implementation loop end-to-end.
- The agent must produce **proof of work** (PR, CI status, screenshots, walkthroughs) — not a chain-of-thought transcript. Reviewers look at evidence on the task card.
- Credentials never enter the agent's container. All outbound auth is injected at the network edge.
- One task = one isolated workspace = one container. No cross-task contamination.
- Failures are normal. The Workflow layer makes them durable and resumable.

**Non-goals (do not build)**

- Multi-tenant SaaS. This is single-account, deployed by one team for itself.
- A general-purpose project management tool. No epics, sprints, time tracking, custom fields, or burndown charts.
- A bring-your-own-LLM abstraction. Claude only. Anthropic API only.
- Mobile app. Web only. Responsive is fine; native is out of scope.
- Email notifications, slack integrations, calendar sync. Not in v1.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Project** | A connected GitHub repo with its own settings and `WORKFLOW.md` template. |
| **Task** | A unit of work in a project. Has a status (backlog → ready → running → review → done). |
| **Run** | One attempt by an agent to implement a task. A task may have multiple runs if the first fails or is rejected. |
| **Sandbox** | A Cloudflare Sandbox SDK container, identified by `task_id`. The agent's workspace. |
| **Orchestrator** | A single Durable Object that owns task claiming and concurrency limits. |
| **TasksRoom** | A per-project Durable Object that fans out live updates over WebSocket. |
| **Tasks MCP** | An MCP server running inside the sandbox so the agent can read/write tasks. |
| **Run token** | A short-lived HMAC-signed token scoped to one `run_id`, used by the agent to call back into the API. |
| **Proof of work** | Artifacts attached to a run: PR link, CI summary, screenshots, walkthrough video. |

---

## 3. Tech stack (decided — do not change)

| Concern | Choice |
|---|---|
| Frontend framework | React 18 + Vite |
| Styling | Tailwind CSS |
| Frontend deployment | Workers Static Assets (single Worker serves SPA + API) |
| API framework | Hono |
| Database | Cloudflare D1 |
| ORM | Drizzle ORM |
| Real-time | Durable Object + WebSocket Hibernation API |
| Background work | Cloudflare Queues |
| Long-running orchestration | Cloudflare Workflows |
| Sandboxing | `@cloudflare/sandbox` (Sandbox SDK) |
| Agent runtime | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), invoked headlessly inside the sandbox |
| Auth (humans) | Cloudflare Access in front of the Worker |
| Auth (agents) | HMAC-signed run tokens minted by the API |
| Secrets | Cloudflare Secrets Store |
| Object storage | R2 (artifacts, sandbox snapshots, walkthrough videos) |
| Language | TypeScript everywhere, strict mode on |
| Package manager | pnpm with workspaces |
| Lint/format | Biome (one tool, both jobs) |
| Test runner | Vitest with `@cloudflare/vitest-pool-workers` |

---

## 4. Repository layout

Use a monorepo with pnpm workspaces. **Note:** `wrangler.jsonc` and `migrations/` live at the **repo root** for Deploy-to-Cloudflare button compatibility (see §0.5).

```
philharmonic/
├── package.json                    # root, defines workspaces + scripts (build, deploy, bootstrap)
├── pnpm-workspace.yaml
├── wrangler.jsonc                  # AT ROOT — Deploy button reads this
├── biome.json
├── tsconfig.base.json
├── README.md                       # Deploy to Cloudflare button + getting started
├── SPEC.md                         # this file
├── DEVIATIONS.md                   # if you needed to deviate, document here
├── LICENSE                         # MIT
├── .github/
│   └── workflows/
│       └── deploy.yml              # GitHub Actions: deploy on push to main
│
├── migrations/                     # D1 migrations at root (drizzle-kit output)
│   └── 0000_initial.sql
│
├── apps/
│   ├── web/                        # Vite React SPA
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   ├── tailwind.config.ts
│   │   ├── src/
│   │   │   ├── main.tsx
│   │   │   ├── App.tsx
│   │   │   ├── routes/
│   │   │   │   ├── Board.tsx
│   │   │   │   ├── TaskDetail.tsx
│   │   │   │   ├── RunViewer.tsx
│   │   │   │   ├── ProjectSettings.tsx
│   │   │   │   └── PostDeploySetup.tsx  # shown when ACCESS_AUD is unset
│   │   │   ├── components/
│   │   │   ├── lib/
│   │   │   │   ├── api.ts          # fetch wrappers
│   │   │   │   ├── ws.ts           # WebSocket client
│   │   │   │   └── store.ts        # Zustand store
│   │   │   └── styles.css
│   │   └── package.json
│   │
│   └── worker/                     # the Cloudflare Worker source
│       ├── src/
│       │   ├── index.ts            # entry: serves static assets + /api + /ws
│       │   ├── api/
│       │   │   ├── auth.ts         # Access JWT verification middleware
│       │   │   ├── projects.ts
│       │   │   ├── tasks.ts
│       │   │   ├── runs.ts
│       │   │   ├── events.ts
│       │   │   ├── artifacts.ts
│       │   │   └── internal.ts     # endpoints for Tasks MCP (run-token auth)
│       │   ├── do/
│       │   │   ├── TasksRoom.ts    # WebSocket fanout per project
│       │   │   └── Orchestrator.ts # singleton task claimer
│       │   ├── workflow/
│       │   │   └── ImplementationRun.ts
│       │   ├── queue/
│       │   │   └── consumer.ts
│       │   ├── sandbox/
│       │   │   └── Sandbox.ts      # re-export from @cloudflare/sandbox
│       │   ├── outbound/
│       │   │   └── outbound.ts     # egress proxy Worker
│       │   ├── lib/
│       │   │   ├── db.ts           # Drizzle client
│       │   │   ├── schema.ts       # Drizzle schema
│       │   │   ├── runtoken.ts     # HMAC mint + verify
│       │   │   ├── workflowmd.ts   # render WORKFLOW.md prompts
│       │   │   └── broadcast.ts    # helper to push events into TasksRoom
│       │   └── types.ts
│       └── package.json
│
├── containers/
│   └── sandbox/
│       ├── Dockerfile              # base image for all task sandboxes
│       ├── entrypoint.sh
│       ├── WORKFLOW.md             # default prompt template (shipped to new projects)
│       └── mcp/
│           ├── tasks-mcp/          # the Tasks MCP server (Node)
│           │   ├── package.json
│           │   ├── src/index.ts
│           │   └── tsconfig.json
│           └── README.md
│
├── packages/
│   └── shared/                     # types shared between web, worker, mcp
│       ├── package.json
│       └── src/
│           ├── index.ts
│           ├── ws-protocol.ts      # WebSocket message shapes
│           └── api-types.ts        # request/response DTOs
│
└── scripts/
    ├── bootstrap.ts                # Path B installer (see §17)
    ├── seed.ts                     # seed a project + a few tasks for dev
    └── postdeploy.ts               # runs `wrangler d1 migrations apply --remote` after deploy
```

Root `package.json` scripts (these are the public API of the repo):

```json
{
  "scripts": {
    "bootstrap": "tsx scripts/bootstrap.ts",
    "build": "pnpm -r build && pnpm --filter web build",
    "dev": "wrangler dev",
    "deploy": "pnpm build && wrangler deploy && tsx scripts/postdeploy.ts",
    "migrate:local": "wrangler d1 migrations apply philharmonic --local",
    "migrate:remote": "wrangler d1 migrations apply philharmonic --remote",
    "seed": "tsx scripts/seed.ts"
  }
}
```

The web app is built into `apps/web/dist/` and served via the Workers Static Assets binding (`ASSETS`). **Single deployable Worker.**

---

## 5. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                       Cloudflare Access                          │
│         (SSO — Google/GitHub/email OTP, sets JWT)                │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
         ┌─────────────────────────────────────────────┐
         │           API Worker (Hono)                 │
         │  • verifies Cf-Access-Jwt-Assertion         │
         │  • REST /api/*                              │
         │  • WS  /ws/projects/:id  → TasksRoom DO     │
         │  • internal /api/internal/*  (run-token)    │
         │  • serves SPA static assets at /            │
         └─────┬─────────────┬─────────────┬───────────┘
               │             │             │
               ▼             ▼             ▼
           ┌──────┐    ┌─────────────┐  ┌──────────────┐
           │  D1  │    │ TasksRoom   │  │   Queue      │
           │ SQL  │    │ DO (WS)     │  │ (dispatch)   │
           └──────┘    └─────────────┘  └──────┬───────┘
                                               ▼
                                  ┌──────────────────────────┐
                                  │  Orchestrator DO          │
                                  │  • claims tasks           │
                                  │  • enforces concurrency   │
                                  │  • spawns Workflow        │
                                  └──────────────┬───────────┘
                                                 ▼
                                  ┌──────────────────────────┐
                                  │ ImplementationRun         │
                                  │ Workflow (durable)        │
                                  │  prepare→runAgent→        │
                                  │  land→cleanup             │
                                  └──────────────┬───────────┘
                                                 ▼
                                  ┌──────────────────────────┐
                                  │ Sandbox (per task)        │
                                  │  • Claude Agent SDK       │
                                  │  • Tasks MCP (stdio)      │
                                  │  • git, gh, node, deno    │
                                  │  • /workspace = repo      │
                                  └──────────────┬───────────┘
                                                 ▼
                                  ┌──────────────────────────┐
                                  │ Outbound Worker (egress)  │
                                  │ injects GitHub + Anthropic│
                                  │ tokens; agent never sees  │
                                  └────┬─────────────────┬────┘
                                       ▼                 ▼
                                  ┌────────┐      ┌────────────┐
                                  │ GitHub │      │ Anthropic  │
                                  └────────┘      └────────────┘
```

---

## 6. Data model (D1)

Use Drizzle ORM. Generate migrations with drizzle-kit. SQLite dialect.

### 6.1 Schema

```typescript
// apps/worker/src/lib/schema.ts
import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),                          // ulid
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),                // url-safe
  repoUrl: text('repo_url').notNull(),                  // https://github.com/org/repo
  defaultBranch: text('default_branch').notNull().default('main'),
  workflowMd: text('workflow_md').notNull(),            // the prompt template
  concurrencyLimit: integer('concurrency_limit').notNull().default(2),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),                          // ulid
  projectId: text('project_id').notNull().references(() => projects.id),
  number: integer('number').notNull(),                  // human-readable, per-project sequence
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status', {
    enum: ['backlog', 'ready', 'running', 'review', 'done', 'cancelled']
  }).notNull().default('backlog'),
  priority: integer('priority').notNull().default(2),   // 0=urgent, 1=high, 2=normal, 3=low
  createdBy: text('created_by').notNull(),              // email from Access JWT
  assignee: text('assignee'),                           // email or 'agent'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => ({
  projectStatusIdx: index('tasks_project_status').on(t.projectId, t.status),
  numberIdx: index('tasks_project_number').on(t.projectId, t.number),
}));

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),                          // ulid
  taskId: text('task_id').notNull().references(() => tasks.id),
  workflowInstanceId: text('workflow_instance_id'),     // Cloudflare Workflow id
  sandboxId: text('sandbox_id').notNull(),              // == taskId for v1
  status: text('status', {
    enum: ['queued', 'preparing', 'running', 'landing', 'succeeded', 'failed', 'cancelled']
  }).notNull().default('queued'),
  prUrl: text('pr_url'),
  errorMessage: text('error_message'),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }),
  endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => ({
  taskIdx: index('runs_task').on(t.taskId),
}));

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),                          // ulid
  taskId: text('task_id').notNull().references(() => tasks.id),
  runId: text('run_id').references(() => runs.id),      // null for human comments
  type: text('type', {
    enum: ['comment', 'status_change', 'agent_action', 'proof', 'system']
  }).notNull(),
  author: text('author').notNull(),                     // email or 'agent' or 'system'
  payload: text('payload', { mode: 'json' }).notNull(), // JSON object
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => ({
  taskIdx: index('events_task_created').on(t.taskId, t.createdAt),
}));

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  kind: text('kind', {
    enum: ['pr_diff', 'screenshot', 'video', 'logs', 'ci_summary', 'other']
  }).notNull(),
  r2Key: text('r2_key').notNull(),
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  caption: text('caption'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
```

### 6.2 Notes on the schema

- `tasks.number` is per-project — like `PHIL-1`, `PHIL-2`. Allocate it in a transaction when creating a task: `select max(number) where project_id = ? + 1`.
- `events` is the source of truth for everything that happens on a task. The UI renders this in chronological order. Comments, status changes, agent actions, and proof-of-work attachments are all events.
- The `payload` JSON column is intentionally schemaless. Document the shapes per `type` in `packages/shared/src/api-types.ts`.
- Do not add foreign-key cascades that delete data. Soft-delete only (add `deletedAt` to projects/tasks if needed; not needed in v1).

### 6.3 Initial migration

Generate the initial migration with `pnpm --filter worker drizzle-kit generate`. Commit the SQL file. Apply locally with `wrangler d1 migrations apply DB --local`. Document the production apply command in the README.

---

## 7. Authentication

### 7.1 Cloudflare Access (humans)

Cloudflare Access sits in front of the entire Worker, configured outside the application (in the dashboard). When a request reaches the Worker, it carries a `Cf-Access-Jwt-Assertion` header.

**You must verify this header on every authenticated request.** Do not trust it without verification; an attacker who bypasses Access (e.g. internal traffic) could forge the header otherwise.

Implement verification in `apps/worker/src/api/auth.ts`:

```typescript
import { jwtVerify, createRemoteJWKSet } from 'jose';

const TEAM_DOMAIN = 'https://YOUR_TEAM.cloudflareaccess.com'; // set via env
const POLICY_AUD = 'YOUR_ACCESS_AUD';                         // set via env

const JWKS = createRemoteJWKSet(new URL(`${TEAM_DOMAIN}/cdn-cgi/access/certs`));

export async function verifyAccessJwt(request: Request): Promise<{
  email: string;
  sub: string;
  identityNonce?: string;
}> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new Response('Unauthorized', { status: 401 });

  const { payload } = await jwtVerify(token, JWKS, {
    issuer: TEAM_DOMAIN,
    audience: POLICY_AUD,
  });

  return {
    email: payload.email as string,
    sub: payload.sub as string,
    identityNonce: payload.identity_nonce as string | undefined,
  };
}
```

Wrap this in a Hono middleware that stashes the user on the context (`c.set('user', ...)`). Apply it to all `/api/*` routes **except** `/api/internal/*` (those use run tokens — see §7.2).

The team domain and audience must come from `wrangler.jsonc` vars, not from secrets — they're not sensitive but they vary by deployment.

### 7.2 Run tokens (agents)

Agents run inside sandboxes and need to call back into your API to read tasks, post comments, attach proof of work. They cannot use Access JWTs because they aren't humans.

Mint a short-lived HMAC-signed token when the Workflow starts a run. Inject it into the sandbox via env. The Tasks MCP attaches it on every API call. The API verifies it at `/api/internal/*`.

Token format (compact, custom — don't use a full JWT lib for this):

```
v1.<base64url-payload>.<base64url-hmac>

payload = { runId: string, taskId: string, projectId: string, exp: number }
hmac    = HMAC-SHA256(secret = env.RUN_TOKEN_SECRET, message = `v1.${payload}`)
```

Implementation in `apps/worker/src/lib/runtoken.ts` — provide `mint(claims, secret, ttlSec)` and `verify(token, secret)` functions. TTL: 24 hours (long enough for slow CI; revoke at run-end by adding to a revocation set in Workers KV if needed — not required for v1).

The `/api/internal/*` middleware verifies the token and exposes `runId`/`taskId` on the context. **All internal endpoints must check that the action targets the run/task in the token.** A token for run X cannot post comments on task Y.

### 7.3 Required secrets

Stored in Cloudflare Secrets Store (preferred) or as Worker secrets:

| Name | Purpose |
|---|---|
| `RUN_TOKEN_SECRET` | HMAC key for run tokens (generate 32 random bytes, base64) |
| `GITHUB_TOKEN` | Fine-grained PAT or GitHub App token; used only by egress proxy |
| `ANTHROPIC_API_KEY` | Claude API key; used only by egress proxy |
| `INTERNAL_API_TOKEN` | Token the Workflow uses to authenticate as itself when calling the Worker (e.g. to broadcast events). Generate 32 random bytes. |

Document in the README how to set each. **Never log a secret value.** Never include them in API responses. Never expose them in the SPA bundle.

---

## 8. API surface

All routes return JSON unless noted. All authenticated routes require either a valid Access JWT (`/api/*`) or a valid run token (`/api/internal/*`). Errors follow the shape `{ error: { code: string, message: string } }`.

### 8.1 REST (human routes — `/api/*`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/me` | `{ email, displayName }` from Access JWT |
| GET | `/api/projects` | list projects |
| POST | `/api/projects` | create project — body: `{ name, slug, repoUrl, workflowMd? }` |
| GET | `/api/projects/:id` | get project |
| PATCH | `/api/projects/:id` | update project (including `workflowMd`) |
| GET | `/api/projects/:id/tasks` | list tasks; query params `?status=ready&assignee=me` |
| POST | `/api/projects/:id/tasks` | create task — body: `{ title, description?, priority? }` |
| GET | `/api/tasks/:id` | task with most recent run summary |
| PATCH | `/api/tasks/:id` | update task (`title`, `description`, `priority`, `assignee`) |
| POST | `/api/tasks/:id/transition` | change status — body: `{ to: 'ready'|'cancelled'|... }` |
| POST | `/api/tasks/:id/comments` | add a comment — body: `{ body }` |
| GET | `/api/tasks/:id/events` | paginated event feed; query `?before=<ulid>&limit=50` |
| GET | `/api/tasks/:id/runs` | list runs for task |
| GET | `/api/runs/:id` | run detail with artifacts |
| GET | `/api/runs/:id/artifacts/:artifactId` | redirect to a signed R2 URL |
| POST | `/api/runs/:id/cancel` | cancel an in-progress run |

**Status transition rules** (enforce in the handler):

- `backlog → ready` — anyone with access
- `ready → running` — only the Orchestrator (write a guard so humans get 403)
- `running → review` — only the Workflow (run token)
- `review → done` — anyone with access (this is the human "approve" action)
- `review → ready` — anyone with access ("send back")
- `* → cancelled` — anyone with access; also cancels any running Workflow

When a task transitions to `ready`, send a message to the dispatch Queue. When a task transitions to `cancelled` and has an active run, call `Workflow.terminate(workflowInstanceId)` and `getSandbox(env.Sandbox, taskId).destroy()`.

### 8.2 Internal routes (agent routes — `/api/internal/*`)

These use run-token auth. The token's `runId` and `taskId` define the scope.

| Method | Path | Description |
|---|---|---|
| GET | `/api/internal/task` | get the task referenced by the run token |
| POST | `/api/internal/comments` | add an agent comment to that task |
| POST | `/api/internal/status` | transition the task (only `running → review` allowed) |
| POST | `/api/internal/proof` | attach proof of work — body: `{ kind, caption?, content }` for text or `{ kind, caption?, uploadId }` after using the upload endpoint below |
| POST | `/api/internal/uploads` | request a signed R2 upload URL — body: `{ filename, contentType, sizeBytes }`; response: `{ uploadUrl, uploadId }` |
| POST | `/api/internal/runs/log` | append agent log lines (used for the live run viewer) — body: `{ lines: string[] }` |

Every write here also broadcasts an event to the TasksRoom DO (see §10).

### 8.3 WebSocket — `/ws/projects/:id`

Authenticated via Access JWT (the Worker validates before upgrading). Routed to the project's TasksRoom DO. See §10 for the protocol.

### 8.4 Static assets

Everything else is served from the SPA build. Use Workers Static Assets with `not_found_handling = "single-page-application"`. The SPA does its own client-side routing.

---

## 9. Frontend

### 9.1 Pages

- **`/`** — redirects to `/projects/<first>` if there's one project, otherwise the project list.
- **`/projects`** — list of projects, "new project" button.
- **`/projects/:slug`** — kanban board. Columns: Backlog · Ready · Running · Review · Done. Drag-and-drop between columns calls `/api/tasks/:id/transition`. New-task button opens a modal.
- **`/projects/:slug/tasks/:number`** — task detail. Shows title, description (markdown rendered), priority, assignee, the activity feed (events), and proof-of-work artifacts at the top once present. Big action buttons:
  - status `backlog` or `ready`: "Run now" (transitions to `ready` if not already; the orchestrator picks it up)
  - status `running`: "Open run viewer" + "Cancel run"
  - status `review`: "Approve & merge" + "Send back"
- **`/projects/:slug/tasks/:number/runs/:runId`** — the run viewer. Live agent log (streaming via WS), embedded sandbox preview iframe if the agent exposed a port, PR link with CI status badge.
- **`/projects/:slug/settings`** — edit project metadata, edit `WORKFLOW.md` in a Monaco editor with a "Save & reload" button.

### 9.2 State management

Use Zustand for client state. Three stores:

- `useAuth()` — `{ email, displayName }` from `/api/me`.
- `useProject(slug)` — current project, tasks indexed by id, runs by id, events by task id.
- `useRunStream(runId)` — log lines for an in-flight run.

The WebSocket client (`apps/web/src/lib/ws.ts`) connects on board mount and dispatches incoming messages into the store. Keep one WS per open project tab. Reconnect with exponential backoff (start 250ms, cap 30s, jitter ±20%).

### 9.3 UX rules

- Optimistic updates on drag-and-drop and comment posts. Roll back on API error.
- Show skeletons during initial load, never spinners on subsequent navigations (the store keeps data warm).
- Activity feed is **append-only** in the UI. New events animate in at the bottom. Don't re-render the whole list.
- The run viewer log auto-scrolls to bottom unless the user has scrolled up; then show a "jump to latest" pill.
- Use Tailwind's `prose` for rendered markdown. Use `react-markdown` + `remark-gfm`.

### 9.4 Visual style

Clean, dense, keyboard-friendly. Think Linear, not Trello. Monospace for IDs and code. No animations longer than 200ms. Dark mode is the only mode (saves you from theming). Color palette: slate background, indigo accents, green/amber/red for status semantics.

---

## 10. TasksRoom Durable Object

One instance per project (use `env.TasksRoom.idFromName(projectId)`).

### 10.1 Responsibilities

- Accept WebSocket connections for clients viewing the project board.
- Receive broadcast messages from the API Worker (via `fetch()` to the DO, internal route).
- Fan out to all connected clients, filtering by what each client cares about.
- Use the **WebSocket Hibernation API** (`acceptWebSocket`, `webSocketMessage`, `webSocketClose`). Do not use the legacy event-listener API. This is non-negotiable; hibernation makes idle DOs free.

### 10.2 Message protocol

Define in `packages/shared/src/ws-protocol.ts`. All messages are JSON.

**Server → client**

```typescript
type ServerMessage =
  | { type: 'hello'; projectId: string; serverTime: number }
  | { type: 'task.created'; task: Task }
  | { type: 'task.updated'; task: Task }
  | { type: 'task.deleted'; taskId: string }
  | { type: 'event.created'; taskId: string; event: Event }
  | { type: 'run.created'; run: Run }
  | { type: 'run.updated'; run: Run }
  | { type: 'run.log'; runId: string; lines: string[] }
  | { type: 'pong'; t: number };
```

**Client → server**

```typescript
type ClientMessage =
  | { type: 'subscribe.run'; runId: string }    // start receiving run.log for this run
  | { type: 'unsubscribe.run'; runId: string }
  | { type: 'ping'; t: number };
```

Default subscription: when a client connects, they get all `task.*`, `event.*`, and `run.created`/`run.updated` for the project. They opt-in to `run.log` per-run because logs are noisy.

### 10.3 Internal broadcast endpoint

The DO exposes an internal `fetch()` route — `POST /broadcast` — that the API Worker calls to emit a message. Authenticate this with `INTERNAL_API_TOKEN` in a header. The API helper `broadcast.ts` should be the only place this is called from.

### 10.4 Liveness

Send `pong` in response to client `ping`. If a client doesn't ping for 60s, close the socket (set an alarm to scan attachments). On reconnect, the client refetches the latest state via REST and resubscribes — do not implement message replay in v1.

---

## 11. Orchestrator Durable Object

Singleton — always addressed as `env.Orchestrator.idFromName('singleton')`.

### 11.1 Responsibilities

- Consume messages from the dispatch Queue.
- For each ready task, check whether the project is below its concurrency limit. If yes, claim the task (transition to `running`, create a `runs` row with status `queued`), and start a Workflow instance. If no, leave the message and let the queue redeliver later (set `delaySeconds`).
- Maintain a counter per project of in-flight runs. Decrement when the Workflow signals completion via `/api/internal/orchestrator/run-finished` (or just re-poll D1 — simpler, do this).
- DO alarm fires every 60s and reconciles: any task in `running` with no active workflow → mark its run `failed`, transition task back to `ready`. Any sandbox older than 24h with no associated run → destroy it.

### 11.2 Single-leader semantics

Because there's exactly one Orchestrator instance, claims are serialized — no race between two pollers grabbing the same task. Use `this.state.storage.transaction` for the claim + run-create write to D1 if you need atomicity, though writing them in sequence with proper status checks is fine.

### 11.3 Concurrency

`projects.concurrencyLimit` defaults to 2. The Orchestrator counts `runs` rows where `status IN ('queued','preparing','running','landing')` for the project. If `count >= limit`, requeue the message with a 30-second delay.

---

## 12. ImplementationRun Workflow

Cloudflare Workflows class. Binding name `RUN`. One instance per run.

### 12.1 Steps

```typescript
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

type Params = { runId: string; taskId: string; projectId: string };

export class ImplementationRun extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { runId, taskId, projectId } = event.payload;

    // Step 1 — prepare sandbox + workspace
    const { repoUrl, branch, prompt } = await step.do('prepare', async () => {
      // load project + task from D1
      // render WORKFLOW.md → prompt
      // mint run token
      // start sandbox: getSandbox(env.Sandbox, taskId)
      // gitCheckout into /workspace
      // write /workspace/.philharmonic/prompt.md
      // write /workspace/.philharmonic/run-token (chmod 600)
      // update run.status = 'preparing'
      // broadcast run.updated
      return { repoUrl, branch, prompt };
    });

    // Step 2 — run the agent
    const agentResult = await step.do(
      'runAgent',
      { retries: { limit: 1, delay: '30 seconds' }, timeout: '2 hours' },
      async () => {
        // update run.status = 'running'
        // broadcast run.updated
        // sandbox.exec('claude -p "$(cat .philharmonic/prompt.md)" \
        //              --output-format=stream-json \
        //              --mcp-config .philharmonic/mcp.json \
        //              --permission-mode=acceptEdits',
        //              { cwd: '/workspace', stream: true })
        // pipe stdout lines → /api/internal/runs/log (which broadcasts run.log)
        // collect final result
        return { exitCode, summary, branchName };
      }
    );

    // Step 3 — land (open PR, attach proof)
    await step.do('land', { retries: { limit: 2 } }, async () => {
      // update run.status = 'landing'
      // sandbox.exec('gh pr create ...') via egress proxy
      // attach pr_diff, ci_summary, screenshots to artifacts table
      // transition task to 'review'  (use internal run-token endpoint)
      // run.prUrl = ..., run.status = 'succeeded'
      // broadcast
    });

    // Step 4 — cleanup
    await step.do('cleanup', async () => {
      // sandbox.createBackup({ destination: 'r2://snapshots/<runId>' })  // optional
      // sandbox.destroy()
      // run.endedAt = now
      // broadcast
    });
  }
}
```

### 12.2 Failure handling

- If `runAgent` fails after retries: mark run `failed`, write `errorMessage`, transition task back to `ready` (so a human can intervene), broadcast.
- If `land` fails after retries: mark run `failed`, leave task in `running` or transition back to `ready` (your choice — pick one and document it). PR may already be open — that's fine; the human can finish it manually.
- If the task is cancelled during the run: the `cancel` endpoint calls `env.RUN.terminate(workflowInstanceId)` which throws `WorkflowAbort` inside the step. The cleanup step still runs in a `try/finally` — ensure sandbox is destroyed.

### 12.3 Long sleeps

The land step may need to wait for CI. Use `step.sleep('wait for ci', '5 minutes')` in a polling loop, up to a total of 30 minutes. Don't burn CPU spinning. Workflows handle long sleeps for free — that's their whole point.

### 12.4 Step idempotence

Every `step.do` body must be safe to re-execute. Use D1 upserts and check current run status before transitioning. Never assume "this is the first time we've run this step."

---

## 13. Sandbox container

### 13.1 Image

`containers/sandbox/Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim

# system tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates jq ripgrep fd-find python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Claude CLI (headless agent runtime)
RUN npm install -g @anthropic-ai/claude-code

# Pre-install Tasks MCP server
COPY mcp/tasks-mcp /opt/tasks-mcp
WORKDIR /opt/tasks-mcp
RUN npm ci && npm run build

# entrypoint
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace
ENV PATH="/usr/local/bin:${PATH}"
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

`entrypoint.sh` is the minimal shell that the Sandbox SDK control plane runs against. Default to a no-op that keeps the container alive (`tail -f /dev/null`) — actual work is invoked via `sandbox.exec()`.

### 13.2 What the Workflow writes into the sandbox

Before running the agent, write three files into `/workspace/.philharmonic/`:

- `prompt.md` — the rendered prompt from `WORKFLOW.md` plus task title + description
- `run-token` — the HMAC run token, mode 600
- `mcp.json` — the MCP config the Claude CLI loads:

```json
{
  "mcpServers": {
    "philharmonic": {
      "command": "node",
      "args": ["/opt/tasks-mcp/dist/index.js"],
      "env": {
        "PHILHARMONIC_API_BASE": "https://tasks.your-domain.com",
        "PHILHARMONIC_RUN_TOKEN_FILE": "/workspace/.philharmonic/run-token"
      }
    }
  }
}
```

### 13.3 Agent invocation

Inside the sandbox, the Workflow runs:

```bash
claude -p "$(cat /workspace/.philharmonic/prompt.md)" \
  --output-format=stream-json \
  --mcp-config /workspace/.philharmonic/mcp.json \
  --permission-mode=acceptEdits \
  --max-turns 100
```

`acceptEdits` allows the agent to edit files and run commands without per-action prompts (there's no human in the loop). `--max-turns 100` is a budget — task too big? It returns and the run fails cleanly.

Capture stdout. It's newline-delimited JSON, one event per line. Forward each line to `/api/internal/runs/log` so the run viewer streams. Also persist the full stream as an `artifacts` row of kind `logs` at the end.

### 13.4 What the agent is told

The `WORKFLOW.md` template is per-project. Default content (use this when creating a project if the user doesn't supply one):

```markdown
You are a coding agent implementing a task in the {{ project.name }} repository.

## Task

**{{ task.identifier }}: {{ task.title }}**

{{ task.description }}

## Your job

1. Understand the codebase. Read the README, look at the directory structure.
2. Make a plan. Use the philharmonic.post_comment tool to share it with the team.
3. Implement the change. Follow the project's conventions — match the surrounding code style.
4. Run tests. Make sure they pass before opening a PR.
5. Open a pull request via `gh pr create`. Title should be `{{ task.identifier }}: <one-line summary>`. Body should explain what changed and why.
6. Take a screenshot or short video of the change in action if it's user-visible. Attach via philharmonic.add_proof_of_work.
7. Use the philharmonic.update_status tool to move the task to "review" when done.

## Constraints

- You have no human in the loop. If you'd normally ask a clarifying question, make a reasonable choice and document it in your PR description.
- Stay inside `/workspace`. Don't try to modify the system.
- Don't add new top-level dependencies without justifying it in the PR description.
- If the task is impossible or under-specified, explain why in a comment and update status to "review" with no PR.
```

---

## 14. Tasks MCP server

Lives at `containers/sandbox/mcp/tasks-mcp/`. Implements MCP over stdio. Use the official `@modelcontextprotocol/sdk` package for the server framework.

### 14.1 Tools exposed

| Tool name | Description |
|---|---|
| `read_task` | Returns the current task as JSON. No arguments. |
| `post_comment` | `{ body: string }` — posts a comment from the agent on the task. |
| `update_status` | `{ to: 'review' \| 'ready' }` — only `review` is allowed by the API; `ready` is a no-op stub for symmetry. |
| `add_proof_of_work` | `{ kind: 'screenshot'\|'video'\|'ci_summary'\|'other', caption?: string, content?: string, file_path?: string }` — text content goes inline, file paths are uploaded to R2 via the upload endpoint. |
| `read_workflow_md` | Returns the project's `WORKFLOW.md` (in case the agent wants to re-read its instructions). |

### 14.2 Authentication

On startup, the server reads the run token from the file at `$PHILHARMONIC_RUN_TOKEN_FILE` and stores it. Every API call attaches `Authorization: Bearer <token>`. If the token is rejected (401), the server returns an MCP tool error with a clear message — the agent can decide what to do (usually: stop and ask for help via comment).

### 14.3 Failure modes

If the API is unreachable, retry with exponential backoff up to 3 attempts, then return a tool error. **Never silently succeed** — the agent needs to know the comment didn't post.

---

## 15. Egress proxy (Outbound Worker)

The Sandbox SDK supports an "outbound Worker" — a Worker that intercepts every outbound HTTP request from the container and can rewrite it. Configure your Sandbox class with the outbound binding.

The proxy:

1. Inspects the destination host.
2. If it's `api.github.com` or `github.com`: inject `Authorization: Bearer <GITHUB_TOKEN>` from secrets.
3. If it's `api.anthropic.com`: inject `x-api-key: <ANTHROPIC_API_KEY>`.
4. If it's the Philharmonic API (`tasks.your-domain.com`): allow through unchanged (the agent uses its run token).
5. Anything else: allow through with no credentials. Log host + path for audit.

Important: the agent's code never reads these secrets. They live only in the egress proxy's environment.

Apply a basic deny-list too: block private IP ranges (`10.0.0.0/8`, `192.168.0.0/16`, `169.254.0.0/16`) at the proxy. The container should never be able to reach internal infrastructure.

---

## 16. Wrangler configuration

`wrangler.jsonc` lives at the **repo root** (see §0.5). Use empty strings for resource IDs that the Deploy button (or `bootstrap.ts`) will fill in. Use `secrets_store_secrets` for any secret the user must supply, so the Deploy UI prompts for them.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "philharmonic",
  "main": "apps/worker/src/index.ts",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat"],

  // Built SPA. The build script (`pnpm build`) produces this directory.
  "assets": {
    "directory": "./apps/web/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application"
  },

  // Plain config — non-sensitive. Filled in post-deploy.
  "vars": {
    "ACCESS_TEAM_DOMAIN": "",
    "ACCESS_AUD": "",
    "API_BASE": ""
  },

  // Auto-provisioned by Deploy button OR bootstrap.ts. Empty database_id =
  // "create me a new one and write it back."
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "philharmonic",
      "database_id": ""
    }
  ],

  "r2_buckets": [
    {
      "binding": "ARTIFACTS",
      "bucket_name": "philharmonic-artifacts"
    }
  ],

  "queues": {
    "producers": [{ "binding": "DISPATCH", "queue": "philharmonic-dispatch" }],
    "consumers": [
      {
        "queue": "philharmonic-dispatch",
        "max_batch_size": 1,
        "max_batch_timeout": 5,
        "max_retries": 5,
        "dead_letter_queue": "philharmonic-dispatch-dlq"
      }
    ]
  },

  "durable_objects": {
    "bindings": [
      { "name": "TASKS_ROOM", "class_name": "TasksRoom" },
      { "name": "ORCHESTRATOR", "class_name": "Orchestrator" },
      { "name": "Sandbox", "class_name": "Sandbox" }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["TasksRoom", "Orchestrator", "Sandbox"]
    }
  ],

  "containers": [
    {
      "class_name": "Sandbox",
      "image": "./containers/sandbox/Dockerfile",
      "instance_type": "standard"
    }
  ],

  "workflows": [
    {
      "name": "implementation-run",
      "binding": "RUN",
      "class_name": "ImplementationRun"
    }
  ],

  // Secrets the Deploy UI prompts for. The user pastes these once and
  // they're stored in Cloudflare Secrets Store, never in the repo.
  "secrets_store_secrets": [
    {
      "binding": "ANTHROPIC_API_KEY",
      "store_id": "",
      "secret_name": "ANTHROPIC_API_KEY"
    },
    {
      "binding": "GITHUB_TOKEN",
      "store_id": "",
      "secret_name": "GITHUB_TOKEN"
    },
    {
      "binding": "RUN_TOKEN_SECRET",
      "store_id": "",
      "secret_name": "RUN_TOKEN_SECRET"
    },
    {
      "binding": "INTERNAL_API_TOKEN",
      "store_id": "",
      "secret_name": "INTERNAL_API_TOKEN"
    }
  ],

  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  }
}
```

A separate Worker hosts the egress proxy (§15). Its config lives at `apps/worker/src/outbound/wrangler.outbound.jsonc` and is deployed with `wrangler deploy --config apps/worker/src/outbound/wrangler.outbound.jsonc`. The main Worker references it via the Sandbox SDK's `outbound` binding.

### 16.1 First-run UX

When a deployed Worker boots without `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` set, the SPA shows a **PostDeploySetup** screen instead of the board. The screen explains, with copy-pasteable commands, how to:

1. Create a Cloudflare Access application pointing at this Worker's URL.
2. Copy the team domain and AUD tag.
3. Run `wrangler deploy` again with those values set in `vars`.

Detect this server-side: if either var is empty, `/api/me` returns `{ setupRequired: true, hint: '...' }` and the SPA routes to `PostDeploySetup`.

---

## 17. Build milestones (do these in this order)

Each milestone is a stopping point. Don't move on until §18's acceptance criteria for that milestone pass.

**M0 — Bootstrap and Deploy button (do this FIRST)**

Before writing any application code, get both installation paths working with a stub Worker that just returns "Hello Philharmonic". This is the most important milestone: without it, the repo is not openly distributable.

1. Create `wrangler.jsonc` at the repo root per §16 with empty resource IDs and the `secrets_store_secrets` declarations.
2. Write a stub `apps/worker/src/index.ts` that returns `Response.json({ ok: true, name: 'philharmonic' })` from `/`.
3. Build the empty SPA shell (`apps/web/dist/index.html` with a "Hello" page) so the assets binding has something to serve.
4. Write `scripts/bootstrap.ts`:
   - Verify `wrangler whoami` works; if not, tell the user to run `wrangler login` and exit.
   - Run `wrangler d1 create philharmonic` and parse the resulting `database_id` from stdout. Write it back into `wrangler.jsonc` (preserving comments — use `jsonc-parser` from npm).
   - Run `wrangler r2 bucket create philharmonic-artifacts`.
   - Run `wrangler queues create philharmonic-dispatch` and `wrangler queues create philharmonic-dispatch-dlq`.
   - Generate `RUN_TOKEN_SECRET` and `INTERNAL_API_TOKEN` (32 random bytes, base64url) and store via `wrangler secrets-store secret create`.
   - Prompt the user (using `node:readline/promises`) for `ANTHROPIC_API_KEY` and `GITHUB_TOKEN`, store the same way.
   - Run `wrangler d1 migrations apply philharmonic --remote` (after migrations exist; for M0 there are no migrations yet so skip with a note).
   - Print clear next steps (configure Access, run `pnpm deploy`).
5. Write `scripts/postdeploy.ts` — runs `wrangler d1 migrations apply philharmonic --remote` (idempotent) and prints the deployed URL.
6. Add the Deploy to Cloudflare button to the README pointing at the eventual public URL (placeholder for now: `https://github.com/<YOUR_ORG>/philharmonic`).
7. Test Path A: push to a fresh GitHub repo, click the Deploy button on a different Cloudflare account, verify it provisions and deploys without manual intervention beyond pasting the two API keys.
8. Test Path B: in a fresh clone, on a fresh Cloudflare account, run `pnpm install && pnpm bootstrap && pnpm deploy`. Verify the same end state.

**M1 — Skeleton (after M0)**

- Hono installed; `/api/me` route added (returns 501 — Access not yet validated).
- Cloudflare Access configured manually on the deployed Worker (document the steps in the README).
- Access JWT verification middleware added to `/api/me`; route now returns the verified user.
- React SPA skeleton replaces the "Hello" page: routes for `/projects`, `/projects/:slug`, etc., all empty.
- The `PostDeploySetup` screen appears when `ACCESS_AUD` is unset (per §16.1).

**M2 — Tasks CRUD**

- Drizzle schema written; migrations generated with `drizzle-kit` and committed to `migrations/`.
- `wrangler d1 migrations apply` succeeds locally and remotely.
- `/api/projects` and `/api/tasks` routes work end-to-end.
- SPA has a working board: create project, create task, drag between columns.
- No real-time yet — refresh shows the new state.

**M3 — Real-time**

- TasksRoom DO with WebSocket Hibernation API.
- SPA opens a WS on the project board.
- `task.created` / `task.updated` events flow live.
- A second browser tab sees changes from the first instantly.

**M4 — Orchestrator + Queue (no agent yet)**

- Queue created and bound (already done in M0; verify it's wired).
- Orchestrator DO consumes messages.
- "Ready" transition enqueues; Orchestrator claims and creates a `runs` row that simply prints "would have run" to logs and immediately marks the run `succeeded`.
- Concurrency limit enforced — set to 1 in dev and verify a second ready task waits.

**M5 — Workflow + Sandbox + agent (hello world prompt)**

- Container image built, Sandbox class deployed.
- Workflow class deployed with a simple `prepare → runAgent → cleanup` pipeline.
- `runAgent` just runs `echo "hello from $(hostname)"` and captures output.
- Run logs stream to the SPA over WS.

**M6 — Real Claude agent**

- Claude CLI installed in the image.
- Tasks MCP server built and wired up.
- Run token mint/verify works.
- Agent receives the prompt, calls `read_task`, posts a comment, finishes.
- Comment appears live in the task detail.

**M7 — Land step**

- Egress proxy deployed with GitHub token injection.
- Agent can `gh pr create` against a real test repo.
- PR URL captured into `runs.prUrl`.
- Task transitions to `review`.

**M8 — Polish**

- Run viewer with embedded preview URL when the agent exposes a port.
- Proof-of-work artifacts (screenshots, walkthroughs) shown in the task detail.
- Cancel button works (Workflow terminate + sandbox destroy).
- Reconciliation alarm catches stuck tasks.
- README finished. Both install paths re-tested from scratch on a clean account.

---

## 18. Acceptance criteria

The system is complete when **all** of the following pass on a fresh deployment.

**Auth**

- A user without Access cannot reach any URL. They get the Cloudflare login page.
- A user with Access can log in and `/api/me` returns their email.
- A request with a tampered `Cf-Access-Jwt-Assertion` is rejected with 401.
- A request to `/api/internal/*` without a run token is rejected with 401.
- A run token issued for run A cannot post a comment on a task that doesn't belong to run A.

**Open-source distribution**

- Clicking the README's "Deploy to Cloudflare" button on a fresh Cloudflare account, with only an `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` to paste, results in a working deployment that reaches the `PostDeploySetup` screen.
- `git clone && pnpm install && pnpm bootstrap && pnpm deploy` on a fresh account reaches the same end state.
- After bootstrap, `wrangler.jsonc` is in a state suitable for committing back to the repo: `database_id` filled, secrets created in Secrets Store, no leaked credentials in the file.
- Running `pnpm bootstrap` twice is idempotent: it does not error on existing resources, and it does not overwrite secrets already set without confirmation.

**Tasks**

- Creating a task in the UI persists to D1 and broadcasts `task.created` to other open clients within 1 second.
- Dragging a task to "Ready" enqueues a dispatch message; the Orchestrator picks it up; the task transitions to "Running" within 5 seconds.
- A second task that's also "Ready" while the project is at concurrency limit waits, and starts running once the first finishes.

**Agent run**

- An agent run on a real test repo produces a real PR within 5 minutes for a trivial task ("add a TODO comment to README").
- The PR title matches `<TASK_IDENTIFIER>: <summary>`.
- Run logs stream live to the run viewer while the agent works.
- The agent posts at least one comment on the task using `post_comment`.
- The task ends in `review` status with the PR URL attached.

**Resilience**

- Cancelling a running task terminates the Workflow and destroys the sandbox within 10 seconds.
- Killing the Worker mid-run does not lose the run — the Workflow resumes after redeploy and the task ends correctly.
- The reconciliation alarm catches a task left in `running` with no live workflow within 2 minutes.

**Security**

- The `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` are not in the SPA bundle, not in any API response, and not in container env when inspected via `sandbox.exec('env')`.
- The agent cannot reach `10.0.0.0/8` from inside the sandbox.

**UX**

- Cold-loading the board renders within 2 seconds on a typical connection.
- Live updates do not cause flicker or layout shift.
- The activity feed renders 500 events without performance degradation.

---

## 19. Out of scope (do not build)

- User management UI. Cloudflare Access manages users.
- Billing, plans, quotas.
- Webhook receivers for GitHub events. The agent polls via `gh`.
- Any LLM other than Claude.
- A CLI client. The web UI is the only client.
- Email notifications.
- "Comments on PRs" surfacing into the task feed (read-only is fine — agent just reports them via `post_comment`).
- Multi-region deployment. Single region; let Cloudflare handle the edge.

---

## 20. Things to write into the README

When you're done, the README must explain:

1. **Prerequisites** — Cloudflare account, Access set up, GitHub PAT or App, Anthropic API key, Node 22, pnpm.
2. **One-time setup** — `wrangler login`, create D1, create R2 bucket, create Queue, set secrets (with exact `wrangler secret put` commands).
3. **Local development** — `pnpm dev` runs the worker + vite in parallel.
4. **Deploying** — `pnpm deploy`. What the Cloudflare dashboard config looks like for Access, including the audience tag.
5. **Adding a project** — UI walkthrough.
6. **Customizing `WORKFLOW.md`** — the template variables available.
7. **Troubleshooting** — common errors and what they mean.

---

## 21. If you get stuck

If you genuinely cannot proceed (a Cloudflare API doesn't exist, a library is broken, a constraint conflicts), do this:

1. Write the problem into `BLOCKERS.md` with: what you tried, what failed, what you suspect.
2. Pick the safest viable path forward — usually "stub it out and continue, leaving a clearly-marked TODO."
3. Keep going. Don't halt the entire build for a single blocked piece.

The goal is a working v1, not a perfect one. We can iterate.

---

End of spec.
