const API_BASE = import.meta.env.VITE_API_URL ?? "/v1";
const WS_BASE = import.meta.env.VITE_WS_URL ??
  `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/v1`;

export interface Task {
  id: string;
  repoUrl: string;
  description: string;
  status: string;
  branchName: string;
  subtasks: Subtask[];
  touchSet: string[];
  prUrl?: string;
  prNumber?: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface Subtask {
  id: string;
  description: string;
  status: string;
  dependencies: string[];
  fileTargets: string[];
}

export interface PhilEvent {
  type: string;
  taskId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export async function createTask(repoUrl: string, description: string): Promise<Task> {
  const res = await fetch(`${API_BASE}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl, description }),
  });
  if (!res.ok) throw new Error(`Failed to create task: ${res.statusText}`);
  return res.json();
}

export async function listTasks(): Promise<Task[]> {
  const res = await fetch(`${API_BASE}/tasks`);
  if (!res.ok) throw new Error(`Failed to list tasks: ${res.statusText}`);
  return res.json();
}

export async function getTask(id: string): Promise<Task> {
  const res = await fetch(`${API_BASE}/tasks/${id}`);
  if (!res.ok) throw new Error(`Failed to get task: ${res.statusText}`);
  return res.json();
}

export async function cancelTask(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/tasks/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to cancel task: ${res.statusText}`);
}

/**
 * Subscribe to real-time events via WebSocket (connects to Durable Object).
 * Receives all task events — filter client-side by taskId if needed.
 */
export function subscribeToEvents(
  onEvent: (event: PhilEvent) => void,
): () => void {
  const ws = new WebSocket(`${WS_BASE}/ws`);

  ws.onmessage = (e) => {
    try {
      const event: PhilEvent = JSON.parse(e.data);
      onEvent(event);
    } catch {
      // ignore malformed messages
    }
  };

  ws.onerror = () => {};

  ws.onclose = () => {
    // Auto-reconnect after 3s
    setTimeout(() => {
      subscribeToEvents(onEvent);
    }, 3000);
  };

  return () => ws.close();
}
