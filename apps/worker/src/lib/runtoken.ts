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
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]!);
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

export async function verifyRunToken(
  token: string,
  secret: string,
): Promise<RunTokenClaims> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new RunTokenError('malformed');
  }
  const [, payloadB64, sigB64] = parts as [string, string, string];

  const key = await importKey(secret);
  const sig = b64urlDecodeToBytes(sigB64);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sig as BufferSource,
    enc.encode(`${VERSION}.${payloadB64}`),
  );
  if (!ok) throw new RunTokenError('bad_signature');

  let claims: RunTokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(payloadB64)));
  } catch {
    throw new RunTokenError('malformed');
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) {
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
