export type ManagerPhase =
  | "booting"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "pr_created"
  | "awaiting_review"
  | "fixing"
  | "done"
  | "error";

export interface ManagerState {
  phase: ManagerPhase;
  waitingForUser: boolean;
  pendingQuestion?: string;
  lastTerminalHash?: string;
  lastCheckAt?: string;
  prUrl?: string;
  previewUrl?: string;
  error?: string;
}
