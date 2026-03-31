export type TaskStatus =
  | "backlog"
  | "queued"
  | "planning"
  | "planned"
  | "blocked"
  | "running"
  | "reviewing"
  | "fixing"
  | "success"
  | "failed"
  | "cancelled"
  | "closed";

export type AutonomyLevel = "full" | "high" | "moderate" | "supervised";

export type SubtaskStatus = "pending" | "running" | "success" | "failed";

export interface Subtask {
  id: string;
  description: string;
  status: SubtaskStatus;
  dependencies: string[];
  fileTargets: string[];
  output?: string;
  error?: string;
}

export interface Task {
  id: string;
  projectId: string;
  repoUrl: string;
  description: string;
  status: TaskStatus;
  branchName: string;
  subtasks: Subtask[];
  touchSet: string[];
  /** Human-readable execution plan (markdown) — shown for review in "planned" state */
  planMarkdown?: string;
  prUrl?: string;
  prNumber?: number;
  previewUrl?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  /** ID of the task blocking this one (touch-set conflict) */
  blockedBy?: string;
  /** Explicit task dependency IDs — task won't dispatch until all are "success" */
  dependsOn?: string[];
  /** Number of review iterations completed */
  reviewCycles?: number;
}

export interface ReviewComment {
  id: string;
  taskId: string;
  prNumber: number;
  author: string;
  body: string;
  path?: string;
  line?: number;
  createdAt: string;
}

export interface EscalationMessage {
  id: string;
  taskId: string;
  from: "agent" | "user";
  message: string;
  createdAt: string;
}
