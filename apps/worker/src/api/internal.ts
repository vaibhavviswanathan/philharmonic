/**
 * /api/internal/* — agent-facing endpoints, run-token authenticated.
 *
 * The token's runId/taskId/projectId define the scope. Every write must check
 * that the action targets the run/task in the token. SPEC §7.2 + §8.2.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { z } from 'zod';
import { getDb, schema } from '../lib/db';
import { artifactDto, eventDto, runDto, taskDto } from '../lib/dto';
import { safeBroadcast } from '../lib/broadcast';
import { TransitionError, assertAllowed } from '../lib/transitions';
import { readSecret, verifyRunToken, RunTokenError, type RunTokenClaims } from '../lib/runtoken';
import type { Env, Variables as BaseVariables } from '../lib/types';

type Variables = BaseVariables & { runClaims: RunTokenClaims };

export const internalRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

internalRoute.use('*', async (c, next) => {
  const auth = c.req.header('Authorization') ?? '';
  const m = auth.match(/^Bearer\s+(\S+)$/);
  if (!m) {
    return c.json({ error: { code: 'missing_token', message: 'Missing run token.' } }, 401);
  }
  try {
    const secret = await readSecret(c.env.RUN_TOKEN_SECRET);
    const claims = await verifyRunToken(m[1]!, secret);
    c.set('runClaims', claims);
    await next();
  } catch (err) {
    if (err instanceof RunTokenError) {
      return c.json({ error: { code: err.code, message: 'Invalid run token.' } }, 401);
    }
    throw err;
  }
});

internalRoute.get('/task', async (c) => {
  const { taskId, projectId } = c.var.runClaims;
  const db = getDb(c.env.DB);
  const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (!task || task.projectId !== projectId) {
    return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404);
  }
  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  return c.json({
    task: taskDto(task),
    project: project
      ? {
          id: project.id,
          name: project.name,
          slug: project.slug,
          repoUrl: project.repoUrl,
          defaultBranch: project.defaultBranch,
        }
      : null,
  });
});

internalRoute.get('/workflow-md', async (c) => {
  const { projectId } = c.var.runClaims;
  const db = getDb(c.env.DB);
  const project = await db
    .select({ workflowMd: schema.projects.workflowMd })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  if (!project) {
    return c.json({ error: { code: 'not_found', message: 'Project not found' } }, 404);
  }
  return c.json({ workflowMd: project.workflowMd });
});

internalRoute.post('/comments', async (c) => {
  const Body = z.object({ body: z.string().min(1).max(20000) });
  const body = Body.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json({ error: { code: 'invalid_body', message: body.error.message } }, 400);
  }
  const { taskId, runId, projectId } = c.var.runClaims;
  const db = getDb(c.env.DB);
  const inserted = await db
    .insert(schema.events)
    .values({
      id: ulid(),
      taskId,
      runId,
      type: 'comment',
      author: 'agent',
      payload: { body: body.data.body },
      createdAt: new Date(),
    })
    .returning();
  const dto = eventDto(inserted[0]!);
  c.executionCtx.waitUntil(
    safeBroadcast(c.env, projectId, { type: 'event.created', taskId, event: dto }),
  );
  return c.json({ event: dto }, 201);
});

internalRoute.post('/status', async (c) => {
  const Body = z.object({ to: z.enum(['review', 'ready']) });
  const body = Body.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json({ error: { code: 'invalid_body', message: body.error.message } }, 400);
  }
  // Only running → review is permitted by run-token holders. ready is a no-op
  // stub for symmetry with the MCP tool surface (SPEC §14.1).
  if (body.data.to === 'ready') return c.json({ ok: true, ignored: true });

  const { taskId, projectId } = c.var.runClaims;
  const db = getDb(c.env.DB);
  const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (!task || task.projectId !== projectId) {
    return c.json({ error: { code: 'not_found', message: 'Task not found' } }, 404);
  }
  try {
    assertAllowed(task.status, 'review', 'agent');
  } catch (err) {
    if (err instanceof TransitionError) {
      return c.json({ error: { code: err.code, message: err.message } }, 400);
    }
    throw err;
  }
  const now = new Date();
  await db
    .update(schema.tasks)
    .set({ status: 'review', updatedAt: now })
    .where(eq(schema.tasks.id, taskId));
  await db.insert(schema.events).values({
    id: ulid(),
    taskId,
    runId: c.var.runClaims.runId,
    type: 'status_change',
    author: 'agent',
    payload: { from: task.status, to: 'review' },
    createdAt: now,
  });
  const updated = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (updated) {
    c.executionCtx.waitUntil(
      safeBroadcast(c.env, projectId, { type: 'task.updated', task: taskDto(updated) }),
    );
  }
  return c.json({ ok: true });
});

internalRoute.post('/proof', async (c) => {
  const Body = z.object({
    kind: z.enum(['pr_diff', 'screenshot', 'video', 'logs', 'ci_summary', 'other']),
    caption: z.string().max(500).optional(),
    /** Inline text content (CI summary, log digests, etc.). */
    content: z.string().max(2_000_000).optional(),
    /** Or an upload id from POST /api/internal/uploads. */
    uploadId: z.string().optional(),
  });
  const parse = Body.safeParse(await c.req.json().catch(() => null));
  if (!parse.success) {
    return c.json({ error: { code: 'invalid_body', message: parse.error.message } }, 400);
  }
  const { content, uploadId } = parse.data;
  const { runId, taskId, projectId } = c.var.runClaims;
  if (!runId) {
    return c.json({ error: { code: 'no_run', message: 'Run token has no runId' } }, 400);
  }

  const db = getDb(c.env.DB);
  let r2Key: string;
  let mime: string;
  let size: number;

  if (content !== undefined) {
    r2Key = `runs/${runId}/proof-${ulid()}.txt`;
    mime = 'text/plain';
    size = content.length;
    await c.env.ARTIFACTS.put(r2Key, content);
  } else if (uploadId) {
    r2Key = `uploads/${uploadId}`;
    const head = await c.env.ARTIFACTS.head(r2Key);
    if (!head) {
      return c.json({ error: { code: 'no_upload', message: 'Upload not found' } }, 404);
    }
    mime = head.httpMetadata?.contentType ?? 'application/octet-stream';
    size = head.size;
  } else {
    return c.json(
      { error: { code: 'invalid_body', message: 'Need content or uploadId' } },
      400,
    );
  }

  const inserted = await db
    .insert(schema.artifacts)
    .values({
      id: ulid(),
      runId,
      kind: parse.data.kind,
      r2Key,
      mime,
      sizeBytes: size,
      caption: parse.data.caption ?? null,
      createdAt: new Date(),
    })
    .returning();
  const dto = artifactDto(inserted[0]!);

  await db.insert(schema.events).values({
    id: ulid(),
    taskId,
    runId,
    type: 'proof',
    author: 'agent',
    payload: { artifactId: dto.id, kind: dto.kind, caption: dto.caption ?? undefined },
    createdAt: new Date(),
  });

  c.executionCtx.waitUntil(
    safeBroadcast(c.env, projectId, {
      type: 'event.created',
      taskId,
      event: eventDto({
        id: dto.id,
        taskId,
        runId,
        type: 'proof',
        author: 'agent',
        payload: { artifactId: dto.id, kind: dto.kind },
        createdAt: new Date(dto.createdAt),
      }),
    }),
  );

  return c.json({ artifact: dto }, 201);
});

