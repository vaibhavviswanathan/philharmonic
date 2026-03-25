import type { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  // Durable Objects
  TASK_COORDINATOR: DurableObjectNamespace;

  // Sandbox SDK — must be named "Sandbox" for proxyToSandbox() compatibility
  Sandbox: DurableObjectNamespace<Sandbox>;

  // KV
  REPO_KB: KVNamespace;

  // Secrets
  ANTHROPIC_API_KEY: string;
  GITHUB_TOKEN: string;

  // Vars
  WORKER_URL?: string;
}
