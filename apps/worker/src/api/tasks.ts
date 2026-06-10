/**
 * /api/tasks/:id — task detail, transitions, comments, events feed.
 * /api/runs/:id — run detail (read-only at this milestone).
 * See SPEC §8.1 for the full surface.
 */

import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import { z } from 'zod';
import { safeBroadcast } from '../lib/broadcast';
import { cancelRun } from '../lib/cancel';
import { getDb, projectSlug, schema } from '../lib/db';
import {
  DependencyError,
  addDependency,
  gateReadyTransition,
  listBlockers,
  listBlocking,
  removeDependency,
  resolveDependents,
} from '../lib/dependencies';
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
  const [latestRun, blockers, blocking, slug] = await Promise.all([
    db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, id))
      .orderBy(desc(schema.runs.createdAt))
      .limit(1)
      .get(),
    listBlockers(db, id),
    listBlocking(db, id),
    projectSlug(db, task.projectId),
  ]);
  // Dependency edges are same-project-only, so one slug covers all of them.
  return c.json({
    task: taskDto(task, slug),
    latestRun: latestRun ? runDto(latestRun) : null,
    blockers: blockers.map((t) => taskDto(t, slug)),
    blocking: blocking.map((t) => taskDto(t, slug)),
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
  const [updatedTask] = updated;
  if (!updatedTask) {
    return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404);
  }
  const slug = await projectSlug(db, updatedTask.projectId);
  const dto = taskDto(updatedTask, slug);
  c.executionCtx.waitUntil(
    safeBroadcast(c.env, dto.projectId, { type: 'task.updated', task: dto }),
  );
  return c.json({ task: dto });
});

tasksRoute.post('/tasks/:id/transition', async (c) => {
  const Body = z.object({
    to: z.enum(['backlog', 'blocked', 'ready', 'running', 'review', 'done', 'cancelled']),
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

  // Redirect ready into blocked if dependencies are unresolved.
  let target = body.data.to;
  if (target === 'ready') {
    target = await gateReadyTransition(db, id);
  }

  const now = new Date();
  await db
    .update(schema.tasks)
    .set({ status: target, updatedAt: now })
    .where(eq(schema.tasks.id, id));

  await db.insert(schema.events).values({
    id: ulid(),
    taskId: id,
    runId: null,
    type: 'status_change',
    author: c.var.user.email,
    payload: { from: task.status, to: target, requested: body.data.to },
    createdAt: now,
  });

  // Cancelling (or pulling back) a task with an active run must tear the run
  // down too — terminate the Workflow + destroy the sandbox via the shared
  // helper (SPEC §8.1 side effects, §12.2). The pull-back lane covers the
  // gate redirect as well: running → ready may land in blocked.
  if (
    target === 'cancelled' ||
    (task.status === 'running' && (target === 'ready' || target === 'blocked'))
  ) {
    const activeRun = await db
      .select()
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.taskId, id),
          inArray(schema.runs.status, ['queued', 'preparing', 'running', 'landing']),
        ),
      )
      .orderBy(desc(schema.runs.createdAt))
      .limit(1)
      .get();
    if (activeRun) {
      await cancelRun(c.env, db, activeRun, { now, projectId: task.projectId });
    }
  }

  // ready transition enqueues onto DISPATCH so the Orchestrator picks it up.
  if (target === 'ready') {
    await c.env.DISPATCH.send({ taskId: id, projectId: task.projectId });
  }

  // Terminal transitions cascade — clear dependents. Inline, before the
  // response: a dropped waitUntil would strand them (SPEC §8.5).
  if (target === 'done' || target === 'cancelled') {
    await resolveDependents(c.env, db, id);
  }

  const updated = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  if (!updated) {
    return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404);
  }
  const slug = await projectSlug(db, task.projectId);
  const dto = taskDto(updated, slug);
  c.executionCtx.waitUntil(
    safeBroadcast(c.env, dto.projectId, { type: 'task.updated', task: dto }),
  );
  return c.json({ task: dto });
});

