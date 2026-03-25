# Philharmonic (Phil)

AI Coding Agent Orchestration Engine. Submit a coding task, Phil plans it, spins up an isolated sandbox, implements the code, writes tests, and opens a PR.

Built on the Claude API, Cloudflare Workers, Sandbox SDK, and Durable Objects.

## Architecture

```
Dashboard (Pages)  →  Orchestrator (Worker + DO)  →  Sandbox (Sandbox SDK)
     ↑                       ↑                              ↓
     └── WebSocket ──────────┘                     Claude Agent Loop
                                                   git, shell, fs tools
                                                          ↓
                                                     GitHub PR
```

- **Orchestrator** — Cloudflare Worker with Hono API. Plans tasks via Claude, dispatches to sandboxes, tracks state in a Durable Object with SQLite.
- **Sandbox** — Cloudflare Sandbox SDK container (Node 20, Python 3.12, Git, GitHub CLI). Runs a Claude-powered agent that implements code, writes tests, and opens PRs.
- **Dashboard** — React + Vite + Tailwind SPA on Cloudflare Pages. Real-time log streaming via WebSocket.

## Monorepo Structure

```
packages/
  shared/           — Types, zod schemas, tool definitions, event protocol
  orchestrator/     — Cloudflare Worker + Durable Object + Sandbox SDK client
  sandbox-runtime/  — Agent code that runs inside the sandbox container
  dashboard/        — React SPA
docker/
  Dockerfile.sandbox — Container image for Sandbox SDK
```

## Prerequisites

- Node.js >= 20
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (paid Workers plan for Sandbox SDK)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (installed as a dev dependency)
- An [Anthropic API key](https://console.anthropic.com/)
- A [GitHub personal access token](https://github.com/settings/tokens) with repo scope

## Setup

```bash
git clone <repo-url> philharmonic
cd philharmonic
pnpm install
pnpm build
```

## Deploy

### 1. Create a KV namespace

```bash
cd packages/orchestrator
npx wrangler kv namespace create REPO_KB
```

Copy the output `id` into `wrangler.jsonc` under `kv_namespaces[0].id`.

### 2. Update wrangler.jsonc

Edit `packages/orchestrator/wrangler.jsonc`:
- Set `vars.WORKER_URL` to your Worker URL (e.g. `https://phil-orchestrator.<subdomain>.workers.dev`)
- Paste the KV namespace ID from step 1

### 3. Set secrets

```bash
cd packages/orchestrator
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GITHUB_TOKEN
```

### 4. Deploy the orchestrator

```bash
cd packages/orchestrator
npx wrangler deploy
```

This provisions the Worker, Durable Object (TaskCoordinator), Sandbox SDK container, and KV namespace.

### 5. Deploy the dashboard

```bash
cd packages/dashboard

# Set the API URL to your orchestrator Worker
echo "VITE_API_URL=https://phil-orchestrator.<subdomain>.workers.dev/v1" > .env.production

pnpm build
npx wrangler pages project create phil-dashboard
npx wrangler pages deploy dist
```

### 6. Verify

Open the dashboard URL printed by wrangler. Submit a task with a GitHub repo URL and description. Watch the agent plan, implement, and open a PR.

## Local Development

```bash
# Terminal 1: orchestrator (requires Cloudflare account for Sandbox SDK)
cd packages/orchestrator
npx wrangler dev

# Terminal 2: dashboard
cd packages/dashboard
pnpm dev
```

The dashboard dev server proxies API requests to the orchestrator at `localhost:8787`.

## How It Works

1. **Submit** — User submits a task (repo URL + description) via the dashboard
2. **Plan** — Orchestrator spins up a sandbox, clones the repo, analyzes the structure, and asks Claude to decompose the task into subtasks with a predicted touch set
3. **Execute** — The sandbox agent (Claude) works through each subtask: reads files, writes code, runs shell commands, commits changes
4. **Test** — Agent runs the test suite, fixes failures in a tight loop
5. **PR** — Agent pushes the branch and opens a pull request on GitHub
6. **Stream** — Dashboard shows real-time agent logs via WebSocket from the Durable Object

## License

Apache 2.0
