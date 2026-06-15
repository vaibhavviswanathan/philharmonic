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

import { Sandbox as BaseSandbox, ContainerProxy } from '@cloudflare/sandbox';
import { readSecret } from '../lib/runtoken';
import type { Env } from '../lib/types';

export { ContainerProxy };

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

/**
 * git-over-HTTPS on github.com authenticates with HTTP Basic (token as the
 * password), NOT Bearer — the clone URL carries a placeholder credential
 * (x-access-token:egress-injected) so git sends the request; we overwrite it
 * here with the real token. The API host (api.github.com) keeps Bearer above.
 */
async function injectGitHubGit(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.protocol !== 'https:') return fetch(req);
  if (hasPresignedSignature(url)) return fetch(req);
  let token: string;
  try {
    token = (await readSecret(env.GITHUB_TOKEN)).trim();
  } catch (err) {
    console.warn('GITHUB_TOKEN unreadable in egress handler:', err);
    return fetch(req);
  }
  // git-over-HTTPS Basic auth: token as the password, with the
  // `x-access-token` username (the GitHub-Actions-standard form, accepted for
  // classic PATs, fine-grained PATs, and App installation tokens). The clone
  // URL carries a placeholder credential so git sends the request; we overwrite
  // it here with the real token (§15).
  const basic = btoa(`x-access-token:${token}`);
  return withHeader(req, 'Authorization', `Basic ${basic}`);
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

  /**
   * Keep the container awake for the whole agent run. `runAgent` executes
   * `claude` as a single multi-minute streaming exec (SPEC §13.3), which does
   * NOT renew the container activity timer — so the SDK's default 10-minute
   * `sleepAfter` fires mid-run, stops the container, and surfaces as a
   * `WorkflowInternalError`. Set it past the 2h runAgent timeout + land
   * retries so the container never idle-sleeps while work is in flight.
   * The SDK parser only accepts `<int><s|m|h>` (no compound) — 150m = 2.5h.
   */
  override sleepAfter = '150m';

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
const OUTBOUND_HANDLERS = {
  'github.com': injectGitHubGit, // git clone/push — HTTP Basic
  '*.github.com': injectGitHub, // api.github.com (gh CLI) — Bearer
  '*.githubusercontent.com': injectGitHub,
  'api.anthropic.com': injectAnthropic,
};

// The SDK's outbound dispatch keys the static-handler registry by the PROXY's
// class name (props.className === "ContainerProxy"), not the Sandbox subclass —
// so handlers registered on Sandbox alone are never found at dispatch time.
// Register on ContainerProxy (where the lookup happens); keep Sandbox too for
// any code path that keys by the container class.
Sandbox.outboundByHost = OUTBOUND_HANDLERS;
(ContainerProxy as unknown as { outboundByHost: typeof OUTBOUND_HANDLERS }).outboundByHost =
  OUTBOUND_HANDLERS;
