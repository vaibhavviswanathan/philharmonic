export type TaskStatus =
  | "queued"
  | "planning"
  | "planned"
  | "blocked"
  | "running"
  | "reviewing"
  | "fixing"
  | "success"
  | "failed"
  | "cancelled";

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
  prUrl?: string;
  prNumber?: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  /** ID of the task blocking this one (touch-set conflict) */
  blockedBy?: string;
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
