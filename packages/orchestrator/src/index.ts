import { Hono } from "hono";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import { proxyToSandbox } from "@cloudflare/sandbox";
export { Sandbox } from "@cloudflare/sandbox";
import {
  CreateTaskSchema,
  SandboxStatusUpdateSchema,
  SandboxLogSchema,
  type Task,
} from "@phil/shared";
import type { Env } from "./env.js";
import { TaskCoordinator } from "./state/task-do.js";
import { planTask } from "./planner/planner.js";
import { SandboxManager } from "./sandbox/manager.js";

export { TaskCoordinator };

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors());

// --- Helpers ---

function getCoordinator(env: Env): DurableObjectStub {
  const id = env.TASK_COORDINATOR.idFromName("global");
  return env.TASK_COORDINATOR.get(id);
}

// Type-safe RPC calls to the DO
async function doRpc<T>(stub: DurableObjectStub, method: string, ...args: unknown[]): Promise<T> {
  return (stub as unknown as Record<string, (...a: unknown[]) => Promise<T>>)[method](...args);
}

// --- Public API ---

app.post("/v1/tasks", async (c) => {
  const body = await c.req.json();
  const parsed = CreateTaskSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const now = new Date().toISOString();
  const task: Task = {
    id: nanoid(),
    repoUrl: parsed.data.repoUrl,
    description: parsed.data.description,
    status: "queued",
    branchName: `phil/${nanoid(8)}`,
    subtasks: [],
    touchSet: [],
    createdAt: now,
    updatedAt: now,
  };

  const coordinator = getCoordinator(c.env);
  await doRpc(coordinator, "createTask", task);

  // Run planning + execution asynchronously
  c.executionCtx.waitUntil(runTask(task, c.env));

  return c.json(task, 201);
});

app.get("/v1/tasks/:id", async (c) => {
  const coordinator = getCoordinator(c.env);
  const task = await doRpc<Task | null>(coordinator, "getTask", c.req.param("id"));
  if (!task) return c.json({ error: "Task not found" }, 404);
  return c.json(task);
});

app.get("/v1/tasks", async (c) => {
  const coordinator = getCoordinator(c.env);
  const tasks = await doRpc<Task[]>(coordinator, "listTasks");
  return c.json(tasks);
});

app.delete("/v1/tasks/:id", async (c) => {
  const taskId = c.req.param("id");
  const coordinator = getCoordinator(c.env);
  const task = await doRpc<Task | null>(coordinator, "getTask", taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);

  await doRpc(coordinator, "updateTask", taskId, { status: "cancelled" });

  // Destroy sandbox if running
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
      // Tear down sandbox
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

app.get("/health", (c) => c.json({ status: "ok" }));

// --- Task execution pipeline ---

async function runTask(task: Task, env: Env): Promise<void> {
  const coordinator = getCoordinator(env);

  try {
    // Phase 1: Planning
    await doRpc(coordinator, "updateTask", task.id, { status: "planning" });
    await doRpc(coordinator, "appendLog", task.id, "", "Starting planning phase...", "info");

    const payload = await planTask(task.id, task.repoUrl, task.description, env);

    // Update task with plan results
    await doRpc(coordinator, "updateTask", task.id, {
      status: "running",
      branchName: payload.branchName,
      subtasks: payload.subtasks,
      touchSet: payload.touchSet,
    });
    await doRpc(coordinator, "appendLog", task.id, "", `Plan created: ${payload.subtasks.length} subtasks`, "info");

    // Phase 2: Execute in sandbox (repo already cloned during planning)
    const sandboxManager = new SandboxManager(env);
    const { sandbox } = await sandboxManager.create(payload);

    await sandboxManager.runAgent(sandbox, payload, async (msg) => {
      await doRpc(coordinator, "appendLog", task.id, `task-${task.id}`, msg, "info");
    });
  } catch (err) {
    console.error(`Task ${task.id} failed:`, err);
    await doRpc(coordinator, "updateTask", task.id, {
      status: "failed",
      error: String(err),
    });
    await doRpc(coordinator, "appendLog", task.id, "", `Task failed: ${err}`, "error");
  }
}

// --- Worker export ---

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CRITICAL: proxyToSandbox must be called first for preview URLs
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    return app.fetch(request, env, ctx);
  },
};
