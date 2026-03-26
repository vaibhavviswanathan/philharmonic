export type EventType =
  | "task_created"
  | "task_status_changed"
  | "subtask_status_changed"
  | "sandbox_started"
  | "sandbox_stopped"
  | "agent_log"
  | "pr_opened"
  | "pr_merged"
  | "project_created"
  | "conflict_detected"
  | "conflict_resolved"
  | "rebase_required"
  | "error";

export interface PhilEvent {
  type: EventType;
  taskId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface AgentLogEvent extends PhilEvent {
  type: "agent_log";
  data: {
    sandboxId: string;
    message: string;
    level: "info" | "warn" | "error" | "debug";
  };
}

export interface TaskStatusEvent extends PhilEvent {
  type: "task_status_changed";
  data: {
    from: string;
    to: string;
  };
}

export interface ConflictEvent extends PhilEvent {
  type: "conflict_detected" | "conflict_resolved";
  data: {
    blockedTaskId: string;
    blockingTaskId: string;
    overlappingFiles: string[];
  };
}

export interface RebaseEvent extends PhilEvent {
  type: "rebase_required";
  data: {
    targetTaskId: string;
    mergedPrNumber: number;
    mergedBranch: string;
  };
}
