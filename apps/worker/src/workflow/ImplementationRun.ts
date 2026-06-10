/**
 * ImplementationRun — durable Workflow that owns a single agent run. SPEC §12.
 *
 * Steps:
 *   prepare     — load task/project, mint run token, render WORKFLOW.md, write
 *                 .philharmonic/{prompt.md, run-token, mcp.json, branch} into the
 *                 sandbox, clone the repo to /workspace/repo, create the branch.
 *   runAgent    — `claude -p` against the prompt with the philharmonic MCP server,
 *                 streaming stdout back to the SPA via run.log frames as it arrives.
 *   land        — harvest the PR the agent opened + capture the pr_diff artifact.
 *   finish      — persist the transcript as a `logs` artifact; stop early when the
 *                 run is `deferred` (agent declared a dependency mid-run); else mark
 *                 the run succeeded and fall back to moving the task to review.
 *   mark-failed — (catch) run failed; reset the task only if still `running`,
 *                 through the dependency gate, re-enqueueing when it lands `ready`.
 *   cleanup     — destroy the sandbox in a finally block.
 *
 * Every step.do body must be idempotent — Workflows replay on resume.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { safeBroadcast } from '../lib/broadcast';
import { getDb, schema } from '../lib/db';
import { gateReadyTransition } from '../lib/dependencies';
import { runDto, taskDto, taskIdentifier } from '../lib/dto';
import { mintRunToken, readSecret } from '../lib/runtoken';
import type { Env } from '../lib/types';
import { renderWorkflowMd } from '../lib/workflowmd';

export interface ImplementationRunParams {
  runId: string;
  taskId: string;
  projectId: string;
}

const PRIORITY_LABEL = ['urgent', 'high', 'normal', 'low'] as const;
const WORKDIR_META = '/workspace/.philharmonic';
/** The clone lives in its own directory so the agent can't commit the run token (§13.2). */
const REPO_DIR = '/workspace/repo';

/** run.log frames are batched to roughly this many lines (§12.1). */
const LOG_BATCH_LINES = 25;
/**
 * Best-effort cadence for stashing the partial transcript to R2 mid-run, so a
 * step timeout/eviction doesn't lose everything streamed so far.
 */
const LOG_STASH_EVERY_LINES = 250;

const agentLogKey = (runId: string) => `runs/${runId}/agent-log.jsonl`;

