/**
 * Shared run-cancel helper. SPEC §12.2: `instance.terminate()` halts the
 * Workflow immediately and its `finally` steps DO NOT run, so cancellation
 * cleanup (sandbox destroy, run row, broadcast) must live here — used by both
 * POST /api/runs/:id/cancel and the task `→ cancelled` transition.
 *
 * Task-status handling stays at the call sites: the run-cancel endpoint
 * gate-resets the task while the cancelled-transition is already moving it.
 */

import { getSandbox } from '@cloudflare/sandbox';
import { eq } from 'drizzle-orm';
import { safeBroadcast } from './broadcast';
import { type DB, schema } from './db';
import { runDto } from './dto';
import type { Run } from './schema';
import type { Env } from './types';

export interface CancelRunOpts {
  /** Timestamp shared with the caller's own writes (defaults to now). */
  now?: Date;
  /** Project id for the broadcast — saves a lookup when the caller has it. */
  projectId?: string;
}

/**
 * Terminate the run's Workflow instance (tolerating already-terminal
 * instances), destroy its sandbox, persist `cancelled` + `endedAt`, and
 * broadcast `run.updated`. Returns the updated run row.
 */
export async function cancelRun(
  env: Env,
  db: DB,
  run: Run,
  opts: CancelRunOpts = {},
): Promise<Run | undefined> {
  const now = opts.now ?? new Date();

  // 1) Terminate the Workflow if one is attached. terminate() throws when the
  //    instance is already terminal or unknown — both are fine here.
  if (run.workflowInstanceId) {
    try {
      const instance = await env.RUN.get(run.workflowInstanceId);
      await instance.terminate();
    } catch (err) {
      console.warn('workflow terminate failed (likely already terminal):', err);
    }
  }

  // 2) Destroy the sandbox — terminate() skips the workflow's cleanup step.
  try {
    const sandbox = getSandbox(env.Sandbox, run.sandboxId);
    await sandbox.destroy();
  } catch (err) {
    console.warn('sandbox destroy failed:', err);
  }

  // 3) Persist cancellation + broadcast run.updated.
  const updated = await db
    .update(schema.runs)
    .set({ status: 'cancelled', endedAt: now })
    .where(eq(schema.runs.id, run.id))
    .returning();

  let projectId = opts.projectId;
  if (!projectId) {
    const taskRow = await db
      .select({ projectId: schema.tasks.projectId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, run.taskId))
      .get();
    projectId = taskRow?.projectId;
  }
  if (updated[0] && projectId) {
    await safeBroadcast(env, projectId, { type: 'run.updated', run: runDto(updated[0]) });
  }
  return updated[0];
}
