/**
 * Egress proxy — separate Worker fronting the sandbox container's outbound
 * HTTP. Wired via `containers[].global_outbound.service` in
 * apps/worker/wrangler.outbound.jsonc + the main wrangler.jsonc. SPEC §15.
 *
 * Behavior:
 *   - api.github.com / *.github.com → inject `Authorization: Bearer GITHUB_TOKEN`
 *   - api.anthropic.com             → inject `x-api-key: ANTHROPIC_API_KEY`
 *   - the Philharmonic API          → pass through (agent uses run token)
 *   - everything else               → pass through with no credentials
 *
 * Deny-list: private IP ranges (10/8, 192.168/16, 169.254/16) and localhost.
 *
 * The agent never sees these secrets — they live only in this Worker's env.
 */

interface OutboundEnv {
  GITHUB_TOKEN: SecretsStoreSecret;
  ANTHROPIC_API_KEY: SecretsStoreSecret;
  /** Base URL of the main Worker — set in wrangler.outbound.jsonc vars. */
  PHILHARMONIC_HOST: string;
}

const PRIVATE_RX =
  /^(?:10\.|192\.168\.|169\.254\.|127\.|::1|fc00:|fd00:)/i;

function isPrivateOrLoopback(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  return PRIVATE_RX.test(hostname);
}

function isGithub(hostname: string): boolean {
  return (
    hostname === 'github.com' ||
    hostname === 'api.github.com' ||
    hostname.endsWith('.github.com') ||
    hostname.endsWith('.githubusercontent.com')
  );
}

function isAnthropic(hostname: string): boolean {
  return hostname === 'api.anthropic.com' || hostname.endsWith('.anthropic.com');
}

function isPhilharmonic(hostname: string, philharmonicHost: string): boolean {
  if (!philharmonicHost) return false;
  try {
    return hostname === new URL(philharmonicHost).hostname;
  } catch {
    return false;
  }
}

const secretCache = new Map<SecretsStoreSecret, Promise<string>>();
function readSecret(binding: SecretsStoreSecret): Promise<string> {
  const cached = secretCache.get(binding);
  if (cached) return cached;
  const fresh = binding.get();
  secretCache.set(binding, fresh);
  return fresh;
}

export default {
  async fetch(request: Request, env: OutboundEnv): Promise<Response> {
    const url = new URL(request.url);

    if (isPrivateOrLoopback(url.hostname)) {
      console.log('outbound: blocked private', url.hostname, url.pathname);
      return new Response('Blocked: private address', { status: 403 });
    }

    const headers = new Headers(request.headers);
    headers.delete('cf-connecting-ip');
    headers.delete('cf-ipcountry');

    if (isGithub(url.hostname)) {
      headers.set('Authorization', `Bearer ${await readSecret(env.GITHUB_TOKEN)}`);
      headers.set('User-Agent', headers.get('User-Agent') ?? 'philharmonic-agent');
    } else if (isAnthropic(url.hostname)) {
      headers.set('x-api-key', await readSecret(env.ANTHROPIC_API_KEY));
      headers.set('anthropic-version', headers.get('anthropic-version') ?? '2023-06-01');
    } else if (isPhilharmonic(url.hostname, env.PHILHARMONIC_HOST)) {
      // Pass through unchanged — agent has its run token already.
    } else {
      // Other external host — log + pass through without creds.
      console.log('outbound: passthrough', url.hostname, url.pathname);
    }

    return fetch(url.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    });
  },
};