// ─── dependency endpoints ──────────────────────────────────────────────────

tasksRoute.post('/tasks/:id/dependencies', async (c) => {
  const Body = z.object({ blockedBy: z.string().min(1) });
  const body = Body.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json({ error: { code: 'invalid_body', message: body.error.message } }, 400);
  }
  const id = c.req.param('id');
  const db = getDb(c.env.DB);
  try {
    await addDependency(db, id, body.data.blockedBy, c.var.user.email);
  } catch (err) {
    if (err instanceof DependencyError) {
      const httpStatus =
        err.code === 'task_not_found' || err.code === 'blocker_not_found' ? 404 : 400;
      return c.json({ error: { code: err.code, message: err.message } }, httpStatus);
    }
    throw err;
  }

  // If this just-added blocker means the task should be in `blocked`, move it.
  const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  if (task && (task.status === 'backlog' || task.status === 'ready')) {
    const target = await gateReadyTransition(db, id);
    if (target === 'blocked') {
      const now = new Date();
      await db
        .update(schema.tasks)
        .set({ status: 'blocked', updatedAt: now })
        .where(eq(schema.tasks.id, id));
      await db.insert(schema.events).values({
        id: ulid(),
        taskId: id,
        runId: null,
        type: 'system',
        author: c.var.user.email,
        payload: { message: 'Task auto-blocked: new dependency added.' },
        createdAt: now,
      });
    }
  }

  const refreshed = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  if (refreshed) {
    const slug = await projectSlug(db, refreshed.projectId);
    c.executionCtx.waitUntil(
      safeBroadcast(c.env, refreshed.projectId, {
        type: 'task.updated',
        task: taskDto(refreshed, slug),
      }),
    );
  }
  return c.json({ ok: true }, 201);
});

tasksRoute.delete('/tasks/:id/dependencies/:blockerId', async (c) => {
  const id = c.req.param('id');
  const blockerId = c.req.param('blockerId');
  const db = getDb(c.env.DB);
  await removeDependency(db, id, blockerId);

  // If removing this blocker fully unblocked the task, cascade it forward.
  const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  if (task && task.status === 'blocked') {
    const target = await gateReadyTransition(db, id);
    if (target === 'ready') {
      const now = new Date();
      await db
        .update(schema.tasks)
        .set({ status: 'ready', updatedAt: now })
        .where(eq(schema.tasks.id, id));
      await db.insert(schema.events).values({
        id: ulid(),
        taskId: id,
        runId: null,
        type: 'system',
        author: c.var.user.email,
        payload: { message: 'Unblocked: blocker removed.' },
        createdAt: now,
      });
      await c.env.DISPATCH.send({ taskId: id, projectId: task.projectId });
    }
  }

  const refreshed = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
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
  const [insertedEvent] = await db.insert(schema.events).values(event).returning();
  if (!insertedEvent) throw new Error('insert returned no row');
  const dto = eventDto(insertedEvent);
  // Look up projectId for the broadcast.
  const projectRow = await db
    .select({ projectId: schema.tasks.projectId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
    .get();
  if (projectRow) {
    c.executionCtx.waitUntil(
      safeBroadcast(c.env, projectRow.projectId, {
        type: 'event.created',
        taskId: id,
        event: dto,
      }),
    );
  }
  return c.json({ event: dto }, 201);
});

tasksRoute.get('/tasks/:id/events', async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param('id');
  const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 200);
  const before = c.req.query('before');
  const where = before
    ? and(eq(schema.events.taskId, id), lt(schema.events.id, before))
    : eq(schema.events.taskId, id);
  // Order by id DESC — the ULID id is BOTH the sort key and the `before`
  // cursor; sorting by a different column would skip/repeat rows (SPEC §6.2).
  const rows = await db
    .select()
    .from(schema.events)
    .where(where)
    .orderBy(desc(schema.events.id))
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
