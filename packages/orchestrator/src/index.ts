import { Hono } from "hono";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import { getSandbox, proxyToSandbox } from "@cloudflare/sandbox";
export { Sandbox } from "@cloudflare/sandbox";
import {
  CreateProjectSchema,
  UpdateProjectSchema,
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
    autonomyLevel: "supervised",
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

app.put("/v1/projects/:id", async (c) => {
  const body = await c.req.json();
  const parsed = UpdateProjectSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const coordinator = getCoordinator(c.env);
  const updated = await doRpc<Project | null>(coordinator, "updateProject", c.req.param("id"), parsed.data);
  if (!updated) return c.json({ error: "Project not found" }, 404);
  return c.json(updated);
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

  const isBacklog = parsed.data.backlog === true;
  const now = new Date().toISOString();
  const task: Task = {
    id: nanoid(),
    projectId: project.id,
    repoUrl: project.repoUrl,
    description: parsed.data.description,
    status: isBacklog ? "backlog" : "queued",
    branchName: `phil/${nanoid(8)}`,
    subtasks: [],
    touchSet: [],
    dependsOn: parsed.data.dependsOn ?? [],
    createdAt: now,
    updatedAt: now,
  };

  await doRpc(coordinator, "createTask", task);

  if (!isBacklog) {
    // Enqueue task for execution in DO alarm (gets 15min wall-clock time)
    await doRpc(coordinator, "enqueueTask", task.id);
  }

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

app.get("/v1/tasks/:id/events", async (c) => {
  const coordinator = getCoordinator(c.env);
  const events = await doRpc<Array<{ type: string; data: string; timestamp: string }>>(
    coordinator, "getEvents", c.req.param("id"),
  );
  return c.json(events);
});

app.get("/v1/tasks/:id/context", async (c) => {
  const coordinator = getCoordinator(c.env);
  const context = await doRpc<string | null>(coordinator, "getContext", c.req.param("id"));
  if (!context) return c.json({ context: null });
  return c.json({ context: JSON.parse(context) });
});

app.delete("/v1/tasks/:id", async (c) => {
  const taskId = c.req.param("id");
  const coordinator = getCoordinator(c.env);
  const task = await doRpc<Task | null>(coordinator, "getTask", taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);

  await doRpc(coordinator, "cancelTask", taskId);

  return c.json({ ok: true });
});

// Retrigger the DO alarm (picks up orphaned tasks)
app.post("/v1/tasks/retrigger", async (c) => {
  const coordinator = getCoordinator(c.env);
  await doRpc(coordinator, "triggerAlarm");
  return c.json({ ok: true });
});

// Cleanup stale tasks — destroy sandboxes for tasks stuck in non-terminal states
app.post("/v1/tasks/cleanup", async (c) => {
  const coordinator = getCoordinator(c.env);
  const allTasks = await doRpc<Task[]>(coordinator, "listTasks");
  const staleStatuses = ["planning", "running", "queued"];
  const terminalStatuses = ["success", "failed", "cancelled", "closed"];
  const staleThreshold = 30 * 60 * 1000; // 30 minutes
  const now = Date.now();
  const cleaned: string[] = [];

  for (const task of allTasks) {
    const age = now - new Date(task.updatedAt).getTime();
    const isStale = staleStatuses.includes(task.status) && age > staleThreshold;
    const isTerminal = terminalStatuses.includes(task.status);

    if (isStale || isTerminal) {
      try {
        if (isStale) {
          await doRpc(coordinator, "updateTask", task.id, {
            status: "failed",
            error: "Cleaned up: task was stale",
          });
        }
        // Clear preview URL on terminal tasks
        if (isTerminal && task.previewUrl) {
          await doRpc(coordinator, "updateTask", task.id, { previewUrl: null });
        }
        await new SandboxManager(c.env).destroy(task.id).catch(() => {});
        cleaned.push(task.id);
      } catch { /* best effort */ }
    }
  }

  return c.json({ cleaned: cleaned.length, taskIds: cleaned });
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

// Force-retry: unstick a task stuck in "fixing" by resetting to "reviewing"
app.post("/v1/tasks/:id/retry", async (c) => {
  const taskId = c.req.param("id");
  const coordinator = getCoordinator(c.env);
  await doRpc(coordinator, "updateTask", taskId, { status: "reviewing" });
  // Re-trigger alarm to pick up any queued review fixes
  await doRpc(coordinator, "enqueueReviewFix", taskId);
  return c.json({ ok: true });
});

app.post("/v1/tasks/:id/resolve", async (c) => {
  const taskId = c.req.param("id");
  const coordinator = getCoordinator(c.env);
  await doRpc(coordinator, "resolveTask", taskId);
  return c.json({ ok: true });
});

// --- Start backlog task ---

app.post("/v1/tasks/:id/start", async (c) => {
  const taskId = c.req.param("id");
  const coordinator = getCoordinator(c.env);
  const task = await doRpc<Task | null>(coordinator, "getTask", taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);
  if (task.status !== "backlog") return c.json({ error: `Task is ${task.status}, not in backlog` }, 400);

  await doRpc(coordinator, "updateTask", taskId, { status: "queued" });
  await doRpc(coordinator, "enqueueTask", taskId);
  return c.json({ ok: true });
});

// --- Admin: unstick a task (force transition to reviewing if it has a PR) ---
app.post("/v1/tasks/:id/unstick", async (c) => {
  const taskId = c.req.param("id");
  const coordinator = getCoordinator(c.env);
  const task = await doRpc<Task | null>(coordinator, "getTask", taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);
  if (task.status !== "running") return c.json({ error: `Task is ${task.status}, not running` }, 400);

  // Remove from running list first
  await doRpc(coordinator, "removeFromRunning", taskId);

  if (task.prUrl) {
    await doRpc(coordinator, "updateTask", taskId, { status: "reviewing" });
    return c.json({ ok: true, status: "reviewing" });
  } else {
    await doRpc(coordinator, "cancelTask", taskId);
    return c.json({ ok: true, status: "cancelled" });
  }
});

// --- Plan Approval ---

app.post("/v1/tasks/:id/plan/approve", async (c) => {
  const taskId = c.req.param("id");
  const coordinator = getCoordinator(c.env);
  const task = await doRpc<Task | null>(coordinator, "getTask", taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);
  if (task.status !== "planned") return c.json({ error: `Task is ${task.status}, not planned` }, 400);

  await doRpc(coordinator, "approvePlan", taskId);
  return c.json({ ok: true });
});

app.post("/v1/tasks/:id/plan/feedback", async (c) => {
  const taskId = c.req.param("id");
  const body = await c.req.json() as { feedback: string };
  if (!body.feedback?.trim()) return c.json({ error: "Feedback is required" }, 400);

  const coordinator = getCoordinator(c.env);
  const task = await doRpc<Task | null>(coordinator, "getTask", taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);
  if (task.status !== "planned") return c.json({ error: `Task is ${task.status}, not planned` }, 400);

  // revisePlan runs in the DO context (alarm) for wall-clock time
  c.executionCtx.waitUntil(doRpc(coordinator, "revisePlan", taskId, body.feedback));
  return c.json({ ok: true, message: "Revising plan..." });
});

// --- Merge PR ---

app.post("/v1/tasks/:id/merge", async (c) => {
  const taskId = c.req.param("id");
  const coordinator = getCoordinator(c.env);
  const task = await doRpc<Task | null>(coordinator, "getTask", taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);
  if (!task.prUrl) return c.json({ error: "No PR associated with this task" }, 400);

  // Extract owner/repo and PR number from prUrl
  const match = task.prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return c.json({ error: "Could not parse PR URL" }, 400);
  const [, owner, repo, prNum] = match;

  // Get GitHub token
  const settings = await doRpc<{ githubToken?: string }>(coordinator, "getSettings");
  const token = settings.githubToken || c.env.GITHUB_TOKEN;
  if (!token) return c.json({ error: "GitHub token not configured" }, 500);

  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "phil-orchestrator",
  };

  // Wait for GitHub to compute mergeability (can take several seconds)
  for (let i = 0; i < 10; i++) {
    const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}`, { headers: ghHeaders });
    if (prRes.ok) {
      const pr = await prRes.json() as { mergeable: boolean | null; mergeable_state: string; state: string };
      if (pr.state !== "open") return c.json({ error: "PR is not open" }, 400);
      if (pr.mergeable === true) break;
      if (pr.mergeable === false) return c.json({ error: "PR has merge conflicts — resolve them first" }, 409);
      // mergeable === null means GitHub is still computing — wait and retry
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Merge via GitHub API
  const mergeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}/merge`, {
    method: "PUT",
    headers: ghHeaders,
    body: JSON.stringify({ merge_method: "squash" }),
  });

  if (!mergeRes.ok) {
    const err = await mergeRes.text();
    return c.json({ error: `GitHub merge failed: ${err}` }, 500);
  }

  // Resolve the task (destroys sandbox, sets status to success)
  await doRpc(coordinator, "resolveTask", taskId);
  return c.json({ ok: true, merged: true });
});

// --- Close PR without merging ---

app.post("/v1/tasks/:id/close", async (c) => {
  const taskId = c.req.param("id");
  const coordinator = getCoordinator(c.env);
  const task = await doRpc<Task | null>(coordinator, "getTask", taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);

  // Close the PR on GitHub if one exists
  if (task.prUrl) {
    const match = task.prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (match) {
      const [, owner, repo, prNum] = match;
      const settings = await doRpc<{ githubToken?: string }>(coordinator, "getSettings");
      const token = settings.githubToken || c.env.GITHUB_TOKEN;
      if (token) {
        await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "phil-orchestrator",
          },
          body: JSON.stringify({ state: "closed" }),
        });
      }
    }
  }

  // Set status to closed (distinct from success/done) and destroy sandbox
  await doRpc(coordinator, "closeTask", taskId);
  return c.json({ ok: true, closed: true });
});

