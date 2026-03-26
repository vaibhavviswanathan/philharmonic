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
  if (event !== "pull_request") {
    return c.json({ ok: true, skipped: true });
  }

  const body = await c.req.json();
  const action = body.action as string;
  const pr = body.pull_request as Record<string, unknown> | undefined;

  if (action !== "closed" || !pr || !pr.merged) {
    return c.json({ ok: true, skipped: true });
  }

  // A PR was merged — find running tasks on this repo and trigger rebase
  const repoUrl = (body.repository as Record<string, unknown>)?.html_url as string;
  const mergedBranch = pr.head_ref as string ?? (pr.head as Record<string, unknown>)?.ref as string ?? "";
  const prNumber = pr.number as number;

  if (!repoUrl) return c.json({ error: "Missing repo URL" }, 400);

  const coordinator = getCoordinator(c.env);
  const rebased = await doRpc<string[]>(coordinator, "triggerRebase", repoUrl, mergedBranch, prNumber);

  return c.json({ ok: true, rebasedTasks: rebased });
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
