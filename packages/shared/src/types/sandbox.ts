export type SandboxState = "cold" | "warm" | "active" | "idle-watching" | "draining";

export interface Sandbox {
  id: string;
  taskId: string;
  containerId: string;
  state: SandboxState;
  repoPath: string;
  branchName: string;
  createdAt: string;
}
