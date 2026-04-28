/**
 * Cloudflare Access JWT verification. Every authenticated /api/* route runs
 * through `accessAuthMiddleware` to populate `c.var.user`. See SPEC §7.1.
 *
 * The team domain and audience tag come from wrangler.jsonc `vars`, not from
 * secrets — they aren't sensitive but vary by deployment. When they're empty
 * the deployment is in PostDeploySetup mode; the /api/me handler short-circuits
 * before reaching this middleware.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Context, MiddlewareHandler } from 'hono';
import type { AccessUser, Env, Variables } from '../lib/types';

type JwksCacheKey = string;
const jwksCache = new Map<JwksCacheKey, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(teamDomain: string) {
  const cached = jwksCache.get(teamDomain);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
  jwksCache.set(teamDomain, jwks);
  return jwks;
}

export class AccessAuthError extends Error {
  constructor(
    public readonly code: 'missing_token' | 'invalid_token' | 'setup_required',
    message: string,
  ) {
    super(message);
  }
}

export async function verifyAccessJwt(request: Request, env: Env): Promise<AccessUser> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new AccessAuthError('setup_required', 'Cloudflare Access is not configured.');
  }

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) {
    throw new AccessAuthError('missing_token', 'Missing Cf-Access-Jwt-Assertion header.');
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(env.ACCESS_TEAM_DOMAIN), {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
    });
    if (typeof payload.email !== 'string' || typeof payload.sub !== 'string') {
      throw new AccessAuthError('invalid_token', 'Access JWT is missing required claims.');
    }
    return {
      email: payload.email,
      sub: payload.sub,
      identityNonce: typeof payload.identity_nonce === 'string' ? payload.identity_nonce : undefined,
    };
  } catch (err) {
    if (err instanceof AccessAuthError) throw err;
    throw new AccessAuthError('invalid_token', 'Access JWT verification failed.');
  }
}

export const accessAuthMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (c, next) => {
  try {
    const user = await verifyAccessJwt(c.req.raw, c.env);
    c.set('user', user);
    await next();
  } catch (err) {
    return jsonError(c, err);
  }
};

export function jsonError(c: Context, err: unknown): Response {
  if (err instanceof AccessAuthError) {
    const status = err.code === 'setup_required' ? 503 : 401;
    return c.json({ error: { code: err.code, message: err.message } }, status);
  }
  return c.json(
    { error: { code: 'internal_error', message: 'Unexpected error' } },
    500,
  );
}
