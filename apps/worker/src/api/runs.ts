/**
 * /api/runs/:id — run detail with artifacts. POST /:id/cancel terminates the
 * Workflow + sandbox; full cancel implementation lands in M8.
 */

import { Hono } from 'hono';
import { getSandbox } from '@cloudflare/sandbox';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { getDb, schema } from '../lib/db';
import { artifactDto, runDto } from '../lib/dto';
import { safeBroadcast } from '../lib/broadcast';
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
  const now = new Date();
  const wasActive = ['queued', 'preparing', 'running', 'landing'].includes(run.status);

  // 1) Terminate the Workflow if one is attached.
  if (run.workflowInstanceId) {
    try {
      const inst = await c.env.RUN.get(run.workflowInstanceId);
      await inst.terminate();
    } catch (err) {
      console.warn('workflow terminate failed:', err);
    }
  }

  // 2) Destroy the sandbox (sandbox_id == task_id for v1).
  try {
    const sandbox = getSandbox(c.env.Sandbox, run.sandboxId);
    await sandbox.destroy();
  } catch (err) {
    console.warn('sandbox destroy failed:', err);
  }

  // 3) Persist cancellation + reset task to ready (if it was active).
  await db
    .update(schema.runs)
    .set({ status: 'cancelled', endedAt: now })
    .where(eq(schema.runs.id, id));
  if (wasActive) {
    await db
      .update(schema.tasks)
      .set({ status: 'ready', updatedAt: now })
      .where(eq(schema.tasks.id, run.taskId));
  }

  // 4) Audit trail + broadcast.
  await db.insert(schema.events).values({
    id: ulid(),
    taskId: run.taskId,
    runId: id,
    type: 'system',
    author: c.var.user.email,
    payload: { message: 'Run cancelled' },
    createdAt: now,
  });

  const task = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, run.taskId))
    .get();
  if (task) {
    c.executionCtx.waitUntil(
      safeBroadcast(c.env, task.projectId, {
        type: 'task.updated',
        task: {
          id: task.id,
          projectId: task.projectId,
          number: task.number,
          identifier: `PHIL-${task.number}`,
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority,
          createdBy: task.createdBy,
          assignee: task.assignee,
          createdAt: task.createdAt.getTime(),
          updatedAt: task.updatedAt.getTime(),
        },
      }),
    );
  }

  return c.json({ ok: true });
});
