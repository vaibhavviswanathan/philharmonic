# Philharmonic — v2 hardening task tracker

Working tracker for the SPEC v2 update and the implementation pass that follows it.
Derived from a full multi-agent audit of branch `d3-agent-deps` (M0–M8 + D0–D3) against SPEC v1.
Statuses: `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` dropped (with reason).

Branch: `v2-hardening` (stacked on `d3-agent-deps`).

---

## 0. Meta

- [x] T0.1 Audit implementation vs SPEC v1 (multi-agent map + verify; 6/8 subsystems, re-ran deploy + platform checks)
- [x] T0.2 Rewrite SPEC.md to v2 — absorb implementation-validated deviations, dependency feature, platform corrections
- [x] T0.3 Create this tasks.md
- [x] T0.4 Update DEVIATIONS.md (most v1 deviations get absorbed into SPEC v2; file shrinks to genuinely-open deviations)
- [x] T0.5 Update README to match reality (template story, secrets list, settings page)
- [x] T0.6 Final build + typecheck + lint + tests green (61 tests; biome clean; wrangler --dry-run parses)
- [x] T0.8 Adversarial multi-agent review of the full diff — 20 confirmed findings, all fixed:
  - critical: land step clobbered `deferred` runs (the deferral short-circuit was dead code)
  - high: reconcile treated transient RPC errors as instance-not-found (would kill healthy runs); alarm sweep wasn't under the claim mutex (double-claim window); deferred runs clobbered by mark-failed; empty `API_BASE` silently broke the whole agent↔API channel on fresh deploys (now fails loudly + documented in PostDeploySetup/README/bootstrap)
  - medium: missing CAS guards on reconcile/cancel writes; agent-declare gate raced blocker resolution; uploads accepted unminted ids with no size cap; bootstrap echoed secrets to the terminal; README CI section omitted the commit-the-patched-config prerequisite; sandbox SDK was caret-ranged vs the exact-pinned image
  - low: cleartext credential injection; sticky SPA error states; optimistic-update clobbering; dev-config containers flip; whoami auth check no-op; classic-PAT scope names; missing status_change event on workflow failure resets
- [ ] T0.7 Push branch + open PR (stacked on d3-agent-deps)

## 1. Orchestrator / Queue / Workflow (worker core)

- [x] T1.1 **critical** Reconciliation must check real Workflow status (`env.RUN.get(workflowInstanceId)` → `.status()`), never a 5-min wall clock. Current code kills every legitimate run >5 min and can double-run the same sandbox. `do/Orchestrator.ts:246`
- [x] T1.2 **high** At-concurrency-limit requeue burns the queue retry budget → tasks dead-letter after ~2.5 min of waiting. Switch to ack + fresh `DISPATCH.send(..., { delaySeconds: 30 })`. `queue/consumer.ts:39`
- [x] T1.3 **high** Every path that resets a task to `ready` must (a) gate on unresolved blockers (`gateReadyTransition`) and (b) re-enqueue on DISPATCH. Today reconcile, workflow `mark-failed`, and run-cancel all skip both → stranded tasks and clobbered `blocked` status. `Orchestrator.ts:262`, `ImplementationRun.ts:269`, `api/runs.ts:94`
- [x] T1.4 **high** `mark-failed` must only reset `running → ready` (guard the current status) so it never clobbers an agent-set `review`. `ImplementationRun.ts:269`
- [x] T1.5 **medium** Serialize the claim path: in-instance promise-chain mutex around `tryClaim` + conditional claim UPDATE (`WHERE status='ready'`, check rows affected) as a D1-level CAS. `Orchestrator.ts:58`
- [x] T1.6 **medium** Reconcile: handle `running` task with no runs row (reset to ready+gate+enqueue) and broadcast `run.updated` alongside `task.updated`. `Orchestrator.ts:242`
- [x] T1.7 **medium** Task `* → cancelled` transition with an active run must terminate the Workflow, destroy the sandbox, and mark the run cancelled — share one cancel helper with `POST /api/runs/:id/cancel`; reject cancelling already-terminal runs. `api/tasks.ts:132`
- [x] T1.8 **medium** Prepare-step idempotence: `rm -rf` repo dir before clone (or fetch-if-exists), `git checkout -B`; land-step idempotence: deterministic pr_diff key (`runs/<runId>/diff.patch` upsert); diff against `origin/<defaultBranch>` not `origin/HEAD`. `ImplementationRun.ts:107,202`
- [x] T1.9 **medium** Cascade durability: run `resolveDependents` inline before the HTTP response (not `waitUntil`). `api/tasks.ts:133`
- [x] T1.10 **low** 24h orphaned-sandbox sweep in reconcile (destroy sandboxes whose task has no active run for >24h)

