import { DurableObject } from "cloudflare:workers";
import type { Task, TaskStatus, Subtask, Project, PhilEvent, DispatchPayload } from "@phil/shared";
import type { Env } from "../env.js";
import { planTask, revisePlan } from "../planner/planner.js";
import { SandboxManager } from "../sandbox/manager.js";

export class TaskCoordinator extends DurableObject<Env> {
  // --- SQL Schema ---

  private ensureSchema(): void {
    // Check if schema already exists (read-only) to avoid unnecessary writes
    const tables = new Set(
      this.ctx.storage.sql.exec(
        `SELECT name FROM sqlite_master WHERE type='table'`
      ).toArray().map((r) => r.name as string),
    );
    if (tables.has("tasks") && tables.has("projects") && tables.has("settings")) {
      // Schema exists — only run migrations if needed
      const cols = new Set(
        this.ctx.storage.sql.exec(`PRAGMA table_info(tasks)`).toArray().map((r) => r.name as string),
      );
      const migrations: Array<{ col: string; sql: string }> = [
        { col: "project_id", sql: `ALTER TABLE tasks ADD COLUMN project_id TEXT NOT NULL DEFAULT ''` },
        { col: "blocked_by", sql: `ALTER TABLE tasks ADD COLUMN blocked_by TEXT` },
        { col: "review_cycles", sql: `ALTER TABLE tasks ADD COLUMN review_cycles INTEGER NOT NULL DEFAULT 0` },
        { col: "preview_url", sql: `ALTER TABLE tasks ADD COLUMN preview_url TEXT` },
        { col: "plan_markdown", sql: `ALTER TABLE tasks ADD COLUMN plan_markdown TEXT` },
        { col: "depends_on", sql: `ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'` },
        { col: "agent_context", sql: `ALTER TABLE tasks ADD COLUMN agent_context TEXT` },
      ];
      for (const m of migrations) {
        if (!cols.has(m.col)) {
          this.ctx.storage.sql.exec(m.sql);
        }
      }
      // Projects table migrations
      const projCols = new Set(
        this.ctx.storage.sql.exec(`PRAGMA table_info(projects)`).toArray().map((r) => r.name as string),
      );
      if (!projCols.has("autonomy_level")) {
        this.ctx.storage.sql.exec(`ALTER TABLE projects ADD COLUMN autonomy_level TEXT NOT NULL DEFAULT 'supervised'`);
      }
      // Events table migration
      if (!tables.has("events")) {
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            type TEXT NOT NULL,
            data TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, created_at);
        `);
      }
      return;
    }

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        default_branch TEXT,
        autonomy_level TEXT NOT NULL DEFAULT 'supervised',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL DEFAULT '',
        repo_url TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        branch_name TEXT NOT NULL,
        touch_set TEXT NOT NULL DEFAULT '[]',
        plan_markdown TEXT,
        pr_url TEXT,
        pr_number INTEGER,
        preview_url TEXT,
        error TEXT,
        blocked_by TEXT,
        depends_on TEXT NOT NULL DEFAULT '[]',
        agent_context TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subtasks (
        id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        dependencies TEXT NOT NULL DEFAULT '[]',
        file_targets TEXT NOT NULL DEFAULT '[]',
        output TEXT,
        error TEXT,
        PRIMARY KEY (task_id, id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE TABLE IF NOT EXISTS review_comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        path TEXT,
        line INTEGER,
        processed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE TABLE IF NOT EXISTS escalations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, created_at);
    `);

    // Migrations already handled in the early-return path above
  }

  private schemaReady = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema creation is deferred to first write operation to avoid
    // burning write quota on read-only requests.
    // Check if schema already exists (read-only).
    try {
      const tables = new Set(
        this.ctx.storage.sql.exec(
          `SELECT name FROM sqlite_master WHERE type='table'`
        ).toArray().map((r) => r.name as string),
      );
      this.schemaReady = tables.has("tasks") && tables.has("projects") && tables.has("settings");
    } catch {
      this.schemaReady = false;
    }

