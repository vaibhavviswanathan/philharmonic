/**
 * Thin fetch wrapper. The Worker is same-origin, so no base URL is needed.
 * REST surface described in SPEC §8; this file holds typed helpers.
 */

export type ApiError = {
  error: {
    code: string;
    message: string;
  };
};

export type MeResponse =
  | { setupRequired: true; hint: string }
  | { setupRequired?: false; email: string; displayName: string };

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

export interface ProjectDto {
  id: string;
  name: string;
  slug: string;
  repoUrl: string;
  defaultBranch: string;
  workflowMd: string;
  concurrencyLimit: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskDto {
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

export interface RunDto {
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

export interface EventDto {
  id: string;
  taskId: string;
  runId: string | null;
  type: EventType;
  author: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    credentials: 'include',
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = body as ApiError | null;
    throw new Error(err?.error?.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
});

const patch = (body: unknown): RequestInit => ({
  method: 'PATCH',
  body: JSON.stringify(body),
});

export const api = {
  me: () => request<MeResponse>('/api/me'),

  listProjects: () => request<{ projects: ProjectDto[] }>('/api/projects'),
  createProject: (body: {
    name: string;
    slug: string;
    repoUrl: string;
    defaultBranch?: string;
  }) => request<{ project: ProjectDto }>('/api/projects', json(body)),
  getProject: (id: string) => request<{ project: ProjectDto }>(`/api/projects/${id}`),
  updateProject: (id: string, body: Partial<ProjectDto>) =>
    request<{ project: ProjectDto }>(`/api/projects/${id}`, patch(body)),

  listTasks: (projectId: string) =>
    request<{ tasks: TaskDto[] }>(`/api/projects/${projectId}/tasks`),
  createTask: (
    projectId: string,
    body: { title: string; description?: string; priority?: number },
  ) => request<{ task: TaskDto }>(`/api/projects/${projectId}/tasks`, json(body)),
  getTask: (id: string) =>
    request<{ task: TaskDto; latestRun: RunDto | null }>(`/api/tasks/${id}`),
  transitionTask: (id: string, to: TaskStatus) =>
    request<{ task: TaskDto }>(`/api/tasks/${id}/transition`, json({ to })),
  postComment: (id: string, body: string) =>
    request<{ event: EventDto }>(`/api/tasks/${id}/comments`, json({ body })),
  listEvents: (id: string) => request<{ events: EventDto[] }>(`/api/tasks/${id}/events`),
  listRuns: (id: string) => request<{ runs: RunDto[] }>(`/api/tasks/${id}/runs`),

  getRun: (id: string) =>
    request<{ run: RunDto; artifacts: unknown[] }>(`/api/runs/${id}`),
  cancelRun: (id: string) => request<{ ok: true }>(`/api/runs/${id}/cancel`, json({})),
};
