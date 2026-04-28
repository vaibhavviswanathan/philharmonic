/**
 * ImplementationRun — durable Workflow that owns a single agent run. SPEC §12.
 *
 * Steps:
 *   prepare   — load task/project, mint run token, render WORKFLOW.md, write
 *               .philharmonic/{prompt.md, run-token, mcp.json} into the sandbox.
 *   runAgent  — `claude -p` against the prompt with the philharmonic MCP server
 *               and stream stdout back to the SPA via run.log frames.
 *   land      — open PR + attach proof of work (M7).
 *   finish    — mark run succeeded; transition task to review if it isn't already
 *               (the agent moves the task itself via philharmonic.update_status,
 *               so finish is a fallback).
 *   cleanup   — destroy the sandbox in a finally block.
 *
 * Every step.do body must be idempotent — Workflows replay on resume.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { getDb, schema } from '../lib/db';
import { runDto, taskDto } from '../lib/dto';
import { safeBroadcast } from '../lib/broadcast';
import { mintRunToken, readSecret } from '../lib/runtoken';
import { renderWorkflowMd } from '../lib/workflowmd';
import type { Env } from '../lib/types';

export interface ImplementationRunParams {
  runId: string;
  taskId: string;
  projectId: string;
}

const PRIORITY_LABEL = ['urgent', 'high', 'normal', 'low'] as const;
const WORKDIR_META = '/workspace/.philharmonic';
const PHILHARMONIC_DIR = '/workspace';

export class ImplementationRun extends WorkflowEntrypoint<Env, ImplementationRunParams> {
  override async run(
    event: WorkflowEvent<ImplementationRunParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const { runId, taskId, projectId } = event.payload;

    await step.do('prepare', async () => {
      const db = getDb(this.env.DB);
      const [task, project] = await Promise.all([
        db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get(),
        db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get(),
      ]);
      if (!task || !project) throw new Error(`task or project missing for run ${runId}`);

      const now = new Date();
      await db
        .update(schema.runs)
        .set({ status: 'preparing', startedAt: now })
        .where(eq(schema.runs.id, runId));
      await this.broadcastRun(runId, projectId);

      // Mint a run token (24h ttl).
      const secret = await readSecret(this.env.RUN_TOKEN_SECRET);
      const token = await mintRunToken({ runId, taskId, projectId }, secret);

      // Render the per-project WORKFLOW.md prompt.
      const prompt = renderWorkflowMd(project.workflowMd, {
        project: {
          name: project.name,
          repoUrl: project.repoUrl,
          defaultBranch: project.defaultBranch,
        },
        task: {
          identifier: `PHIL-${task.number}`,
          title: task.title,
          description: task.description,
          priority: PRIORITY_LABEL[task.priority] ?? 'normal',
          createdBy: task.createdBy,
          createdAt: task.createdAt.toISOString(),
        },
        run: { id: runId, attempt: 1 },
      });

      const apiBase = this.env.API_BASE || 'http://host.docker.internal:8787';
      const mcpConfig = {
        mcpServers: {
          philharmonic: {
            command: 'node',
            args: ['/opt/tasks-mcp/dist/index.js'],
            env: {
              PHILHARMONIC_API_BASE: apiBase,
              PHILHARMONIC_RUN_TOKEN_FILE: `${WORKDIR_META}/run-token`,
            },
          },
        },
      };

      const sandbox = getSandbox(this.env.Sandbox, taskId);
      await sandbox.exec(`mkdir -p ${WORKDIR_META}`);
      await sandbox.writeFile(`${WORKDIR_META}/prompt.md`, prompt);
      await sandbox.writeFile(`${WORKDIR_META}/run-token`, token);
      await sandbox.exec(`chmod 600 ${WORKDIR_META}/run-token`);
      await sandbox.writeFile(`${WORKDIR_META}/mcp.json`, JSON.stringify(mcpConfig, null, 2));

      // Repo clone happens here in M7+ once the egress proxy injects the
      // GitHub token. For M6 the agent runs against an empty workspace and
      // just exercises read_task/post_comment/update_status.
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

          const cmd = [
            'claude',
            '-p',
            `"$(cat ${WORKDIR_META}/prompt.md)"`,
            '--output-format=stream-json',
            `--mcp-config ${WORKDIR_META}/mcp.json`,
            '--permission-mode=acceptEdits',
            '--max-turns 100',
          ].join(' ');

          const result = await sandbox.exec(`bash -c '${cmd.replace(/'/g, "'\\''")}'`, {
            cwd: PHILHARMONIC_DIR,
          });

          const lines = (result.stdout ?? '')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);

          if (lines.length > 0) {
            // Stream in batches; keeps run.log frames small.
            const BATCH = 25;
            for (let i = 0; i < lines.length; i += BATCH) {
              await safeBroadcast(this.env, projectId, {
                type: 'run.log',
                runId,
                lines: lines.slice(i, i + BATCH),
              });
            }
          }

          if (result.exitCode !== 0) {
            const tail = (result.stderr ?? '').split('\n').slice(-20).join('\n');
            throw new Error(`claude exited ${result.exitCode}: ${tail}`);
          }
        },
      );

      // M7 land step (gh pr create + proof) — placeholder transition for now.
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

        // The agent should have already transitioned the task to `review` via
        // philharmonic.update_status. If it didn't (e.g. exited early), do it
        // here so the task doesn't get stuck in `running`.
        const task = await db
          .select()
          .from(schema.tasks)
          .where(eq(schema.tasks.id, taskId))
          .get();
        if (task && task.status === 'running') {
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
            payload: { from: 'running', to: 'review', reason: 'workflow_finalized' },
            createdAt: now,
          });
        }
        await this.broadcastRun(runId, projectId);
        await this.broadcastTask(taskId, projectId);
      });
    } catch (err) {
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
