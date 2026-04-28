/**
 * ImplementationRun — durable Workflow that owns a single agent run.
 *
 * Steps:
 *   1. prepare   — load task/project, mark run preparing, broadcast.
 *   2. runAgent  — invoke the agent inside the sandbox; M5 stub runs
 *                  `echo "hello from $(hostname)"` and streams stdout to the
 *                  TasksRoom DO as run.log frames. M6 swaps in the Claude CLI.
 *   3. land      — open PR, attach proof of work; M7.
 *   4. cleanup   — destroy sandbox, finalize run row, broadcast.
 *
 * Each `step.do` body must be idempotent — Workflows replay on resume.
 * See SPEC §12.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { getDb, schema } from '../lib/db';
import { runDto, taskDto } from '../lib/dto';
import { safeBroadcast } from '../lib/broadcast';
import type { Env } from '../lib/types';

export interface ImplementationRunParams {
  runId: string;
  taskId: string;
  projectId: string;
}

const LOG_BATCH_SIZE = 10;

export class ImplementationRun extends WorkflowEntrypoint<Env, ImplementationRunParams> {
  override async run(
    event: WorkflowEvent<ImplementationRunParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const { runId, taskId, projectId } = event.payload;

    await step.do('prepare', async () => {
      const db = getDb(this.env.DB);
      const now = new Date();
      await db
        .update(schema.runs)
        .set({ status: 'preparing', startedAt: now })
        .where(eq(schema.runs.id, runId));
      await this.broadcastRun(runId, projectId);
      // M6 — also: gitCheckout into /workspace, write .philharmonic/{prompt.md, run-token, mcp.json}
    });

    try {
      await step.do(
        'runAgent',
        { retries: { limit: 1, delay: '30 seconds' }, timeout: '2 hours' },
        async () => {
          const db = getDb(this.env.DB);
          await db
            .update(schema.runs)
            .set({ status: 'running' })
            .where(eq(schema.runs.id, runId));
          await this.broadcastRun(runId, projectId);

          const sandbox = getSandbox(this.env.Sandbox, taskId);
          const result = await sandbox.exec('echo "hello from $(hostname)" && date');

          const lines = (result.stdout ?? '')
            .split('\n')
            .filter((l) => l.trim().length > 0);
          // Stream in batches so the run viewer feels live.
          for (let i = 0; i < lines.length; i += LOG_BATCH_SIZE) {
            const slice = lines.slice(i, i + LOG_BATCH_SIZE);
            await safeBroadcast(this.env, projectId, {
              type: 'run.log',
              runId,
              lines: slice,
            });
          }

          // Persist the agent_action event so the activity feed survives a refresh.
          await db.insert(schema.events).values({
            id: ulid(),
            taskId,
            runId,
            type: 'agent_action',
            author: 'agent',
            payload: { tool: 'echo', summary: lines.join('\n') },
            createdAt: new Date(),
          });
        },
      );

      // M7 land step — open PR + attach proof. Stub for M5.
      await step.do('land', async () => {
        const db = getDb(this.env.DB);
        await db
          .update(schema.runs)
          .set({ status: 'landing' })
          .where(eq(schema.runs.id, runId));
        await this.broadcastRun(runId, projectId);
      });

      await step.do('finish', async () => {
        const db = getDb(this.env.DB);
        const now = new Date();
        await db
          .update(schema.runs)
          .set({ status: 'succeeded', endedAt: now })
          .where(eq(schema.runs.id, runId));
        await db
          .update(schema.tasks)
          .set({ status: 'review', updatedAt: now })
          .where(eq(schema.tasks.id, taskId));
        await db.insert(schema.events).values({
          id: ulid(),
          taskId,
          runId,
          type: 'status_change',
          author: 'system',
          payload: { from: 'running', to: 'review' },
          createdAt: now,
        });
        await this.broadcastRun(runId, projectId);
        await this.broadcastTask(taskId, projectId);
      });
    } catch (err) {
      // Failure path: mark run failed, return task to ready.
      await step.do('mark-failed', async () => {
        const db = getDb(this.env.DB);
        const now = new Date();
        await db
          .update(schema.runs)
          .set({
            status: 'failed',
            endedAt: now,
            errorMessage: err instanceof Error ? err.message : String(err),
          })
          .where(eq(schema.runs.id, runId));
        await db
          .update(schema.tasks)
          .set({ status: 'ready', updatedAt: now })
          .where(eq(schema.tasks.id, taskId));
        await this.broadcastRun(runId, projectId);
        await this.broadcastTask(taskId, projectId);
      });
      throw err;
    } finally {
      await step.do('cleanup', async () => {
        try {
          const sandbox = getSandbox(this.env.Sandbox, taskId);
          await sandbox.destroy();
        } catch (err) {
          console.warn('sandbox destroy failed:', err);
        }
      });
    }
  }

  private async broadcastRun(runId: string, projectId: string): Promise<void> {
    const db = getDb(this.env.DB);
    const run = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .get();
    if (run) {
      await safeBroadcast(this.env, projectId, { type: 'run.updated', run: runDto(run) });
    }
  }

  private async broadcastTask(taskId: string, projectId: string): Promise<void> {
    const db = getDb(this.env.DB);
    const task = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    if (task) {
      await safeBroadcast(this.env, projectId, {
        type: 'task.updated',
        task: taskDto(task),
      });
    }
  }
}
