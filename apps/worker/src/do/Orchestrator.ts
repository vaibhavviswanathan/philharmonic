/**
 * Orchestrator — singleton Durable Object that owns task claiming and the
 * per-project concurrency limit. See SPEC §11.
 *
 * - Consumes dispatch Queue messages forwarded from the Worker's queue()
 *   handler. For each message:
 *     1. Re-read project + task from D1.
 *     2. Count in-flight runs for the project (queued/preparing/running/landing).
 *     3. If at the project's concurrency limit, return `requeue` so the Worker
 *        re-delivers with a 30s delay.
 *     4. Otherwise, claim: insert a runs row, transition the task to `running`,
 *        and (M5+) start the ImplementationRun Workflow. M4 stub finishes the
 *        run immediately as `succeeded` so the rest of the pipeline can be
 *        exercised end-to-end without a real agent.
 *
 * Reconciliation alarm fires every 60s — it catches tasks stuck in `running`
 * with no live workflow and resets them to `ready`. M4 just logs; full
 * sweep lands in M8.
 */

import { DurableObject } from 'cloudflare:workers';
import { and, eq, inArray } from 'drizzle-orm';
import { ulid } from 'ulid';
import { getDb, schema } from '../lib/db';
import { safeBroadcast } from '../lib/broadcast';
import { taskDto, runDto } from '../lib/dto';
import type { Env } from '../lib/types';

const RECONCILE_INTERVAL_MS = 60_000;
const ACTIVE_RUN_STATUSES = ['queued', 'preparing', 'running', 'landing'] as const;

export interface DispatchMessage {
  taskId: string;
  projectId: string;
}

export type DispatchResult =
  | { taskId: string; outcome: 'claimed'; runId: string }
  | { taskId: string; outcome: 'requeue'; reason: string }
  | { taskId: string; outcome: 'skipped'; reason: string };

export class Orchestrator extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/dispatch' && request.method === 'POST') {
      const body = (await request.json()) as { messages: DispatchMessage[] };
      const results: DispatchResult[] = [];
      for (const msg of body.messages) {
        results.push(await this.tryClaim(msg));
      }
      await this.ensureAlarm();
      return Response.json({ results });
    }
    return new Response('Not found', { status: 404 });
  }

  async tryClaim(msg: DispatchMessage): Promise<DispatchResult> {
    const db = getDb(this.env.DB);
    const task = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, msg.taskId))
      .get();
    if (!task) {
      return { taskId: msg.taskId, outcome: 'skipped', reason: 'task_not_found' };
    }
    if (task.status !== 'ready') {
      return {
        taskId: msg.taskId,
        outcome: 'skipped',
        reason: `task_status=${task.status}`,
      };
    }
    const project = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, msg.projectId))
      .get();
    if (!project) {
      return { taskId: msg.taskId, outcome: 'skipped', reason: 'project_not_found' };
    }

    const inflight = await db
      .select({ count: schema.runs.id })
      .from(schema.runs)
      .innerJoin(schema.tasks, eq(schema.runs.taskId, schema.tasks.id))
      .where(
        and(
          eq(schema.tasks.projectId, project.id),
          inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]),
        ),
      )
      .all();
    if (inflight.length >= project.concurrencyLimit) {
      return {
        taskId: msg.taskId,
        outcome: 'requeue',
        reason: `at_limit=${project.concurrencyLimit}`,
      };
    }

    // Claim — task→running and create a run row.
    const now = new Date();
    const runId = ulid();
    await db
      .update(schema.tasks)
      .set({ status: 'running', updatedAt: now })
      .where(eq(schema.tasks.id, task.id));

    const runRow: typeof schema.runs.$inferInsert = {
      id: runId,
      taskId: task.id,
      sandboxId: task.id, // SPEC §6.2: sandbox_id == task_id for v1
      workflowInstanceId: null,
      status: 'queued',
      prUrl: null,
      errorMessage: null,
      startedAt: null,
      endedAt: null,
      createdAt: now,
    };
    const insertedRuns = await db.insert(schema.runs).values(runRow).returning();

    // Status_change event.
    await db.insert(schema.events).values({
      id: ulid(),
      taskId: task.id,
      runId,
      type: 'status_change',
      author: 'system',
      payload: { from: 'ready', to: 'running' },
      createdAt: now,
    });

    // Broadcast claim → SPA updates instantly.
    const updatedTask = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, task.id))
      .get();
    if (updatedTask) {
      await safeBroadcast(this.env, project.id, {
        type: 'task.updated',
        task: taskDto(updatedTask),
      });
    }
    if (insertedRuns[0]) {
      await safeBroadcast(this.env, project.id, {
        type: 'run.created',
        run: runDto(insertedRuns[0]),
      });
    }

    // M4 stub: mark the run succeeded immediately so the pipeline closes.
    // M5 replaces this with `await env.RUN.create(...)`.
    await this.completeRunStub(runId, task.id, project.id);

    return { taskId: msg.taskId, outcome: 'claimed', runId };
  }

  private async completeRunStub(
    runId: string,
    taskId: string,
    projectId: string,
  ): Promise<void> {
    const db = getDb(this.env.DB);
    const now = new Date();
    await db
      .update(schema.runs)
      .set({
        status: 'succeeded',
        startedAt: now,
        endedAt: now,
      })
      .where(eq(schema.runs.id, runId));
    await db
      .update(schema.tasks)
      .set({ status: 'review', updatedAt: now })
      .where(eq(schema.tasks.id, taskId));
    await db.insert(schema.events).values({
      id: ulid(),
      taskId,
      runId,
      type: 'system',
      author: 'system',
      payload: { message: 'M4 stub: would have run agent here.' },
      createdAt: now,
    });
    await db.insert(schema.events).values({
      id: ulid(),
      taskId,
      runId,
      type: 'status_change',
      author: 'system',
      payload: { from: 'running', to: 'review' },
      createdAt: now,
    });

    const finalTask = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    const finalRun = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .get();
    if (finalTask) {
      await safeBroadcast(this.env, projectId, {
        type: 'task.updated',
        task: taskDto(finalTask),
      });
    }
    if (finalRun) {
      await safeBroadcast(this.env, projectId, {
        type: 'run.updated',
        run: runDto(finalRun),
      });
    }
  }

  private async ensureAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null) {
      await this.ctx.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);
    }
  }

  override async alarm(): Promise<void> {
    // M8 will sweep stuck `running` tasks here; for now just keep the alarm alive.
    await this.ctx.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);
  }
}
