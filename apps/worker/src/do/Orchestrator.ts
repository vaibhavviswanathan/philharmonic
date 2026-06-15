/**
 * Orchestrator — singleton Durable Object that owns task claiming and the
 * per-project concurrency limit. See SPEC §11.
 *
 * - Consumes dispatch Queue messages forwarded from the Worker's queue()
 *   handler. For each message:
 *     1. Re-read project + task from D1.
 *     2. Re-check unresolved blockers (defense-in-depth, SPEC §8.5).
 *     3. Count in-flight runs for the project (queued/preparing/running/landing).
 *     4. If at the project's concurrency limit, return `requeue` — the
 *        consumer acks and re-sends with a delay (never message.retry()).
 *     5. Otherwise CAS-claim the task (UPDATE ... WHERE status='ready'),
 *        insert a runs row, and start the ImplementationRun Workflow.
 *
 *   The claim path runs under an in-instance promise-chain mutex: DO input
 *   gates do NOT serialize across D1/fetch awaits, so two concurrent
 *   /dispatch requests could otherwise both pass the concurrency check
 *   (SPEC §11.2).
 *
 * Reconciliation alarm fires every 60s — it queries the REAL Workflow status
 * for every `running` task's active run and resets only runs whose instance
 * is errored/terminated/complete/missing. Never wall-clock heuristics: a
 * legitimate run is allowed 2+ hours (SPEC §11.3).
 */

import { DurableObject } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { ulid } from 'ulid';
import { safeBroadcast } from '../lib/broadcast';
import { type DB, getDb, projectSlug, schema } from '../lib/db';
import { gateReadyTransition, unresolvedBlockers } from '../lib/dependencies';
import { runDto, taskDto } from '../lib/dto';
import type { Env } from '../lib/types';

const RECONCILE_INTERVAL_MS = 60_000;
const ACTIVE_RUN_STATUSES = ['queued', 'preparing', 'running', 'landing'] as const;
/**
 * Grace period for an active run with no workflowInstanceId: the claim
 * inserts the run before env.RUN.create() persists the id, so a fresh run
 * can legitimately have none for a moment. After 10 minutes it never will.
 */
const NO_INSTANCE_GRACE_MS = 10 * 60_000;
/**
 * Grace period before resetting a `running` task that has no run row. The
 * sweep runs under the claim mutex, so a claim can't be mid-flight — but a
 * grace window is kept as defense-in-depth against any writer outside the DO.
 */
const NO_RUN_GRACE_MS = 5 * 60_000;
/** Orphaned-sandbox sweep window: latest run ended 24–48h ago (SPEC §11.3). */
const ORPHAN_SWEEP_MIN_MS = 24 * 60 * 60_000;
const ORPHAN_SWEEP_MAX_MS = 48 * 60 * 60_000;

export interface DispatchMessage {
  taskId: string;
  projectId: string;
  /** Times this message has been re-sent for backpressure (SPEC §11.1). */
  requeueCount?: number;
}

export type DispatchResult =
  | { taskId: string; outcome: 'claimed'; runId: string }
  | { taskId: string; outcome: 'requeue'; reason: string }
  | { taskId: string; outcome: 'skipped'; reason: string };

