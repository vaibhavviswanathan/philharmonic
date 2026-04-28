/**
 * /ws/projects/:slug — WebSocket upgrade routed to the project's TasksRoom DO.
 *
 * Cloudflare Access intercepts the upgrade handshake and adds Cf-Access-Jwt-
 * Assertion just like any other request. We verify it server-side before
 * forwarding to the DO so an attacker who routes around Access still hits a
 * 401 here.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { jsonError, verifyAccessJwt } from './auth';
import { getDb, schema } from '../lib/db';
import type { Env, Variables } from '../lib/types';

export const wsRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

wsRoute.get('/projects/:slug', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  try {
    await verifyAccessJwt(c.req.raw, c.env);
  } catch (err) {
    return jsonError(c, err);
  }

  const slug = c.req.param('slug');
  const db = getDb(c.env.DB);
  const project = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.slug, slug))
    .get();
  if (!project) {
    return c.json({ error: { code: 'not_found', message: 'Project not found' } }, 404);
  }

  const id = c.env.TASKS_ROOM.idFromName(project.id);
  const stub = c.env.TASKS_ROOM.get(id);
  // Pass the projectId through so the DO can include it in its `hello` frame.
  const url = new URL(c.req.url);
  url.searchParams.set('projectId', project.id);
  return stub.fetch(url.toString(), c.req.raw);
});
