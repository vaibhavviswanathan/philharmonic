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
 *                 A run the agent already `deferred` is left untouched (the error
 *                 came after the hand-off) and the workflow ends cleanly.
 *   cleanup     — destroy the sandbox in a finally block.
 *
 * Every step.do body must be idempotent — Workflows replay on resume.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
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

      // The agent's Tasks MCP reaches the API at this origin (§14.2). In a
      // deployed Worker there is NO silent fallback: host.docker.internal does
      // not exist inside a Cloudflare container, so an unset API_BASE would
      // strand the entire MCP surface while runs looked successful. Fail the
      // run loudly instead. Local dev sets API_BASE via the committed
      // .dev.vars (http://host.docker.internal:8787, allowlisted in Sandbox.ts).
      const apiBase = this.env.API_BASE?.trim();
      if (!apiBase) {
        throw new NonRetryableError(
          'API_BASE is not set. Set the API_BASE var in wrangler.jsonc to your deployed ' +
            'Worker origin (e.g. https://philharmonic.<account>.workers.dev) and redeploy. ' +
            'For local dev, .dev.vars provides http://host.docker.internal:8787.',
        );
      }
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
      // Private repos make git prompt for a username BEFORE it sends any
      // request — so the egress handler never sees the request to inject the
      // token into, and with no TTY git dies "could not read Username". Embed
      // a PLACEHOLDER credential so git proceeds and sends the request; the
      // egress handler then overwrites the Authorization header with the real
      // token (§15) — the real secret still never enters the container.
      // GIT_TERMINAL_PROMPT=0 makes any residual auth gap fail fast, not hang.
      const cloneUrl = project.repoUrl.replace(
        /^https:\/\//,
        'https://x-access-token:egress-injected@',
      );
      // A failed clone leaves no /workspace/repo, which the agent then can't cd
      // into — surface git's own error instead of failing opaquely downstream.
      const clone = await sandbox.exec(
        `git clone --depth 50 --branch ${project.defaultBranch} ${cloneUrl} ${REPO_DIR}`,
        { env: { GIT_TERMINAL_PROMPT: '0' } },
      );
      if (clone.exitCode !== 0) {
        throw new Error(
          `git clone failed (${clone.exitCode}): ${(clone.stderr ?? '').split('\n').slice(-10).join('\n')}`,
        );
      }
      // Verify the working tree actually exists before handing off.
      const check = await sandbox.exec(`test -d ${REPO_DIR}/.git && echo ok`);
      if (!(check.stdout ?? '').includes('ok')) {
        throw new Error(`clone reported success but ${REPO_DIR}/.git is missing`);
      }
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
          // Retry guard: if the agent already deferred (declare_dependency →
          // run `deferred`, task `blocked`) and the first attempt then threw
          // (e.g. claude exited non-zero after declaring), do NOT re-run the
          // agent — the run is terminal and the deferral already handed off.
          const current = await db
            .select({ status: schema.runs.status })
            .from(schema.runs)
            .where(eq(schema.runs.id, runId))
            .get();
          if (current?.status === 'deferred') return;
          // CAS: never un-terminate a run (deferred/cancelled/...) back to
          // `running` — only an active pre-agent status may move forward.
          await db
            .update(schema.runs)
            .set({ status: 'running' })
            .where(
              sql`${schema.runs.id} = ${runId} AND ${schema.runs.status} IN ('queued', 'preparing', 'running')`,
            );
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
            // Close stdin: a detached process with an open stdin pipe can make
            // claude block in interactive mode and produce nothing (TL.5).
            '< /dev/null',
          ].join(' ');

          // Run the agent as a BACKGROUND process and poll its logs in short
          // requests, rather than one long streaming exec. A single streaming
          // exec held one connection open for the whole run and hit a ~30-min
          // platform wall (TL.4); it also discarded stderr, so claude's
          // startup/auth failures were invisible (TL.5). startProcess +
          // getProcessLogs keeps every request short and captures stderr too.
          agentLog.text = '';
          const PID = `agent-${runId}`;

          // Clean up any process a prior attempt left running before relaunch
          // (retries replay this body in a fresh isolate).
          await sandbox.killAllProcesses().catch(() => {});
          await sandbox.startProcess(`bash -c '${cmd.replace(/'/g, "'\\''")}'`, {
            processId: PID,
            cwd: REPO_DIR,
            // Keep the record after exit so we can read the exit code.
            autoCleanup: false,
            // Placeholder credentials: gh/claude refuse to start with no local
            // token; the outbound handler overwrites the auth headers at the
            // edge (§13.3/§15), so real secrets never enter the container.
            env: { GH_TOKEN: 'egress-injected', ANTHROPIC_API_KEY: 'egress-injected' },
          });

          const POLL_MS = 8_000;
          const MAX_MS = 2 * 60 * 60 * 1000; // hard cap, matches the step timeout
          const QUIET_MS = 2 * 60 * 1000; // no output for 2m + still running ⇒ stuck
          const startedAt = Date.now();
          let lastOutputAt = Date.now();
          let emittedLines = 0; // stdout lines already broadcast

          const persist = () =>
            this.env.ARTIFACTS.put(agentLogKey(runId), agentLog.text).catch((err) => {
              console.warn('transcript stash failed:', err);
            });

          try {
            while (true) {
              await new Promise((r) => setTimeout(r, POLL_MS));

              let stderr = '';
              try {
                const logs = await sandbox.getProcessLogs(PID);
                const stdout = logs.stdout ?? '';
                stderr = logs.stderr ?? '';
                agentLog.text = stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
                const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
                if (lines.length > emittedLines) {
                  const fresh = lines.slice(emittedLines);
                  emittedLines = lines.length;
                  lastOutputAt = Date.now();
                  for (let i = 0; i < fresh.length; i += LOG_BATCH_LINES) {
                    await safeBroadcast(this.env, projectId, {
                      type: 'run.log',
                      runId,
                      lines: fresh.slice(i, i + LOG_BATCH_LINES),
                    });
                  }
                }
                // Persist every poll so any output (incl. a short stderr error
                // or a pure hang's emptiness) is visible within one poll.
                if (agentLog.text.length > 0) await persist();
              } catch {
                // logs momentarily unavailable — fall through to the status check
              }

              let status = 'running';
              let exitCode: number | null = null;
              try {
                const proc = await sandbox.getProcess(PID);
                if (proc) {
                  status = await proc.getStatus();
                  exitCode = proc.exitCode ?? null;
                } else {
                  status = 'gone';
                }
              } catch {
                status = 'gone';
              }

              if (status === 'completed') {
                await persist();
                if (exitCode != null && exitCode !== 0) {
                  throw new Error(
                    `claude exited ${exitCode}: ${stderr.split('\n').slice(-25).join('\n')}`,
                  );
                }
                break;
              }
              if (
                status === 'failed' ||
                status === 'killed' ||
                status === 'error' ||
                status === 'gone'
              ) {
                await persist();
                throw new Error(`claude ${status}: ${stderr.split('\n').slice(-25).join('\n')}`);
              }

              const now = Date.now();
              if (now - startedAt > MAX_MS) {
                await sandbox.killProcess(PID).catch(() => {});
                await persist();
                throw new Error('agent run exceeded the 2h cap');
              }
              if (now - lastOutputAt > QUIET_MS) {
                await sandbox.killProcess(PID).catch(() => {});
                await persist();
                throw new Error(
                  `agent produced no output for ${Math.round(QUIET_MS / 60000)}m — treating as stuck. stderr tail: ${stderr.split('\n').slice(-25).join('\n')}`,
                );
              }
            }
          } finally {
            await sandbox.killProcess(PID).catch(() => {});
            if (agentLog.text.length > 0) await persist();
          }
        },
      );

      // Land step: capture the PR the agent opened, attach the diff artifact.
      await step.do('land', { retries: { limit: 2, delay: '15 seconds' } }, async () => {
        const db = getDb(this.env.DB);
        // CAS (§8.5(4)/§12.1): the agent may have deferred mid-runAgent (run
        // terminal `deferred`, task `blocked`, agent exits 0). An
        // unconditional `landing` write would erase the deferral and turn
        // finish's deferred short-circuit into dead code — so guard the write
        // and skip the whole step when the run is already terminal.
        const landing = await db
          .update(schema.runs)
          .set({ status: 'landing' })
          .where(
            sql`${schema.runs.id} = ${runId} AND ${schema.runs.status} NOT IN ('deferred', 'succeeded', 'failed', 'cancelled')`,
          )
          .run();
        if ((landing.meta?.changes ?? 0) === 0) return; // already terminal — nothing to land
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
        // CAS for the reload→write window: a deferral/cancel landing after
        // the reload above must not be overwritten. `succeeded` itself stays
        // re-writable so a replayed finish still reaches the task fallback.
        await db
          .update(schema.runs)
          .set({ status: 'succeeded', endedAt: now })
          .where(
            sql`${schema.runs.id} = ${runId} AND ${schema.runs.status} NOT IN ('deferred', 'failed', 'cancelled')`,
          );

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
      const outcome = await step.do('mark-failed', async () => {
        const db = getDb(this.env.DB);
        const now = new Date();

        // A deferral is deliberate and terminal (§8.5(3)/§12.1). If the agent
        // declared a dependency and the workflow STILL errored afterwards
        // (e.g. claude exited non-zero right after declaring), the deferral
        // already handed off: run `deferred` + endedAt, task `blocked`, slot
        // freed. Record nothing as failed — the workflow is done, not broken.
        const run = await db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
        if (run?.status === 'deferred') {
          await this.persistAgentLog(runId, agentLog.text);
          await this.broadcastRun(runId, projectId);
          return 'deferred' as const;
        }

        // CAS: never overwrite a terminal run — a deferral/cancel landing
        // between the reload above and this write must survive.
        await db
          .update(schema.runs)
          .set({
            status: 'failed',
            endedAt: now,
            errorMessage: err instanceof Error ? err.message : String(err),
          })
          .where(
            sql`${schema.runs.id} = ${runId} AND ${schema.runs.status} NOT IN ('deferred', 'succeeded', 'cancelled')`,
          );

        // Reset the task ONLY if it is still `running` — never clobber an
        // agent-set `review` or `blocked`. The reset goes through the
        // dependency gate (§8.5) and re-enqueues when it lands `ready`.
        const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
        if (task && task.status === 'running') {
          const gated = await gateReadyTransition(db, taskId);
          const reset = await db
            .update(schema.tasks)
            .set({ status: gated, updatedAt: now })
            .where(sql`${schema.tasks.id} = ${taskId} AND ${schema.tasks.status} = 'running'`)
            .run();
          if ((reset.meta?.changes ?? 0) > 0) {
            // §8.1/§8.5: every transition writes a status_change event; a
            // gate redirect records { requested: 'ready', to: 'blocked' }.
            await db.insert(schema.events).values({
              id: ulid(),
              taskId,
              runId,
              type: 'status_change',
              author: 'system',
              payload:
                gated === 'blocked'
                  ? {
                      from: 'running',
                      requested: 'ready',
                      to: 'blocked',
                      reason: 'workflow_failed',
                    }
                  : { from: 'running', to: 'ready', reason: 'workflow_failed' },
              createdAt: now,
            });
            if (gated === 'ready') {
              await this.env.DISPATCH.send({ taskId, projectId });
            }
          }
        }

        // Partial transcript on failure (re-derived from the in-step R2 stash
        // when this executes in a replayed isolate).
        await this.persistAgentLog(runId, agentLog.text);

        await this.broadcastRun(runId, projectId);
        await this.broadcastTask(taskId, projectId);
        return 'failed' as const;
      });
      // A post-deferral error is not a workflow failure — the run is
      // deliberately deferred and fully handed off; end the instance cleanly.
      if (outcome !== 'deferred') throw err;
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