export class Orchestrator extends DurableObject<Env> {
  /** Promise-chain mutex serializing the claim path across awaits (§11.2). */
  private claimChain: Promise<void> = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/dispatch' && request.method === 'POST') {
      const body = (await request.json()) as { messages: DispatchMessage[] };
      const results: DispatchResult[] = [];
      for (const msg of body.messages) {
        results.push(await this.serializeClaim(() => this.tryClaim(msg)));
      }
      await this.ensureAlarm();
      return Response.json({ results });
    }
    return new Response('Not found', { status: 404 });
  }

  /** Queue `fn` behind every in-flight claim; failures don't poison the chain. */
  private serializeClaim<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.claimChain.then(fn);
    this.claimChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async tryClaim(msg: DispatchMessage): Promise<DispatchResult> {
    const db = getDb(this.env.DB);
    const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, msg.taskId)).get();
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

    // Defense-in-depth: re-check blockers right before claiming. Catches a
    // race where a task was marked ready but a blocker reverted before the
    // queue message arrived. Cheap query, indexed lookup.
    const stillBlocked = await unresolvedBlockers(db, task.id);
    if (stillBlocked.length > 0) {
      const now = new Date();
      await db
        .update(schema.tasks)
        .set({ status: 'blocked', updatedAt: now })
        .where(eq(schema.tasks.id, task.id));
      await db.insert(schema.events).values({
        id: ulid(),
        taskId: task.id,
        runId: null,
        type: 'system',
        author: 'system',
        payload: { message: 'Reverted to blocked: dependencies unresolved at claim time.' },
        createdAt: now,
      });
      const reverted = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, task.id))
        .get();
      if (reverted) {
        await safeBroadcast(this.env, reverted.projectId, {
          type: 'task.updated',
          task: taskDto(reverted, project.slug),
        });
      }
      return { taskId: msg.taskId, outcome: 'skipped', reason: 'blocked_at_claim' };
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

    // Claim — D1-level CAS (§11.2): only one writer can flip ready→running.
    const now = new Date();
    const runId = ulid();
    const claim = await db
      .update(schema.tasks)
      .set({ status: 'running', updatedAt: now })
      .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, 'ready')))
      .run();
    if ((claim.meta?.changes ?? 0) === 0) {
      return { taskId: msg.taskId, outcome: 'skipped', reason: 'lost_claim_race' };
    }

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
        task: taskDto(updatedTask, project.slug),
      });
    }
    if (insertedRuns[0]) {
      await safeBroadcast(this.env, project.id, {
        type: 'run.created',
        run: runDto(insertedRuns[0]),
      });
    }

    // Hand off to the durable ImplementationRun Workflow.
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
      // Run the sweep under the claim mutex (§11.2): input gates don't cover
      // D1 awaits, so an unserialized sweep could observe a half-finished
      // claim (task `running`, run row not yet inserted) and reset it —
      // double-claiming the task and double-running its sandbox.
      await this.serializeClaim(() => this.reconcile());
    } catch (err) {
      console.warn('reconcile failed:', err);
    }
    await this.ctx.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);
  }

  /**
   * Reconciliation sweep. SPEC §11.3. For every task in `running`:
   *  - no runs row at all → the claim died between the CAS and the run
   *    insert; gate-reset the task (ready/blocked) and re-dispatch.
   *  - latest run active → ask the Workflow itself via
   *    env.RUN.get(workflowInstanceId).status(). Reconcile ONLY when the
   *    instance is errored/terminated/complete-but-row-still-active, when
   *    get() throws (instance missing), or when no instance id was ever
   *    persisted and the run is past the grace period. NEVER wall-clock-kill
   *    an active run — runAgent alone is allowed 2 hours.
   *  - latest run terminal → leave it alone; the workflow/declare path owns
   *    that hand-off (and replays on resume).
   * Plus the 24h orphaned-sandbox sweep (hygiene, not cost-critical).
   */
  private async reconcile(): Promise<void> {
    const db = getDb(this.env.DB);
    const runningTasks = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.status, 'running'))
      .all();

    for (const task of runningTasks) {
      const run = await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.taskId, task.id))
        .orderBy(desc(schema.runs.createdAt))
        .limit(1)
        .get();

      if (!run) {
        // The mutex means a claim can't be mid-flight, so a run-less running
        // task is a dead claim — but only reset after a grace window, in case
        // anything outside the DO ever races the task into `running`.
        if (Date.now() - task.updatedAt.getTime() < NO_RUN_GRACE_MS) continue;
        await this.resetTask(db, task, null, 'Reconciled: running task had no run.');
        continue;
      }
      if (!ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number])) {
        continue;
      }

      // Query the real Workflow — never a wall-clock heuristic (§11.3).
      let deadReason: string | null = null;
      const missingKey = `missing:${run.id}`;
      if (!run.workflowInstanceId) {
        if (Date.now() - run.createdAt.getTime() > NO_INSTANCE_GRACE_MS) {
          deadReason = 'no workflow instance was ever attached';
        }
      } else {
        try {
          const instance = await this.env.RUN.get(run.workflowInstanceId);
          const { status } = await instance.status();
          if (status === 'errored' || status === 'terminated' || status === 'complete') {
            deadReason = `workflow ${status} but run still active`;
          }
          await this.ctx.storage.delete(missingKey);
        } catch (err) {
          // Discriminate (§11.3): only a genuine unknown-id error means the
          // instance is gone. A transient infra/RPC failure must NOT kill a
          // healthy mid-flight run — skip it; the next 60s sweep retries.
          const msg = err instanceof Error ? err.message : String(err);
          if (!/not found|does not exist|no such/i.test(msg)) continue;
          // Even a real not-found gets a persisted grace period before we
          // declare the workflow dead.
          const firstMissing = await this.ctx.storage.get<number>(missingKey);
          if (firstMissing == null) {
            await this.ctx.storage.put(missingKey, Date.now());
            continue;
          }
          if (Date.now() - firstMissing < NO_INSTANCE_GRACE_MS) continue;
          deadReason = 'workflow instance not found'; // get() throws on unknown ids
        }
      }
      if (!deadReason) continue;

      const now = new Date();
      // CAS: only an ACTIVE run may be failed by reconciliation. The finish
      // step writes succeeded/deferred from outside the DO, so the row may
      // have gone terminal during the status() RPC — never overwrite that.
      const failed = await db
        .update(schema.runs)
        .set({
          status: 'failed',
          endedAt: now,
          errorMessage: `reconciliation: ${deadReason}`,
        })
        .where(
          and(eq(schema.runs.id, run.id), inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES])),
        )
        .returning();
      await this.ctx.storage.delete(missingKey);
      if (failed.length === 0) continue; // run finished while we looked — its own path owns the task hand-off
      await this.resetTask(db, task, run.id, `Run reconciled: ${deadReason}.`);
      if (failed[0]) {
        await safeBroadcast(this.env, task.projectId, {
          type: 'run.updated',
          run: runDto(failed[0]),
        });
      }
    }

    await this.sweepOrphanedSandboxes(db);
  }

  /**
   * Gate-reset a stuck `running` task back into the dispatch pool: land in
   * ready/blocked through the blocker gate (§1's law), write a system event,
   * broadcast task.updated, and re-enqueue when it lands ready.
   */
  private async resetTask(
    db: DB,
    task: schema.Task,
    runId: string | null,
    message: string,
  ): Promise<void> {
    const target = await gateReadyTransition(db, task.id);
    const now = new Date();
    // CAS: only reset a task that is STILL `running` — an agent-set `review`
    // (or any other concurrent transition) must never be clobbered (§12.2).
    const reset = await db
      .update(schema.tasks)
      .set({ status: target, updatedAt: now })
      .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, 'running')))
      .run();
    if ((reset.meta?.changes ?? 0) === 0) return;
    await db.insert(schema.events).values({
      id: ulid(),
      taskId: task.id,
      runId,
      type: 'system',
      author: 'system',
      payload: { message, to: target },
      createdAt: now,
    });
    const slug = await projectSlug(db, task.projectId);
    await safeBroadcast(this.env, task.projectId, {
      type: 'task.updated',
      task: taskDto({ ...task, status: target, updatedAt: now }, slug),
    });
    if (target === 'ready') {
      await this.env.DISPATCH.send({ taskId: task.id, projectId: task.projectId });
    }
  }

  /**
   * Destroy sandboxes whose task's latest run ended 24–48h ago. The workflow's
   * cleanup step (or the cancel helper) normally destroys them; this is a
   * belt-and-suspenders sweep for anything that slipped through. The 48h
   * upper bound keeps the sweep from re-destroying the same sandbox forever.
   */
  private async sweepOrphanedSandboxes(db: DB): Promise<void> {
    const now = Date.now();
    const endedRuns = await db
      .select()
      .from(schema.runs)
      .where(
        and(
          gte(schema.runs.endedAt, new Date(now - ORPHAN_SWEEP_MAX_MS)),
          lte(schema.runs.endedAt, new Date(now - ORPHAN_SWEEP_MIN_MS)),
        ),
      )
      .all();

    for (const run of endedRuns) {
      // Only sweep when this is still the task's latest run — a newer run
      // means the sandbox may be live (or about to be) again.
      const latest = await db
        .select({ id: schema.runs.id })
        .from(schema.runs)
        .where(eq(schema.runs.taskId, run.taskId))
        .orderBy(desc(schema.runs.createdAt))
        .limit(1)
        .get();
      if (!latest || latest.id !== run.id) continue;
      try {
        await getSandbox(this.env.Sandbox, run.sandboxId).destroy();
      } catch {
        /* ignore — sandbox is likely already gone */
      }
    }
  }
}
