/**
 * /api/internal/* — agent-facing endpoints, run-token authenticated.
 * Implementation lands in M6 alongside run tokens (SPEC §7.2). Stub here
 * just so Hono knows the prefix exists and 404s cleanly until then.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../lib/types';

export const internalRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

internalRoute.all('/*', (c) =>
  c.json(
    { error: { code: 'not_implemented', message: 'Internal API lands in M6.' } },
    501,
  ),
);
