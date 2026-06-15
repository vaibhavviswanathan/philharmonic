/**
 * /api/internal/* — agent-facing endpoints, run-token authenticated.
 *
 * The token's runId/taskId/projectId define the scope. Every write must check
 * that the action targets the run/task in the token. SPEC §7.2 + §8.2.
 */

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import { z } from 'zod';
import { safeBroadcast } from '../lib/broadcast';
import { getDb, projectSlug, schema } from '../lib/db';
import { DependencyError, addDependencyForAgent, resolveDependents } from '../lib/dependencies';
import { artifactDto, eventDto, runDto, taskDto } from '../lib/dto';
import { type RunTokenClaims, RunTokenError, readSecret, verifyRunToken } from '../lib/runtoken';
import { TransitionError, assertAllowed } from '../lib/transitions';
import type { Variables as BaseVariables, Env } from '../lib/types';
import {
  type UploadMint,
  acceptedContentLength,
  isValidUploadId,
  uploadMetaKey,
  uploadObjectKey,
} from '../lib/uploads';

type Variables = BaseVariables & { runClaims: RunTokenClaims };

export const internalRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

internalRoute.use('*', async (c, next) => {
  const auth = c.req.header('Authorization') ?? '';
  const m = auth.match(/^Bearer\s+(\S+)$/);
  if (!m) {
    return c.json({ error: { code: 'missing_token', message: 'Missing run token.' } }, 401);
  }
  const secret = await readSecret(c.env.RUN_TOKEN_SECRET);
  const token = m[1];
  if (!token) {
    return c.json({ error: { code: 'malformed', message: 'Invalid run token' } }, 401);
  }
  let claims: RunTokenClaims;
  try {
    claims = await verifyRunToken(token, secret);
  } catch (err) {
    // EVERY verification failure is a 401 — a garbage token must never 500
    // (SPEC §7.2). verifyRunToken only throws RunTokenError, but map
    // defensively anyway.
    const code = err instanceof RunTokenError ? err.code : 'malformed';
    return c.json({ error: { code, message: 'Invalid run token.' } }, 401);
  }
  c.set('runClaims', claims);
  await next();
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
    task: taskDto(task, project?.slug ?? ''),
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
  const [insertedEvent] = inserted;
  if (!insertedEvent) throw new Error('insert returned no row');
  const dto = eventDto(insertedEvent);
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
    const slug = await projectSlug(db, projectId);
    c.executionCtx.waitUntil(
      safeBroadcast(c.env, projectId, { type: 'task.updated', task: taskDto(updated, slug) }),
    );
  }
  // running → review isn't terminal for dependents (the human still has to
  // approve the PR). Resolution cascades on `done` / `cancelled`, both of
  // which only humans can trigger.
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
    // UTF-8 byte length, not JS string length — multi-byte chars differ.
    size = new TextEncoder().encode(content).length;
    await c.env.ARTIFACTS.put(r2Key, content);
  } else if (uploadId) {
    // Claims-only scoping (SPEC §7.2): the key is derived from the TOKEN's
    // runId, so an uploadId minted by another run can never resolve here.
    // The mint sentinel is verified too — only ids this run actually minted
    // (and uploaded) can be attached (SPEC §8.2).
    if (!isValidUploadId(uploadId)) {
      return c.json({ error: { code: 'no_upload', message: 'Invalid upload id' } }, 404);
    }
    const mint = await c.env.ARTIFACTS.head(uploadMetaKey(runId, uploadId));
    if (!mint) {
      return c.json(
        { error: { code: 'no_upload', message: 'Upload was not minted by this run' } },
        404,
      );
    }
    r2Key = uploadObjectKey(runId, uploadId);
    const head = await c.env.ARTIFACTS.head(r2Key);
    if (!head) {
      return c.json({ error: { code: 'no_upload', message: 'Upload not found' } }, 404);
    }
    mime = head.httpMetadata?.contentType ?? 'application/octet-stream';
    size = head.size;
  } else {
    return c.json({ error: { code: 'invalid_body', message: 'Need content or uploadId' } }, 400);
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
  const [insertedArtifact] = inserted;
  if (!insertedArtifact) throw new Error('insert returned no row');
  const dto = artifactDto(insertedArtifact);

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
    sizeBytes: z
      .number()
      .int()
      .min(0)
      .max(200 * 1024 * 1024),
  });
  const parse = Body.safeParse(await c.req.json().catch(() => null));
  if (!parse.success) {
    return c.json({ error: { code: 'invalid_body', message: parse.error.message } }, 400);
  }
  const { runId } = c.var.runClaims;
  if (!runId) {
    return c.json({ error: { code: 'no_run', message: 'Run token has no runId' } }, 400);
  }
  // R2 bindings cannot mint presigned URLs, so the upload comes back through
  // the Worker (SPEC §8.2). The id is minted here; the PUT below namespaces
  // it under the token's run. The declared metadata is persisted as a mint
  // sentinel so PUT/proof can reject unminted ids and enforce the size cap.
  const uploadId = ulid();
  await c.env.ARTIFACTS.put(uploadMetaKey(runId, uploadId), JSON.stringify(parse.data));
  return c.json({
    uploadId,
    uploadUrl: `/api/internal/uploads/${uploadId}`,
  });
});

