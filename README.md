# Philharmonic

> Self-hosted coding-agent task manager. Runs entirely on Cloudflare. Powered by Claude.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_ORG/philharmonic)

Philharmonic turns a task into a pull request. Create a card, click **Run**, and Claude implements it — clones the repo, writes the code, runs the tests, opens a PR — all inside an isolated Cloudflare sandbox. You review the result on the task card and merge.

It's a Cloudflare-native take on [openai/symphony](https://github.com/openai/symphony), with a hosted task tracker instead of Linear and Claude instead of Codex.

---

## How it works

```
You file a task  →  click Run  →  Sandbox spins up  →  Claude implements  →  PR opens  →  You review
                       │                                                      │
                       └──────── live updates over WebSocket ◄────────────────┘
```

- **Task tracker** — kanban board with backlog / ready / running / review / done columns
- **Auth** — Cloudflare Access (Google, GitHub, email OTP — all without writing login code)
- **Agent runtime** — Claude Agent SDK running headless inside a Cloudflare Sandbox container, one container per task
- **Orchestration** — Cloudflare Workflows for durable, resumable, multi-hour runs
- **Real-time UI** — Durable Objects + WebSocket Hibernation
- **Credentials** — never enter the agent. Injected at the network edge by an outbound Worker.

---

## Quick start (one-click)

1. Click **Deploy to Cloudflare** above.
2. Cloudflare forks this repo into your GitHub, provisions D1 / R2 / Queues / Secrets Store, and prompts you for two secrets:
   - `ANTHROPIC_API_KEY` — get one at <https://console.anthropic.com>
   - `GITHUB_TOKEN` — a fine-grained PAT with `repo` and `pull_request` scopes for the repos Philharmonic will work on
3. Wait for the build (~3 minutes — first build pulls the sandbox container image).
4. Open the deployed URL. You'll land on a **Post-Deploy Setup** screen that walks you through:
   - Putting Cloudflare Access in front of your Worker
   - Setting `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in your Worker's vars
   - Re-deploying to pick up those values
5. Log in. Create a project. File a task. Click Run. Watch it work.

## Quick start (manual)

If you'd rather run the install locally:

```sh
git clone https://github.com/YOUR_ORG/philharmonic
cd philharmonic
pnpm install
pnpm bootstrap         # creates D1, R2, queues, sets all secrets
pnpm deploy
```

Then complete the Access configuration as in step 4 above.

---

## What you need

- A Cloudflare account (free plan works for the control plane; Workers Paid is required for Containers and Workflows at production volume)
- An Anthropic API key
- A GitHub fine-grained PAT for the repos you want Philharmonic to work on (or a GitHub App if you'd rather)
- For the manual path: Node 22+, pnpm 9+, Wrangler 4+

## What gets created in your account

| Resource | Name | Purpose |
|---|---|---|
| Worker | `philharmonic` | The whole app — API, SPA, Durable Objects, Workflow, queue consumer |
| D1 database | `philharmonic` | Tasks, runs, events, artifacts |
| R2 bucket | `philharmonic-artifacts` | PR diffs, screenshots, walkthrough videos, sandbox snapshots |
| Queue | `philharmonic-dispatch` (+ DLQ) | Decouples task-ready from agent dispatch |
| Container | (via Sandbox SDK) | One per task; Linux env with Claude CLI, git, gh |
| Secrets Store | `philharmonic-secrets` | All four secrets, never in the repo |

## What does NOT get created automatically

- **Cloudflare Access application** — you set this up manually in the dashboard. The PostDeploySetup screen walks you through it.
- **Custom domain** — optional. The default `philharmonic.YOUR-SUBDOMAIN.workers.dev` works fine to start.
- **GitHub App** — if you want to upgrade from a PAT to a proper GitHub App, see `docs/github-app.md`.

---

## Configuration

### Per-project `WORKFLOW.md`

Each project has a `WORKFLOW.md` — the prompt template the agent uses for that project. Edit it from the project settings page in Philharmonic itself; changes take effect on the next run with no redeploy.

The default template is in `containers/sandbox/WORKFLOW.md`.

Available template variables: see comments at the top of that file.

### Concurrency limits

Per-project, set in the project settings page. Default is 2 simultaneous agent runs. Increase if you trust your repo's CI to handle the parallel PRs; decrease if your CI is slow or expensive.

### Rotating secrets

```sh
pnpm bootstrap --rotate
```

Generates fresh `RUN_TOKEN_SECRET` and `INTERNAL_API_TOKEN`, re-prompts for the external credentials. Existing in-flight runs will fail when they hit the API — drain first if that matters.

---

## Architecture

See [`SPEC.md`](./SPEC.md) for the full spec. Short version:

- The Worker serves the React SPA, the JSON API (`/api/*`), the agent-internal API (`/api/internal/*`), and a WebSocket (`/ws/projects/:id`) all from one binary.
- A singleton **Orchestrator Durable Object** consumes the dispatch queue and decides when to start runs.
- Each run is a **Cloudflare Workflow** instance, durable across restarts and able to sleep for hours waiting on CI.
- The agent runs as headless Claude Code inside a **Sandbox SDK container** with `task_id` as its sandbox ID — so the same task always reuses the same workspace.
- A **TasksRoom Durable Object** per project fans out live updates to connected browsers using the WebSocket Hibernation API.
- An **outbound Worker** intercepts every HTTP request from the sandbox and injects credentials at the network layer. The agent never sees a token.

---

## Limits and trade-offs

- Single-tenant. Philharmonic is designed to be deployed per team, not as multi-tenant SaaS.
- Claude only. Not multi-LLM. If you want a different model, fork and swap.
- Web UI only. No CLI client.
- The agent is non-interactive. It never asks you a question mid-run; if it's stuck it documents the ambiguity in its PR description and you decide on review.

---

## Contributing

Issues and PRs welcome. The whole spec is in [`SPEC.md`](./SPEC.md) — that's the source of truth for what this is and isn't trying to be.

If you found a bug or want a feature, file a Philharmonic task in your own deployment and let the agent take a swing at it. We mean that literally.

## License

MIT — see [`LICENSE`](./LICENSE).

## Acknowledgements

- Architecture pattern from OpenAI's [Symphony](https://github.com/openai/symphony)
- Built on [Cloudflare Workers](https://workers.cloudflare.com), [Durable Objects](https://developers.cloudflare.com/durable-objects/), [Sandbox SDK](https://developers.cloudflare.com/sandbox/), and [Workflows](https://developers.cloudflare.com/workflows/)
- Powered by [Claude](https://claude.com) via the Claude Agent SDK
