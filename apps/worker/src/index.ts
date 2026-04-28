/**
 * Philharmonic Worker entry — M3.
 *
 * Hono app with:
 *   - /api/me                       (Access JWT, may return setupRequired)
 *   - /api/projects, /api/tasks, /api/runs  (Access JWT)
 *   - /api/internal/*               (run-token, M6 stub)
 *   - /ws/projects/:slug            (Access JWT + WebSocket upgrade → TasksRoom DO)
 *   - everything else               → ASSETS (SPA fallback)
 */

import { Hono } from 'hono';
import { meRoute } from './api/me';
import { projectsRoute } from './api/projects';
import { tasksRoute } from './api/tasks';
import { runsRoute } from './api/runs';
import { internalRoute } from './api/internal';
import { wsRoute } from './api/ws';
import { accessAuthMiddleware } from './api/auth';
import type { Env, Variables } from './lib/types';

export { TasksRoom } from './do/TasksRoom';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.route('/api', meRoute);
app.route('/api/internal', internalRoute);

const authed = new Hono<{ Bindings: Env; Variables: Variables }>();
authed.use('*', accessAuthMiddleware);
authed.route('/', projectsRoute);
authed.route('/', tasksRoute);
authed.route('/', runsRoute);
app.route('/api', authed);

app.route('/ws', wsRoute);

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
