# Philharmonic — Self-hosted Coding-Agent Task Manager on Cloudflare

**Spec version:** 2.0
**Audience:** an autonomous Claude Code agent building and maintaining this end-to-end with no human supervision.
**Reading order:** read this whole document before writing any code. §17 records what has shipped and what remains. Verify changes against §18 before declaring a milestone done.

**What changed in v2.** Version 1 was a prescriptive blueprint written before any code existed. Milestones M0–M8 and the dependency feature (D0–D3) have since shipped, and a full audit compared the implementation against v1. Version 2 is the reconciliation: wherever the implementation found a better approach (or the platform contradicted v1's assumptions), the spec now documents the validated reality; wherever the implementation cut a corner v1 was right about, the requirement is restated and tracked in `tasks.md`. Major v2 changes:

- **Task dependencies are first-class** (new §8.5): `blocked` status, `task_dependencies` table, gated ready-transitions, auto-dispatch cascade, agent-declared deferral via MCP.
- **Platform corrections:** Workflows `terminate()` does not run `finally` steps (§12.2); R2 bindings cannot mint presigned URLs, so artifacts/uploads proxy through the Worker (§8); container egress uses the Sandbox SDK's outbound mechanism, not a separately-deployed proxy Worker (§15); app-level JSON ping/pong defeats DO hibernation — use WebSocket auto-response (§10.4).
- **Agent-runtime corrections:** `claude -p --output-format=stream-json` requires `--verbose`; `gh`/`claude` need placeholder env tokens for the edge-injection model to work; the repo checks out to `/workspace/repo`, not `/workspace` (§13).
- **Honest reliability rules:** a single-instance DO does not serialize across I/O awaits (§11.2); queue `retry()` burns the delivery budget — re-send instead (§11.3); reconciliation must query real Workflow status, never wall-clock heuristics (§11.4).
- Tailwind and Monaco are out (§9.4); plain CSS and a plain textarea are in. Three required secrets instead of four (§7.3).

This spec remains **prescriptive**. Where it decides something, follow it. Deviations require an entry in `DEVIATIONS.md` explaining what and why.

---

## 0. What you are building

A single, self-hosted web app deployed entirely on Cloudflare that lets a small team:

1. Create and triage coding tasks in a kanban-style UI, with dependencies between tasks.
2. Mark a task "ready" and have an autonomous Claude agent implement it: clone the repo, write code, run tests, open a pull request, and attach proof of work.
3. Watch the agent's progress live in the browser (status, comments, PR link, streaming logs).
4. Approve or send back the result.

This is a Cloudflare-native re-imagining of OpenAI's Symphony, with Linear replaced by a hosted task tracker and Codex replaced by Claude.

---

## 0.5. Open-source readiness — "Deploy to Cloudflare" button

This repo is intended to be open-sourced and deployable to anyone's Cloudflare account in two clicks. There are two installation paths and **both must work**:

### Path A — One-click (the README's primary CTA)

A "Deploy to Cloudflare" button at the top of the README pointing at `https://deploy.workers.cloudflare.com/?url=https://github.com/<ORG>/philharmonic`. When clicked, Cloudflare:

1. Forks the repo into the user's GitHub account.
2. Reads `wrangler.jsonc` and provisions all declared resources automatically (D1, R2, Queues, Secrets Store).
3. Prompts the user for the secrets declared via `secrets_store_secrets`.
4. Builds (using the `build` script) and deploys.
5. Connects the new GitHub fork to Workers Builds for ongoing CI/CD.

### Path B — Manual (`pnpm bootstrap && pnpm deploy`)

A TypeScript script at `scripts/bootstrap.ts` that does the equivalent locally for users cloning the repo manually. It uses the Wrangler CLI under the hood — same outcome, same end state.

### Constraints both paths must honor

- **`wrangler.jsonc` lives at the repository root.** Not in `apps/worker/`. The Deploy button does not handle subdirectories well in monorepos, and a root-level config keeps the auto-provisioner happy.
- **Resource IDs use the empty-string placeholder pattern** (`"database_id": ""`). The Deploy button's auto-provisioner detects empty IDs and fills them in. The bootstrap script does the same via `wrangler d1 create` and writes the result back (preserving comments — `jsonc-parser`).
- **All required secrets are declared in `secrets_store_secrets`** so the Deploy UI prompts for them.
- **`pnpm build` must succeed from a fresh clone** with no Cloudflare state: no migrations, no wrangler invocations, no D1 reads during build.
- **Local dev must work with empty resource IDs.** `pnpm dev` runs a wrapper (`scripts/dev.ts`) that materializes a dev config with placeholder IDs filled in for miniflare, so a fresh clone can run locally before bootstrap.
- **MIT `LICENSE` at the root. No PII, secrets, or internal URLs anywhere in the repo.**

### Things the user does manually after Deploy

- Configure Cloudflare Access in the dashboard, pointed at the deployed Worker hostname.
- Set the `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` vars and redeploy (the app's PostDeploySetup screen walks through this; see §16.1).
- Optional: bind a custom domain.

---

## 1. Philosophy and non-goals

**Philosophy**

- The user manages tasks, not agents. Once a task is "ready", the platform owns the implementation loop end-to-end. Anything non-routine comes back to the human as a task-state change (review, blocked, failed) — never as a mid-run question.
- The agent must produce **proof of work** (PR, diffs, screenshots, logs) — not a chain-of-thought transcript. Reviewers look at evidence on the task card.
- Credentials never enter the agent's container. All outbound auth is injected at the network edge (§15).
- One task = one isolated workspace = one container. No cross-task contamination.
- Failures are normal. The Workflow layer makes them durable; the Orchestrator's reconciliation makes them visible; every failure path must leave the task in a state a human can act on.
- **Every code path that returns a task to `ready` must gate on unresolved blockers and re-enqueue for dispatch.** This is the single most violated invariant in the v1 implementation; treat it as a law.

**Non-goals (do not build)**

- Multi-tenant SaaS. Single-account, deployed by one team for itself.
- A general project-management tool. No epics, sprints, time tracking, custom fields.
- Bring-your-own-LLM. Claude only. Anthropic API only.
- Mobile apps, email notifications, Slack integrations, calendar sync.
- A CLI client. The web UI is the only client.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Project** | A connected GitHub repo with its own settings and `WORKFLOW.md` template. |
| **Task** | A unit of work in a project. Status: backlog → (blocked ⇄) ready → running → review → done, plus cancelled. |
| **Dependency** | A directed edge "task X is blocked by task Y". Kept acyclic. See §8.5. |
| **Run** | One attempt by an agent to implement a task. A task may have multiple runs. |
| **Deferred run** | A run the agent ended early by declaring a dependency; terminal, frees the concurrency slot. |
| **Sandbox** | A Cloudflare Sandbox SDK container, identified by `task_id`. The agent's workspace. |
| **Orchestrator** | A single Durable Object that owns task claiming and concurrency limits. |
| **TasksRoom** | A per-project Durable Object that fans out live updates over WebSocket. |
| **Tasks MCP** | An MCP server running inside the sandbox so the agent can read/write tasks. |
| **Run token** | A short-lived HMAC-signed token scoped to one `run_id`, used by the agent to call back into the API. |
| **Proof of work** | Artifacts attached to a run: PR link, diff, screenshots, logs. |
| **Task identifier** | Human-readable per-project ID: uppercased project slug + number, e.g. `WEB-12`. |

---

## 3. Tech stack (decided — do not change)

| Concern | Choice |
|---|---|
| Frontend framework | React 18 + Vite |
| Styling | Hand-written plain CSS (single `styles.css`, dark-only). No Tailwind, no CSS-in-JS. |
| Frontend deployment | Workers Static Assets (single Worker serves SPA + API) |
| API framework | Hono |
| Validation | Zod at every API boundary |
| Database | Cloudflare D1 |
| ORM | Drizzle ORM (drizzle-kit generates migrations into root `migrations/`) |
| Real-time | Durable Object + WebSocket Hibernation API (with auto-response ping/pong) |
| Background work | Cloudflare Queues |
| Long-running orchestration | Cloudflare Workflows |
| Sandboxing | `@cloudflare/sandbox` (Sandbox SDK), **exact-pinned**; container base image tag must match the pinned SDK version |
| Agent runtime | Claude Code CLI (`@anthropic-ai/claude-code`), invoked headlessly inside the sandbox |
| Auth (humans) | Cloudflare Access in front of the Worker |
| Auth (agents) | HMAC-signed run tokens minted by the API |
| Secrets | Cloudflare Secrets Store |
| Object storage | R2 (artifacts), always proxied through the Worker (no presigned URLs — R2 bindings cannot mint them) |
| IDs | ULID everywhere (lexicographically time-ordered — pagination cursors rely on this) |
| Language | TypeScript everywhere, strict mode on |
| Package manager | pnpm with workspaces |
| Lint/format | Biome |
| Test runner | Vitest (plain `node` environment for pure-logic units; see §18.1) |

---

## 4. Repository layout

Monorepo with pnpm workspaces. `wrangler.jsonc` and `migrations/` live at the **repo root** (§0.5).

```
philharmonic/
├── package.json                    # root: workspaces + scripts (build, deploy, bootstrap, dev)
├── pnpm-workspace.yaml
├── wrangler.jsonc                  # AT ROOT — Deploy button reads this
├── biome.json
├── tsconfig.base.json
├── README.md                       # Deploy button + getting started
├── SPEC.md                         # this file
├── DEVIATIONS.md                   # deviations from this spec, with reasons
├── tasks.md                        # living task tracker for ongoing work
├── LICENSE                         # MIT
├── .github/workflows/deploy.yml    # GitHub Actions: deploy on push to main
│
├── migrations/                     # D1 migrations at root (drizzle-kit output)
│   ├── 0000_initial.sql
│   ├── 0001_dependencies.sql
│   └── meta/                       # drizzle journal — commit it
│
├── apps/
│   ├── web/                        # Vite React SPA
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── App.tsx
│   │       ├── routes/             # Projects, Board, TaskDetail, RunViewer,
│   │       │                       # ProjectSettings, PostDeploySetup, RootLayout
│   │       ├── components/         # Column, TaskCard, modals, DependencyPicker
│   │       ├── lib/
│   │       │   ├── api.ts          # fetch wrappers (types imported from @philharmonic/shared)
│   │       │   ├── ws.ts           # WebSocket client (queue + resubscribe; see §9.2)
│   │       │   └── store.ts        # Zustand stores (see §9.2)
│   │       └── styles.css          # the entire theme, hand-written
│   │
│   └── worker/                     # the Cloudflare Worker source
│       ├── drizzle.config.ts       # out: ../../migrations
│       └── src/
│           ├── index.ts            # entry: /api + /ws routing, queue handler, asset fallback
│           ├── api/
│           │   ├── auth.ts         # Access JWT middleware + setup-required short-circuit
│           │   ├── me.ts
│           │   ├── projects.ts
│           │   ├── tasks.ts        # incl. dependency endpoints
│           │   ├── runs.ts         # incl. cancel + proxied artifact download
│           │   ├── ws.ts           # slug → TasksRoom DO upgrade
│           │   └── internal.ts     # run-token routes for the Tasks MCP
│           ├── do/
│           │   ├── TasksRoom.ts
│           │   └── Orchestrator.ts
│           ├── workflow/
│           │   └── ImplementationRun.ts
│           ├── queue/
│           │   └── consumer.ts
│           ├── sandbox/
│           │   └── Sandbox.ts      # Sandbox class with outbound egress handler (§15)
│           └── lib/
│               ├── db.ts           # Drizzle client
│               ├── schema.ts       # Drizzle schema
│               ├── dto.ts          # row → wire-shape mappers (single source for Task/Run DTOs)
│               ├── transitions.ts  # the status machine (single source of truth)
│               ├── dependencies.ts # cycle check, gating, resolution cascade
│               ├── runtoken.ts     # HMAC mint + verify
│               ├── workflowmd.ts   # render WORKFLOW.md prompts
│               ├── broadcast.ts    # the only caller of TasksRoom /broadcast
│               ├── cancel.ts       # shared run-cancel helper (terminate + destroy + persist)
│               └── types.ts        # Env
│
├── containers/
│   └── sandbox/
│       ├── Dockerfile              # FROM docker.io/cloudflare/sandbox:<pinned> (§13.1)
│       ├── WORKFLOW.md             # THE canonical default prompt template (single-sourced; §13.4)
│       └── mcp/tasks-mcp/          # the Tasks MCP server (Node, npm ci, lockfile committed)
│           ├── package.json
│           ├── package-lock.json
│           └── src/index.ts
│
├── packages/
│   └── shared/                     # types shared between web, worker, mcp
│       └── src/
│           ├── index.ts
│           ├── ws-protocol.ts      # WebSocket message shapes
│           └── api-types.ts        # request/response DTOs incl. dependency shapes
│
└── scripts/
    ├── bootstrap.ts                # Path B installer
    ├── dev.ts                      # wrangler dev wrapper (fills placeholder IDs for miniflare)
    ├── seed.ts                     # seed a project + tasks for dev
    └── postdeploy.ts               # `wrangler d1 migrations apply --remote` after deploy
```

Root `package.json` scripts (the public API of the repo):

```json
{
  "scripts": {
    "bootstrap": "tsx scripts/bootstrap.ts",
    "build": "pnpm -r build",
    "dev": "tsx scripts/dev.ts",
    "deploy": "pnpm build && wrangler deploy && tsx scripts/postdeploy.ts",
    "migrate:local": "wrangler d1 migrations apply philharmonic --local",
    "migrate:remote": "wrangler d1 migrations apply philharmonic --remote",
    "seed": "tsx scripts/seed.ts",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "lint": "biome check ."
  }
}
```

The web app builds into `apps/web/dist/` and is served via the assets binding with `run_worker_first: true` — the Worker handles `/api/*` and `/ws/*` first; everything else falls through to `env.ASSETS.fetch()`. **Single deployable Worker.**

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
         │  • WS  /ws/projects/:slug → TasksRoom DO    │
         │  • internal /api/internal/* (run-token)     │
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
                                  │  • claims tasks (CAS)     │
                                  │  • enforces concurrency   │
                                  │  • dependency re-check    │
                                  │  • reconciliation alarm   │
                                  │  • spawns Workflow        │
                                  └──────────────┬───────────┘
                                                 ▼
                                  ┌──────────────────────────┐
                                  │ ImplementationRun         │
                                  │ Workflow (durable)        │
                                  │  prepare→runAgent→land→   │
                                  │  finish→cleanup           │
                                  └──────────────┬───────────┘
                                                 ▼
                                  ┌──────────────────────────┐
                                  │ Sandbox (per task)        │
                                  │  • Claude Code headless   │
                                  │  • Tasks MCP (stdio)      │
                                  │  • repo at /workspace/repo│
                                  └──────────────┬───────────┘
                                                 ▼
                                  ┌──────────────────────────┐
                                  │ Sandbox outbound handler  │
                                  │ (runs in the Worker;      │
                                  │ injects GitHub+Anthropic  │
                                  │ creds at the edge)        │
                                  └────┬─────────────────┬────┘
                                       ▼                 ▼
                                  ┌────────┐      ┌────────────┐
                                  │ GitHub │      │ Anthropic  │
                                  └────────┘      └────────────┘
```

---

## 6. Data model (D1)

Drizzle ORM, SQLite dialect, migrations generated with drizzle-kit into root `migrations/`.

### 6.1 Schema

```typescript
// apps/worker/src/lib/schema.ts (abridged — authoritative file is the source)

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),                          // ulid
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),                // url-safe; uppercased → task identifier prefix
  repoUrl: text('repo_url').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  workflowMd: text('workflow_md').notNull(),            // the prompt template
  concurrencyLimit: integer('concurrency_limit').notNull().default(2),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),                          // ulid
  projectId: text('project_id').notNull().references(() => projects.id),
  number: integer('number').notNull(),                  // per-project sequence
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status', {
    enum: ['backlog', 'blocked', 'ready', 'running', 'review', 'done', 'cancelled']
  }).notNull().default('backlog'),
  priority: integer('priority').notNull().default(2),   // 0=urgent .. 3=low
  createdBy: text('created_by').notNull(),              // email from Access JWT
  assignee: text('assignee'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, /* indexes: (projectId,status), (projectId,number) */);

export const taskDependencies = sqliteTable('task_dependencies', {
  taskId: text('task_id').notNull().references(() => tasks.id),      // the blocked task
  blockedBy: text('blocked_by').notNull().references(() => tasks.id),// the blocker
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  createdBy: text('created_by').notNull(),              // email or 'agent'
}, /* PRIMARY KEY (taskId, blockedBy); index on blockedBy */);

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),                          // ulid
  taskId: text('task_id').notNull().references(() => tasks.id),
  workflowInstanceId: text('workflow_instance_id'),
  sandboxId: text('sandbox_id').notNull(),              // == taskId for v1
  status: text('status', {
    enum: ['queued', 'preparing', 'running', 'landing', 'succeeded', 'failed', 'cancelled', 'deferred']
  }).notNull().default('queued'),
  prUrl: text('pr_url'),
  errorMessage: text('error_message'),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }),
  endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),                          // ulid — pagination cursor
  taskId: text('task_id').notNull().references(() => tasks.id),
  runId: text('run_id').references(() => runs.id),
  type: text('type', {
    enum: ['comment', 'status_change', 'agent_action', 'proof', 'system']
  }).notNull(),
  author: text('author').notNull(),                     // email | 'agent' | 'system'
  payload: text('payload', { mode: 'json' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  kind: text('kind', {
    enum: ['pr_diff', 'screenshot', 'video', 'logs', 'ci_summary', 'other']
  }).notNull(),
  r2Key: text('r2_key').notNull(),
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),           // UTF-8 byte length for text content
  caption: text('caption'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
```

### 6.2 Notes

- **Active run statuses** are `queued | preparing | running | landing`. `succeeded | failed | cancelled | deferred` are terminal. Concurrency counting and "has an active run" checks must use exactly this set — `deferred` is terminal precisely so a deferral frees the project's concurrency slot immediately.
- **Task identifiers** are `UPPER(project.slug)-number` (e.g. `web-app` → `WEB-APP-7`). One derivation function in `lib/dto.ts`, used by the DTO mapper, the workflow prompt renderer, and the agent-reference parser in the internal dependencies endpoint. Never hardcode a prefix.
- `tasks.number` is allocated per-project at create time (`max(number)+1`).
- `events` is the source of truth for task history. The UI renders newest-first. Event `id` (ULID) is the pagination cursor **and** the sort key — never sort by one column and cursor by another.
- The `payload` JSON column is schemaless; document shapes per `type` in `packages/shared/src/api-types.ts`.
- No cascading deletes. Soft-delete only (not needed in v1).
- `task_dependencies` invariants are enforced at the API layer, not the schema: same-project only, no self-reference, acyclic (DFS check before insert), duplicate edge = idempotent no-op (`ON CONFLICT DO NOTHING` on both human and agent paths).

---

## 7. Authentication

### 7.1 Cloudflare Access (humans)

Cloudflare Access sits in front of the Worker (configured in the dashboard). Every request carries `Cf-Access-Jwt-Assertion`; **verify it on every authenticated request** using `jose`'s `jwtVerify` + `createRemoteJWKSet` against `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, with issuer = `ACCESS_TEAM_DOMAIN` and audience = `ACCESS_AUD`.

- `ACCESS_TEAM_DOMAIN` **must include the `https://` scheme** — it is used both as the JWT issuer string and the JWKS URL base.
- Both values are plain `vars` in `wrangler.jsonc`, not secrets.
- **Fail-closed setup mode:** while either var is empty, `/api/me` returns `200 { setupRequired: true, hint }` and every other Access-authenticated route returns `503 { error: { code: 'setup_required' } }`. The SPA routes to the PostDeploySetup screen (§16.1).
- The middleware stashes `{ email, sub }` on the Hono context. Applied to all `/api/*` except `/api/internal/*`.

### 7.2 Run tokens (agents)

Minted when a Workflow starts a run; injected into the sandbox as a file; attached by the Tasks MCP as `Authorization: Bearer` on every call to `/api/internal/*`.

Format: `v1.<base64url-payload>.<base64url-hmac>` where `payload = { runId, taskId, projectId, exp }` and the MAC is HMAC-SHA256 over `v1.<payload>` with `RUN_TOKEN_SECRET`. TTL 24h. No revocation in v1 (accepted exposure window).

Verification rules (in `lib/runtoken.ts`, names `mintRunToken` / `verifyRunToken`):

- Verify via `crypto.subtle.verify` (constant-time). Never string-compare MACs.
- **Every** malformed input — bad structure, bad base64, bad JSON, bad signature, expired — yields a 401 with code `malformed | bad_signature | expired`. A garbage token must never produce a 500.
- **Claims-only scoping:** internal handlers derive `runId` / `taskId` / `projectId` exclusively from the verified token claims, never from the request body or URL. This makes cross-run access structurally impossible. The uploads flow is included: upload R2 keys are namespaced `runs/<runId>/uploads/<uploadId>` and validated against the token's run on both PUT and proof-attach.

### 7.3 Required secrets

| Name | Purpose |
|---|---|
| `RUN_TOKEN_SECRET` | HMAC key for run tokens (32 random bytes, base64url; generated by bootstrap) |
| `GITHUB_TOKEN` | Fine-grained PAT or GitHub App token; read only by the egress handler (§15) |
| `ANTHROPIC_API_KEY` | Claude API key; read only by the egress handler (§15) |

v1 also declared `INTERNAL_API_TOKEN` for authenticating the TasksRoom `/broadcast` route. **Removed in v2:** in the shipped single-script architecture the DO is reachable only via its binding, the WS upgrade route forwards only `/ws/...` paths, and nothing external can address `/broadcast` — a shared secret would protect against nothing. If a future change splits the egress handler or broadcasters into a separate Worker, reintroduce a token for that cross-Worker call.

Never log a secret. Never include one in an API response or the SPA bundle. The sandbox container env gets **placeholder** values only (§13.3).

---

## 8. API surface

All routes return JSON unless noted. Errors are `{ error: { code: string, message: string } }`. Zod-validate every body. All `/api/*` routes require a valid Access JWT; all `/api/internal/*` routes require a valid run token.

### 8.1 REST (human routes — `/api/*`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/me` | `{ email, displayName }`, or `{ setupRequired, hint }` in setup mode |
| GET | `/api/projects` | list projects |
| POST | `/api/projects` | create — `{ name, slug, repoUrl, workflowMd? }`; default template from §13.4 |
| GET | `/api/projects/:id` | get project |
| PATCH | `/api/projects/:id` | update (incl. `workflowMd`, `concurrencyLimit`) |
| GET | `/api/projects/:id/tasks` | list tasks; `?status=` filter |
| POST | `/api/projects/:id/tasks` | create task — `{ title, description?, priority? }` |
| GET | `/api/tasks/:id` | task + latest-run summary + `blockers: Task[]` + `blocking: Task[]` |
| PATCH | `/api/tasks/:id` | update `title`, `description`, `priority`, `assignee` |
| POST | `/api/tasks/:id/transition` | change status — `{ to }`; see matrix below |
| POST | `/api/tasks/:id/dependencies` | add blocker — `{ blockedBy: taskId }`; see §8.5 |
| DELETE | `/api/tasks/:id/dependencies/:blockerId` | remove blocker; see §8.5 |
| POST | `/api/tasks/:id/comments` | add a comment — `{ body }` |
| GET | `/api/tasks/:id/events` | event feed; `?before=<eventId>&limit=50`; filter `id < before`, **order by `id DESC`**, limit clamped 1..200 |
| GET | `/api/tasks/:id/runs` | list runs for task |
| GET | `/api/runs/:id` | run detail with artifacts |
| GET | `/api/runs/:id/artifacts/:artifactId` | **stream the R2 object through the Worker** (Content-Type from the artifact row; Content-Disposition `inline` for screenshot/video, `attachment` otherwise). R2 bindings cannot mint presigned URLs; proxying also keeps Access in front of artifact bytes. |
| POST | `/api/runs/:id/cancel` | cancel an in-progress run (shared cancel helper, below) |

**Status transition matrix** (single source of truth: `lib/transitions.ts`; the handler consults it — never inline status checks):

| From | To | Actor | Notes |
|---|---|---|---|
| backlog | ready | human | gated: lands in `blocked` if unresolved blockers exist (§8.5) |
| backlog | blocked | human | manual park |
| blocked | ready | human | gated (re-lands in `blocked` if blockers remain) |
| blocked | backlog | human | |
| ready | backlog | human | "pause" — pull out of the dispatch pool |
| ready | running | orchestrator only | humans get 403 |
| running | review | workflow / agent (run token) only | |
| running | ready | human | pull back a stuck run (cancels the active run via the shared helper) |
| running | blocked | **agent only**, via declare-dependency (§8.5) | not reachable through `/transition` |
| review | done | human | the "approve" action |
| review | ready | human | "send back" — gated |
| backlog/blocked/ready/running/review | cancelled | human | `done` is strictly terminal — no cancelling finished work |
| cancelled | ready / backlog | human | requeue an abandoned task (gated for `ready`) |

Side effects (enforced in the transition handler):

- `→ ready` (any path, including all internal resets — see §1's law): run the blocker gate; if it lands in `ready`, **enqueue** `{ taskId, projectId }` on the dispatch Queue.
- `→ cancelled` or `→ done`: run the dependency-resolution cascade **inline before responding** (§8.5) — not in `waitUntil` (a dropped cascade strands dependents).
- `→ cancelled` with an active run: invoke the **shared cancel helper** (`lib/cancel.ts`): terminate the Workflow instance, destroy the sandbox, mark the run `cancelled` + `endedAt`, broadcast `run.updated`. The same helper backs `POST /api/runs/:id/cancel`, which must reject runs already in a terminal status.
- Every transition writes a `status_change` event and broadcasts `task.updated`.

### 8.2 Internal routes (agent routes — `/api/internal/*`)

Run-token auth; scope comes from token claims only (§7.2).

| Method | Path | Description |
|---|---|---|
| GET | `/api/internal/task` | the token's task, plus a project summary `{ id, name, slug, repoUrl, defaultBranch }` |
| GET | `/api/internal/workflow-md` | the project's current `WORKFLOW.md` source |
| POST | `/api/internal/comments` | agent comment on the token's task |
| POST | `/api/internal/status` | `{ to: 'review' }` transitions running→review; `{ to: 'ready' }` answers `{ ok: true, ignored: true }` (explicit no-op kept for tool symmetry) |
| POST | `/api/internal/dependencies` | agent-declared dependency; see §8.5 |
| POST | `/api/internal/proof` | attach proof — `{ kind, caption?, content }` (inline text) or `{ kind, caption?, uploadId }` |
| POST | `/api/internal/uploads` | `{ filename, contentType, sizeBytes }` → `{ uploadId, uploadUrl: '/api/internal/uploads/<id>' }` |
| PUT | `/api/internal/uploads/:uploadId` | raw body upload, stored at `runs/<runId>/uploads/<uploadId>`; rejects uploads not minted by this run |
| POST | `/api/internal/runs/log` | `{ lines: string[] }` → broadcast-only `run.log` frames (live viewer). Durable log storage is the Workflow's job (§12.1 finish step persists the full stream as a `logs` artifact). |

Every write broadcasts the corresponding event to the TasksRoom DO.

### 8.3 WebSocket — `/ws/projects/:slug`

The Worker verifies the Access JWT **before** upgrading, resolves slug → project id in D1, and forwards to the project's TasksRoom DO (`idFromName(projectId)` — DO identity is id-keyed, so slug renames don't orphan rooms). Protocol in §10.2.

### 8.4 Static assets

Everything else falls through to the assets binding (`run_worker_first: true`, `not_found_handling: "single-page-application"`).

---

## 8.5 Task dependencies

The dependency feature (shipped as D0–D3) is part of the core product.

**Model.** `task_dependencies(taskId, blockedBy)` edges, same project only, acyclic, no self-reference, duplicate adds are idempotent no-ops. Cycle prevention: DFS from the prospective blocker through its own blockers; reject if it reaches the task. Check-then-insert races are tolerated (worst case: a cycle slips in; the gate and cascade still terminate because resolution only follows `done|cancelled` edges — but keep the DFS to make it practically impossible).

**A blocker is resolved when its status is `done` or `cancelled`.** Cancelled-counts-as-resolved is deliberate (a moot blocker shouldn't hold work hostage); the cascade event payload records which terminal status resolved it so humans can tell.

**Gating.** Any request that would land a task in `ready` first checks unresolved blockers (`gateReadyTransition`); if any exist, the task lands in `blocked` instead and the `status_change` event records `{ requested: 'ready', to: 'blocked' }`. This applies to *every* path that produces `ready`: human transitions, run-cancel resets, workflow failure resets, reconciliation resets, requeue-from-cancelled.

**Human endpoints.**

- `POST /api/tasks/:id/dependencies { blockedBy }` — 400 on cycle/self/cross-project (typed codes), 404 on unknown ids, 409 `task_locked` when the task is `running|review|done`. If the task is in `backlog|ready` and the new blocker is unresolved, the task auto-moves to `blocked` with a system event.
- `DELETE /api/tasks/:id/dependencies/:blockerId` — if that was the last unresolved blocker of a `blocked` task, auto-transition to `ready` + enqueue.
- `GET /api/tasks/:id` returns `blockers` and `blocking` arrays.

**Resolution cascade.** When a task reaches `done` or `cancelled`: walk its direct dependents; each dependent in `blocked` whose blockers are now all resolved transitions to `ready`, gets a system event (`Unblocked: all dependencies resolved.`), broadcasts `task.updated`, and is enqueued on DISPATCH. Resolution is **single-level by construction** (an unblocked task becomes `ready`, never resolved, so it cannot transitively unblock its own dependents) — implement it as one pass, not a misleading depth loop. Run the cascade inline before the HTTP response.

**Orchestrator defense-in-depth.** Immediately before claiming, the Orchestrator re-checks unresolved blockers; if any exist it reverts the task to `blocked` (system event + broadcast) and the consumer acks the message. This closes the race between a ready-transition's enqueue and queue delivery.

**Agent-declared dependencies.** `POST /api/internal/dependencies { blockedBy: '<IDENTIFIER>' | taskId, reason? }` (run-token scoped; identifier references like `WEB-4` resolve within the token's project using the §6.2 derivation):

1. Insert the edge (cycle/self checks intact; the human-path `task_locked` check is skipped — the agent's own task is `running` by definition).
2. **Gate:** if the blocker is already `done|cancelled`, do *not* touch task status; return `{ ok: true, alreadyResolved: true }` so the agent knows to just keep working. (An unconditional `running → blocked` write here permanently strands the task — nothing ever re-dispatches a task whose blockers were all resolved before it was blocked.)
3. Otherwise transition the task `running → blocked`, write an `agent_action` event with `{ tool: 'declare_dependency', blockedBy, reason }`, and mark the run **`deferred`** (terminal: frees the concurrency slot; a later cascade can safely start run #2).
4. The Workflow's finish step must not overwrite a `deferred` run with `succeeded` (§12.1).

**UI.** See §9.1: Blocked column (hidden by default), lock badges, blockers/blocking panels, picker. A task in `blocked` with zero dependency edges renders a "manually parked — will not auto-resume" notice (it is the one blocked state the cascade can never reach).

---

## 9. Frontend

### 9.1 Pages

- **`/`** — redirects to the board when exactly one project exists; otherwise the project list.
- **`/projects`** — project list, "new project" button.
- **`/projects/:slug`** — kanban board. Columns: Backlog · Blocked · Ready · Running · Review · Done. The **Blocked column is hidden by default** behind a "Show blocked (n)" toggle persisted in localStorage; blocked cards carry a lock badge. Drag-and-drop between columns calls `/transition` (dropping a card on its own column is a no-op). New-task button opens a modal.
- **`/projects/:slug/tasks/:number`** — task detail: title, markdown-rendered description, priority, activity feed (events, newest-first), proof-of-work artifacts, and two dependency panels — **Blocked by** (each blocker linked, live status pill, remove button, "+ Add blocker" opens a searchable picker that excludes self / existing blockers / done / cancelled tasks; server-rejected adds surface the API error inline) and **Blocking** (read-only dependents). Action buttons by status:
  - `backlog`: **Run now** (→ ready)
  - `ready`: **Pause** (→ backlog)
  - `running`: **Open run viewer** + **Cancel run**
  - `review`: **Approve & merge** (→ done) + **Send back** (→ ready)
  - any status with a run: link to the latest run viewer
  - `blocked` with zero dependency edges: a "manually parked — will not auto-resume" notice
  
  Action buttons must work on deep links: they call the API directly and apply the response locally; they must not depend on the board store having been loaded first.
- **`/projects/:slug/tasks/:number/runs/:runId`** — run viewer: live agent log (streamed over WS), PR link. Auto-scrolls to bottom unless the user scrolled up; then a "jump to latest" pill.
- **`/projects/:slug/settings`** — edit project metadata (name, repo URL, default branch, concurrency limit) and `WORKFLOW.md` in a **plain textarea** with save. (v1 prescribed Monaco; dropped — a 3MB editor dependency to edit one markdown file is not worth it.)

The task detail page subscribes to the project WS stream while open so agent comments and status changes appear live.

### 9.2 State management

Zustand. The validated decomposition (which replaces v1's three-store prescription):

- `useAuth` — a state machine: `loading | setup_required(hint) | unauthenticated(message) | authenticated(email, displayName)`. PostDeploySetup routing needs the four states.
- `useProjects` — projects indexed `byId` and `bySlug`.
- `useBoard` — the active project's `tasks` / `runs` / `events` records, a `applyWsMessage` dispatcher, and optimistic transition with rollback.

Run-log lines may live in run-viewer component state — they're ephemeral.

**WebSocket client rules** (`lib/ws.ts`):

- One socket per open project. Reconnect with exponential backoff: start 250ms, cap 30s, jitter ±20%.
- **Outbound messages queue until the socket is OPEN**, and active run subscriptions are **re-sent after every (re)connect**. (A `subscribe.run` sent while CONNECTING is silently dropped by the browser — this killed live logs in v1.)
- The refetch-state-on-reconnect callback fires after the new socket **opens** — never in the close handler (refetch storms, and it misses the gap it exists to fill).
- Heartbeat: send the literal string `ping` every 25s; the server auto-responds `pong` (§10.4). These are raw strings, not JSON frames.

### 9.3 UX rules

- Optimistic updates on drag-and-drop, rolled back on API error (the rollback must restore the *previous* status, not blindly refetch). Comment posts are server-confirmed — simpler, one same-origin round trip — but failures must surface an error; never silently drop a comment.
- Markdown rendering for descriptions and comments: `react-markdown` + `remark-gfm`.
- Activity feed is **newest-first** (matches the API's `id DESC` order and the `?before` cursor direction); new events prepend at the top.
- The run viewer log auto-scroll behavior per §9.1.
- API client: non-JSON error responses (e.g. HTML error pages from the edge) must be handled gracefully — surface status + text, never throw a raw `SyntaxError`.

### 9.4 Visual style

Clean, dense, keyboard-friendly. Think Linear, not Trello. Monospace for IDs and code. Dark mode is the only mode. Slate background, indigo accents, green/amber/red status semantics. The whole theme is one hand-written `styles.css` — no Tailwind (v1 prescribed it; the hand-rolled CSS shipped first and is equivalent for a single fixed theme), no CSS-in-JS, no UI kit.

---

## 10. TasksRoom Durable Object

One instance per project (`idFromName(projectId)`).

### 10.1 Responsibilities

- Accept WebSocket connections for clients viewing the project.
- Receive broadcast messages from the rest of the Worker and fan out to connected clients, filtering per-client run-log subscriptions.
- Use the **WebSocket Hibernation API** (`acceptWebSocket`, `webSocketMessage`, `webSocketClose`). Never the legacy event-listener API.

### 10.2 Message protocol

Defined in `packages/shared/src/ws-protocol.ts`. All messages JSON **except the heartbeat** (raw `ping`/`pong` strings — see §10.4).

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
  | { type: 'run.log'; runId: string; lines: string[] };
```

**Client → server**

```typescript
type ClientMessage =
  | { type: 'subscribe.run'; runId: string }
  | { type: 'unsubscribe.run'; runId: string };
```

Default subscription: all `task.*`, `event.*`, `run.created`/`run.updated` for the project. Clients opt in to `run.log` per run.

### 10.3 Internal broadcast endpoint

The DO exposes `POST /broadcast`, called via `lib/broadcast.ts` (the only caller) through the DO binding. **No token auth**: in the single-script architecture the DO is unreachable except via its binding, and the only externally-driven forward (the WS upgrade in `api/ws.ts`) preserves the original `/ws/...` path, so no external request can ever arrive with pathname `/broadcast`. Enforce method `POST` and reject other paths. (v1 required `INTERNAL_API_TOKEN` here; see §7.3 for why that's gone.)

### 10.4 Liveness — hibernation-friendly heartbeats

v1's timestamped JSON ping/pong woke the DO from hibernation on every ping (25s × every client), defeating the "idle DOs are free" goal. v2 uses the platform primitive:

- In the DO constructor: `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))`. The runtime answers heartbeats **without waking the DO**.
- Clients send the literal string `ping` every 25s.
- A low-frequency alarm (every 2–5 minutes, set while any socket is attached) sweeps sockets whose `ctx.getWebSocketAutoResponseTimestamp(ws)` is older than **90 seconds** (3 missed pings) and closes them. Broadcast-time opportunistic sweeping stays as a bonus.
- On reconnect the client refetches via REST and resubscribes. No message replay.

Set `compatibility_date` ≥ `2026-04-07` to pick up automatic Close-frame replies for hibernated sockets.

---

## 11. Orchestrator Durable Object

Singleton — always `idFromName('singleton')`.

### 11.1 Dispatch contract

Durable Objects cannot consume queues directly. The topology is:

1. The Worker's `queue()` handler forwards the batch to the Orchestrator's `POST /dispatch`.
2. The DO returns a per-message result: `claimed { runId } | requeue { reason } | skipped { reason }`.
3. The consumer translates: `claimed`/`skipped` → `ack()`; `requeue` → `ack()` **plus a fresh** `env.DISPATCH.send({ ...body, requeueCount: n+1 }, { delaySeconds: 30 })`.

**Never use `message.retry()` for backpressure.** Retries increment the message's attempt counter; with `max_retries: 5`, a healthy task waiting behind a busy project dead-letters after ~2.5 minutes. `retry()` is reserved for genuine processing failures (Orchestrator unreachable, missing result), so the DLQ keeps meaning "something is broken", not "we were busy". Cap `requeueCount` (e.g. 240 ≈ 2h of waiting) and surface a system event if exceeded.

### 11.2 Claim semantics — the honest version

v1 claimed the singleton DO serializes claims. **It does not**: input gates only cover DO storage operations; every `await` on D1 or `fetch` is an interleaving point, so two concurrent `/dispatch` requests can both pass the concurrency check. Required:

- An **in-instance promise-chain mutex** around the claim path (cheap, correct for a singleton), and
- A **conditional claim write** as a D1-level CAS: `UPDATE tasks SET status='running' WHERE id=? AND status='ready'`, checking rows-affected before creating the run.

(v1 also suggested `this.state.storage.transaction` for the claim + run-create — impossible; DO storage transactions cannot span D1.)

Claim sequence per message: load task (skip unless `ready`) → **re-check unresolved blockers** (revert to `blocked` + event + broadcast + skip if any — §8.5) → load project → count in-flight runs (statuses `queued|preparing|running|landing` joined to the project) and requeue if at `concurrencyLimit` → CAS-claim, insert run (`sandboxId = taskId`), write `status_change` event, broadcast `task.updated` + `run.created` → `env.RUN.create({ id: runId, params })` → persist `workflowInstanceId` on the run.

### 11.3 Reconciliation alarm

Fires every 60s while armed (armed on first dispatch, re-armed after each sweep). For each task in `running`:

- Load its latest run. **If there is no run at all**, reset the task (gate → `ready`/`blocked`, event, broadcast, enqueue if ready).
- If the run is in an active status, **query the actual Workflow**: `env.RUN.get(run.workflowInstanceId)` → `.status()`. Only when the instance is `errored | terminated | complete`-but-row-still-active, or the instance id is missing/not found after a grace period, mark the run `failed`, reset the task (gate + enqueue), write a system event, and broadcast **both** `task.updated` and `run.updated`.
- **Never use wall-clock age as the stuck signal.** v1's 5-minute heuristic murdered every legitimate run (the runAgent step alone is allowed 2 hours) and could spawn a second concurrent Workflow against the same sandbox. Any age-based fallback must exceed the runAgent timeout plus land retries.
- Orphaned-sandbox sweep: destroy any sandbox whose task has had no active run for 24h (`getSandbox(env.Sandbox, taskId).destroy()`, ignore errors). Containers auto-sleep when idle so this is hygiene, not cost-critical.

### 11.4 Concurrency

`projects.concurrencyLimit` defaults to 2. Counted from D1 (runs in active statuses), not from in-memory state — the DO can be evicted at any time.

---

## 12. ImplementationRun Workflow

Cloudflare Workflows class, binding `RUN`, one instance per run, instance id == run id.

### 12.1 Steps

```
prepare → runAgent → land → finish      (catch: mark-failed)  (finally: cleanup)
```

- **prepare** — load task + project; set run `preparing` + broadcast; mint run token; render the prompt from the project's `WORKFLOW.md` (§13.4); write `/workspace/.philharmonic/{prompt.md, run-token (mode 600), mcp.json, branch}`; clone the repo to **`/workspace/repo`** (shallow, `--branch <defaultBranch>`); create branch `philharmonic/<identifier-lowercased>`. **Idempotent**: `rm -rf /workspace/repo` before cloning, `git checkout -B`. (The metadata dir lives *outside* the git tree so the agent can't commit the run token; v1's layout put the repo at `/workspace` itself, which is both un-clonable into a non-empty dir and a token-leak hazard.)
- **runAgent** (retries `{ limit: 1, delay: '30 seconds' }`, timeout `'2 hours'`) — set run `running` + broadcast; run the agent **with streaming output** (§13.3): broadcast `run.log` frames as lines arrive (batch ~25 lines; direct `safeBroadcast` to the TasksRoom — no HTTP self-hop) and accumulate the full transcript. Non-zero exit → throw (stderr tail in the message).
- **land** (retries `{ limit: 2, delay: '15 seconds' }`) — set run `landing` + broadcast; **the agent opens the PR** (§13.4 — v1 contradicted itself here; the agent owning `gh pr create` is correct); land only *harvests*: `gh pr list --head <branch> --json url` → `runs.prUrl`; capture `git diff origin/<defaultBranch>...HEAD` (never `origin/HEAD` — absent on shallow `--branch` clones) as a `pr_diff` artifact at the **deterministic key** `runs/<runId>/diff.patch` (upsert: skip the insert if the artifact row exists — idempotence under retries).
- **finish** — persist the full agent transcript as a `logs` artifact (`runs/<runId>/agent-log.jsonl`); **if the run is `deferred`, stop here** (the agent declared a dependency mid-run; don't overwrite); otherwise set run `succeeded` + `endedAt`; if the task is still `running`, fall back to transitioning it to `review` with a system event (the agent normally does this itself via MCP); broadcast run + task.
- **mark-failed** (in the catch) — set run `failed` + `errorMessage` + `endedAt`; reset the task **only if it is still `running`** (never clobber an agent-set `review` or `blocked`), through the gate (§8.5), **and enqueue it** if it lands in `ready`; persist the partial transcript as the `logs` artifact; broadcast; rethrow.
- **cleanup** (in the finally) — `sandbox.destroy()`, ignore errors.

Every step body must be safe to re-execute (Workflows replay on resume).

### 12.2 Cancellation — corrected platform semantics

`instance.terminate()` halts the Workflow **immediately. `finally` steps do not run.** (v1 claimed cleanup still runs after terminate — wrong.) Therefore cancellation cleanup lives in the **shared cancel helper** (`lib/cancel.ts`), used by both `POST /api/runs/:id/cancel` and the `→ cancelled` transition: terminate the instance (tolerate "already terminal" errors), destroy the sandbox, set run `cancelled` + `endedAt`, reset the task through the gate + enqueue, broadcast run + task. The reconciliation alarm (§11.3) is the backstop for anything that slips through.

### 12.3 CI waiting — descoped

v1 specified a CI-polling loop in land (`step.sleep` up to 30 min). **Descoped for v2**: test evidence arrives via the agent (`add_proof_of_work` with test output); reviewers see CI on the PR itself. If a future milestone needs `ci_summary` artifacts, poll `gh pr checks` in short steps with `step.sleep` between.

---

## 13. Sandbox container

### 13.1 Image

`containers/sandbox/Dockerfile` **must** extend the official sandbox image — the SDK's control plane (exec, file I/O, port exposure) is a server inside that image; a bare `node:` base builds fine and fails at runtime:

```dockerfile
FROM docker.io/cloudflare/sandbox:<VERSION>   # exact tag == the @cloudflare/sandbox version in apps/worker/package.json

# extras: gh CLI, ripgrep, etc.
# Claude Code CLI, pinned
RUN npm install -g @anthropic-ai/claude-code@<PINNED>

# Tasks MCP server — lockfile committed, reproducible install
COPY mcp/tasks-mcp /opt/tasks-mcp
WORKDIR /opt/tasks-mcp
RUN npm ci && npm run build && npm prune --omit=dev

WORKDIR /workspace
# NO ENTRYPOINT override — the base image's control-plane entrypoint must keep running.
```

Rules: the image tag and the npm `@cloudflare/sandbox` version are **identical and exact-pinned** (the SDK checks compatibility at startup); never override `ENTRYPOINT`/`CMD`; `npm ci` against a committed `package-lock.json` (tasks-mcp sits outside the pnpm workspace globs, so it keeps its own lockfile).

### 13.2 What the Workflow writes into the sandbox

```
/workspace/
├── repo/                  ← the clone; agent cwd; feature branch pre-created
└── .philharmonic/         ← outside the git tree
    ├── prompt.md          ← rendered WORKFLOW.md
    ├── run-token          ← mode 600
    ├── mcp.json           ← MCP config (below)
    └── branch             ← feature branch name
```

```json
{
  "mcpServers": {
    "philharmonic": {
      "command": "node",
      "args": ["/opt/tasks-mcp/dist/index.js"],
      "env": {
        "PHILHARMONIC_API_BASE": "<API_BASE>",
        "PHILHARMONIC_RUN_TOKEN_FILE": "/workspace/.philharmonic/run-token"
      }
    }
  }
}
```

### 13.3 Agent invocation

```bash
claude -p "$(cat /workspace/.philharmonic/prompt.md)" \
  --output-format=stream-json --verbose \
  --mcp-config /workspace/.philharmonic/mcp.json \
  --permission-mode=acceptEdits \
  --max-turns 100
```

- **`--verbose` is mandatory** with `-p --output-format=stream-json` — without it the CLI exits immediately with a usage error. (v1 omitted it; no agent run could ever start.)
- **cwd = `/workspace/repo`** (the clone), matching what the prompt tells the agent.
- **Placeholder credentials:** `gh` and `claude` both refuse to start when no token is present locally — they fail before making the network request the egress handler would authenticate. The exec env must set `GH_TOKEN=egress-injected` and `ANTHROPIC_API_KEY=egress-injected`; the outbound handler **overwrites** the auth headers at the edge (§15), so real secrets still never enter the container.
- Run via streaming exec — `sandbox.exec(cmd, { stream: true, onOutput })` (or `startProcess` + `streamProcessLogs`) — forwarding line batches to the TasksRoom as they arrive (§12.1). stdout is NDJSON, one event per line; persist the full stream as the run's `logs` artifact in finish/mark-failed.

### 13.4 What the agent is told

`containers/sandbox/WORKFLOW.md` is the **single canonical default template**. The projects API seeds new projects from it — the Worker imports the file as a text module (wrangler `rules: [{ type: "Text", globs: ["**/*.md"] }]`); there must be **no second inline copy** drifting out of sync (v1's implementation had a stripped-down `DEFAULT_WORKFLOW_MD` constant that silently superseded the rich template — the dependency-deferral protocol was never reaching agents).

Template requirements:

- The comment frontmatter (variable documentation) is for humans editing the template and is stripped from the rendered prompt.
- Supported constructs, implemented in `lib/workflowmd.ts`: `{{ a.b.c }}` substitution and `{{#if (gt path N)}}…{{/if}}`.
- Variables: `project.{name,repoUrl,defaultBranch}`, `task.{identifier,title,description,priority,createdBy,createdAt}`, `run.{id,attempt}`. `run.attempt` = 1 + count of prior runs for the task.
- Content (the shipped template is authoritative): understand the codebase first → post a plan via `post_comment` → **declare dependencies before writing code** (`declare_dependency` + explanatory comment + exit) if the task depends on incomplete work → implement, matching local conventions → run tests → `gh pr create` titled `<identifier>: <summary>` with What/Why/How/Decisions/Testing sections → attach proof of work → `update_status` to `review`. The repo is at `/workspace/repo`. The Tools section must list **all** MCP tools including `declare_dependency`.

---

## 14. Tasks MCP server

`containers/sandbox/mcp/tasks-mcp/`, MCP over stdio, official `@modelcontextprotocol/sdk`.

### 14.1 Tools

| Tool | Description |
|---|---|
| `read_task` | Returns `{ task, project: { id, name, slug, repoUrl, defaultBranch } }`. No arguments. |
| `post_comment` | `{ body }` — agent comment on the task. |
| `update_status` | `{ to: 'review' \| 'ready' }` — `review` transitions; `ready` answers `{ ok, ignored: true }`. |
| `declare_dependency` | `{ blockedBy: '<IDENTIFIER>' \| taskId, reason? }` — declare this task blocked by another (§8.5). On success the agent should post a brief comment and exit; the platform re-queues automatically when the blocker resolves. Response includes `alreadyResolved: true` when the named blocker is already done/cancelled (keep working). |
| `add_proof_of_work` | `{ kind: 'pr_diff'\|'screenshot'\|'video'\|'logs'\|'ci_summary'\|'other', caption?, content?, file_path? }` — inline text via `content`; for `file_path` **the MCP server performs the upload itself**: `POST /uploads` → `PUT` the bytes → `POST /proof` with the `uploadId`. (v1's implementation exposed only a raw `uploadId` parameter with nothing to perform the upload — binary proof was unreachable.) |
| `read_workflow_md` | Returns the project's current `WORKFLOW.md`. |

### 14.2 Authentication

Reads the run token from `$PHILHARMONIC_RUN_TOKEN_FILE` at startup; sends `Authorization: Bearer <token>` on every call. 401 → MCP tool error with a clear message.

### 14.3 Failure semantics

- Retry **network errors and 5xx only**, exponential backoff, 3 attempts total. Never retry 4xx. Never retry after a 2xx (POST retries are at-least-once — duplicate comments are worse than a tool error).
- Tool errors must include the API's structured error body (`code` + `message`), not just an HTTP status.
- Parse response bodies defensively: fall back to raw text when JSON parsing fails (edge HTML error pages must not crash the tool or be misclassified as retryable).
- **Never silently succeed.**

---

## 15. Egress — sandbox outbound handlers

**v2 platform correction.** v1 prescribed a separately-deployed proxy Worker wired through a `containers[].global_outbound` config key. That key does not exist in wrangler's schema, and `@cloudflare/sandbox` 0.5.x had no outbound support at all — the v1 design was undeployable, which means **a v1 install had no credential injection whatsoever**. The platform mechanism (since `@cloudflare/sandbox` 0.8.9) is class-level outbound handlers with TLS interception, running inside the main Worker:

```typescript
// apps/worker/src/sandbox/Sandbox.ts
import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
export { ContainerProxy } from '@cloudflare/sandbox';   // must also be re-exported from the Worker entrypoint

export class Sandbox extends BaseSandbox<Env> {
  // Deny-by-default allowlist. Non-HTTP(S) egress is not intercepted, so an
  // allowlist is strictly stronger than v1's private-IP regex deny-list.
  allowedHosts = [
    'github.com', '*.github.com', '*.githubusercontent.com',
    'api.anthropic.com',
    'registry.npmjs.org',
    '<PHILHARMONIC_HOST>',          // the app's own API, for the Tasks MCP
  ];

  static outboundByHost = {
    'github.com': injectGitHub, '*.github.com': injectGitHub, '*.githubusercontent.com': injectGitHub,
    'api.anthropic.com': injectAnthropic,
  };
}
// injectGitHub: set Authorization: Bearer <env.GITHUB_TOKEN>  (overwrite the placeholder)
// injectAnthropic: set x-api-key: <env.ANTHROPIC_API_KEY>
```

Rules:

- Handlers run in the **Worker's** environment — they read the `GITHUB_TOKEN` / `ANTHROPIC_API_KEY` Secrets Store bindings already on the main Worker. The container only ever sees placeholder values (§13.3).
- TLS interception is on by default; the base image trusts the per-sandbox CA out of the box. Only ports 80/443 are intercepted — hence the allowlist posture.
- One caveat: GitHub pre-signed URLs (`*.githubusercontent.com` release/raw redirects) break if an `Authorization` header is added — the inject function must skip injection when the URL already carries a signature query (`X-Amz-*` / `token=`).
- Delete from the repo: the standalone outbound Worker (`src/outbound/`), `wrangler.outbound.jsonc`, and the `global_outbound` comment in `wrangler.jsonc`. No second Worker, no deploy-ordering dance.
- Version gates: `@cloudflare/sandbox` ≥ 0.8.9 for handlers + TLS interception + allow/deny lists. Pin the current version exactly (0.12.1 as of this writing) and keep the image tag identical (§13.1).

---

## 16. Wrangler configuration

`wrangler.jsonc` at the **repo root** (§0.5). Empty-string IDs are filled by the Deploy button or `bootstrap.ts`. The authoritative file is the source; the shape:

```jsonc
{
  "name": "philharmonic",
  "main": "apps/worker/src/index.ts",
  "compatibility_date": "2026-04-07",        // ≥ 2026-04-07 for WS close auto-reply (§10.4)
  "compatibility_flags": ["nodejs_compat"],

  "assets": {
    "directory": "./apps/web/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": true                  // REQUIRED — without it the asset matcher
  },                                          // swallows /api/* and /ws/* with index.html

  "vars": { "ACCESS_TEAM_DOMAIN": "", "ACCESS_AUD": "", "API_BASE": "" },

  "d1_databases": [{ "binding": "DB", "database_name": "philharmonic", "database_id": "", "migrations_dir": "migrations" }],
  "r2_buckets": [{ "binding": "ARTIFACTS", "bucket_name": "philharmonic-artifacts" }],

  "queues": {
    "producers": [{ "binding": "DISPATCH", "queue": "philharmonic-dispatch" }],
    "consumers": [{
      "queue": "philharmonic-dispatch",
      "max_batch_size": 1, "max_batch_timeout": 5,
      "max_retries": 5,                       // genuine failures only — backpressure
      "dead_letter_queue": "philharmonic-dispatch-dlq"   // re-sends, never retry() (§11.1)
    }]
  },

  "durable_objects": {
    "bindings": [
      { "name": "TASKS_ROOM", "class_name": "TasksRoom" },
      { "name": "ORCHESTRATOR", "class_name": "Orchestrator" },
      { "name": "Sandbox", "class_name": "Sandbox" }
    ]
  },
  // Incremental migration tags reflect deploy history; never fold deployed
  // classes into one tag retroactively.
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["TasksRoom"] },
    { "tag": "v2", "new_sqlite_classes": ["Orchestrator"] },
    { "tag": "v3", "new_sqlite_classes": ["Sandbox"] }
  ],

  "containers": [{
    "class_name": "Sandbox",
    "image": "./containers/sandbox/Dockerfile",
    "instance_type": "standard-1"             // lite|basic|standard-1..4 (wrangler ≥4.86 names)
  }],

  "workflows": [{ "name": "implementation-run", "binding": "RUN", "class_name": "ImplementationRun" }],

  // The Deploy UI prompts for these; bootstrap.ts creates them via the CLI.
  "secrets_store_secrets": [
    { "binding": "ANTHROPIC_API_KEY", "store_id": "", "secret_name": "ANTHROPIC_API_KEY" },
    { "binding": "GITHUB_TOKEN",      "store_id": "", "secret_name": "GITHUB_TOKEN" },
    { "binding": "RUN_TOKEN_SECRET",  "store_id": "", "secret_name": "RUN_TOKEN_SECRET" }
  ],

  "rules": [{ "type": "Text", "globs": ["**/*.md"] }],   // WORKFLOW.md text-module import (§13.4)
  "observability": { "enabled": true, "head_sampling_rate": 1 }
}
```

Notes:

- **`run_worker_first: true` is load-bearing.** v1's sample config omitted it and was broken as written.
- There is no second Worker anymore (§15). No `wrangler.outbound.jsonc`.
- **Deploy-button caveat:** the button's auto-provisioner covers D1, R2, Queues, DOs, and Secrets Store — **not Containers or Workflows**, and Dockerfile-path images are built by `wrangler deploy` *locally with Docker*. Treat Path A as the control-plane install; the canonical full-stack deploy (containers included) is Path B (`pnpm bootstrap` + `pnpm run deploy`, Docker required). Document this honestly in the README; a future improvement is publishing the sandbox image to a registry and referencing it by URI.
- The DLQ (`philharmonic-dispatch-dlq`) is only a string reference in the consumer block — bootstrap creates it explicitly; verify it exists after a Path A install.

### 16.1 First-run UX

When the Worker runs with empty `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`: `/api/me` returns `{ setupRequired: true, hint }`, all other authed routes return 503 `setup_required` (§7.1), and the SPA shows **PostDeploySetup** — copy-pasteable steps to create the Access application, copy the team domain + AUD, set the vars, and redeploy; plus an "I'm done — re-check" button. `ACCESS_TEAM_DOMAIN` must include `https://`.

### 16.2 Wrangler CLI shapes that bit us (bootstrap.ts must use these)

- `wrangler d1 create <name>` prints a **JSONC** snippet when the project config is JSON-format (not TOML). Parse `"database_id": "..."`, or better: `wrangler d1 list --json` after create.
- Secrets Store (wrangler 4.x): `secrets-store store create <name> --remote` (omitting `--remote` creates a *local simulated* store); `secrets-store secret create <store-id> --name <NAME> --scopes workers --remote` with the value via stdin (never `--value` — argv leaks); `secrets-store secret list <store-id> --remote`; update requires `--secret-id`, not a name.
- `pnpm deploy` is a **reserved pnpm built-in** and does not run the package script. All docs and printed next-steps say `pnpm run deploy`.

---

## 17. Milestones

### Shipped (M0–M8, D0–D3)

| Milestone | Delivered |
|---|---|
| M0 | Repo skeleton, root wrangler.jsonc, Deploy button scaffolding, bootstrap.ts, postdeploy.ts, dev.ts |
| M1 | Hono router, Access JWT verification, SPA skeleton, PostDeploySetup |
| M2 | Drizzle schema + migrations, projects/tasks REST, kanban board |
| M3 | TasksRoom DO (hibernation), live task/event updates |
| M4 | Orchestrator DO, queue consumer, concurrency limits |
| M5 | Workflow + sandbox container + echo agent, run log plumbing |
| M6 | Real Claude agent, Tasks MCP, run tokens |
| M7 | Egress proxy logic, git clone, PR-capture land step |
| M8 | Run viewer, cancel, reconciliation skeleton, proof-of-work display |
| D0–D3 | Task dependencies: schema, manual deps, auto state management, dependency UI, agent-declared deps |

### M9 — v2 hardening (current; tracked in `tasks.md`)

The audit-driven reconciliation this spec version exists for. Highlights: real Workflow-status reconciliation; requeue without burning retries; shared cancel helper; `--verbose` + placeholder creds + streaming agent exec; egress via Sandbox outbound handlers (SDK 0.12.x); run-scoped uploads; gated ready-resets everywhere; deferred runs; canonical WORKFLOW.md; WS client queue/resubscribe; markdown rendering; ProjectSettings editor; hibernation-friendly heartbeats; bootstrap CLI fixes; first tests. Acceptance: §18 below.

### M10 — preview & CI surfacing (next, not started)

- Embedded sandbox preview in the run viewer, via `sandbox.tunnels.get(port)` (quick tunnels work on `.workers.dev`; `exposePort` needs a custom domain).
- PR CI status badge on the task card / run viewer (worker-side: `gh pr checks` polling or PR head status).
- Requires worker plumbing (preview URL on the run DTO) that intentionally does not exist yet.

---

## 18. Acceptance criteria

### 18.1 Tests (new in v2)

Vitest, plain node environment, colocated `*.test.ts`. Required coverage (pure logic — no Workers runtime needed):

- `runtoken`: round-trip, expiry, tampered payload/sig, malformed input → typed errors (never throws unhandled).
- `transitions`: the full §8.1 matrix — allowed/denied per actor, including blocked lanes and agent-only `running → blocked`.
- `workflowmd`: variable substitution, conditionals, frontmatter stripping, missing keys.
- `dependencies`: cycle DFS (self, direct, transitive), gate semantics, resolution AND-logic with cancelled-counts-as-resolved.
- Shared package: worker and SPA import DTO/protocol types from `@philharmonic/shared` — no local re-declarations (typecheck enforces).

### 18.2 System criteria

All of the following on a fresh deployment:

**Auth.** No Access → Cloudflare login page. With Access, `/api/me` returns the email. Tampered `Cf-Access-Jwt-Assertion` → 401. `/api/internal/*` without a run token → 401; with a garbage token → 401 (never 500). A token for run A cannot read, write, comment, upload, or attach proof against any other run/task.

**Distribution.** `git clone && pnpm install && pnpm bootstrap && pnpm run deploy` on a fresh account (with Docker) reaches PostDeploySetup. Bootstrap is idempotent: second run skips existing resources and never silently overwrites secrets. `pnpm build` succeeds from a fresh clone with no Cloudflare state. Deploy button provisions the control plane and reaches PostDeploySetup (container limitations documented).

**Tasks & dependencies.** Create/drag works live across two browser tabs within 1s. Ready→running within 5s of dispatch. A ready task at the concurrency limit waits **indefinitely** without dead-lettering and starts when a slot frees. Adding an unresolved blocker to a backlog/ready task lands it in `blocked`; resolving the last blocker (done *or* cancelled) auto-moves dependents to `ready` and dispatches them. Cycle and cross-project adds are rejected with typed errors.

**Agent run.** A trivial task ("add a TODO to the README") on a real repo: agent starts (placeholder creds + `--verbose` correct), posts a plan comment, opens a PR titled `<IDENTIFIER>: <summary>`, logs stream **live** (frames arriving while the agent is mid-run, not after exit), task ends in `review` with `prUrl` set, a `pr_diff` and a `logs` artifact exist. An agent that declares a dependency ends its run as `deferred`, the task sits in `blocked`, the concurrency slot frees immediately, and blocker resolution re-dispatches automatically.

**Resilience.** Cancelling a running task (either via the run or the task transition) terminates the Workflow and destroys the sandbox within 10s. A run legitimately executing for >5 minutes is **not** touched by reconciliation; a run whose Workflow instance is errored/terminated/missing is reconciled within 2 minutes, and the task is re-dispatched (or re-blocked) — never stranded. Worker redeploy mid-run does not lose the run.

**Security.** `ANTHROPIC_API_KEY`/`GITHUB_TOKEN` appear nowhere in the SPA bundle, API responses, or container env (`sandbox.exec('env')` shows only placeholders). Egress to hosts outside the allowlist is blocked; private-range requests from the sandbox fail.

**UX.** Board cold-load < 2s. Live updates without flicker. 500-event feed renders without degradation. Markdown renders in descriptions and comments. Deep-linked task pages have working action buttons. WORKFLOW.md edits via settings take effect on the next run with no redeploy.

---

## 19. Out of scope (do not build)

- User management UI (Access owns users), billing, quotas.
- GitHub webhook receivers — the agent polls via `gh`.
- Any LLM other than Claude. A CLI client. Email/Slack/calendar.
- Multi-region. Sandbox snapshots/backups. Run-token revocation lists.
- `assignee` filtering/UI (column exists in the schema; surfacing it is a future milestone).
- Comments-on-PRs ingestion into the task feed.

---

## 20. README requirements

1. **Prerequisites** — Cloudflare account (Workers Paid for containers), Anthropic API key, GitHub fine-grained PAT, Node 22+, pnpm 9+, **Docker** (container image builds during deploy).
2. **Install paths** — Deploy button (control plane; container caveat per §16) and manual (`pnpm bootstrap` + `pnpm run deploy` — always `pnpm run`, see §16.2).
3. **Access setup** — the PostDeploySetup walkthrough, including the audience tag and the `https://` requirement.
4. **Local development** — what `pnpm dev` actually does (dev.ts wrapper, placeholder IDs, Docker needed for sandbox work, `pnpm build` first for assets).
5. **CI/CD** — what deploy.yml needs (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and its relationship to Workers Builds for Deploy-button forks (delete one or accept double deploys).
6. **Using it** — projects, tasks, dependencies, the run lifecycle, reviewing proof of work.
7. **Customizing WORKFLOW.md** — template variables, where to edit, when changes take effect.
8. **Troubleshooting** — setup-required loop, agent can't authenticate (egress allowlist), task stuck in blocked (manually parked), DLQ meaning.

No links to files that don't exist.

---

## 21. If you get stuck

1. Write the problem into `BLOCKERS.md`: what you tried, what failed, what you suspect.
2. Pick the safest viable path — usually "stub it out, leave a clearly-marked TODO, keep going."
3. Record real deviations in `DEVIATIONS.md` with reasoning.

The goal is a working system that tells the truth about itself. We iterate from there.

---

End of spec.
