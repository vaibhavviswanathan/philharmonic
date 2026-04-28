/**
 * Zustand stores.
 *   - useAuth     — /api/me result
 *   - useProjects — project list, indexed by id and slug
 *   - useBoard    — tasks for a single project, indexed by id (per-project store)
 *
 * Real-time wiring (WebSocket → store dispatch) lands in M3.
 */

import { create } from 'zustand';
import type { ServerMessage } from '@philharmonic/shared';
import { api, type EventDto, type MeResponse, type ProjectDto, type RunDto, type TaskDto, type TaskStatus } from './api';

// ─── Auth ────────────────────────────────────────────────────────────────────

type AuthState =
  | { status: 'loading' }
  | { status: 'setup_required'; hint: string }
  | { status: 'unauthenticated'; message: string }
  | { status: 'authenticated'; email: string; displayName: string };

interface AuthStore {
  auth: AuthState;
  refresh: () => Promise<void>;
}

export const useAuth = create<AuthStore>((set) => ({
  auth: { status: 'loading' },
  refresh: async () => {
    set({ auth: { status: 'loading' } });
    try {
      const res: MeResponse = await api.me();
      if ('setupRequired' in res && res.setupRequired) {
        set({ auth: { status: 'setup_required', hint: res.hint } });
        return;
      }
      set({
        auth: { status: 'authenticated', email: res.email, displayName: res.displayName },
      });
    } catch (err) {
      set({
        auth: {
          status: 'unauthenticated',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  },
}));

// ─── Projects ────────────────────────────────────────────────────────────────

interface ProjectsStore {
  byId: Record<string, ProjectDto>;
  bySlug: Record<string, ProjectDto>;
  loaded: boolean;
  load: () => Promise<void>;
  upsert: (p: ProjectDto) => void;
}

export const useProjects = create<ProjectsStore>((set, get) => ({
  byId: {},
  bySlug: {},
  loaded: false,
  load: async () => {
    const { projects } = await api.listProjects();
    const byId: Record<string, ProjectDto> = {};
    const bySlug: Record<string, ProjectDto> = {};
    for (const p of projects) {
      byId[p.id] = p;
      bySlug[p.slug] = p;
    }
    set({ byId, bySlug, loaded: true });
  },
  upsert: (p: ProjectDto) =>
    set({
      byId: { ...get().byId, [p.id]: p },
      bySlug: { ...get().bySlug, [p.slug]: p },
    }),
}));

// ─── Board (one per project) ────────────────────────────────────────────────

interface BoardStore {
  projectId: string | null;
  tasks: Record<string, TaskDto>;
  runs: Record<string, RunDto>;
  events: Record<string, EventDto[]>; // keyed by taskId
  loaded: boolean;
  load: (projectId: string) => Promise<void>;
  upsertTask: (t: TaskDto) => void;
  removeTask: (id: string) => void;
  upsertRun: (r: RunDto) => void;
  appendEvent: (taskId: string, e: EventDto) => void;
  /** Apply an incoming WebSocket message. */
  applyWsMessage: (m: ServerMessage) => void;
  /** Optimistic transition; rolls back on error. */
  transition: (taskId: string, to: TaskStatus) => Promise<void>;
}

export const useBoard = create<BoardStore>((set, get) => ({
  projectId: null,
  tasks: {},
  runs: {},
  events: {},
  loaded: false,

  load: async (projectId: string) => {
    set({ projectId, loaded: false, tasks: {}, runs: {}, events: {} });
    const { tasks } = await api.listTasks(projectId);
    const next: Record<string, TaskDto> = {};
    for (const t of tasks) next[t.id] = t;
    set({ tasks: next, loaded: true });
  },

  upsertTask: (t) => set({ tasks: { ...get().tasks, [t.id]: t } }),
  removeTask: (id) => {
    const next = { ...get().tasks };
    delete next[id];
    set({ tasks: next });
  },
  upsertRun: (r) => set({ runs: { ...get().runs, [r.id]: r } }),
  appendEvent: (taskId, e) => {
    const existing = get().events[taskId] ?? [];
    set({ events: { ...get().events, [taskId]: [e, ...existing] } });
  },

  applyWsMessage: (m) => {
    switch (m.type) {
      case 'task.created':
      case 'task.updated':
        get().upsertTask(m.task as unknown as TaskDto);
        break;
      case 'task.deleted':
        get().removeTask(m.taskId);
        break;
      case 'event.created':
        get().appendEvent(m.taskId, m.event as unknown as EventDto);
        break;
      case 'run.created':
      case 'run.updated':
        get().upsertRun(m.run as unknown as RunDto);
        break;
      case 'run.log':
      case 'hello':
      case 'pong':
        // run.log handled by RunViewer; hello/pong are housekeeping
        break;
    }
  },

  transition: async (taskId, to) => {
    const current = get().tasks[taskId];
    if (!current) return;
    const previous = current.status;
    set({ tasks: { ...get().tasks, [taskId]: { ...current, status: to } } });
    try {
      const { task } = await api.transitionTask(taskId, to);
      set({ tasks: { ...get().tasks, [taskId]: task } });
    } catch (err) {
      set({ tasks: { ...get().tasks, [taskId]: { ...current, status: previous } } });
      throw err;
    }
  },
}));
