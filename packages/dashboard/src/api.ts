const API_BASE = import.meta.env.VITE_API_URL ?? "/v1";
const WS_BASE = import.meta.env.VITE_WS_URL ??
  `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/v1`;

// --- Types ---

export interface Project {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
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
  blockedBy?: string;
  reviewCycles?: number;
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

export interface Settings {
  anthropicApiKey: string;
  githubToken: string;
  envAnthropicApiKey: boolean;
  envGithubToken: boolean;
}

// --- Settings ---

export async function getSettings(): Promise<Settings> {
  const res = await fetch(`${API_BASE}/settings`);
  if (!res.ok) throw new Error(`Failed to get settings: ${res.statusText}`);
  return res.json();
}

export async function updateSettings(updates: { anthropicApiKey?: string; githubToken?: string }): Promise<void> {
  const res = await fetch(`${API_BASE}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Failed to update settings: ${res.statusText}`);
}

// --- Projects ---

export async function createProject(name: string, repoUrl: string): Promise<Project> {
  const res = await fetch(`${API_BASE}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, repoUrl }),
  });
  if (!res.ok) throw new Error(`Failed to create project: ${res.statusText}`);
  return res.json();
}

export async function listProjects(): Promise<Project[]> {
  const res = await fetch(`${API_BASE}/projects`);
  if (!res.ok) throw new Error(`Failed to list projects: ${res.statusText}`);
  return res.json();
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/projects/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete project: ${res.statusText}`);
}

// --- Tasks ---

export async function createTask(projectId: string, description: string): Promise<Task> {
  const res = await fetch(`${API_BASE}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, description }),
  });
  if (!res.ok) throw new Error(`Failed to create task: ${res.statusText}`);
  return res.json();
}

export async function listTasks(projectId?: string): Promise<Task[]> {
  const url = projectId ? `${API_BASE}/tasks?projectId=${projectId}` : `${API_BASE}/tasks`;
  const res = await fetch(url);
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

export async function resolveTask(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/tasks/${id}/resolve`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to resolve task: ${res.statusText}`);
}

// --- Messages (Escalation / Chat) ---

export interface Message {
  sender: string;
  message: string;
  createdAt: string;
}

export async function getMessages(taskId: string): Promise<Message[]> {
  const res = await fetch(`${API_BASE}/tasks/${taskId}/messages`);
  if (!res.ok) throw new Error(`Failed to get messages: ${res.statusText}`);
  return res.json();
}

export async function sendMessage(taskId: string, message: string): Promise<void> {
  const res = await fetch(`${API_BASE}/tasks/${taskId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Failed to send message: ${res.statusText}`);
}

// --- WebSocket ---

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
    setTimeout(() => {
      subscribeToEvents(onEvent);
    }, 3000);
  };

  return () => ws.close();
}
