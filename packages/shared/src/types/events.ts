export type EventType =
  | "task_created"
  | "task_status_changed"
  | "subtask_status_changed"
  | "sandbox_started"
  | "sandbox_stopped"
  | "agent_log"
  | "pr_opened"
  | "project_created"
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
