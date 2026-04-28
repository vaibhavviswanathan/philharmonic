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
  | 'cancelled';

export type EventType =
  | 'comment'
  | 'status_change'
  | 'agent_action'
  | 'proof'
  | 'system';

export type ArtifactKind =
  | 'pr_diff'
  | 'screenshot'
  | 'video'
  | 'logs'
  | 'ci_summary'
  | 'other';

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
  identifier: string; // "PHIL-{number}" — convenience for the agent
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
//   status_change → { from: TaskStatus, to: TaskStatus }
//   agent_action  → { tool: string, summary?: string }
//   proof         → { artifactId: string, kind: ArtifactKind, caption?: string }
//   system        → { message: string }
export interface EventDto {
  id: string;
  taskId: string;
  runId: string | null;
  type: EventType;
  author: string;
  payload: Record<string, unknown>;
  createdAt: number;
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
