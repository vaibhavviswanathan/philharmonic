/**
 * Philharmonic Worker entry — M2.
 *
 * Hono app with:
 *   - /api/me                       (Access JWT, may return setupRequired)
 *   - /api/projects, /api/tasks, /api/runs  (Access JWT)
 *   - /api/internal/*               (run-token, M6 stub)
 *   - everything else               → ASSETS (SPA fallback)
 *
 * Real-time /ws layer lands in M3.
 */

import { Hono } from 'hono';
import { meRoute } from './api/me';
import { projectsRoute } from './api/projects';
import { tasksRoute } from './api/tasks';
import { runsRoute } from './api/runs';
import { internalRoute } from './api/internal';
import { accessAuthMiddleware } from './api/auth';
import type { Env, Variables } from './lib/types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// /api/me has its own setupRequired short-circuit before auth.
app.route('/api', meRoute);

// /api/internal/* uses run-token auth (M6); skip the Access middleware here.
app.route('/api/internal', internalRoute);

// All other /api/* routes require Access.
const authed = new Hono<{ Bindings: Env; Variables: Variables }>();
authed.use('*', accessAuthMiddleware);
authed.route('/', projectsRoute);
authed.route('/', tasksRoute);
authed.route('/', runsRoute);
app.route('/api', authed);

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
