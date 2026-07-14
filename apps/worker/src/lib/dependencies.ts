/**
 * Task-dependency helpers.
 *
 * The flow:
 *   - Adding a blocker:    POST /api/tasks/:id/dependencies
 *     ⇒ checkCycle    rejects if it would form a directed cycle.
 *     ⇒ assertSameProject rejects cross-project edges.
 *   - Resolving:           after `* → done` or `* → cancelled`, call
 *     resolveDependents() to cascade `blocked → ready` for tasks whose
 *     last unresolved blocker just cleared.
 *   - Defense-in-depth:    blockersUnresolved() lets the Orchestrator
 *     re-check before claiming.
 *
 * Cancelled blocker = resolved (project decision D0). The two terminal
 * statuses (`done`, `cancelled`) both unblock dependents.
 */

import { eq, inArray, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import * as schema from './schema';
import type { DB } from './db';
import { taskDto } from './dto';
import type { Env } from './types';
import { safeBroadcast } from './broadcast';

const RESOLVED_STATUSES: schema.TaskStatus[] = ['done', 'cancelled'];
const MAX_CASCADE_DEPTH = 64;

export class DependencyError extends Error {
  constructor(
    public readonly code:
      | 'cycle'
      | 'cross_project'
      | 'self_reference'
      | 'task_not_found'
      | 'blocker_not_found'
      | 'task_locked',
    message: string,
  ) {
    super(message);
  }
}

/** Quick predicate: returns the unresolved blockers for `taskId`, if any. */
export async function unresolvedBlockers(db: DB, taskId: string): Promise<schema.Task[]> {
  return db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      number: schema.tasks.number,
      title: schema.tasks.title,
      description: schema.tasks.description,
      status: schema.tasks.status,
      priority: schema.tasks.priority,
      createdBy: schema.tasks.createdBy,
      assignee: schema.tasks.assignee,
      createdAt: schema.tasks.createdAt,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.taskDependencies)
    .innerJoin(schema.tasks, eq(schema.taskDependencies.blockedBy, schema.tasks.id))
    .where(
      sql`${schema.taskDependencies.taskId} = ${taskId} AND ${schema.tasks.status} NOT IN ('done','cancelled')`,
    )
    .all();
}

/**
 * Add a dependency. Validates the same-project constraint (D0 lock-in: cross-
 * project rejected) and runs DFS to reject cycles. Returns the newly inserted
 * row.
 */
/**
 * Agent-friendly variant: skips the running/review/done lock so an agent can
 * declare a dependency mid-run. The MCP path enters here; humans use
 * addDependency() with stricter checks.
 */
export async function addDependencyForAgent(
  db: DB,
  taskId: string,
  blockerId: string,
): Promise<schema.TaskDependency> {
  if (taskId === blockerId) {
    throw new DependencyError('self_reference', "A task can't block itself.");
  }
  const [task, blocker] = await Promise.all([
    db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get(),
    db.select().from(schema.tasks).where(eq(schema.tasks.id, blockerId)).get(),
  ]);
  if (!task) throw new DependencyError('task_not_found', `Task ${taskId} not found.`);
  if (!blocker) throw new DependencyError('blocker_not_found', `Blocker ${blockerId} not found.`);
  if (task.projectId !== blocker.projectId) {
    throw new DependencyError(
      'cross_project',
      'Cross-project dependencies are not supported in v1.',
    );
  }
  await assertNoCycle(db, taskId, blockerId);

  const row: schema.NewTaskDependency = {
    taskId,
    blockedBy: blockerId,
    createdAt: new Date(),
    createdBy: 'agent',
  };
  const inserted = await db
    .insert(schema.taskDependencies)
    .values(row)
    .onConflictDoNothing()
    .returning();
  // If the edge already existed, returning() yields []. Treat that as success.
  return inserted[0] ?? row as schema.TaskDependency;
}

export async function addDependency(
  db: DB,
  taskId: string,
  blockerId: string,
  createdBy: string,
): Promise<schema.TaskDependency> {
  if (taskId === blockerId) {
    throw new DependencyError('self_reference', "A task can't block itself.");
  }
  const [task, blocker] = await Promise.all([
    db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get(),
    db.select().from(schema.tasks).where(eq(schema.tasks.id, blockerId)).get(),
  ]);
  if (!task) throw new DependencyError('task_not_found', `Task ${taskId} not found.`);
  if (!blocker) throw new DependencyError('blocker_not_found', `Blocker ${blockerId} not found.`);
  if (task.projectId !== blocker.projectId) {
    throw new DependencyError(
      'cross_project',
      'Cross-project dependencies are not supported in v1.',
    );
  }
  // Disallow editing deps on tasks that are already mid-flight.
  if (task.status === 'running' || task.status === 'review' || task.status === 'done') {
    throw new DependencyError(
      'task_locked',
      `Cannot add a dependency to a task in status "${task.status}".`,
    );
  }

  // Cycle check: walk the dependency graph forward from `blockerId` and ensure
  // we never hit `taskId`. (If blocker depends on taskId, taskId↔blocker is a cycle.)
  await assertNoCycle(db, taskId, blockerId);

  const row: schema.NewTaskDependency = {
    taskId,
    blockedBy: blockerId,
    createdAt: new Date(),
    createdBy,
  };
  const inserted = await db.insert(schema.taskDependencies).values(row).returning();
  return inserted[0]!;
}

