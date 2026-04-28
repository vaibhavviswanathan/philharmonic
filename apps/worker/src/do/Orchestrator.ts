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
import { and, desc, eq, inArray } from 'drizzle-orm';
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

    // M5+: hand off to the durable ImplementationRun Workflow.
    const instance = await this.env.RUN.create({
      id: runId,
      params: { runId, taskId: task.id, projectId: project.id },
    });
    await db
      .update(schema.runs)
      .set({ workflowInstanceId: instance.id })
      .where(eq(schema.runs.id, runId));

    return { taskId: msg.taskId, outcome: 'claimed', runId };
  }

  private async ensureAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null) {
      await this.ctx.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);
    }
  }

  override async alarm(): Promise<void> {
    try {
      await this.reconcile();
    } catch (err) {
      console.warn('reconcile failed:', err);
    }
    await this.ctx.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);
  }

  /**
   * Sweep stuck rows. SPEC §11.1.
   *  - any task in `running` with no active run → mark its run failed,
   *    transition task back to `ready`.
   *  - any sandbox older than 24h with no associated run → destroy it
   *    (sandbox cleanup happens in the run's cleanup step normally; this is a
   *     belt-and-suspenders sweep for orphaned containers).
   */
  private async reconcile(): Promise<void> {
    const db = getDb(this.env.DB);
    const orphans = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.status, 'running'))
      .all();

    for (const task of orphans) {
      const run = await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.taskId, task.id))
        .orderBy(desc(schema.runs.createdAt))
        .limit(1)
        .get();

      if (!run) continue;
      // Heuristic for "no active workflow": run row has been in an active
      // status for > 5 minutes without progress (M8 stub — a richer check
      // would call env.RUN.get(workflowInstanceId).status).
      const STUCK_MS = 5 * 60 * 1000;
      if (
        ACTIVE_RUN_STATUSES.includes(
          run.status as (typeof ACTIVE_RUN_STATUSES)[number],
        ) &&
        Date.now() - run.createdAt.getTime() > STUCK_MS
      ) {
        const now = new Date();
        await db
          .update(schema.runs)
          .set({
            status: 'failed',
            endedAt: now,
            errorMessage: 'reconciliation: workflow appears stuck',
          })
          .where(eq(schema.runs.id, run.id));
        await db
          .update(schema.tasks)
          .set({ status: 'ready', updatedAt: now })
          .where(eq(schema.tasks.id, task.id));
        await db.insert(schema.events).values({
          id: ulid(),
          taskId: task.id,
          runId: run.id,
          type: 'system',
          author: 'system',
          payload: { message: 'Run reconciled: workflow appears stuck.' },
          createdAt: now,
        });
        await safeBroadcast(this.env, task.projectId, {
          type: 'task.updated',
          task: taskDto({ ...task, status: 'ready', updatedAt: now }),
        });
      }
    }
  }
}
