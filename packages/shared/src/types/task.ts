export type TaskStatus =
  | "queued"
  | "planning"
  | "running"
  | "success"
  | "failed"
  | "cancelled";

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
}