export async function removeDependency(
  db: DB,
  taskId: string,
  blockerId: string,
): Promise<void> {
  await db
    .delete(schema.taskDependencies)
    .where(
      sql`${schema.taskDependencies.taskId} = ${taskId} AND ${schema.taskDependencies.blockedBy} = ${blockerId}`,
    );
}

export async function listBlockers(db: DB, taskId: string): Promise<schema.Task[]> {
  return db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      number: schema.tasks.number,
      title: schema.tasks.title,
      description: schema.tasks.description,
      status: schema.tasks.status,
      priority: schema.tasks.priority,
      createdBy: schema.tasks.createdBy,
      assignee: schema.tasks.assignee,
      createdAt: schema.tasks.createdAt,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.taskDependencies)
    .innerJoin(schema.tasks, eq(schema.taskDependencies.blockedBy, schema.tasks.id))
    .where(eq(schema.taskDependencies.taskId, taskId))
    .all();
}

export async function listBlocking(db: DB, taskId: string): Promise<schema.Task[]> {
  return db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      number: schema.tasks.number,
      title: schema.tasks.title,
      description: schema.tasks.description,
      status: schema.tasks.status,
      priority: schema.tasks.priority,
      createdBy: schema.tasks.createdBy,
      assignee: schema.tasks.assignee,
      createdAt: schema.tasks.createdAt,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.taskDependencies)
    .innerJoin(schema.tasks, eq(schema.taskDependencies.taskId, schema.tasks.id))
    .where(eq(schema.taskDependencies.blockedBy, taskId))
    .all();
}

/**
 * Cascading unblock. Call after a task hits `done` or `cancelled`. Walks
 * dependents; for each currently-`blocked` task whose blockers are now all
 * resolved, transitions to `ready` and enqueues onto DISPATCH so the
 * Orchestrator can claim it.
 *
 * Bounded by MAX_CASCADE_DEPTH to keep pathological graphs from looping.
 */
export async function resolveDependents(
  env: Env,
  db: DB,
  resolvedTaskId: string,
): Promise<schema.Task[]> {
  const unblocked: schema.Task[] = [];
  const visited = new Set<string>([resolvedTaskId]);
  let frontier: string[] = [resolvedTaskId];

  for (let depth = 0; depth < MAX_CASCADE_DEPTH && frontier.length > 0; depth++) {
    const dependents = await db
      .select({
        taskId: schema.taskDependencies.taskId,
        task: schema.tasks,
      })
      .from(schema.taskDependencies)
      .innerJoin(schema.tasks, eq(schema.taskDependencies.taskId, schema.tasks.id))
      .where(inArray(schema.taskDependencies.blockedBy, frontier))
      .all();

      const candidates = dependents
        .filter(({ task }) => task.status === 'blocked' && !visited.has(task.id))
        .map(({ task }) => task);

    const next: string[] = [];
    for (const dep of candidates) {
      visited.add(dep.id);
      const remaining = await unresolvedBlockers(db, dep.id);
      if (remaining.length > 0) continue;

      const now = new Date();
      await db
        .update(schema.tasks)
        .set({ status: 'ready', updatedAt: now })
        .where(eq(schema.tasks.id, dep.id));
      await db.insert(schema.events).values({
        id: ulid(),
        taskId: dep.id,
        runId: null,
        type: 'system',
        author: 'system',
        payload: { message: 'Unblocked: all dependencies resolved.' },
        createdAt: now,
      });
      await env.DISPATCH.send({ taskId: dep.id, projectId: dep.projectId });
      const refreshed = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, dep.id))
        .get();
      if (refreshed) {
        unblocked.push(refreshed);
        await safeBroadcast(env, refreshed.projectId, {
          type: 'task.updated',
          task: taskDto(refreshed),
        });
        next.push(refreshed.id); // cascading further is rare but possible
      }
    }
    frontier = next;
  }

  return unblocked;
}

/**
 * If a task transitions ready ← {backlog|blocked} but has unresolved blockers,
 * land it in `blocked` instead. Used by the transition handler. Returns the
 * status we actually persisted.
 */
export async function gateReadyTransition(
  db: DB,
  taskId: string,
): Promise<'ready' | 'blocked'> {
  const blockers = await unresolvedBlockers(db, taskId);
  return blockers.length === 0 ? 'ready' : 'blocked';
}

// ─── internal: cycle check ─────────────────────────────────────────────────

async function assertNoCycle(
  db: DB,
  taskId: string,
  blockerId: string,
): Promise<void> {
  const seen = new Set<string>();
  const stack = [blockerId];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === taskId) {
      throw new DependencyError(
        'cycle',
        `Adding ${blockerId} as a blocker of ${taskId} would form a cycle.`,
      );
    }
    if (seen.has(node)) continue;
    seen.add(node);
    if (seen.size > 1024) break; // sanity cap; real graphs won't hit this

    const next = await db
      .select({ blockedBy: schema.taskDependencies.blockedBy })
      .from(schema.taskDependencies)
      .where(eq(schema.taskDependencies.taskId, node))
      .all();
    for (const row of next) stack.push(row.blockedBy);
  }
}
