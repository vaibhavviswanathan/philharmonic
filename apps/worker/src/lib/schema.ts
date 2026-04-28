/**
 * D1 schema. See SPEC §6.1 for the canonical shape.
 *
 * `tasks.number` is per-project (PHIL-1, PHIL-2, …). Allocate it in a
 * transaction when creating a task. `events.payload` is JSON; document the
 * shapes per `type` in packages/shared/src/api-types.ts.
 */

import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  repoUrl: text('repo_url').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  workflowMd: text('workflow_md').notNull(),
  concurrencyLimit: integer('concurrency_limit').notNull().default(2),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status', {
      enum: ['backlog', 'blocked', 'ready', 'running', 'review', 'done', 'cancelled'],
    })
      .notNull()
      .default('backlog'),
    priority: integer('priority').notNull().default(2),
    createdBy: text('created_by').notNull(),
    assignee: text('assignee'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    projectStatusIdx: index('tasks_project_status').on(t.projectId, t.status),
    numberIdx: index('tasks_project_number').on(t.projectId, t.number),
  }),
);

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull().references(() => tasks.id),
    workflowInstanceId: text('workflow_instance_id'),
    sandboxId: text('sandbox_id').notNull(),
    status: text('status', {
      enum: ['queued', 'preparing', 'running', 'landing', 'succeeded', 'failed', 'cancelled'],
    })
      .notNull()
      .default('queued'),
    prUrl: text('pr_url'),
    errorMessage: text('error_message'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    taskIdx: index('runs_task').on(t.taskId),
  }),
);

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull().references(() => tasks.id),
    runId: text('run_id').references(() => runs.id),
    type: text('type', {
      enum: ['comment', 'status_change', 'agent_action', 'proof', 'system'],
    }).notNull(),
    author: text('author').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    taskIdx: index('events_task_created').on(t.taskId, t.createdAt),
  }),
);

/**
 * Task dependencies — `taskId` is blocked by `blockedBy`. Both reference
 * `tasks.id` and must belong to the same project (enforced at the API layer,
 * not the schema). Cycles are rejected at write time via DFS in
 * lib/dependencies.ts.
 *
 * Resolution rule (D0 lock-in): a blocker is "resolved" when it reaches
 * `done` or `cancelled`. Strict by default — soft deps would need a column.
 */
export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    taskId: text('task_id').notNull().references(() => tasks.id),
    blockedBy: text('blocked_by').notNull().references(() => tasks.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    createdBy: text('created_by').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taskId, t.blockedBy] }),
    blockedByIdx: index('task_deps_blocked_by').on(t.blockedBy),
  }),
);

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  kind: text('kind', {
    enum: ['pr_diff', 'screenshot', 'video', 'logs', 'ci_summary', 'other'],
  }).notNull(),
  r2Key: text('r2_key').notNull(),
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  caption: text('caption'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
export type TaskDependency = typeof taskDependencies.$inferSelect;
export type NewTaskDependency = typeof taskDependencies.$inferInsert;

export type TaskStatus = Task['status'];
export type RunStatus = Run['status'];
export type EventType = Event['type'];