// --- Preview (start dev server + proxy) ---

app.post("/v1/tasks/:id/preview", async (c) => {
  const taskId = c.req.param("id");
  const coordinator = getCoordinator(c.env);
  const task = await doRpc<Task | null>(coordinator, "getTask", taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);

  const body = await c.req.json();
  const port = body.port as number;
  if (!port) return c.json({ error: "port is required" }, 400);

  // Store the preview port — the preview proxy will use it
  const previewUrl = `${new URL(c.req.url).origin}/preview/${taskId}/`;
  await doRpc(coordinator, "updateTask", taskId, { previewUrl });
  // Store port for proxy routing
  await doRpc(coordinator, "setPreviewPort", taskId, port);

  return c.json({ ok: true, previewUrl });
});

// Preview URL generator — calls sandbox.exposePort() and returns the real URL
app.post("/v1/tasks/:id/expose", async (c) => {
  const taskId = c.req.param("id");
  const coordinator = getCoordinator(c.env);
  const task = await doRpc<Task | null>(coordinator, "getTask", taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);

  const port = 8080;
  const sandboxId = `task-${taskId}`.toLowerCase();
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);
  const hostname = c.env.PREVIEW_HOSTNAME ?? new URL(c.env.WORKER_URL ?? c.req.url).hostname;

  try {
    // Recover workspace if sandbox was recycled
    const wsCheck = await sandbox.exec("ls /workspace/.git 2>/dev/null && echo 'ok' || echo 'empty'");
    if (wsCheck.stdout.trim() === "empty") {
      const token = c.env.GITHUB_TOKEN ?? "";
      const authedUrl = task.repoUrl.replace("https://", `https://x-access-token:${token}@`);
      await sandbox.exec(`git clone ${authedUrl} /workspace 2>&1`);
      if (task.branchName) {
        await sandbox.exec(`cd /workspace && git checkout ${task.branchName} 2>&1`, { cwd: "/workspace" });
      }
      await sandbox.exec("cd /workspace && npm install --no-audit --no-fund 2>&1", { cwd: "/workspace" });
    }

    // Start server if not running
    const serverCheck = await sandbox.exec("curl -sf http://localhost:8080 -o /dev/null && echo 'LISTENING' || echo 'CLOSED'");
    if (!serverCheck.stdout.includes("LISTENING")) {
      const pkgCheck = await sandbox.exec("cat /workspace/package.json 2>/dev/null || true");
      if (pkgCheck.stdout.includes("{")) {
        const startCmd = pkgCheck.stdout.includes('"dev"')
          ? "npm run dev -- --port 8080 --host 0.0.0.0"
          : pkgCheck.stdout.includes('"start"')
            ? "PORT=8080 npm start"
            : "npx -y serve /workspace -l 8080";
        await sandbox.exec(
          `bash -c 'cd /workspace && ${startCmd} > /tmp/dev-server.log 2>&1 &'`,
          { env: { PORT: "8080", HOME: "/root" } },
        );
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    // Unexpose first if already exposed (token may be stale)
    try { await sandbox.unexposePort(port); } catch { /* not exposed */ }

    const exposed = await sandbox.exposePort(port, { hostname });
    await doRpc(coordinator, "updateTask", taskId, { previewUrl: exposed.url });
    return c.json({ ok: true, previewUrl: exposed.url });
  } catch (err) {
    return c.json({ error: `Failed to expose port: ${err}` }, 500);
  }
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
