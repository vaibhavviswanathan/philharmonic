import { Hono } from "hono";
import { nanoid } from "nanoid";
import type { Task } from "@phil/shared";
import type { Env } from "../env.js";

const tasks = new Hono<{ Bindings: Env }>();

function getCoordinator(env: Env): DurableObjectStub {
  const id = env.TASK_COORDINATOR.idFromName("global");
  return env.TASK_COORDINATOR.get(id);
}

async function doRpc<T>(stub: DurableObjectStub, method: string, ...args: unknown[]): Promise<T> {
  return (stub as unknown as Record<string, (...a: unknown[]) => Promise<T>>)[method](...args);
}

// POST /v1/tasks/:id/rebase
// Creates a new rebase task that prompts Phil to rebase the original task's branch onto main
tasks.post("/:id/rebase", async (c) => {
  const taskId = c.req.param("id");
  const coordinator = getCoordinator(c.env);
  const originalTask = await doRpc<Task | null>(coordinator, "getTask", taskId);
  if (!originalTask) return c.json({ error: "Task not found" }, 404);

  const now = new Date().toISOString();
  const rebaseTask: Task = {
    id: nanoid(),
    projectId: originalTask.projectId,
    repoUrl: originalTask.repoUrl,
    description: `Rebase \`${originalTask.branchName}\` onto the latest main branch to resolve conflicts and unblock task ${taskId}.`,
    status: "queued",
    branchName: originalTask.branchName,
    subtasks: [],
    touchSet: [],
    taskType: "rebase",
    dependsOn: [],
    createdAt: now,
    updatedAt: now,
  };

  await doRpc(coordinator, "createTask", rebaseTask);
  await doRpc(coordinator, "enqueueTask", rebaseTask.id);

  return c.json(rebaseTask, 201);
});

export default tasks;