internalRoute.put('/uploads/:uploadId', async (c) => {
  const uploadId = c.req.param('uploadId');
  const { runId } = c.var.runClaims;
  if (!runId) {
    return c.json({ error: { code: 'no_run', message: 'Run token has no runId' } }, 400);
  }
  // ULID-shaped ids only — Hono decodes percent-encoded slashes into the
  // param, so this also kills any attempt at key-suffix/path games.
  if (!isValidUploadId(uploadId)) {
    return c.json({ error: { code: 'no_upload', message: 'Invalid upload id' } }, 404);
  }
  // Reject ids not minted by this run (SPEC §8.2). Claims-only scoping
  // (SPEC §7.2): both keys derive from the TOKEN's runId, never the request —
  // cross-run writes are structurally impossible because run A's token can
  // only ever address runs/A/.
  const mintObj = await c.env.ARTIFACTS.get(uploadMetaKey(runId, uploadId));
  if (!mintObj) {
    return c.json(
      { error: { code: 'no_upload', message: 'Upload was not minted by this run' } },
      404,
    );
  }
  const mint = (await mintObj.json()) as UploadMint;
  // Enforce the declared size: Content-Length must be present and within the
  // minted sizeBytes — the runtime then holds the stream to that length.
  const length = acceptedContentLength(c.req.header('content-length'), mint.sizeBytes);
  if (length === null) {
    return c.json(
      {
        error: {
          code: 'too_large',
          message: `Content-Length is required and must not exceed the declared sizeBytes (${mint.sizeBytes}).`,
        },
      },
      413,
    );
  }
  const r2Key = uploadObjectKey(runId, uploadId);
  await c.env.ARTIFACTS.put(r2Key, c.req.raw.body, {
    // The minted contentType is authoritative, not the request header.
    httpMetadata: { contentType: mint.contentType },
  });
  return c.json({ ok: true, r2Key });
});

/**
 * POST /api/internal/dependencies — agent-driven dependency declaration.
 * Body: { blockedBy: '<IDENTIFIER>' | taskId, reason?: string }
 *
 * Identifier references (e.g. "WEB-4", case-insensitive) resolve within the
 * run token's project using the §6.2 derivation (cross-project blockers are
 * rejected). SPEC §8.5:
 *  - blocker already done/cancelled → record the edge, do NOT touch task
 *    status, answer { alreadyResolved: true } so the agent keeps working.
 *    (An unconditional running → blocked write here would strand the task
 *    forever — nothing ever re-dispatches it.)
 *  - otherwise → task running → blocked, run → deferred (terminal: frees the
 *    concurrency slot). The agent should post a brief comment and exit;
 *    resolveDependents re-queues the task when the blocker hits done/cancelled.
 */
