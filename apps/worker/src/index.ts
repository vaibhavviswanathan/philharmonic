/**
 * Philharmonic Worker entry — M1.
 *
 * Hono app with the /api/me route. Real REST routes (projects, tasks, runs,
 * events) and the /ws upgrade land in M2/M3. Static assets fall through to
 * the ASSETS binding so the SPA serves at every non-/api path.
 */

import { Hono } from 'hono';
import { meRoute } from './api/me';
import type { Env, Variables } from './lib/types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.route('/api', meRoute);

app.notFound((c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
    return c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  console.error('worker error:', err);
  return c.json({ error: { code: 'internal_error', message: 'Unexpected error' } }, 500);
});

export default app satisfies ExportedHandler<Env>;