export class ImplementationRun extends WorkflowEntrypoint<Env, ImplementationRunParams> {
  override async run(
    event: WorkflowEvent<ImplementationRunParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const { runId, taskId, projectId } = event.payload;

    // Accumulated agent stdout (NDJSON, one event per line). Only valid within
    // the isolate that executed runAgent — replays of later steps re-derive the
    // transcript from the R2 stash runAgent wrote (see persistAgentLog).
    const agentLog = { text: '' };

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

      // run.attempt = 1 + count of prior runs for this task (§13.4).
      const priorRuns = await db
        .select({ n: sql<number>`COUNT(*)` })
        .from(schema.runs)
        .where(sql`${schema.runs.taskId} = ${taskId} AND ${schema.runs.id} != ${runId}`)
        .get();
      const attempt = (priorRuns?.n ?? 0) + 1;

      // Render the per-project WORKFLOW.md prompt.
      const identifier = taskIdentifier(project.slug, task.number);
      const prompt = renderWorkflowMd(project.workflowMd, {
        project: {
          name: project.name,
          repoUrl: project.repoUrl,
          defaultBranch: project.defaultBranch,
        },
        task: {
          identifier,
          title: task.title,
          description: task.description,
          priority: PRIORITY_LABEL[task.priority] ?? 'normal',
          createdBy: task.createdBy,
          createdAt: task.createdAt.toISOString(),
        },
        run: { id: runId, attempt },
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

      // Clone the repo into /workspace/repo. The egress handler injects
      // GITHUB_TOKEN (SPEC §15) so the URL doesn't need a credential.
      // Idempotent under replay: blow away any half-finished clone first and
      // recreate the branch with -B.
      const branch = `philharmonic/${identifier.toLowerCase()}`;
      await sandbox.exec(`rm -rf ${REPO_DIR}`);
      await sandbox.exec(
        `git clone --depth 50 --branch ${project.defaultBranch} ${project.repoUrl} ${REPO_DIR}`,
      );
      await sandbox.exec(`git -C ${REPO_DIR} config user.email "agent@philharmonic.local"`);
      await sandbox.exec(`git -C ${REPO_DIR} config user.name "Philharmonic Agent"`);
      await sandbox.exec(`git -C ${REPO_DIR} checkout -B ${branch}`);
      await sandbox.writeFile(`${WORKDIR_META}/branch`, branch);
    });

    try {
      await step.do(
        'runAgent',
        { retries: { limit: 1, delay: '30 seconds' }, timeout: '2 hours' },
        async () => {
          const db = getDb(this.env.DB);
          await db.update(schema.runs).set({ status: 'running' }).where(eq(schema.runs.id, runId));
          await this.broadcastRun(runId, projectId);

          const sandbox = getSandbox(this.env.Sandbox, taskId);

          // `--verbose` is mandatory with `-p --output-format=stream-json` —
          // without it the CLI exits immediately with a usage error (§13.3).
          const cmd = [
            'claude',
            '-p',
            `"$(cat ${WORKDIR_META}/prompt.md)"`,
            '--output-format=stream-json',
            '--verbose',
            `--mcp-config ${WORKDIR_META}/mcp.json`,
            '--permission-mode=acceptEdits',
            '--max-turns 100',
          ].join(' ');

          // Reset on retry — a second attempt in the same isolate must not
          // append onto the first attempt's transcript.
          agentLog.text = '';
          let lineBuffer = '';
          let pendingLines: string[] = [];
          let linesSinceStash = 0;
          // Broadcasts/stashes are chained so frames stay ordered without
          // blocking the synchronous onOutput callback.
          let pump: Promise<unknown> = Promise.resolve();

          const flushLogBatch = () => {
            if (pendingLines.length === 0) return;
            const lines = pendingLines;
            pendingLines = [];
            linesSinceStash += lines.length;
            const stash = linesSinceStash >= LOG_STASH_EVERY_LINES;
            if (stash) linesSinceStash = 0;
            pump = pump
              .then(() => safeBroadcast(this.env, projectId, { type: 'run.log', runId, lines }))
              .then(() =>
                stash
                  ? this.env.ARTIFACTS.put(agentLogKey(runId), agentLog.text).catch((err) => {
                      console.warn('partial transcript stash failed:', err);
                    })
                  : undefined,
              );
          };

          try {
            const result = await sandbox.exec(`bash -c '${cmd.replace(/'/g, "'\\''")}'`, {
              cwd: REPO_DIR,
              stream: true,
              // Placeholder credentials: gh/claude refuse to start with no
              // local token; the outbound handler overwrites the auth headers
              // at the edge (§13.3/§15), so real secrets never enter the
              // container.
              env: {
                GH_TOKEN: 'egress-injected',
                ANTHROPIC_API_KEY: 'egress-injected',
              },
              onOutput: (stream, data) => {
                if (stream !== 'stdout') return;
                agentLog.text += data;
                lineBuffer += data;
                const segments = lineBuffer.split('\n');
                lineBuffer = segments.pop() ?? '';
                for (const line of segments) {
                  if (line.trim().length > 0) pendingLines.push(line);
                }
                if (pendingLines.length >= LOG_BATCH_LINES) flushLogBatch();
              },
            });
            if (result.exitCode !== 0) {
              const tail = (result.stderr ?? '').split('\n').slice(-20).join('\n');
              throw new Error(`claude exited ${result.exitCode}: ${tail}`);
            }
          } finally {
            if (lineBuffer.trim().length > 0) {
              pendingLines.push(lineBuffer);
              lineBuffer = '';
            }
            flushLogBatch();
            await pump;
            // Stash the full transcript inside the step that produced it —
            // finish/mark-failed run as separate steps and may replay in a
            // fresh isolate where agentLog is empty.
            if (agentLog.text.length > 0) {
              await this.env.ARTIFACTS.put(agentLogKey(runId), agentLog.text).catch((err) => {
                console.warn('transcript stash failed:', err);
              });
            }
          }
        },
      );

      // Land step: capture the PR the agent opened, attach the diff artifact.
      await step.do('land', { retries: { limit: 2, delay: '15 seconds' } }, async () => {
        const db = getDb(this.env.DB);
        await db.update(schema.runs).set({ status: 'landing' }).where(eq(schema.runs.id, runId));
        await this.broadcastRun(runId, projectId);

        const project = await db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, projectId))
          .get();
        if (!project) throw new Error(`project missing for run ${runId}`);

        const sandbox = getSandbox(this.env.Sandbox, taskId);
        const branchRead = await sandbox.exec(`cat ${WORKDIR_META}/branch`).catch(() => null);
        const branch = branchRead?.stdout?.trim() || '';
        if (!branch) return; // agent never set up the branch — nothing to land

        // Look up the PR the agent created via `gh`.
        const prResult = await sandbox.exec(
          `cd ${REPO_DIR} && gh pr list --head ${branch} --json url --jq '.[0].url' 2>/dev/null || true`,
          { env: { GH_TOKEN: 'egress-injected' } },
        );
        const prUrl = prResult.stdout?.trim();
        if (prUrl?.startsWith('http')) {
          await db.update(schema.runs).set({ prUrl }).where(eq(schema.runs.id, runId));
        }

        // Capture a unified diff against the default branch as proof of work.
        // Never origin/HEAD — it's absent on shallow `--branch` clones.
        const diffResult = await sandbox.exec(
          `cd ${REPO_DIR} && git diff origin/${project.defaultBranch}...HEAD 2>/dev/null | head -c 1000000`,
        );
        const diff = diffResult.stdout ?? '';
        if (diff.trim().length > 0) {
          // Deterministic key + row existence check = idempotent under retries.
          const r2Key = `runs/${runId}/diff.patch`;
          await this.env.ARTIFACTS.put(r2Key, diff);
          const existing = await db
            .select({ id: schema.artifacts.id })
            .from(schema.artifacts)
            .where(
              sql`${schema.artifacts.runId} = ${runId} AND ${schema.artifacts.kind} = 'pr_diff'`,
            )
            .get();
          if (!existing) {
            await db.insert(schema.artifacts).values({
              id: ulid(),
              runId,
              kind: 'pr_diff',
              r2Key,
              mime: 'text/x-diff',
              sizeBytes: new TextEncoder().encode(diff).byteLength,
              caption: prUrl ? `Diff for ${prUrl}` : 'Working tree diff',
              createdAt: new Date(),
            });
          }
        }
      });

