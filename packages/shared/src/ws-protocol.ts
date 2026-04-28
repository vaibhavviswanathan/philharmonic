/**
 * WebSocket protocol shared by the Worker (TasksRoom DO) and the SPA. SPEC §10.2.
 *
 * Default subscription on connect: all task.* and event.* + run.created/updated.
 * `run.log` is opt-in per-run (logs are noisy).
 */

// ─── Domain shapes (mirrored from api-types so the WS protocol is self-contained)

export type TaskStatus =
  | 'backlog'
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

export interface WsTask {
  id: string;
  projectId: string;
  number: number;
  identifier: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  createdBy: string;
  assignee: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WsRun {
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

export interface WsEvent {
  id: string;
  taskId: string;
  runId: string | null;
  type: EventType;
  author: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

// ─── Server → client messages ──────────────────────────────────────────────

export type ServerMessage =
  | { type: 'hello'; projectId: string; serverTime: number }
  | { type: 'task.created'; task: WsTask }
  | { type: 'task.updated'; task: WsTask }
  | { type: 'task.deleted'; taskId: string }
  | { type: 'event.created'; taskId: string; event: WsEvent }
  | { type: 'run.created'; run: WsRun }
  | { type: 'run.updated'; run: WsRun }
  | { type: 'run.log'; runId: string; lines: string[] }
  | { type: 'pong'; t: number };

// ─── Client → server messages ──────────────────────────────────────────────

export type ClientMessage =
  | { type: 'subscribe.run'; runId: string }
  | { type: 'unsubscribe.run'; runId: string }
  | { type: 'ping'; t: number };

export const isServerMessage = (m: unknown): m is ServerMessage =>
  !!m && typeof m === 'object' && typeof (m as { type?: unknown }).type === 'string';
