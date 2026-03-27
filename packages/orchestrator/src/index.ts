import { Hono } from "hono";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import { proxyToSandbox } from "@cloudflare/sandbox";
export { Sandbox } from "@cloudflare/sandbox";
import {
  CreateProjectSchema,
  CreateTaskSchema,
  UpdateSettingsSchema,
  SandboxStatusUpdateSchema,
  SandboxLogSchema,
  type Task,
  type Project,
} from "@phil/shared";
import type { Env } from "./env.js";
import { TaskCoordinator } from "./state/task-do.js";
import { SandboxManager } from "./sandbox/manager.js";

export { TaskCoordinator };

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors());

// --- Helpers ---

function getCoordinator(env: Env): DurableObjectStub {
  const id = env.TASK_COORDINATOR.idFromName("global");
  return env.TASK_COORDINATOR.get(id);
}

async function doRpc<T>(stub: DurableObjectStub, method: string, ...args: unknown[]): Promise<T> {
  return (stub as unknown as Record<string, (...a: unknown[]) => Promise<T>>)[method](...args);
}

// --- Settings API ---

app.get("/v1/settings", async (c) => {
  const coordinator = getCoordinator(c.env);
  const settings = await doRpc<{ anthropicApiKey?: string; githubToken?: string }>(coordinator, "getSettings");
  // Return masked values so the UI knows which are set
  return c.json({
    anthropicApiKey: settings.anthropicApiKey ? "sk-...configured" : "",
    githubToken: settings.githubToken ? "ghp_...configured" : "",
    // Also indicate if env vars are set
    envAnthropicApiKey: c.env.ANTHROPIC_API_KEY ? true : false,
    envGithubToken: c.env.GITHUB_TOKEN ? true : false,
  });
});

app.put("/v1/settings", async (c) => {
  const body = await c.req.json();
  const parsed = UpdateSettingsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const coordinator = getCoordinator(c.env);
  await doRpc(coordinator, "updateSettings", parsed.data);
  return c.json({ ok: true });
});

// --- Projects API ---

app.post("/v1/projects", async (c) => {
  const body = await c.req.json();
  const parsed = CreateProjectSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const now = new Date().toISOString();
  const project: Project = {
    id: nanoid(),
    name: parsed.data.name,
    repoUrl: parsed.data.repoUrl,
    createdAt: now,
    updatedAt: now,
  };

  const coordinator = getCoordinator(c.env);
  await doRpc(coordinator, "createProject", project);
  return c.json(project, 201);
});

app.get("/v1/projects", async (c) => {
  const coordinator = getCoordinator(c.env);
  const projects = await doRpc<Project[]>(coordinator, "listProjects");
  return c.json(projects);
});

