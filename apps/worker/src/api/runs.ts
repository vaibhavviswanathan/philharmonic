/**
 * /api/runs/:id — run detail with artifacts. POST /:id/cancel terminates the
 * Workflow + sandbox; full cancel implementation lands in M8.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../lib/db';
import { artifactDto, runDto } from '../lib/dto';
import type { Env, Variables } from '../lib/types';

export const runsRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

runsRoute.get('/runs/:id', async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param('id');
  const run = await db.select().from(schema.runs).where(eq(schema.runs.id, id)).get();
  if (!run) {
    return c.json({ error: { code: 'not_found', message: 'Run not found' } }, 404);
  }
  const artifacts = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.runId, id))
    .all();
  return c.json({ run: runDto(run), artifacts: artifacts.map(artifactDto) });
});

runsRoute.post('/runs/:id/cancel', async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param('id');
  const run = await db.select().from(schema.runs).where(eq(schema.runs.id, id)).get();
  if (!run) {
    return c.json({ error: { code: 'not_found', message: 'Run not found' } }, 404);
  }
  // M8: terminate Workflow + destroy sandbox. For now, mark cancelled.
  const now = new Date();
  await db
    .update(schema.runs)
    .set({ status: 'cancelled', endedAt: now })
    .where(eq(schema.runs.id, id));
  await db
    .update(schema.tasks)
    .set({ status: 'ready', updatedAt: now })
    .where(eq(schema.tasks.id, run.taskId));
  return c.json({ ok: true });
});
