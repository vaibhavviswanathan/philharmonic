import type { Subtask } from "./task.js";

export interface RepoContext {
  repoUrl: string;
  defaultBranch: string;
  projectType: string;
  testFramework?: string;
  packageManager?: string;
  structure: string[];
}

export interface DispatchPayload {
  taskId: string;
  branchName: string;
  repoContext: RepoContext;
  subtasks: Subtask[];
  touchSet: string[];
  callbackUrl: string;
}
