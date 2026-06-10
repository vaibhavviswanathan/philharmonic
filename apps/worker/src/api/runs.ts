/**
 * /api/runs/:id — run detail with artifacts, proxied artifact download, and
 * POST /:id/cancel via the shared cancel helper (terminate Workflow + destroy
 * sandbox + persist; SPEC §8.1/§12.2).
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import { safeBroadcast } from '../lib/broadcast';
import { cancelRun } from '../lib/cancel';
import { getDb, projectSlug, schema } from '../lib/db';
import { gateReadyTransition } from '../lib/dependencies';
import { artifactDto, runDto, taskDto } from '../lib/dto';
import type { Env, Variables } from '../lib/types';

const ACTIVE_RUN_STATUSES = ['queued', 'preparing', 'running', 'landing'] as const;

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

runsRoute.get('/runs/:id/artifacts/:artifactId', async (c) => {
  const db = getDb(c.env.DB);
  const artifact = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, c.req.param('artifactId')))
    .get();
  if (!artifact || artifact.runId !== c.req.param('id')) {
    return c.json({ error: { code: 'not_found', message: 'Artifact not found' } }, 404);
  }
  const obj = await c.env.ARTIFACTS.get(artifact.r2Key);
  if (!obj) {
    return c.json({ error: { code: 'gone', message: 'Artifact body missing' } }, 410);
  }
  return new Response(obj.body, {
    headers: {
      'Content-Type': artifact.mime,
      'Content-Length': String(artifact.sizeBytes),
      'Cache-Control': 'private, max-age=300',
      ...(artifact.kind === 'screenshot' || artifact.kind === 'video'
        ? { 'Content-Disposition': 'inline' }
        : { 'Content-Disposition': `attachment; filename="${artifact.id}"` }),
    },
  });
});

runsRoute.post('/runs/:id/cancel', async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param('id');
  const run = await db.select().from(schema.runs).where(eq(schema.runs.id, id)).get();
  if (!run) {
    return c.json({ error: { code: 'not_found', message: 'Run not found' } }, 404);
  }
  // No cancelling finished work — succeeded/failed/cancelled/deferred are terminal.
  if (!ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number])) {
    return c.json(
      { error: { code: 'run_terminal', message: `Run is already ${run.status}.` } },
      409,
    );
  }

  const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, run.taskId)).get();
  const now = new Date();

  // 1) Terminate Workflow + destroy sandbox + persist cancelled + broadcast
  //    run.updated — the shared helper (SPEC §12.2).
  await cancelRun(c.env, db, run, { now, projectId: task?.projectId });

  // 2) Reset the task through the blocker gate (§1's law) and re-enqueue if
  //    it lands ready.
  if (task && task.status === 'running') {
    const target = await gateReadyTransition(db, task.id);
    await db
      .update(schema.tasks)
      .set({ status: target, updatedAt: now })
      .where(eq(schema.tasks.id, task.id));
    if (target === 'ready') {
      await c.env.DISPATCH.send({ taskId: task.id, projectId: task.projectId });
    }
  }

  // 3) Audit trail + broadcast.
  await db.insert(schema.events).values({
    id: ulid(),
    taskId: run.taskId,
    runId: id,
    type: 'system',
    author: c.var.user.email,
    payload: { message: 'Run cancelled' },
    createdAt: now,
  });

  const refreshed = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, run.taskId))
    .get();
  if (refreshed) {
    const slug = await projectSlug(db, refreshed.projectId);
    c.executionCtx.waitUntil(
      safeBroadcast(c.env, refreshed.projectId, {
        type: 'task.updated',
        task: taskDto(refreshed, slug),
      }),
    );
  }

  return c.json({ ok: true });
});