internalRoute.post('/dependencies', async (c) => {
  const Body = z.object({
    blockedBy: z.string().min(1).max(200),
    reason: z.string().max(2000).optional(),
  });
  const parse = Body.safeParse(await c.req.json().catch(() => null));
  if (!parse.success) {
    return c.json({ error: { code: 'invalid_body', message: parse.error.message } }, 400);
  }
  const { taskId, projectId, runId } = c.var.runClaims;
  const db = getDb(c.env.DB);
  const slug = await projectSlug(db, projectId);

  // Resolve `blockedBy` — a raw task id or "<UPPERCASED-SLUG>-N" identifier
  // (matched case-insensitively against the token project's slug; never a
  // hardcoded prefix). Task ids are ULIDs and contain no hyphen, so the two
  // forms can't collide.
  let blocker: { id: string; status: schema.TaskStatus } | null = null;
  const ref = parse.data.blockedBy.match(/^(.+)-(\d+)$/);
  if (ref?.[1] && ref[2] && slug && ref[1].toLowerCase() === slug.toLowerCase()) {
    const n = Number.parseInt(ref[2], 10);
    const row = await db
      .select({ id: schema.tasks.id, status: schema.tasks.status })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.projectId, projectId), eq(schema.tasks.number, n)))
      .get();
    if (row) blocker = row;
  } else {
    const row = await db
      .select({
        id: schema.tasks.id,
        status: schema.tasks.status,
        projectId: schema.tasks.projectId,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, parse.data.blockedBy))
      .get();
    if (row && row.projectId === projectId) blocker = { id: row.id, status: row.status };
  }
  if (!blocker) {
    return c.json(
      { error: { code: 'blocker_not_found', message: 'Blocker not found in this project.' } },
      404,
    );
  }

  try {
    await addDependencyForAgent(db, taskId, blocker.id);
  } catch (err) {
    if (err instanceof DependencyError) {
      return c.json({ error: { code: err.code, message: err.message } }, 400);
    }
    throw err;
  }

  // Gate: an already-resolved blocker records the edge but must not block
  // the task or defer the run — tell the agent to keep working (SPEC §8.5).
  // The gate re-reads the blocker AFTER the edge insert (the snapshot above
  // only resolved the id): addDependencyForAgent is several D1 round-trips,
  // and a blocker approved (review → done) in that window would otherwise be
  // gated on a stale 'unresolved' verdict — stranding the task in `blocked`
  // forever, since the cascade for an already-terminal blocker never refires.
  const freshBlocker = await db
    .select({ status: schema.tasks.status })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, blocker.id))
    .get();
  const blockerStatus = freshBlocker?.status ?? blocker.status;
  if (blockerStatus === 'done' || blockerStatus === 'cancelled') {
    return c.json({ ok: true, blockedBy: blocker.id, alreadyResolved: true });
  }

  const now = new Date();
  const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (task && task.status === 'running') {
    // Keep the state machine authoritative — running → blocked is the
    // agent-only lane (lib/transitions.ts), not reachable via /transition.
    assertAllowed(task.status, 'blocked', 'agent');
    await db
      .update(schema.tasks)
      .set({ status: 'blocked', updatedAt: now })
      .where(eq(schema.tasks.id, taskId));
  }

  await db.insert(schema.events).values({
    id: ulid(),
    taskId,
    runId,
    type: 'agent_action',
    author: 'agent',
    payload: {
      tool: 'declare_dependency',
      blockedBy: blocker.id,
      reason: parse.data.reason ?? '',
      summary: `Declared dependency on ${parse.data.blockedBy}`,
    },
    createdAt: now,
  });

  // Defer the run — terminal, so the project's concurrency slot frees
  // immediately and a later cascade can safely start run #2. The workflow's
  // finish step must not overwrite this with `succeeded` (SPEC §12.1).
  const deferred = await db
    .update(schema.runs)
    .set({ status: 'deferred', endedAt: now })
    .where(eq(schema.runs.id, runId))
    .returning();
  if (deferred[0]) {
    c.executionCtx.waitUntil(
      safeBroadcast(c.env, projectId, { type: 'run.updated', run: runDto(deferred[0]) }),
    );
  }

  // Close the remaining race: the blocker may have gone terminal between the
  // post-insert read and our blocked/deferred writes (its cascade saw a
  // still-`running` dependent and skipped it). Re-read once more — the
  // happens-before pairing guarantees at least one side observes the truth —
  // and run the cascade ourselves if it resolved. resolveDependents re-checks
  // blocked status + remaining blockers, so this is idempotent.
  const finalBlocker = await db
    .select({ status: schema.tasks.status })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, blocker.id))
    .get();
  if (finalBlocker && (finalBlocker.status === 'done' || finalBlocker.status === 'cancelled')) {
    await resolveDependents(c.env, db, blocker.id);
  }

  const updated = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (updated) {
    c.executionCtx.waitUntil(
      safeBroadcast(c.env, projectId, { type: 'task.updated', task: taskDto(updated, slug) }),
    );
  }
  return c.json({ ok: true, blockedBy: blocker.id });
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