    if (this.schemaReady) {
      // Only set alarm if schema exists and no alarm is running (read check first)
      ctx.blockConcurrencyWhile(async () => {
        const currentAlarm = await ctx.storage.getAlarm();
        if (!currentAlarm) {
          await ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
        }
      });
    }
  }

  private ensureReady(): void {
    if (!this.schemaReady) {
      this.ensureSchema();
      this.schemaReady = true;
    }
  }

  // --- Settings ---

  async getSettings(): Promise<{ anthropicApiKey?: string; githubToken?: string }> {
    if (!this.schemaReady) return {};
    const rows = this.ctx.storage.sql.exec(
      `SELECT key, value FROM settings WHERE key IN ('anthropic_api_key', 'github_token')`
    ).toArray();
    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.key as string] = row.value as string;
    }
    return {
      anthropicApiKey: map.anthropic_api_key,
      githubToken: map.github_token,
    };
  }

  async updateSettings(updates: { anthropicApiKey?: string; githubToken?: string }): Promise<void> {
    this.ensureReady();
    if (updates.anthropicApiKey !== undefined) {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO settings (key, value) VALUES ('anthropic_api_key', ?)`,
        updates.anthropicApiKey,
      );
    }
    if (updates.githubToken !== undefined) {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO settings (key, value) VALUES ('github_token', ?)`,
        updates.githubToken,
      );
    }
  }

  // --- Projects ---

  async createProject(project: Project): Promise<Project> {
    this.ensureReady();
    this.ctx.storage.sql.exec(
      `INSERT INTO projects (id, name, repo_url, default_branch, autonomy_level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      project.id, project.name, project.repoUrl, project.defaultBranch ?? null,
      project.autonomyLevel ?? "supervised",
      project.createdAt, project.updatedAt,
    );
    this.broadcast({ type: "project_created", taskId: "", timestamp: project.createdAt, data: { project } });
    return project;
  }

  async updateProject(id: string, updates: { name?: string; autonomyLevel?: string }): Promise<Project | null> {
    this.ensureReady();
    const project = await this.getProject(id);
    if (!project) return null;
    const now = new Date().toISOString();
    if (updates.name !== undefined) {
      this.ctx.storage.sql.exec(`UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`, updates.name, now, id);
    }
    if (updates.autonomyLevel !== undefined) {
      this.ctx.storage.sql.exec(`UPDATE projects SET autonomy_level = ?, updated_at = ? WHERE id = ?`, updates.autonomyLevel, now, id);
    }
    return this.getProject(id);
  }

  async getProject(id: string): Promise<Project | null> {
    if (!this.schemaReady) return null;
    const row = this.ctx.storage.sql.exec(
      `SELECT * FROM projects WHERE id = ?`, id
    ).one();
    if (!row) return null;
    return this.rowToProject(row);
  }

  async listProjects(): Promise<Project[]> {
    if (!this.schemaReady) return [];
    const rows = this.ctx.storage.sql.exec(
      `SELECT * FROM projects ORDER BY created_at DESC`
    ).toArray();
    return rows.map((r) => this.rowToProject(r));
  }

  async deleteProject(id: string): Promise<void> {
    // Delete all tasks and their subtasks/logs for this project
    const tasks = this.ctx.storage.sql.exec(
      `SELECT id FROM tasks WHERE project_id = ?`, id
    ).toArray();
    for (const t of tasks) {
      const taskId = t.id as string;
      this.ctx.storage.sql.exec(`DELETE FROM subtasks WHERE task_id = ?`, taskId);
      this.ctx.storage.sql.exec(`DELETE FROM logs WHERE task_id = ?`, taskId);
    }
    this.ctx.storage.sql.exec(`DELETE FROM tasks WHERE project_id = ?`, id);
    this.ctx.storage.sql.exec(`DELETE FROM projects WHERE id = ?`, id);
  }

  // --- Task CRUD ---

  async createTask(task: Task): Promise<Task> {
    this.ensureReady();
    this.ctx.storage.sql.exec(
      `INSERT INTO tasks (id, project_id, repo_url, description, status, branch_name, touch_set, depends_on, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id,
      task.projectId,
      task.repoUrl,
      task.description,
      task.status,
      task.branchName,
      JSON.stringify(task.touchSet),
      JSON.stringify(task.dependsOn ?? []),
      task.createdAt,
      task.updatedAt,
    );

    for (const s of task.subtasks) {
      this.insertSubtask(task.id, s);
    }

    this.broadcast({ type: "task_created", taskId: task.id, timestamp: task.createdAt, data: { task } });
    return task;
  }

  async getTask(id: string): Promise<Task | null> {
    if (!this.schemaReady) return null;
    const row = this.ctx.storage.sql.exec(
      `SELECT * FROM tasks WHERE id = ?`, id
    ).one();
    if (!row) return null;
    return this.rowToTask(row);
  }

  async listTasks(projectId?: string): Promise<Task[]> {
    if (!this.schemaReady) return [];
    if (projectId) {
      const rows = this.ctx.storage.sql.exec(
        `SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC`, projectId
      ).toArray();
      return rows.map((r) => this.rowToTask(r));
    }
    const rows = this.ctx.storage.sql.exec(
      `SELECT * FROM tasks ORDER BY created_at DESC`
    ).toArray();
    return rows.map((r) => this.rowToTask(r));
  }

  async updateTask(id: string, updates: Partial<Omit<Task, "previewUrl">> & { previewUrl?: string | null }): Promise<Task | null> {
    const now = new Date().toISOString();
    const sets: string[] = [`updated_at = ?`];
    const params: unknown[] = [now];

    if (updates.status !== undefined) { sets.push(`status = ?`); params.push(updates.status); }
    if (updates.branchName !== undefined) { sets.push(`branch_name = ?`); params.push(updates.branchName); }
    if (updates.touchSet !== undefined) { sets.push(`touch_set = ?`); params.push(JSON.stringify(updates.touchSet)); }
    if (updates.prUrl !== undefined) { sets.push(`pr_url = ?`); params.push(updates.prUrl); }
    if (updates.prNumber !== undefined) { sets.push(`pr_number = ?`); params.push(updates.prNumber); }
    if (updates.error !== undefined) { sets.push(`error = ?`); params.push(updates.error); }
    if (updates.blockedBy !== undefined) { sets.push(`blocked_by = ?`); params.push(updates.blockedBy ?? null); }
    if (updates.reviewCycles !== undefined) { sets.push(`review_cycles = ?`); params.push(updates.reviewCycles); }
    if (updates.previewUrl !== undefined) { sets.push(`preview_url = ?`); params.push(updates.previewUrl ?? null); }
    if (updates.planMarkdown !== undefined) { sets.push(`plan_markdown = ?`); params.push(updates.planMarkdown); }

    params.push(id);
    this.ctx.storage.sql.exec(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
      ...params,
    );

    if (updates.subtasks) {
      this.ctx.storage.sql.exec(`DELETE FROM subtasks WHERE task_id = ?`, id);
      for (const s of updates.subtasks) {
        this.insertSubtask(id, s);
      }
    }

    const task = await this.getTask(id);
    if (task && updates.status) {
      this.broadcast({ type: "task_status_changed", taskId: id, timestamp: now, data: { status: updates.status } });
    }
    return task;
  }

  async deleteTask(id: string): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM subtasks WHERE task_id = ?`, id);
    this.ctx.storage.sql.exec(`DELETE FROM logs WHERE task_id = ?`, id);
    this.ctx.storage.sql.exec(`DELETE FROM tasks WHERE id = ?`, id);
  }

  // --- Task Execution (runs in DO alarm for long wall-clock time) ---

  private static readonly MAX_CONCURRENT = 5;

  async triggerAlarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now());
  }

  async enqueueTask(taskId: string): Promise<void> {
    const pending = await this.ctx.storage.get<string[]>("pending_tasks") ?? [];
    pending.push(taskId);
    await this.ctx.storage.put("pending_tasks", pending);
    // Always fire alarm immediately — overrides any scheduled periodic alarm
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    this.ensureReady();
    let pending = await this.ctx.storage.get<string[]>("pending_tasks") ?? [];
    const running = await this.ctx.storage.get<string[]>("running_tasks") ?? [];
    const pendingReviewFixes = await this.ctx.storage.get<string[]>("pending_review_fixes") ?? [];
    const approved = await this.ctx.storage.get<string[]>("approved_tasks") ?? [];

    // Self-healing: find orphaned queued/planned/blocked tasks not in any list
    const trackedSet = new Set([...pending, ...running, ...approved]);
    const activeRows = this.ctx.storage.sql.exec(
      `SELECT id FROM tasks WHERE status IN ('queued', 'planned', 'blocked')`,
    ).toArray();
    const orphaned = activeRows.filter((r) => !trackedSet.has(r.id as string));
    if (orphaned.length > 0) {
      for (const row of orphaned) {
        const id = row.id as string;
        console.log(`Alarm: re-enqueuing orphaned task ${id}`);
        pending.push(id);
      }
      await this.ctx.storage.put("pending_tasks", pending);
    }

    if (pending.length === 0 && running.length === 0 && pendingReviewFixes.length === 0 && approved.length === 0) return;

    // Phase 1: Plan any queued tasks that haven't been planned yet
    const needsPlanning: string[] = [];
    for (const taskId of pending) {
      const task = await this.getTask(taskId);
      if (!task || task.status === "cancelled") continue;
      if (task.status === "queued") {
        needsPlanning.push(taskId);
      }
    }

    const secrets = await this.resolveSecrets();
    if (needsPlanning.length > 0) {
      if (!secrets.anthropicApiKey) {
        for (const id of needsPlanning) {
          await this.updateTask(id, { status: "failed", error: "ANTHROPIC_API_KEY not configured. Go to Settings to add it." });
        }
        await this.ctx.storage.put("pending_tasks", pending.filter((id) => !needsPlanning.includes(id)));
        return;
      }

      const resolvedEnv: Env = { ...this.env, ANTHROPIC_API_KEY: secrets.anthropicApiKey, GITHUB_TOKEN: secrets.githubToken };

      // Plan tasks sequentially (each takes ~10s, fast enough)
      for (const taskId of needsPlanning) {
        try {
          await this.planSingleTask(taskId, resolvedEnv);
        } catch (err) {
          console.error(`Planning failed for task ${taskId}:`, err);
          await this.updateTask(taskId, { status: "failed", error: `Planning error: ${err}` });
          await this.appendLog(taskId, "", `Planning failed: ${err}`, "error");
        }
      }
    }

    // Phase 2: Dispatch approved tasks, checking for conflicts
    // Only tasks that have been explicitly approved (or unblocked) get dispatched
    // (approved already fetched at top of alarm)
    const updatedPending = await this.ctx.storage.get<string[]>("pending_tasks") ?? [];
    const toRun: string[] = [];
    const stillPending: string[] = [];

    // Merge approved tasks into the dispatch candidates
    const dispatchCandidates = [...new Set([...approved, ...updatedPending.filter((id) => {
      // Only blocked tasks can auto-dispatch from pending (they were already approved before being blocked)
      const t = this.ctx.storage.sql.exec(`SELECT status FROM tasks WHERE id = ?`, id).toArray()[0];
      return t && (t.status as string) === "blocked";
    })])];

    // Clean approved list — they're being processed now
    await this.ctx.storage.put("approved_tasks", []);

    // Keep pending tasks that are still waiting (planned but not approved, or queued)
    for (const taskId of updatedPending) {
      const task = await this.getTask(taskId);
      if (!task || task.status === "cancelled" || task.status === "failed") continue;
      if (!dispatchCandidates.includes(taskId)) {
        stillPending.push(taskId);
        continue;
      }
    }

    for (const taskId of dispatchCandidates) {
      const task = await this.getTask(taskId);
      if (!task || task.status === "cancelled" || task.status === "failed") continue;
      if (task.status !== "planned" && task.status !== "blocked") continue;

      // DAG check: all dependsOn tasks must be "success" before dispatching
      if (task.dependsOn && task.dependsOn.length > 0) {
        const depsMet = task.dependsOn.every((depId) => {
          const row = this.ctx.storage.sql.exec(`SELECT status FROM tasks WHERE id = ?`, depId).toArray()[0];
          return row && (row.status as string) === "success";
        });
        if (!depsMet) {
          if (task.status !== "blocked") {
            const pendingDeps = task.dependsOn.filter((depId) => {
              const row = this.ctx.storage.sql.exec(`SELECT status FROM tasks WHERE id = ?`, depId).toArray()[0];
              return !row || (row.status as string) !== "success";
            });
            await this.updateTask(taskId, { status: "blocked" });
            await this.appendLog(taskId, "", `Waiting on dependencies: ${pendingDeps.join(", ")}`, "info");
          }
          stillPending.push(taskId);
          continue;
        }
      }

      if (running.length + toRun.length >= TaskCoordinator.MAX_CONCURRENT) {
        stillPending.push(taskId);
        continue;
      }

      // Check for touch-set conflicts with running + about-to-run tasks
      const conflict = await this.detectConflict(taskId, task.touchSet, [...running, ...toRun]);
      if (conflict) {
        if (task.status !== "blocked" || task.blockedBy !== conflict.blockingTaskId) {
          await this.updateTask(taskId, { status: "blocked", blockedBy: conflict.blockingTaskId });
          await this.appendLog(taskId, "", `Blocked by task ${conflict.blockingTaskId} (overlapping files: ${conflict.overlappingFiles.join(", ")})`, "warn");
          this.broadcast({
            type: "conflict_detected",
            taskId,
            timestamp: new Date().toISOString(),
            data: { blockedTaskId: taskId, blockingTaskId: conflict.blockingTaskId, overlappingFiles: conflict.overlappingFiles },
          });
        }
        stillPending.push(taskId);
      } else {
        // Clear blocked state if it was previously blocked
        if (task.status === "blocked") {
          this.broadcast({
            type: "conflict_resolved",
            taskId,
            timestamp: new Date().toISOString(),
            data: { blockedTaskId: taskId, blockingTaskId: task.blockedBy ?? "", overlappingFiles: [] },
          });
        }
        toRun.push(taskId);
      }
    }

    await this.ctx.storage.put("pending_tasks", stillPending);
    running.push(...toRun);
    await this.ctx.storage.put("running_tasks", running);

    // Phase 3: Execute non-conflicting tasks in parallel
    if (toRun.length > 0) {
      if (!secrets.githubToken) {
        for (const id of toRun) {
          await this.updateTask(id, { status: "failed", error: "GITHUB_TOKEN not configured. Go to Settings to add it." });
        }
      } else {
        const resolvedEnv: Env = { ...this.env, ANTHROPIC_API_KEY: secrets.anthropicApiKey, GITHUB_TOKEN: secrets.githubToken };

        const results = await Promise.allSettled(
          toRun.map((taskId) => this.executePlannedTask(taskId, resolvedEnv)),
        );

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.status === "rejected") {
            console.error(`Task ${toRun[i]} rejected:`, r.reason);
            try {
              await this.updateTask(toRun[i], { status: "failed", error: `Execution error: ${r.reason}` });
              await this.appendLog(toRun[i], "", `Task failed: ${r.reason}`, "error");
            } catch { /* best effort */ }
          }
        }
      }

      // Remove completed tasks from running set + unblock waiting tasks
      const currentRunning = await this.ctx.storage.get<string[]>("running_tasks") ?? [];
      const nowDone = currentRunning.filter((id) => toRun.includes(id));
      const stillRunning = currentRunning.filter((id) => !toRun.includes(id));
      await this.ctx.storage.put("running_tasks", stillRunning);

      // Check if any blocked tasks can now proceed
      if (nowDone.length > 0) {
        const currentPending = await this.ctx.storage.get<string[]>("pending_tasks") ?? [];
        if (currentPending.length > 0) {
          await this.ctx.storage.setAlarm(Date.now());
        }
      }
    }

    // Process any pending review fixes
    await this.processReviewFixes();

    // Cleanup stale sandboxes periodically
    await this.cleanupStaleTasks();

    // Reschedule if there are still pending tasks or review fixes
    const remaining = await this.ctx.storage.get<string[]>("pending_tasks") ?? [];
    const pendingReviews = await this.ctx.storage.get<string[]>("pending_review_fixes") ?? [];
    if (remaining.length > 0 || pendingReviews.length > 0) {
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (!currentAlarm) {
        await this.ctx.storage.setAlarm(Date.now() + 1000);
      }
    } else {
      // Even with no active work, schedule a cleanup check every 5 minutes
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (!currentAlarm) {
        await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
      }
    }
  }

  // --- Conflict Detection ---

  private async detectConflict(
    taskId: string,
    touchSet: string[],
    activeTaskIds: string[],
  ): Promise<{ blockingTaskId: string; overlappingFiles: string[] } | null> {
    if (touchSet.length === 0) return null;

    const terminalStatuses = ["success", "failed", "cancelled", "closed"];
    for (const activeId of activeTaskIds) {
      if (activeId === taskId) continue;
      const activeTask = await this.getTask(activeId);
      if (!activeTask || activeTask.touchSet.length === 0) continue;
      // Skip tasks in terminal states — they can't conflict
      if (terminalStatuses.includes(activeTask.status)) continue;

      // Same repo check — tasks on different repos can never conflict
      // (touchSet contains relative paths, so same filename on different repos isn't a conflict)
      // We only compare tasks on the same repo
      const task = await this.getTask(taskId);
      if (!task || task.repoUrl !== activeTask.repoUrl) continue;

      const overlap = touchSet.filter((f) => activeTask.touchSet.includes(f));
      if (overlap.length > 0) {
        return { blockingTaskId: activeId, overlappingFiles: overlap };
      }
    }
    return null;
  }

  // --- Rebase Support ---

  async triggerRebase(repoUrl: string, mergedBranch: string, mergedPrNumber: number): Promise<string[]> {
    // Find all running tasks on this repo that need rebasing
    const runningIds = await this.ctx.storage.get<string[]>("running_tasks") ?? [];
    const rebased: string[] = [];

    for (const taskId of runningIds) {
      const task = await this.getTask(taskId);
      if (!task || task.repoUrl !== repoUrl || task.branchName === mergedBranch) continue;

      await this.appendLog(taskId, "", `Rebase needed: PR #${mergedPrNumber} (${mergedBranch}) was merged`, "warn");
      this.broadcast({
        type: "rebase_required",
        taskId,
        timestamp: new Date().toISOString(),
        data: { targetTaskId: taskId, mergedPrNumber, mergedBranch },
      });
      rebased.push(taskId);
    }
    return rebased;
  }

  // --- Secrets ---

  private async resolveSecrets(): Promise<{ anthropicApiKey: string; githubToken: string }> {
    const settings = await this.getSettings();
    return {
      anthropicApiKey: settings.anthropicApiKey || this.env.ANTHROPIC_API_KEY || "",
      githubToken: settings.githubToken || this.env.GITHUB_TOKEN || "",
    };
  }

  // --- Task Execution Phases ---

  private async planSingleTask(taskId: string, env: Env): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task || task.status === "cancelled") return;

    await this.updateTask(taskId, { status: "planning" });
    await this.appendLog(taskId, "", "Starting planning phase...", "info");

    const result = await planTask(taskId, task.repoUrl, task.description, env);

    await this.updateTask(taskId, {
      status: "planned",
      branchName: result.payload.branchName,
      subtasks: result.payload.subtasks,
      touchSet: result.payload.touchSet,
      planMarkdown: result.planMarkdown,
    });

    // Check if we should auto-approve based on project autonomy level
    const project = task.projectId ? await this.getProject(task.projectId) : null;
    const autonomy = project?.autonomyLevel ?? "supervised";
    const fileCount = result.payload.touchSet.length;
    const shouldAutoApprove =
      autonomy === "full" ||
      (autonomy === "high" && fileCount <= 10) ||
      (autonomy === "moderate" && fileCount <= 3);

    if (shouldAutoApprove) {
      await this.appendLog(taskId, "", `Auto-approved (autonomy: ${autonomy}, ${fileCount} files). Queuing for execution.`, "info");
      await this.approvePlan(taskId);
    } else {
      await this.appendLog(taskId, "", `Plan ready for review: ${result.payload.subtasks.length} subtasks. Waiting for approval.`, "info");
    }
  }

  /**
   * Approve a plan — transitions from "planned" to ready for execution.
   */
  async approvePlan(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task || task.status !== "planned") return;

    await this.appendLog(taskId, "", "Plan approved — queuing for execution", "info");

    // Move to the approved_tasks list so the alarm picks it up
    const approved = await this.ctx.storage.get<string[]>("approved_tasks") ?? [];
    approved.push(taskId);
    await this.ctx.storage.put("approved_tasks", approved);

    // Trigger alarm to dispatch immediately
    await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * Revise a plan based on developer feedback.
   */
  async revisePlan(taskId: string, feedback: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task || task.status !== "planned") return;

    await this.updateTask(taskId, { status: "planning" });
    await this.appendLog(taskId, "", `Revising plan based on feedback: ${feedback.slice(0, 100)}`, "info");

    const secrets = await this.resolveSecrets();
    if (!secrets.anthropicApiKey) {
      await this.updateTask(taskId, { status: "failed", error: "ANTHROPIC_API_KEY not configured" });
      return;
    }

    const resolvedEnv: Env = { ...this.env, ANTHROPIC_API_KEY: secrets.anthropicApiKey, GITHUB_TOKEN: secrets.githubToken };

    try {
      const result = await revisePlan(
        taskId,
        task.repoUrl,
        task.description,
        task.planMarkdown ?? "",
        feedback,
        resolvedEnv,
      );

      await this.updateTask(taskId, {
        status: "planned",
        branchName: result.payload.branchName,
        subtasks: result.payload.subtasks,
        touchSet: result.payload.touchSet,
        planMarkdown: result.planMarkdown,
      });
      await this.appendLog(taskId, "", `Plan revised: ${result.payload.subtasks.length} subtasks. Waiting for approval.`, "info");
    } catch (err) {
      await this.updateTask(taskId, { status: "planned" }); // Revert to planned so user can retry
      await this.appendLog(taskId, "", `Plan revision failed: ${err}`, "error");
    }
  }

  private async executePlannedTask(taskId: string, env: Env): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task || task.status === "cancelled") return;

    await this.updateTask(taskId, { status: "running", blockedBy: undefined });
    await this.appendLog(taskId, "", "Starting execution phase...", "info");

    try {
      const payload: DispatchPayload = {
        taskId,
        branchName: task.branchName,
        repoContext: {
          repoUrl: task.repoUrl,
          defaultBranch: "main",
          projectType: "unknown",
          structure: [],
        },
        subtasks: task.subtasks,
        touchSet: task.touchSet,
        callbackUrl: `${env.WORKER_URL ?? ""}/internal/sandboxes/${taskId}`,
      };

      // Re-analyze repo to get full context for the agent
      const sandboxManager = new SandboxManager(env);
      const repoAnalysis = await sandboxManager.analyzeRepo(task.repoUrl, taskId);
      payload.repoContext = {
        repoUrl: task.repoUrl,
        defaultBranch: repoAnalysis.defaultBranch,
        projectType: repoAnalysis.projectType,
        structure: repoAnalysis.structure,
      };

      const { sandbox } = await sandboxManager.create(payload);

      const result = await sandboxManager.runAgent(sandbox, payload, async (msg) => {
        await this.appendLog(taskId, `task-${taskId}`, msg, "info");
      }, async (partial) => {
        // Persist PR URL and preview URL immediately as they're discovered
        const updates: Record<string, unknown> = {};
        if (partial.prUrl) {
          updates.prUrl = partial.prUrl;
          // Extract PR number
          const prMatch = partial.prUrl.match(/\/pull\/(\d+)/);
          if (prMatch) updates.prNumber = parseInt(prMatch[1], 10);
        }
        if (partial.previewUrl) {
          // Preview URL is now a real URL from sandbox.exposePort()
          updates.previewUrl = partial.previewUrl;
        }
        if (Object.keys(updates).length > 0) {
          await this.updateTask(taskId, updates as Partial<Task>);
        }
      });

      await this.updateTask(taskId, { status: "reviewing", prUrl: result.prUrl, previewUrl: result.previewUrl });

      // Store agent context for post-hoc inspection
      if (result.agentContext) {
        await this.storeContext(taskId, result.agentContext);
      }

      await this.appendLog(taskId, "", "PR created — sandbox kept alive for review fixes", "info");
      if (result.previewUrl) {
        await this.appendLog(taskId, "", `Preview available at ${result.previewUrl}`, "info");
      }

      // If no preview was exposed and the project looks like a web app, ask the agent to fix it
      if (!result.previewUrl && payload.repoContext.projectType === "node") {
        const hasWebServer = await this.detectWebServer(sandbox, taskId);
        if (hasWebServer) {
          await this.appendLog(taskId, "", "Detected web server but no preview — requesting agent to start it", "info");
          await this.addReviewComment(taskId, {
            id: `auto-preview-${Date.now()}`,
            prNumber: task.prNumber ?? 0,
            author: "phil-orchestrator",
            body: "Please start the dev/web server in the background on port 8080 (port 3000 is reserved and cannot be used). Run it with & or use a process manager so it keeps running after you finish. Do NOT use port 3000.",
            createdAt: new Date().toISOString(),
          });
          await this.enqueueReviewFix(taskId);
        }
      }

      // Track that this sandbox is alive for review fixes
      const watching = await this.ctx.storage.get<string[]>("watching_tasks") ?? [];
      if (!watching.includes(taskId)) {
        watching.push(taskId);
        await this.ctx.storage.put("watching_tasks", watching);
      }
    } catch (err) {
      console.error(`Task ${taskId} failed:`, err);
      await this.updateTask(taskId, { status: "failed", error: String(err) });
      await this.appendLog(taskId, "", `Task failed: ${err}`, "error");
      // Destroy sandbox on failure — no reason to keep it alive
      const sandboxManager = new SandboxManager(this.env);
      await sandboxManager.destroy(taskId).catch(() => {});
    }
  }

  // --- Review Loop ---

  async addReviewComment(
    taskId: string,
    comment: { id: string; prNumber: number; author: string; body: string; path?: string; line?: number; createdAt: string },
  ): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO review_comments (id, task_id, pr_number, author, body, path, line, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      comment.id, taskId, comment.prNumber, comment.author, comment.body,
      comment.path ?? null, comment.line ?? null, comment.createdAt,
    );

    this.broadcast({
      type: "review_received",
      taskId,
      timestamp: comment.createdAt,
      data: { prNumber: comment.prNumber, author: comment.author, body: comment.body, path: comment.path, line: comment.line },
    });
    await this.appendLog(taskId, "", `Review comment from ${comment.author}: ${comment.body.slice(0, 100)}`, "info");
  }

  async getUnprocessedReviews(taskId: string): Promise<Array<{ id: string; author: string; body: string; path?: string; line?: number }>> {
    return this.ctx.storage.sql.exec(
      `SELECT id, author, body, path, line FROM review_comments WHERE task_id = ? AND processed = 0 ORDER BY created_at`,
      taskId,
    ).toArray() as Array<{ id: string; author: string; body: string; path?: string; line?: number }>;
  }

  async markReviewsProcessed(taskId: string, reviewIds: string[]): Promise<void> {
    for (const id of reviewIds) {
      this.ctx.storage.sql.exec(`UPDATE review_comments SET processed = 1 WHERE id = ?`, id);
    }
  }

  async enqueueReviewFix(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;

    // Only process if task is in reviewing state
    if (task.status !== "reviewing") {
      await this.appendLog(taskId, "", `Skipping review fix — task status is ${task.status}`, "warn");
      return;
    }

    const pending = await this.ctx.storage.get<string[]>("pending_review_fixes") ?? [];
    if (!pending.includes(taskId)) {
      pending.push(taskId);
      await this.ctx.storage.put("pending_review_fixes", pending);
    }

    // Schedule alarm immediately to process review fixes
    await this.ctx.storage.setAlarm(Date.now());
  }

  private async processReviewFixes(): Promise<void> {
    const pending = await this.ctx.storage.get<string[]>("pending_review_fixes") ?? [];
    if (pending.length === 0) return;

    const secrets = await this.resolveSecrets();
    if (!secrets.anthropicApiKey || !secrets.githubToken) return;

    const resolvedEnv: Env = { ...this.env, ANTHROPIC_API_KEY: secrets.anthropicApiKey, GITHUB_TOKEN: secrets.githubToken };

    // Process one review fix at a time
    const taskId = pending.shift()!;
    await this.ctx.storage.put("pending_review_fixes", pending);

    try {
      await this.executeReviewFix(taskId, resolvedEnv);
    } catch (err) {
      console.error(`Review fix failed for task ${taskId}:`, err);
      await this.appendLog(taskId, "", `Review fix failed: ${err}`, "error");
      // Return to reviewing state so it can try again
      await this.updateTask(taskId, { status: "reviewing" });
    }
  }

  private async executeReviewFix(taskId: string, env: Env): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;

    const reviews = await this.getUnprocessedReviews(taskId);
    if (reviews.length === 0) {
      await this.appendLog(taskId, "", "No unprocessed reviews to fix", "info");
      return;
    }

    await this.updateTask(taskId, { status: "fixing" });
    this.broadcast({ type: "review_fix_started", taskId, timestamp: new Date().toISOString(), data: { reviewCount: reviews.length } });
    await this.appendLog(taskId, "", `Processing ${reviews.length} review comment(s)...`, "info");

    const sandboxManager = new SandboxManager(env);
    // Get existing sandbox (still alive from initial run)
    const sandboxId = `task-${taskId}`.toLowerCase();
    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandbox = getSandbox(env.Sandbox, sandboxId, { keepAlive: true });

    // Recover workspace if sandbox was recycled
    const wsCheck = await sandbox.exec("ls /workspace/package.json 2>/dev/null && echo 'ok' || echo 'empty'");
    if (wsCheck.stdout.trim() === "empty") {
      await this.appendLog(taskId, "", "Workspace empty — re-cloning repo...", "info");
      const token = env.GITHUB_TOKEN ?? "";
      const authedUrl = task.repoUrl.replace("https://", `https://x-access-token:${token}@`);
      await sandbox.exec(`git clone ${authedUrl} /workspace 2>&1`);
      await sandbox.exec(`cd /workspace && git checkout ${task.branchName} 2>&1`, { cwd: "/workspace" });
      await sandbox.exec(`cd /workspace && npm install --no-audit --no-fund 2>&1`, { cwd: "/workspace" });
      await sandbox.exec('git config --global user.name "Phil Agent"');
      await sandbox.exec('git config --global user.email "phil@agent.local"');
      if (token) {
        await sandbox.exec(
          `git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=${token}"; }; f'`,
        );
      }
    }

    // Build review context for the agent
    const reviewContext = reviews.map((r) => {
      let ctx = `**${r.author}**: ${r.body}`;
      if (r.path) ctx += `\n  File: ${r.path}${r.line ? `:${r.line}` : ""}`;
      return ctx;
    }).join("\n\n");

    // Run review-fix agent loop
    const { runReviewFixLoop } = await import("../sandbox/review-agent.js");
    const result = await runReviewFixLoop(sandbox, task, reviewContext, env, async (msg) => {
      await this.appendLog(taskId, `task-${taskId}`, msg, "info");
    });

    // Store review-fix context (appends to existing context)
    if (result.agentContext) {
      const existing = await this.getContext(taskId);
      if (existing) {
        // Append review-fix context to existing
        try {
          const prev = JSON.parse(existing);
          const next = JSON.parse(result.agentContext);
          prev.push({ type: "text", content: "--- Review Fix ---" }, ...next);
          await this.storeContext(taskId, JSON.stringify(prev));
        } catch {
          await this.storeContext(taskId, result.agentContext);
        }
      } else {
        await this.storeContext(taskId, result.agentContext);
      }
    }

    // Mark reviews as processed
    await this.markReviewsProcessed(taskId, reviews.map((r) => r.id));

    // Check for preview server after review fix (agent may have started one)
    if (!task.previewUrl) {
      try {
        let portCheck = await sandbox.exec("curl -sf http://localhost:8080 -o /dev/null && echo 'LISTENING' || echo 'CLOSED'");

        // If no server running, try to start one automatically
        if (!portCheck.stdout.includes("LISTENING")) {
          await this.appendLog(taskId, "", "No server on port 8080 — attempting to start one...", "info");
          const pkgCheck = await sandbox.exec("cat /workspace/package.json 2>/dev/null || true");
          if (pkgCheck.success && pkgCheck.stdout.includes("{")) {
            // Ensure dependencies are installed
            await this.appendLog(taskId, "", "Installing dependencies...", "info");
            await sandbox.exec("cd /workspace && npm install --no-audit --no-fund 2>&1", { cwd: "/workspace" });

            const startCmd = pkgCheck.stdout.includes('"dev"')
              ? "npm run dev -- --port 8080 --host 0.0.0.0"
              : pkgCheck.stdout.includes('"start"')
                ? "PORT=8080 npm start"
                : "npx -y serve /workspace -l 8080";
            await this.appendLog(taskId, "", `Starting server: ${startCmd}`, "info");
            await sandbox.exec(
              `bash -c 'cd /workspace && ${startCmd} > /tmp/dev-server.log 2>&1 &'`,
              { env: { PORT: "8080", HOME: "/root" } },
            );
            await new Promise((r) => setTimeout(r, 5000));
            portCheck = await sandbox.exec("curl -sf http://localhost:8080 -o /dev/null && echo 'LISTENING' || echo 'CLOSED'");
          }
        }

        if (portCheck.success && portCheck.stdout.includes("LISTENING")) {
          await this.appendLog(taskId, "", "Preview server detected on port 8080 — exposing...", "info");
          const hostname = env.PREVIEW_HOSTNAME ?? new URL(env.WORKER_URL ?? "https://localhost").hostname;
          const exposed = await sandbox.exposePort(8080, { hostname });
          await this.updateTask(taskId, { previewUrl: exposed.url });
          await this.appendLog(taskId, "", `Preview URL: ${exposed.url}`, "info");
        }
      } catch (err) {
        await this.appendLog(taskId, "", `Preview expose failed: ${err}`, "info");
      }
    }

    const cycles = (task.reviewCycles ?? 0) + 1;
    await this.updateTask(taskId, { status: "reviewing", reviewCycles: cycles });
    this.broadcast({ type: "review_fix_completed", taskId, timestamp: new Date().toISOString(), data: { cycles, pushed: result.pushed } });
    await this.appendLog(taskId, "", `Review fix cycle ${cycles} complete${result.pushed ? " — changes pushed" : ""}`, "info");
  }

  // --- Escalation ---

  async addEscalation(taskId: string, from: "agent" | "user", message: string): Promise<void> {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO escalations (task_id, sender, message, created_at) VALUES (?, ?, ?, ?)`,
      taskId, from, message, timestamp,
    );
    const eventType = from === "agent" ? "escalation" : "escalation_response";
    this.broadcast({ type: eventType, taskId, timestamp, data: { from, message } });
    await this.appendLog(taskId, "", `[${from === "agent" ? "ESCALATION" : "USER RESPONSE"}] ${message}`, from === "agent" ? "warn" : "info");
  }

  async getEscalations(taskId: string): Promise<Array<{ sender: string; message: string; createdAt: string }>> {
    return this.ctx.storage.sql.exec(
      `SELECT sender, message, created_at as createdAt FROM escalations WHERE task_id = ? ORDER BY id`,
      taskId,
    ).toArray() as Array<{ sender: string; message: string; createdAt: string }>;
  }

  async resolveTask(taskId: string): Promise<void> {
    // Mark a reviewing task as fully done, destroy sandbox
    const task = await this.getTask(taskId);
    if (!task) return;

    await this.updateTask(taskId, { status: "success", previewUrl: null });
    await this.appendLog(taskId, "", "Task resolved — sandbox destroyed", "info");

    // Remove from watching list
    const watching = await this.ctx.storage.get<string[]>("watching_tasks") ?? [];
    await this.ctx.storage.put("watching_tasks", watching.filter((id) => id !== taskId));

    // Destroy sandbox
    const sandboxManager = new SandboxManager(this.env);
    await sandboxManager.destroy(taskId).catch(() => {});
  }

  async removeFromRunning(taskId: string): Promise<void> {
    const running = await this.ctx.storage.get<string[]>("running_tasks") ?? [];
    await this.ctx.storage.put("running_tasks", running.filter((id) => id !== taskId));
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;

    await this.updateTask(taskId, { status: "cancelled", previewUrl: null });
    await this.appendLog(taskId, "", "Task cancelled", "info");

    // Remove from all tracking lists
    for (const key of ["pending_tasks", "running_tasks", "watching_tasks", "approved_tasks"] as const) {
      const list = await this.ctx.storage.get<string[]>(key) ?? [];
      await this.ctx.storage.put(key, list.filter((id) => id !== taskId));
    }

    // Destroy sandbox
    const sandboxManager = new SandboxManager(this.env);
    await sandboxManager.destroy(taskId).catch(() => {});
  }

  async closeTask(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;

    await this.updateTask(taskId, { status: "closed", previewUrl: null });
    await this.appendLog(taskId, "", "Task closed", "info");

    // Remove from all tracking lists
    for (const key of ["pending_tasks", "running_tasks", "watching_tasks", "approved_tasks"] as const) {
      const list = await this.ctx.storage.get<string[]>(key) ?? [];
      await this.ctx.storage.put(key, list.filter((id) => id !== taskId));
    }

    // Destroy sandbox
    const sandboxManager = new SandboxManager(this.env);
    await sandboxManager.destroy(taskId).catch(() => {});
  }

  // --- Stale Sandbox Cleanup ---

  private async cleanupStaleTasks(): Promise<void> {
    const lastCleanup = await this.ctx.storage.get<number>("last_cleanup_at") ?? 0;
    const now = Date.now();
    // Run cleanup at most every 5 minutes
    if (now - lastCleanup < 5 * 60 * 1000) return;
    await this.ctx.storage.put("last_cleanup_at", now);

    const allTasks = await this.listTasks();
    const sandboxManager = new SandboxManager(this.env);
    const staleThreshold = 30 * 60 * 1000; // 30 min for stuck planning/running/queued

    for (const task of allTasks) {
      const age = now - new Date(task.updatedAt).getTime();

      // Stuck in non-terminal, non-review states for >30 min
      if (["planning", "running", "queued"].includes(task.status) && age > staleThreshold) {
        console.log(`Cleanup: task ${task.id} stuck in ${task.status} for ${Math.round(age / 60000)}m`);
        await this.updateTask(task.id, { status: "failed", error: "Auto-cleanup: task was stale" });
        await this.appendLog(task.id, "", "Auto-cleanup: sandbox destroyed (task was stale)", "warn");
        await sandboxManager.destroy(task.id).catch(() => {});

        // Remove from running/pending lists
        const running = await this.ctx.storage.get<string[]>("running_tasks") ?? [];
        await this.ctx.storage.put("running_tasks", running.filter((id) => id !== task.id));
        const pending = await this.ctx.storage.get<string[]>("pending_tasks") ?? [];
        await this.ctx.storage.put("pending_tasks", pending.filter((id) => id !== task.id));
      }

      // Reviewing/fixing tasks idle for >2 hours — sandbox is burning resources
      if (["reviewing", "fixing"].includes(task.status) && age > 2 * 60 * 60 * 1000) {
        console.log(`Cleanup: task ${task.id} in ${task.status} idle for ${Math.round(age / 60000)}m — destroying sandbox`);
        await this.appendLog(task.id, "", "Auto-cleanup: sandbox destroyed after 2h idle (task still open, sandbox can be recreated)", "warn");
        await sandboxManager.destroy(task.id).catch(() => {});
        // Remove from watching list — sandbox is gone
        const watching = await this.ctx.storage.get<string[]>("watching_tasks") ?? [];
        await this.ctx.storage.put("watching_tasks", watching.filter((id) => id !== task.id));
      }
    }
  }

  // --- Logs ---

  async appendLog(taskId: string, sandboxId: string, message: string, level: string): Promise<void> {
    const timestamp = new Date().toISOString();
    console.log(`[${level}] task=${taskId} ${message}`);
    // Persist to events table
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO events (task_id, type, data, created_at) VALUES (?, ?, ?, ?)`,
        taskId,
        "agent_log",
        JSON.stringify({ sandboxId, message, level }),
        timestamp,
      );
    } catch { /* schema may not exist yet */ }
    // Broadcast via WebSocket (real-time)
    this.broadcast({ type: "agent_log", taskId, timestamp, data: { sandboxId, message, level } });
  }

  private async detectWebServer(sandbox: { readFile(path: string, opts?: unknown): Promise<{ content: string }> }, _taskId: string): Promise<boolean> {
    try {
      const sb = sandbox;
      const pkgResult = await sb.readFile("/workspace/package.json");
      const pkg = JSON.parse(pkgResult.content);
      const scripts = pkg.scripts ?? {};
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      // Check for common web server indicators
      const hasServerScript = !!(scripts.start || scripts.dev || scripts.serve);
      const hasWebFramework = !!(deps.express || deps.fastify || deps.koa || deps.hapi || deps.next || deps.vite || deps.react || deps.vue || deps.svelte || deps["@angular/core"]);
      return hasServerScript || hasWebFramework;
    } catch {
      return false;
    }
  }

  async setPreviewPort(taskId: string, port: number): Promise<void> {
    await this.ctx.storage.put(`preview_port:${taskId}`, port);
  }

  async getPreviewPort(taskId: string): Promise<number | null> {
    return (await this.ctx.storage.get<number>(`preview_port:${taskId}`)) ?? null;
  }

  async getLogs(taskId: string): Promise<Array<{ message: string; level: string; timestamp: string }>> {
    try {
      return this.ctx.storage.sql.exec(
        `SELECT json_extract(data, '$.message') as message, json_extract(data, '$.level') as level, created_at as timestamp
         FROM events WHERE task_id = ? AND type = 'agent_log' ORDER BY id`,
        taskId,
      ).toArray() as Array<{ message: string; level: string; timestamp: string }>;
    } catch {
      return [];
    }
  }

  async getEvents(taskId: string): Promise<Array<{ type: string; data: string; timestamp: string }>> {
    try {
      return this.ctx.storage.sql.exec(
        `SELECT type, data, created_at as timestamp FROM events WHERE task_id = ? ORDER BY id`,
        taskId,
      ).toArray() as Array<{ type: string; data: string; timestamp: string }>;
    } catch {
      return [];
    }
  }

  // --- Agent Context ---

  async storeContext(taskId: string, context: string): Promise<void> {
    this.ensureReady();
    this.ctx.storage.sql.exec(
      `UPDATE tasks SET agent_context = ?, updated_at = ? WHERE id = ?`,
      context, new Date().toISOString(), taskId,
    );
  }

  async getContext(taskId: string): Promise<string | null> {
    if (!this.schemaReady) return null;
    const row = this.ctx.storage.sql.exec(
      `SELECT agent_context FROM tasks WHERE id = ?`, taskId,
    ).one();
    return (row?.agent_context as string) ?? null;
  }

  // --- WebSocket for real-time dashboard ---

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("Expected WebSocket", { status: 400 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Client can send ping or subscribe to specific task IDs
  }

  webSocketClose(ws: WebSocket): void {
    // Cleanup handled by hibernation
  }

  // --- Helpers ---

  private insertSubtask(taskId: string, s: Subtask): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO subtasks (id, task_id, description, status, dependencies, file_targets, output, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      s.id, taskId, s.description, s.status,
      JSON.stringify(s.dependencies), JSON.stringify(s.fileTargets),
      s.output ?? null, s.error ?? null,
    );
  }

  private rowToProject(row: Record<string, unknown>): Project {
    return {
      id: row.id as string,
      name: row.name as string,
      repoUrl: row.repo_url as string,
      defaultBranch: row.default_branch as string | undefined,
      autonomyLevel: (row.autonomy_level as string as Project["autonomyLevel"]) ?? "supervised",
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private rowToTask(row: Record<string, unknown>): Task {
    const subtaskRows = this.ctx.storage.sql.exec(
      `SELECT * FROM subtasks WHERE task_id = ? ORDER BY id`,
      row.id as string,
    ).toArray();

    return {
      id: row.id as string,
      projectId: row.project_id as string,
      repoUrl: row.repo_url as string,
      description: row.description as string,
      status: row.status as TaskStatus,
      branchName: row.branch_name as string,
      touchSet: JSON.parse(row.touch_set as string),
      subtasks: subtaskRows.map((s) => ({
        id: s.id as string,
        description: s.description as string,
        status: s.status as Subtask["status"],
        dependencies: JSON.parse(s.dependencies as string),
        fileTargets: JSON.parse(s.file_targets as string),
        output: s.output as string | undefined,
        error: s.error as string | undefined,
      })),
      planMarkdown: row.plan_markdown as string | undefined,
      prUrl: row.pr_url as string | undefined,
      prNumber: row.pr_number as number | undefined,
      previewUrl: row.preview_url as string | undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      error: row.error as string | undefined,
      blockedBy: row.blocked_by as string | undefined,
      dependsOn: JSON.parse((row.depends_on as string) || "[]"),
      reviewCycles: (row.review_cycles as number) || 0,
    };
  }

  private broadcast(event: PhilEvent): void {
    const msg = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* client disconnected */ }
    }
    // Persist significant events (not agent_log — those go to appendLog)
    if (event.type !== "agent_log") {
      try {
        this.ctx.storage.sql.exec(
          `INSERT INTO events (task_id, type, data, created_at) VALUES (?, ?, ?, ?)`,
          event.taskId || "",
          event.type,
          JSON.stringify(event.data ?? {}),
          event.timestamp,
        );
      } catch { /* schema may not exist yet during init */ }
    }
  }
}