internalRoute.post('/uploads', async (c) => {
  const Body = z.object({
    filename: z.string().min(1).max(255),
    contentType: z.string().min(1).max(200),
    sizeBytes: z.number().int().min(0).max(200 * 1024 * 1024),
  });
  const parse = Body.safeParse(await c.req.json().catch(() => null));
  if (!parse.success) {
    return c.json({ error: { code: 'invalid_body', message: parse.error.message } }, 400);
  }
  // R2's signed URL is implementation-specific; for v1 we accept the upload
  // through the Worker itself.
  const uploadId = ulid();
  return c.json({
    uploadId,
    uploadUrl: `/api/internal/uploads/${uploadId}`,
  });
});

internalRoute.put('/uploads/:uploadId', async (c) => {
  const uploadId = c.req.param('uploadId');
  const r2Key = `uploads/${uploadId}`;
  const contentType = c.req.header('content-type') ?? 'application/octet-stream';
  await c.env.ARTIFACTS.put(r2Key, c.req.raw.body, {
    httpMetadata: { contentType },
  });
  return c.json({ ok: true, r2Key });
});

internalRoute.post('/runs/log', async (c) => {
  const Body = z.object({
    lines: z.array(z.string().max(20000)).min(1).max(500),
  });
  const parse = Body.safeParse(await c.req.json().catch(() => null));
  if (!parse.success) {
    return c.json({ error: { code: 'invalid_body', message: parse.error.message } }, 400);
  }
  const { runId, projectId } = c.var.runClaims;
  if (!runId) {
    return c.json({ error: { code: 'no_run', message: 'Run token has no runId' } }, 400);
  }
  c.executionCtx.waitUntil(
    safeBroadcast(c.env, projectId, {
      type: 'run.log',
      runId,
      lines: parse.data.lines,
    }),
  );
  return c.json({ ok: true });
});
