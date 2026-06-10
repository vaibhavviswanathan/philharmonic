/**
 * Thin fetch wrapper. The Worker is same-origin, so no base URL is needed.
 * REST surface described in SPEC §8; this file holds typed helpers.
 *
 * Domain DTO types come from @philharmonic/shared (single source of truth);
 * only web-only view/response shapes are declared locally.
 */

import type {
  ApiError,
  ArtifactDto,
  ArtifactKind,
  EventDto,
  EventType,
  ProjectDto,
  RunDto,
  RunStatus,
  TaskDetailResponse,
  TaskDto,
  TaskStatus,
} from '@philharmonic/shared';

export type {
  ApiError,
  ArtifactDto,
  ArtifactKind,
  EventDto,
  EventType,
  ProjectDto,
  RunDto,
  RunStatus,
  TaskDetailResponse,
  TaskDto,
  TaskStatus,
};

/** Web-only: /api/me has no shared DTO (the SPA is its only consumer). */
export type MeResponse =
  | { setupRequired: true; hint: string }
  | { setupRequired?: false; email: string; displayName: string };

/**
 * Typed request failure. `code` is the API's structured error code when the
 * body was parseable JSON, otherwise `http_<status>` with the raw body text
 * as the message (SPEC §9.3 — never throw a raw SyntaxError on HTML edge pages).
 */
export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
  }
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
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null; // non-JSON body (HTML edge page, plain text, …)
    }
  }
  if (!res.ok) {
    const err = body as ApiError | null;
    if (err && typeof err.error?.message === 'string') {
      throw new ApiRequestError(
        err.error.code || `http_${res.status}`,
        err.error.message,
        res.status,
      );
    }
    throw new ApiRequestError(
      `http_${res.status}`,
      text.trim() || `Request failed (${res.status})`,
      res.status,
    );
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
  getTask: (id: string) => request<TaskDetailResponse>(`/api/tasks/${id}`),
  addDependency: (id: string, blockedBy: string) =>
    request<{ ok: true }>(`/api/tasks/${id}/dependencies`, json({ blockedBy })),
  removeDependency: (id: string, blockerId: string) =>
    request<{ ok: true }>(`/api/tasks/${id}/dependencies/${blockerId}`, {
      method: 'DELETE',
    }),
  transitionTask: (id: string, to: TaskStatus) =>
    request<{ task: TaskDto }>(`/api/tasks/${id}/transition`, json({ to })),
  postComment: (id: string, body: string) =>
    request<{ event: EventDto }>(`/api/tasks/${id}/comments`, json({ body })),
  listEvents: (id: string) => request<{ events: EventDto[] }>(`/api/tasks/${id}/events`),
  listRuns: (id: string) => request<{ runs: RunDto[] }>(`/api/tasks/${id}/runs`),

  getRun: (id: string) => request<{ run: RunDto; artifacts: ArtifactDto[] }>(`/api/runs/${id}`),
  cancelRun: (id: string) => request<{ ok: true }>(`/api/runs/${id}/cancel`, json({})),
  artifactUrl: (runId: string, artifactId: string) => `/api/runs/${runId}/artifacts/${artifactId}`,
};
