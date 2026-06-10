/**
 * REST API request/response DTOs shared between the Worker, the SPA, and the
 * Tasks MCP server. See SPEC §8 for the full surface.
 *
 * The DB schema lives in apps/worker/src/lib/schema.ts; these types should be
 * compatible with `Project`/`Task`/`Run`/`Event`/`Artifact` from there.
 */

export type ApiError = {
  error: {
    code: string;
    message: string;
  };
};

// ─── Domain shapes ───────────────────────────────────────────────────────────

export type TaskStatus =
  | 'backlog'
  | 'blocked'
  | 'ready'
  | 'running'
  | 'review'
  | 'done'
  | 'cancelled';

export type RunStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'landing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'deferred';

export type EventType = 'comment' | 'status_change' | 'agent_action' | 'proof' | 'system';

export type ArtifactKind = 'pr_diff' | 'screenshot' | 'video' | 'logs' | 'ci_summary' | 'other';

export interface ProjectDto {
  id: string;
  name: string;
  slug: string;
  repoUrl: string;
  defaultBranch: string;
  workflowMd: string;
  concurrencyLimit: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskDto {
  id: string;
  projectId: string;
  number: number;
  identifier: string; // "<UPPERCASED-SLUG>-{number}" (e.g. "WEB-12") — convenience for the agent
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  createdBy: string;
  assignee: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunDto {
  id: string;
  taskId: string;
  workflowInstanceId: string | null;
  sandboxId: string;
  status: RunStatus;
  prUrl: string | null;
  errorMessage: string | null;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
}

// `payload` shape is documented per `type`:
//   comment       → { body: string }
//   status_change → { from: TaskStatus, to: TaskStatus, requested?: TaskStatus }
//   agent_action  → { tool: string, summary?: string }
//   proof         → { artifactId: string, kind: ArtifactKind, caption?: string }
//   system        → { message: string, ... } (cascade unblocks add
//                   { resolvedBy: taskId, resolvedStatus: 'done' | 'cancelled' })
export interface EventDto {
  id: string;
  taskId: string;
  runId: string | null;
  type: EventType;
  author: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface ArtifactDto {
  id: string;
  runId: string;
  kind: ArtifactKind;
  r2Key: string;
  mime: string;
  sizeBytes: number;
  caption: string | null;
  createdAt: number;
}

// ─── Response DTOs ───────────────────────────────────────────────────────────

/** GET /api/tasks/:id — task + latest-run summary + dependency edges. */
export interface TaskDetailResponse {
  task: TaskDto;
  latestRun: RunDto | null;
  blockers: TaskDto[];
  blocking: TaskDto[];
}

// ─── Request DTOs ────────────────────────────────────────────────────────────

export interface CreateProjectRequest {
  name: string;
  slug: string;
  repoUrl: string;
  defaultBranch?: string;
  workflowMd?: string;
  concurrencyLimit?: number;
}

export interface UpdateProjectRequest {
  name?: string;
  repoUrl?: string;
  defaultBranch?: string;
  workflowMd?: string;
  concurrencyLimit?: number;
}

export interface CreateTaskRequest {
  title: string;
  description?: string;
  priority?: number;
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  priority?: number;
  assignee?: string | null;
}

export interface TransitionTaskRequest {
  to: TaskStatus;
}

export interface CreateCommentRequest {
  body: string;
}

// ─── Dependency contract ─────────────────────────────────────────────────────

/** POST /api/tasks/:id/dependencies — human-added blocker (SPEC §8.5). */
export interface AddDependencyRequest {
  /** Task id of the blocker. Same project only; duplicate adds are no-ops. */
  blockedBy: string;
}

/**
 * POST /api/internal/dependencies — agent-declared blocker (SPEC §8.5).
 * `blockedBy` is a task identifier ("WEB-4", case-insensitive) or a raw task
 * id, resolved within the run token's project.
 */
export interface DeclareDependencyRequest {
  blockedBy: string;
  reason?: string;
}

export interface DeclareDependencyResponse {
  ok: true;
  /** Resolved task id of the blocker. */
  blockedBy: string;
  /**
   * The named blocker is already done/cancelled: the edge was recorded but
   * the task was NOT blocked and the run was NOT deferred — keep working.
   */
  alreadyResolved?: boolean;
}
