import type { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  // Durable Objects
  TASK_COORDINATOR: DurableObjectNamespace;

  // Sandbox SDK — must be named "Sandbox" for proxyToSandbox() compatibility
  Sandbox: DurableObjectNamespace<Sandbox>;

  // KV (Phase 2 — optional for now)
  REPO_KB?: KVNamespace;

  // Secrets (optional — can be set via UI settings instead)
  ANTHROPIC_API_KEY?: string;
  GITHUB_TOKEN?: string;

  // Vars
  WORKER_URL?: string;
}
