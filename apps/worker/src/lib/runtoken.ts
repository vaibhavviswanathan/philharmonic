/**
 * Run-token mint + verify. Format per SPEC §7.2:
 *
 *   v1.<base64url-payload>.<base64url-hmac>
 *
 *   payload = { runId, taskId, projectId, exp }   (compact JSON)
 *   hmac    = HMAC-SHA256(secret, `v1.${payload}`)
 *
 * The token authenticates an agent's calls to /api/internal/*. A token issued
 * for run X cannot post comments on a task that doesn't belong to run X — the
 * Worker checks this in the internal-route middleware.
 *
 * TTL: 24h, plenty of headroom for slow CI. Revocation is a future concern.
 */

import type { SecretsStoreSecret } from '@cloudflare/workers-types';

const VERSION = 'v1';
const DEFAULT_TTL_SEC = 24 * 60 * 60;

export interface RunTokenClaims {
  runId: string;
  taskId: string;
  projectId: string;
  /** Unix seconds. Set by `mint` when ttl is supplied. */
  exp: number;
}

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const byte of buf) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecodeToBytes(s: string): Uint8Array {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function mintRunToken(
  claims: Omit<RunTokenClaims, 'exp'> & { exp?: number },
  secret: string,
  ttlSec: number = DEFAULT_TTL_SEC,
): Promise<string> {
  const exp = claims.exp ?? Math.floor(Date.now() / 1000) + ttlSec;
  const payload: RunTokenClaims = { ...claims, exp };
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const message = `${VERSION}.${payloadB64}`;

  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return `${message}.${b64urlEncode(sig)}`;
}

export class RunTokenError extends Error {
  constructor(public readonly code: 'malformed' | 'bad_signature' | 'expired') {
    super(code);
  }
}

/**
 * Verify a run token. EVERY malformed input — bad structure, bad base64, bad
 * JSON, bad claim shape — throws a typed RunTokenError (`malformed` |
 * `bad_signature` | `expired`), never anything else: a garbage token must
 * yield a 401, not a 500 (SPEC §7.2).
 */
export async function verifyRunToken(token: string, secret: string): Promise<RunTokenClaims> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new RunTokenError('malformed');
  }
  const [, payloadB64, sigB64] = parts as [string, string, string];

  let sig: Uint8Array;
  try {
    sig = b64urlDecodeToBytes(sigB64);
  } catch {
    throw new RunTokenError('malformed'); // atob rejects non-base64 input
  }
  const key = await importKey(secret);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sig as BufferSource,
    enc.encode(`${VERSION}.${payloadB64}`),
  );
  if (!ok) throw new RunTokenError('bad_signature');

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(payloadB64)));
  } catch {
    throw new RunTokenError('malformed');
  }
  // A valid MAC over a non-claims payload is still malformed (e.g. a token
  // minted for a different purpose with the same secret).
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as RunTokenClaims).runId !== 'string' ||
    typeof (parsed as RunTokenClaims).taskId !== 'string' ||
    typeof (parsed as RunTokenClaims).projectId !== 'string' ||
    typeof (parsed as RunTokenClaims).exp !== 'number'
  ) {
    throw new RunTokenError('malformed');
  }
  const claims = parsed as RunTokenClaims;
  if (claims.exp * 1000 < Date.now()) {
    throw new RunTokenError('expired');
  }
  return claims;
}

/** Read the secret value from a Secrets Store binding, with a small cache. */
const secretCache = new WeakMap<SecretsStoreSecret, Promise<string>>();
export function readSecret(binding: SecretsStoreSecret): Promise<string> {
  const cached = secretCache.get(binding);
  if (cached) return cached;
  const fresh = binding.get();
  secretCache.set(binding, fresh);
  return fresh;
}
