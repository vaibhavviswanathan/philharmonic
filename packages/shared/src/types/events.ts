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
  | "review_received"
  | "review_fix_started"
  | "review_fix_completed"
  | "escalation"
  | "escalation_response"
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

export interface ReviewEvent extends PhilEvent {
  type: "review_received";
  data: {
    prNumber: number;
    author: string;
    body: string;
    path?: string;
    line?: number;
  };
}

export interface EscalationEvent extends PhilEvent {
  type: "escalation" | "escalation_response";
  data: {
    from: "agent" | "user";
    message: string;
  };
}