## 2. Agent run pipeline (workflow ↔ sandbox)

- [x] T2.1 **critical** `claude -p --output-format=stream-json` requires `--verbose` — without it every agent run exits immediately. `ImplementationRun.ts:134`
- [x] T2.2 **critical** Wire the egress for real, per SPEC v2 §15: `Sandbox` subclass with `static outboundByHost` (GitHub Authorization, Anthropic x-api-key) + `allowedHosts` allowlist; `export { ContainerProxy }` from the entrypoint; delete `src/outbound/` + `wrangler.outbound.jsonc` + the `global_outbound` comment; bump `@cloudflare/sandbox` to exact `0.12.1` and the Dockerfile base tag to match. (Platform-verified: `global_outbound` never existed; handlers require SDK ≥ 0.8.9.)
- [x] T2.3 **high** `gh`/`claude` refuse to start with no token present: set placeholder env (`GH_TOKEN`, `ANTHROPIC_API_KEY` = `egress-injected`) in the sandbox exec env; real secrets stay edge-injected.
- [x] T2.4 **high** Live log streaming: replace single blocking 2h exec with streaming exec (or `startProcess` + log polling loop), broadcasting `run.log` batches as they arrive; persist full stream as a `logs` artifact at run end (success AND failure).
- [x] T2.5 **high** Repo path consistency: clone is at `/workspace/repo` but agent cwd is `/workspace` and the prompt says "checked out at /workspace". Set cwd to `/workspace/repo` and fix the template. `ImplementationRun.ts:145`, `containers/sandbox/WORKFLOW.md`
- [x] T2.6 **medium** Deferred-run semantics for agent-declared dependencies: add `deferred` to run status enum; internal declare endpoint marks the run deferred (frees the concurrency slot — keep it out of ACTIVE_RUN_STATUSES); workflow finish step must not overwrite a deferred run with `succeeded`.
- [x] T2.7 **medium** Agent declare on an already-resolved blocker must NOT force `running → blocked` (permanent strand — nothing ever re-dispatches). Gate on blocker status; return `{ alreadyResolved: true }`. `api/internal.ts:341`
- [-] T2.8 superseded — SPEC v2 §15 replaced the deny-list proxy Worker with a deny-by-default `allowedHosts` allowlist on the Sandbox class (strictly stronger; private ranges unreachable by construction)

## 3. API (worker HTTP surface)

