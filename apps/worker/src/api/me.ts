/**
 * GET /api/me — returns the signed-in user, or { setupRequired } when Cloudflare
 * Access is not yet configured. See SPEC §16.1 for the post-deploy UX flow.
 */

import { Hono } from 'hono';
import { jsonError, verifyAccessJwt } from './auth';
import type { Env, Variables } from '../lib/types';

export const meRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

meRoute.get('/me', async (c) => {
  if (!c.env.ACCESS_TEAM_DOMAIN || !c.env.ACCESS_AUD) {
    return c.json({
      setupRequired: true,
      hint:
        'Cloudflare Access is not configured. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD ' +
        'in wrangler.jsonc vars and re-deploy. See README for steps.',
    });
  }
  try {
    const user = await verifyAccessJwt(c.req.raw, c.env);
    return c.json({
      email: user.email,
      displayName: user.email.split('@')[0],
    });
  } catch (err) {
    return jsonError(c, err);
  }
});
