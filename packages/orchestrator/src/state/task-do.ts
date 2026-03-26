import { DurableObject } from "cloudflare:workers";
import type { Task, TaskStatus, Subtask, Project, PhilEvent } from "@phil/shared";
import type { Env } from "../env.js";

export class TaskCoordinator extends DurableObject<Env> {
  // --- SQL Schema ---

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        default_branch TEXT,
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
        pr_url TEXT,
        pr_number INTEGER,
        error TEXT,
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
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        sandbox_id TEXT,
        message TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Migrate existing tasks table: add project_id if missing
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE tasks ADD COLUMN project_id TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ensureSchema();
  }

  // --- Settings ---

  async getSettings(): Promise<{ anthropicApiKey?: string; githubToken?: string }> {
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
    this.ctx.storage.sql.exec(
      `INSERT INTO projects (id, name, repo_url, default_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      project.id, project.name, project.repoUrl, project.defaultBranch ?? null,
      project.createdAt, project.updatedAt,
    );
    this.broadcast({ type: "project_created", taskId: "", timestamp: project.createdAt, data: { project } });
    return project;
  }

  async getProject(id: string): Promise<Project | null> {
    const row = this.ctx.storage.sql.exec(
      `SELECT * FROM projects WHERE id = ?`, id
    ).one();
    if (!row) return null;
    return this.rowToProject(row);
  }

  async listProjects(): Promise<Project[]> {
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
    this.ctx.storage.sql.exec(
      `INSERT INTO tasks (id, project_id, repo_url, description, status, branch_name, touch_set, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id,
      task.projectId,
      task.repoUrl,
      task.description,
      task.status,
      task.branchName,
      JSON.stringify(task.touchSet),
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
    const row = this.ctx.storage.sql.exec(
      `SELECT * FROM tasks WHERE id = ?`, id
    ).one();
    if (!row) return null;
    return this.rowToTask(row);
  }

  async listTasks(projectId?: string): Promise<Task[]> {
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

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const now = new Date().toISOString();
    const sets: string[] = [`updated_at = ?`];
    const params: unknown[] = [now];

    if (updates.status !== undefined) { sets.push(`status = ?`); params.push(updates.status); }
    if (updates.branchName !== undefined) { sets.push(`branch_name = ?`); params.push(updates.branchName); }
    if (updates.touchSet !== undefined) { sets.push(`touch_set = ?`); params.push(JSON.stringify(updates.touchSet)); }
    if (updates.prUrl !== undefined) { sets.push(`pr_url = ?`); params.push(updates.prUrl); }
    if (updates.prNumber !== undefined) { sets.push(`pr_number = ?`); params.push(updates.prNumber); }
    if (updates.error !== undefined) { sets.push(`error = ?`); params.push(updates.error); }

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

  // --- Logs ---

  async appendLog(taskId: string, sandboxId: string, message: string, level: string): Promise<void> {
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO logs (task_id, sandbox_id, message, level, timestamp) VALUES (?, ?, ?, ?, ?)`,
      taskId, sandboxId, message, level, timestamp,
    );
    this.broadcast({ type: "agent_log", taskId, timestamp, data: { sandboxId, message, level } });
  }

  async getLogs(taskId: string): Promise<Array<{ message: string; level: string; timestamp: string }>> {
    return this.ctx.storage.sql.exec(
      `SELECT message, level, timestamp FROM logs WHERE task_id = ? ORDER BY id`,
      taskId,
    ).toArray() as Array<{ message: string; level: string; timestamp: string }>;
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
      prUrl: row.pr_url as string | undefined,
      prNumber: row.pr_number as number | undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      error: row.error as string | undefined,
    };
  }

  private broadcast(event: PhilEvent): void {
    const msg = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* client disconnected */ }
    }
  }
}
