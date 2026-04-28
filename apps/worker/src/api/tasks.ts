/**
 * /api/tasks/:id — task detail, transitions, comments, events feed.
 * /api/runs/:id — run detail (read-only at this milestone).
 * See SPEC §8.1 for the full surface.
 */

import { Hono } from 'hono';
import { and, desc, eq, lt } from 'drizzle-orm';
import { ulid } from 'ulid';
import { z } from 'zod';
import { getDb, schema } from '../lib/db';
import { eventDto, runDto, taskDto } from '../lib/dto';
import { TransitionError, assertAllowed } from '../lib/transitions';
import type { Env, Variables } from '../lib/types';

export const tasksRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

tasksRoute.get('/tasks/:id', async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param('id');
  const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  if (!task) {
    return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404);
  }
  const latestRun = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.taskId, id))
    .orderBy(desc(schema.runs.createdAt))
    .limit(1)
    .get();
  return c.json({
    task: taskDto(task),
    latestRun: latestRun ? runDto(latestRun) : null,
  });
});

tasksRoute.patch('/tasks/:id', async (c) => {
  const Body = z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(20000).optional(),
    priority: z.number().int().min(0).max(3).optional(),
    assignee: z.string().nullable().optional(),
  });
  const body = Body.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json({ error: { code: 'invalid_body', message: body.error.message } }, 400);
  }
  const db = getDb(c.env.DB);
  const updated = await db
    .update(schema.tasks)
    .set({ ...body.data, updatedAt: new Date() })
    .where(eq(schema.tasks.id, c.req.param('id')))
    .returning();
  if (updated.length === 0) {
    return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404);
  }
  return c.json({ task: taskDto(updated[0]!) });
});

tasksRoute.post('/tasks/:id/transition', async (c) => {
  const Body = z.object({
    to: z.enum(['backlog', 'ready', 'running', 'review', 'done', 'cancelled']),
  });
  const body = Body.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json({ error: { code: 'invalid_body', message: body.error.message } }, 400);
  }
  const db = getDb(c.env.DB);
  const id = c.req.param('id');
  const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  if (!task) {
    return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404);
  }

  try {
    assertAllowed(task.status, body.data.to, 'human');
  } catch (err) {
    if (err instanceof TransitionError) {
      const status = err.code === 'forbidden' ? 403 : 400;
      return c.json({ error: { code: err.code, message: err.message } }, status);
    }
    throw err;
  }

  const now = new Date();
  await db
    .update(schema.tasks)
    .set({ status: body.data.to, updatedAt: now })
    .where(eq(schema.tasks.id, id));

  await db.insert(schema.events).values({
    id: ulid(),
    taskId: id,
    runId: null,
    type: 'status_change',
    author: c.var.user.email,
    payload: { from: task.status, to: body.data.to },
    createdAt: now,
  });

  // ready transition enqueues onto DISPATCH so the Orchestrator (M4) picks it up.
  if (body.data.to === 'ready') {
    await c.env.DISPATCH.send({ taskId: id, projectId: task.projectId });
  }

  const updated = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  return c.json({ task: taskDto(updated!) });
});

tasksRoute.post('/tasks/:id/comments', async (c) => {
  const Body = z.object({ body: z.string().min(1).max(20000) });
  const body = Body.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json({ error: { code: 'invalid_body', message: body.error.message } }, 400);
  }
  const db = getDb(c.env.DB);
  const id = c.req.param('id');
  const task = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
    .get();
  if (!task) {
    return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404);
  }
  const event: typeof schema.events.$inferInsert = {
    id: ulid(),
    taskId: id,
    runId: null,
    type: 'comment',
    author: c.var.user.email,
    payload: { body: body.data.body },
    createdAt: new Date(),
  };
  const inserted = await db.insert(schema.events).values(event).returning();
  return c.json({ event: eventDto(inserted[0]!) }, 201);
});

tasksRoute.get('/tasks/:id/events', async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param('id');
  const limit = Math.min(Number.parseInt(c.req.query('limit') ?? '50', 10) || 50, 200);
  const before = c.req.query('before');
  const where = before
    ? and(eq(schema.events.taskId, id), lt(schema.events.id, before))
    : eq(schema.events.taskId, id);
  const rows = await db
    .select()
    .from(schema.events)
    .where(where)
    .orderBy(desc(schema.events.createdAt))
    .limit(limit)
    .all();
  return c.json({ events: rows.map(eventDto) });
});

tasksRoute.get('/tasks/:id/runs', async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param('id');
  const rows = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.taskId, id))
    .orderBy(desc(schema.runs.createdAt))
    .all();
  return c.json({ runs: rows.map(runDto) });
});