- [x] T3.1 **high** Run-scope uploads: R2 key `runs/<runId>/uploads/<uploadId>`; PUT and `/proof` validate the upload belongs to the token's run. `api/internal.ts:252-279`
- [x] T3.2 **medium** Events pagination: cursor is `id < before` but sort is `createdAt DESC` — order by `id DESC` so cursor and order agree. `api/tasks.ts:297`
- [x] T3.3 **medium** Malformed run token (bad base64 etc.) must yield 401, not 500 — wrap verify in try/catch with `malformed|bad_signature|expired` codes. `lib/runtoken.ts`
- [x] T3.4 **medium** Per-project task identifiers: derive prefix from uppercased project slug (`taskDto`, agent `PHIL-N` reference parsing, workflow prompt identifier); kill the hand-built task DTO duplicate in `api/runs.ts:118`
- [x] T3.5 **low** `sizeBytes` should be UTF-8 byte length (`TextEncoder`), not JS string length. `api/internal.ts:192`
- [x] T3.6 **low** Add `running → blocked (agent-only)` to the transitions RULES table so the state machine stays authoritative. `lib/transitions.ts`
- [x] T3.7 **low** `assignee` query filter on task listing (spec'd, unimplemented) — or drop from SPEC v2. Decision: drop (no UI for it).

## 4. Container + Tasks MCP

- [x] T4.1 **high** Make the rich `containers/sandbox/WORKFLOW.md` the single canonical default template — seed projects from it (wrangler Text module rule) and delete the divergent inline `DEFAULT_WORKFLOW_MD`.
- [x] T4.2 **high** `add_proof_of_work` must accept `file_path` and have the MCP server perform the upload itself (POST /uploads → PUT bytes → POST /proof). Today binary proof is unreachable.
- [x] T4.3 **medium** MCP tool errors must surface the API's structured error body; JSON-parse defensively (HTML error pages); never retry 4xx; 3-attempt backoff for network/5xx only.
- [x] T4.4 **medium** Commit `package-lock.json` for tasks-mcp, use `npm ci` in the Dockerfile; pin `@anthropic-ai/claude-code` to a known-good version.
- [x] T4.5 **low** Delete dead `containers/sandbox/entrypoint.sh` (base image's control-plane entrypoint must not be overridden).
- [x] T4.6 **low** `run.attempt`: pass 1 + count of prior runs for the task (template documents it; currently hardcoded 1).

## 5. Web SPA

- [x] T5.1 **critical** WS client: queue outbound messages until socket OPEN; re-send active run subscriptions after every (re)connect; fire refetch callback on open (not close). Without this, live run logs never render. `lib/ws.ts:91`
- [x] T5.2 **high** Task-detail action buttons silently no-op on deep links (board store not loaded). Actions must work standalone: call API, apply result locally.
- [x] T5.3 **high** ProjectSettings page: implement metadata + WORKFLOW.md editing (plain textarea + save; Monaco dropped in SPEC v2).
- [x] T5.4 **medium** Markdown rendering for task descriptions + comments (`react-markdown` + `remark-gfm`).
- [x] T5.5 **medium** Comment post failures must surface an error (today: silent loss).
- [x] T5.6 **low** `/` redirects to the sole project's board when exactly one project exists.
- [x] T5.7 **low** Drag-and-drop: dropping a card on its own column must not fire a transition.
- [x] T5.8 **low** API client: non-JSON error responses (HTML edge pages) must not throw raw SyntaxError.
- [x] T5.9 **low** Task detail: subscribe to project WS while open so agent comments/status changes appear live.
- [-] T5.10 Sandbox preview iframe + PR CI badge — DEFERRED to a named follow-up milestone in SPEC v2 (needs worker-side plumbing that doesn't exist; out of v2-hardening scope).

## 6. TasksRoom DO (real-time)

- [x] T6.1 **medium** Ping/pong via `setWebSocketAutoResponse` (fixed-string frames) + `getWebSocketAutoResponseTimestamp` so pings never wake the hibernated DO; keep 90s timeout; add low-frequency alarm sweep for quiet rooms.
- [x] T6.2 **low** Document (SPEC v2 + DEVIATIONS) that `/broadcast` is binding-internal in the single-script architecture; drop `INTERNAL_API_TOKEN` from required secrets (nothing verifies it) — remove from wrangler.jsonc + bootstrap prompts.

## 7. Distribution / bootstrap

(audit complete — findings verified against the pinned wrangler 4.86 CLI)

- [x] T7.1 Audit findings from deploy/bootstrap mapper — triaged below
- [x] T7.2 `pnpm build` verified clean from fresh clone (tsc/vite only; `wrangler deploy --dry-run` validates config)
- [x] T7.3 **critical** bootstrap.ts secrets-store CLI calls use flags that don't exist in wrangler 4.x — Path B dies at the secrets step every time. Real shapes (SPEC v2 §16.2): `store create <name> --remote`; `secret create <store-id> --name <NAME> --scopes workers --remote` (value via stdin, never `--value` argv); `secret list <store-id> --remote`; update needs `--secret-id`. Fix all five call sites + the idempotency guard + `--rotate`.
- [x] T7.4 **high** bootstrap.ts parses `d1 create` output with a TOML regex; wrangler emits JSONC for JSON-config projects. Parse the JSON form or use `d1 list --json` after create.
- [x] T7.5 **high** `pnpm deploy` is a reserved pnpm built-in (verified: ERR_PNPM_NOTHING_TO_DEPLOY). Replace with `pnpm run deploy` everywhere: README, bootstrap next-steps output, PostDeploySetup screen, SPEC examples.
- [x] T7.6 **low** Queue existence check uses substring match — `philharmonic-dispatch` matches the DLQ name; match whole names.
- [x] T7.7 README: add Docker prerequisite; local-dev section (dev.ts wrapper, build assets first); deploy.yml secrets (`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`) + Workers Builds double-CI note; Deploy-button container caveat (button provisions control plane only — containers/workflows are not in its documented auto-provision list, Dockerfile builds need local Docker); troubleshooting section; remove dead `docs/github-app.md` link; drop `--rotate`/`INTERNAL_API_TOKEN` references that no longer match.
- [x] T7.8 **low** seed.ts: implement minimal real seeding (project + a few tasks) or update the stale stub note.
- [x] T7.9 DEVIATIONS.md: shrink — v2 spec absorbs D1 (base image), D2 (naming), D3 (drizzle path); keep only genuinely-open deviations.
- [x] T7.10 Remove `INTERNAL_API_TOKEN` from wrangler.jsonc `secrets_store_secrets` + bootstrap prompts (SPEC v2 §7.3 — nothing ever verified it).

## 8. Tests (none exist today)

- [x] T8.1 Vitest setup at the worker package; unit tests for pure logic:
  - run token mint/verify (round-trip, expiry, tamper, malformed → typed errors)
  - transitions matrix (actor × from × to, including blocked lanes and agent-only running→blocked)
  - workflowmd renderer (vars, conditionals, missing keys)
  - dependency engine vs an in-memory DB if cheap, else pure parts (cycle DFS over a fake adapter)
- [x] T8.2 Shared package: ws-protocol/api-types compile-time contract (worker + SPA import shared types; kill SPA-local re-declarations)

## 9. SPEC v2 content checklist (what the rewrite must capture)

- [ ] §6: `blocked` status; `task_dependencies` table; `deferred` run status; per-project identifier derivation
- [ ] §7: token verify semantics (constant-time, typed 401s, claims-only scoping); INTERNAL_API_TOKEN removed
- [ ] §8: real route tables (uploads pair, workflow-md, dependencies, slug WS path, proxied artifacts); full transition matrix incl. gating; pagination semantics; cancel side effects
- [ ] §10: auto-response ping/pong; binding-internal broadcast; 90s/25s liveness numbers
- [ ] §11: dispatch contract (consumer↔DO results protocol); real reconcile algorithm; claim serialization; no-storage-transaction correction; dependency-aware dispatch
- [ ] §12: step structure as implemented (agent opens PR); terminate() semantics correction (no finally); streaming runAgent; idempotence patterns; deferred short-circuit
- [ ] §13: cloudflare/sandbox base image (D1 absorbed); /workspace/repo layout; --verbose; placeholder env tokens; canonical template single-sourcing
- [ ] §14: declare_dependency tool; file_path upload flow; error-body fidelity; kind enum aligned with §6
- [ ] §15: rewritten around the real outbound mechanism (pending platform audit); expanded deny-list
- [ ] §16/§0.5: wrangler config as shipped (run_worker_first, migrations chain v1-v3, containers block); 3 secrets not 4
- [ ] §9: implemented store shapes, WS client rules (queue+resubscribe), blocked column + dependency UI, newest-first feed, plain-CSS styling decision, action matrix
- [ ] §17/§18: updated milestones (M0–M8 done; v2-hardening as M9; preview/CI-badge as M10) + acceptance criteria matching v2 reality
- [ ] NEW: dependency feature section (schema, gating, cascade, agent deferral protocol, UI)
