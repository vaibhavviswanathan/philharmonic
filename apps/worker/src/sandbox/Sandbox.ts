/**
 * Sandbox Durable Object with egress credential injection. SPEC §15.
 *
 * One sandbox per task (sandbox_id == task_id). The Workflow's `prepare` step
 * checks the repo out into /workspace/repo; `runAgent` runs `claude -p` inside it.
 *
 * Egress posture: deny-by-default allowlist with class-level outbound handlers
 * (TLS interception, @cloudflare/sandbox ≥ 0.8.9). Handlers run in the WORKER's
 * environment and overwrite the container's placeholder credentials
 * (`GH_TOKEN=egress-injected`, `ANTHROPIC_API_KEY=egress-injected`, §13.3) with
 * the real Secrets Store values at the edge — the container never sees them.
 *
 * The SDK dispatches interception through a ContainerProxy WorkerEntrypoint;
 * it must be re-exported from the Worker entrypoint (see src/index.ts).
 */

import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
import { readSecret } from '../lib/runtoken';
import type { Env } from '../lib/types';

export { ContainerProxy } from '@cloudflare/sandbox';

/**
 * Deny-by-default allowlist. Non-HTTP(S) egress is not intercepted, so an
 * allowlist is strictly stronger than v1's private-IP regex deny-list.
 * The app's own host (for the Tasks MCP) is appended per-instance from
 * env.API_BASE in the constructor.
 */
const STATIC_ALLOWED_HOSTS = [
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'api.anthropic.com',
  'registry.npmjs.org',
  // Local dev API origin (.dev.vars sets API_BASE=http://host.docker.internal:8787)
  // so dev MCP traffic goes through the allowlist rather than around it. The
  // name only resolves inside local Docker — harmless in production.
  'host.docker.internal',
];

/**
 * GitHub pre-signed URLs (release/raw redirects on *.githubusercontent.com)
 * break when an `Authorization` header is added — skip injection when the URL
 * already carries a signature query (`X-Amz-*` / `token=`).
 */
function hasPresignedSignature(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase().startsWith('x-amz-') || key === 'token') return true;
  }
  return false;
}

async function withHeader(req: Request, name: string, value: string): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set(name, value);
  return fetch(new Request(req, { headers }));
}

async function injectGitHub(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  // Never attach real secrets to cleartext: interception covers port-80 HTTP
  // too, and the agent controls its own request schemes (§15).
  if (url.protocol !== 'https:') return fetch(req);
  if (hasPresignedSignature(url)) return fetch(req);
  const token = await readSecret(env.GITHUB_TOKEN);
  return withHeader(req, 'Authorization', `Bearer ${token}`);
}

async function injectAnthropic(req: Request, env: Env): Promise<Response> {
  // Same cleartext rule as injectGitHub — the request goes out uncredentialed.
  if (new URL(req.url).protocol !== 'https:') return fetch(req);
  const key = await readSecret(env.ANTHROPIC_API_KEY);
  return withHeader(req, 'x-api-key', key);
}

export class Sandbox extends BaseSandbox<Env> {
  /** Intercept port 443 too — GitHub/Anthropic traffic is HTTPS. The base image trusts the per-sandbox CA. */
  override interceptHttps = true;

  constructor(ctx: ConstructorParameters<typeof BaseSandbox<Env>>[0], env: Env) {
    super(ctx, env);
    const hosts = [...STATIC_ALLOWED_HOSTS];
    if (env.API_BASE) {
      try {
        hosts.push(new URL(env.API_BASE).hostname);
      } catch {
        // Malformed API_BASE — the MCP server can't reach the API either way;
        // don't let it take the whole allowlist down.
      }
    }
    this.allowedHosts = hosts;
  }
}

// Assigned after the class declaration so the inherited static SETTER runs
// (a `static outboundByHost = …` class field would shadow the accessor with a
// data property and never reach the SDK's per-class handler registry).
Sandbox.outboundByHost = {
  'github.com': injectGitHub,
  '*.github.com': injectGitHub,
  '*.githubusercontent.com': injectGitHub,
  'api.anthropic.com': injectAnthropic,
};