      await step.do('finish', async () => {
        const db = getDb(this.env.DB);

        // Persist the transcript first — it applies to every outcome below.
        await this.persistAgentLog(runId, agentLog.text);

        // Reload the run: if the agent declared a dependency mid-run the
        // internal API marked it `deferred` — don't overwrite with succeeded
        // and don't touch the task (it's already `blocked`).
        const run = await db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
        if (!run) throw new Error(`run ${runId} missing in finish`);
        const runStatus: schema.RunStatus | 'deferred' = run.status;
        if (runStatus === 'deferred') {
          await this.broadcastRun(runId, projectId);
          return;
        }

        const now = new Date();
        await db
          .update(schema.runs)
          .set({ status: 'succeeded', endedAt: now })
          .where(eq(schema.runs.id, runId));

        // The agent should have already transitioned the task to `review` via
        // philharmonic.update_status. If it didn't (e.g. exited early), do it
        // here so the task doesn't get stuck in `running`.
        const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
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

        // Reset the task ONLY if it is still `running` — never clobber an
        // agent-set `review` or `blocked`. The reset goes through the
        // dependency gate (§8.5) and re-enqueues when it lands `ready`.
        const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
        if (task && task.status === 'running') {
          const gated = await gateReadyTransition(db, taskId);
          await db
            .update(schema.tasks)
            .set({ status: gated, updatedAt: now })
            .where(sql`${schema.tasks.id} = ${taskId} AND ${schema.tasks.status} = 'running'`);
          if (gated === 'ready') {
            await this.env.DISPATCH.send({ taskId, projectId });
          }
        }

        // Partial transcript on failure (re-derived from the in-step R2 stash
        // when this executes in a replayed isolate).
        await this.persistAgentLog(runId, agentLog.text);

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

  /**
   * Persist the agent transcript as the run's `logs` artifact at the
   * deterministic key `runs/<runId>/agent-log.jsonl`. Idempotent: the R2 put
   * overwrites in place and the artifact row insert is upsert-guarded, so
   * finish, mark-failed, and Workflows replays can all call it safely. When
   * the in-memory transcript is empty (this step replayed in a fresh isolate),
   * falls back to whatever runAgent already stashed in R2.
   */
  private async persistAgentLog(runId: string, transcript: string): Promise<void> {
    const r2Key = agentLogKey(runId);
    let sizeBytes: number;
    if (transcript.length > 0) {
      const bytes = new TextEncoder().encode(transcript);
      await this.env.ARTIFACTS.put(r2Key, bytes);
      sizeBytes = bytes.byteLength;
    } else {
      const head = await this.env.ARTIFACTS.head(r2Key);
      if (!head) return; // the agent never produced output — nothing to persist
      sizeBytes = head.size;
    }

    const db = getDb(this.env.DB);
    const existing = await db
      .select({ id: schema.artifacts.id })
      .from(schema.artifacts)
      .where(sql`${schema.artifacts.runId} = ${runId} AND ${schema.artifacts.kind} = 'logs'`)
      .get();
    if (existing) return;
    await db.insert(schema.artifacts).values({
      id: ulid(),
      runId,
      kind: 'logs',
      r2Key,
      mime: 'application/x-ndjson',
      sizeBytes,
      caption: 'Agent transcript (stream-json)',
      createdAt: new Date(),
    });
  }

  private async broadcastRun(runId: string, projectId: string): Promise<void> {
    const db = getDb(this.env.DB);
    const run = await db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
    if (run) {
      await safeBroadcast(this.env, projectId, { type: 'run.updated', run: runDto(run) });
    }
  }

  private async broadcastTask(taskId: string, projectId: string): Promise<void> {
    const db = getDb(this.env.DB);
    const [task, project] = await Promise.all([
      db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get(),
      db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get(),
    ]);
    if (task && project) {
      await safeBroadcast(this.env, projectId, {
        type: 'task.updated',
        task: taskDto(task, project.slug),
      });
    }
  }
}