app.get("/v1/projects/:id", async (c) => {
  const coordinator = getCoordinator(c.env);
  const project = await doRpc<Project | null>(coordinator, "getProject", c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  return c.json(project);
});

app.delete("/v1/projects/:id", async (c) => {
  const coordinator = getCoordinator(c.env);
  const project = await doRpc<Project | null>(coordinator, "getProject", c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  await doRpc(coordinator, "deleteProject", c.req.param("id"));
  return c.json({ ok: true });
});

// --- Tasks API ---

app.post("/v1/tasks", async (c) => {
  const body = await c.req.json();
  const parsed = CreateTaskSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const coordinator = getCoordinator(c.env);

  // Resolve project to get repoUrl
  const project = await doRpc<Project | null>(coordinator, "getProject", parsed.data.projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const now = new Date().toISOString();
  const task: Task = {
    id: nanoid(),
    projectId: project.id,
    repoUrl: project.repoUrl,
    description: parsed.data.description,
    status: "queued",
    branchName: `phil/${nanoid(8)}`,
    subtasks: [],
    touchSet: [],
    createdAt: now,
    updatedAt: now,
  };

  await doRpc(coordinator, "createTask", task);

  // Enqueue task for execution in DO alarm (gets 15min wall-clock time)
  await doRpc(coordinator, "enqueueTask", task.id);

  return c.json(task, 201);
});

app.get("/v1/tasks", async (c) => {
  const projectId = c.req.query("projectId");
  const coordinator = getCoordinator(c.env);
  const tasks = await doRpc<Task[]>(coordinator, "listTasks", projectId);
  return c.json(tasks);
});

app.get("/v1/tasks/:id", async (c) => {
  const coordinator = getCoordinator(c.env);
  const task = await doRpc<Task | null>(coordinator, "getTask", c.req.param("id"));
  if (!task) return c.json({ error: "Task not found" }, 404);
  return c.json(task);
});

app.get("/v1/tasks/:id/logs", async (c) => {
  const coordinator = getCoordinator(c.env);
  const logs = await doRpc<Array<{ message: string; level: string; timestamp: string }>>(
    coordinator, "getLogs", c.req.param("id"),
  );
  return c.json(logs);
});

app.delete("/v1/tasks/:id", async (c) => {
  const taskId = c.req.param("id");
  const coordinator = getCoordinator(c.env);
  const task = await doRpc<Task | null>(coordinator, "getTask", taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);

  await doRpc(coordinator, "updateTask", taskId, { status: "cancelled" });

  c.executionCtx.waitUntil(
    new SandboxManager(c.env).destroy(taskId).catch(() => {}),
  );

  return c.json({ ok: true });
});

// WebSocket upgrade for live log streaming
app.get("/v1/ws", async (c) => {
  const coordinator = getCoordinator(c.env);
  return coordinator.fetch(c.req.raw);
});

// --- Internal API (called by sandbox agent) ---

app.post("/internal/sandboxes/:taskId/status", async (c) => {
  const body = await c.req.json();
  const parsed = SandboxStatusUpdateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const taskId = c.req.param("taskId");
  const update = parsed.data;
  const coordinator = getCoordinator(c.env);

  switch (update.status) {
    case "completed":
      await doRpc(coordinator, "updateTask", taskId, {
        status: "success",
        prUrl: update.prUrl,
        prNumber: update.prNumber,
      });
      c.executionCtx.waitUntil(
        new SandboxManager(c.env).destroy(taskId).catch(() => {}),
      );
      break;
    case "failed":
      await doRpc(coordinator, "updateTask", taskId, {
        status: "failed",
        error: update.error,
      });
      c.executionCtx.waitUntil(
        new SandboxManager(c.env).destroy(taskId).catch(() => {}),
      );
      break;
    case "subtask_started":
    case "subtask_completed":
    case "subtask_failed": {
      const task = await doRpc<Task | null>(coordinator, "getTask", taskId);
      if (task && update.subtaskId) {
        const subtasks = task.subtasks.map((s) =>
          s.id === update.subtaskId
            ? {
                ...s,
                status: update.status === "subtask_started"
                  ? "running" as const
                  : update.status === "subtask_completed"
                    ? "success" as const
                    : "failed" as const,
                error: update.error,
              }
            : s,
        );
        await doRpc(coordinator, "updateTask", taskId, { subtasks });
      }
      break;
    }
  }

  return c.json({ ok: true });
});

app.post("/internal/sandboxes/:taskId/logs", async (c) => {
  const body = await c.req.json();
  const parsed = SandboxLogSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const taskId = c.req.param("taskId");
  const coordinator = getCoordinator(c.env);
  await doRpc(coordinator, "appendLog", taskId, parsed.data.sandboxId, parsed.data.message, parsed.data.level);

  return c.json({ ok: true });
});

// --- GitHub Webhook (PR merge → rebase running tasks) ---

app.post("/webhooks/github", async (c) => {
  const event = c.req.header("X-GitHub-Event");
  const body = await c.req.json();
  const coordinator = getCoordinator(c.env);

  // --- PR review comments (pull_request_review) ---
  if (event === "pull_request_review" && body.action === "submitted") {
    const review = body.review as Record<string, unknown>;
    const pr = body.pull_request as Record<string, unknown>;
    const reviewBody = (review?.body as string) ?? "";

    // Skip empty reviews or approvals without comments
    if (!reviewBody.trim()) return c.json({ ok: true, skipped: true });

    const branchName = (pr?.head as Record<string, unknown>)?.ref as string ?? "";
    const prNumber = pr?.number as number;
    const repoUrl = (body.repository as Record<string, unknown>)?.html_url as string;

    // Find the task by branch name
    const task = await findTaskByBranch(coordinator, repoUrl, branchName);
    if (!task) return c.json({ ok: true, skipped: true, reason: "no matching task" });

    const commentId = `review-${review?.id}`;
    await doRpc(coordinator, "addReviewComment", task.id, {
      id: commentId,
      prNumber,
      author: (review?.user as Record<string, unknown>)?.login as string ?? "unknown",
      body: reviewBody,
      createdAt: (review?.submitted_at as string) ?? new Date().toISOString(),
    });

    // Queue review fix
    await doRpc(coordinator, "enqueueReviewFix", task.id);
    return c.json({ ok: true, taskId: task.id });
  }

  // --- PR review comments (individual line comments via pull_request_review_comment) ---
  if (event === "pull_request_review_comment" && body.action === "created") {
    const comment = body.comment as Record<string, unknown>;
    const pr = body.pull_request as Record<string, unknown>;
    const branchName = (pr?.head as Record<string, unknown>)?.ref as string ?? "";
    const prNumber = pr?.number as number;
    const repoUrl = (body.repository as Record<string, unknown>)?.html_url as string;

    const task = await findTaskByBranch(coordinator, repoUrl, branchName);
    if (!task) return c.json({ ok: true, skipped: true, reason: "no matching task" });

    const commentId = `comment-${comment?.id}`;
    await doRpc(coordinator, "addReviewComment", task.id, {
      id: commentId,
      prNumber,
      author: (comment?.user as Record<string, unknown>)?.login as string ?? "unknown",
      body: comment?.body as string ?? "",
      path: comment?.path as string,
      line: comment?.line as number ?? comment?.original_line as number,
      createdAt: (comment?.created_at as string) ?? new Date().toISOString(),
    });

    // Queue review fix
    await doRpc(coordinator, "enqueueReviewFix", task.id);
    return c.json({ ok: true, taskId: task.id });
  }

  // --- Issue comments on PRs ---
  if (event === "issue_comment" && body.action === "created") {
    const issue = body.issue as Record<string, unknown>;
    // Only process comments on PRs (issues with pull_request field)
    if (!issue?.pull_request) return c.json({ ok: true, skipped: true });

    const comment = body.comment as Record<string, unknown>;
    const repoUrl = (body.repository as Record<string, unknown>)?.html_url as string;
    const prNumber = issue?.number as number;

    // We need to find the task by PR number
    const task = await findTaskByPrNumber(coordinator, repoUrl, prNumber);
    if (!task) return c.json({ ok: true, skipped: true, reason: "no matching task" });

    // Skip comments from the bot itself
    const author = (comment?.user as Record<string, unknown>)?.login as string ?? "";
    if (author === "phil-agent" || author.includes("[bot]")) return c.json({ ok: true, skipped: true });

    const commentId = `issue-comment-${comment?.id}`;
    await doRpc(coordinator, "addReviewComment", task.id, {
      id: commentId,
      prNumber,
      author,
      body: comment?.body as string ?? "",
      createdAt: (comment?.created_at as string) ?? new Date().toISOString(),
    });

    await doRpc(coordinator, "enqueueReviewFix", task.id);
    return c.json({ ok: true, taskId: task.id });
  }

  // --- PR merged → rebase ---
  if (event === "pull_request") {
    const action = body.action as string;
    const pr = body.pull_request as Record<string, unknown> | undefined;

    if (action === "closed" && pr?.merged) {
      const repoUrl = (body.repository as Record<string, unknown>)?.html_url as string;
      const mergedBranch = (pr?.head as Record<string, unknown>)?.ref as string ?? "";
      const prNumber = pr?.number as number;

      if (!repoUrl) return c.json({ error: "Missing repo URL" }, 400);

      const coordinator2 = getCoordinator(c.env);

      // Also mark the task as success (PR merged = done)
      const task = await findTaskByBranch(coordinator2, repoUrl, mergedBranch);
      if (task && (task.status === "reviewing" || task.status === "fixing")) {
        await doRpc(coordinator2, "resolveTask", task.id);
      }

      const rebased = await doRpc<string[]>(coordinator2, "triggerRebase", repoUrl, mergedBranch, prNumber);
      return c.json({ ok: true, rebasedTasks: rebased });
    }
  }

  return c.json({ ok: true, skipped: true });
});

/** Helper: find a task by its branch name */
async function findTaskByBranch(coordinator: DurableObjectStub, repoUrl: string, branchName: string): Promise<Task | null> {
  const tasks = await doRpc<Task[]>(coordinator, "listTasks");
  return tasks.find((t) => t.repoUrl === repoUrl && t.branchName === branchName) ?? null;
}

/** Helper: find a task by PR number */
async function findTaskByPrNumber(coordinator: DurableObjectStub, repoUrl: string, prNumber: number): Promise<Task | null> {
  const tasks = await doRpc<Task[]>(coordinator, "listTasks");
  return tasks.find((t) => t.repoUrl === repoUrl && t.prNumber === prNumber) ?? null;
}

// --- Escalation API ---

app.post("/v1/tasks/:id/messages", async (c) => {
  const taskId = c.req.param("id");
  const body = await c.req.json();
  const message = body.message as string;
  if (!message) return c.json({ error: "message is required" }, 400);

  const coordinator = getCoordinator(c.env);
  await doRpc(coordinator, "addEscalation", taskId, "user", message);

  // If the task is reviewing, queue a review fix with the user's message
  const task = await doRpc<Task | null>(coordinator, "getTask", taskId);
  if (task && task.status === "reviewing") {
    // Add user message as a review comment so the agent processes it
    await doRpc(coordinator, "addReviewComment", taskId, {
      id: `user-msg-${Date.now()}`,
      prNumber: task.prNumber ?? 0,
      author: "user",
      body: message,
      createdAt: new Date().toISOString(),
    });
    await doRpc(coordinator, "enqueueReviewFix", taskId);
  }

  return c.json({ ok: true });
});

app.get("/v1/tasks/:id/messages", async (c) => {
  const taskId = c.req.param("id");
  const coordinator = getCoordinator(c.env);
  const escalations = await doRpc<Array<{ sender: string; message: string; createdAt: string }>>(
    coordinator, "getEscalations", taskId,
  );
  return c.json(escalations);
});

app.post("/v1/tasks/:id/resolve", async (c) => {
  const taskId = c.req.param("id");
  const coordinator = getCoordinator(c.env);
  await doRpc(coordinator, "resolveTask", taskId);
  return c.json({ ok: true });
});

app.get("/health", (c) => c.json({ status: "ok" }));




// --- Worker export ---

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CRITICAL: proxyToSandbox must be called first for preview URLs
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    return app.fetch(request, env, ctx);
  },
};
