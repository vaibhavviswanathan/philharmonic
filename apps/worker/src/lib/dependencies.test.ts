import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { ulid } from 'ulid';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from './db';
import {
  DependencyError,
  addDependency,
  addDependencyForAgent,
  gateReadyTransition,
  listBlockers,
  listBlocking,
  removeDependency,
  resolveDependents,
  unresolvedBlockers,
} from './dependencies';
import * as schema from './schema';
import type { Env } from './types';

// Run the real D1 migrations against an in-memory SQLite so the tests
// exercise the exact deployed schema.
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../migrations');

function makeDb(): { db: DB; sqlite: Database.Database } {
  const sqlite = new Database(':memory:');
  for (const file of fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    sqlite.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return { db: drizzle(sqlite, { schema }) as unknown as DB, sqlite };
}

/** Minimal Env stub: capture queue sends, swallow broadcasts. */
function makeEnv(sent: unknown[]): Env {
  return {
    DISPATCH: {
      send: async (msg: unknown) => {
        sent.push(msg);
      },
    },
    TASKS_ROOM: {
      idFromName: () => 'id',
      get: () => ({ fetch: async () => new Response('ok') }),
    },
  } as unknown as Env;
}

let db: DB;
let env: Env;
let sent: unknown[];
let projectId: string;

async function makeTask(status: schema.TaskStatus, number: number): Promise<schema.Task> {
  const now = new Date();
  const [row] = await db
    .insert(schema.tasks)
    .values({
      id: ulid(),
      projectId,
      number,
      title: `Task ${number}`,
      description: '',
      status,
      priority: 2,
      createdBy: 'test@example.com',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error('insert failed');
  return row;
}

async function setStatus(taskId: string, status: schema.TaskStatus): Promise<void> {
  const { eq } = await import('drizzle-orm');
  await db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, taskId));
}

beforeEach(async () => {
  ({ db } = makeDb());
  sent = [];
  env = makeEnv(sent);
  projectId = ulid();
  const now = new Date();
  await db.insert(schema.projects).values({
    id: projectId,
    name: 'Test',
    slug: 'test',
    repoUrl: 'https://github.com/acme/test',
    defaultBranch: 'main',
    workflowMd: '# wf',
    concurrencyLimit: 2,
    createdAt: now,
    updatedAt: now,
  });
});

describe('cycle prevention', () => {
  it('rejects a self-reference', async () => {
    const a = await makeTask('backlog', 1);
    await expect(addDependency(db, a.id, a.id, 'h')).rejects.toSatisfy(
      (e: unknown) => e instanceof DependencyError && e.code === 'self_reference',
    );
  });

  it('rejects a direct cycle (A blocks B, B blocks A)', async () => {
    const a = await makeTask('backlog', 1);
    const b = await makeTask('backlog', 2);
    await addDependency(db, a.id, b.id, 'h'); // A blocked by B
    await expect(addDependency(db, b.id, a.id, 'h')).rejects.toSatisfy(
      (e: unknown) => e instanceof DependencyError && e.code === 'cycle',
    );
  });

  it('rejects a transitive cycle (A←B←C, then C blocked by A)', async () => {
    const a = await makeTask('backlog', 1);
    const b = await makeTask('backlog', 2);
    const c = await makeTask('backlog', 3);
    await addDependency(db, a.id, b.id, 'h'); // A blocked by B
    await addDependency(db, b.id, c.id, 'h'); // B blocked by C
    await expect(addDependency(db, c.id, a.id, 'h')).rejects.toSatisfy(
      (e: unknown) => e instanceof DependencyError && e.code === 'cycle',
    );
  });

  it('the agent path enforces the same cycle check', async () => {
    const a = await makeTask('running', 1);
    const b = await makeTask('backlog', 2);
    await addDependency(db, b.id, a.id, 'h'); // B blocked by A
    await expect(addDependencyForAgent(db, a.id, b.id)).rejects.toSatisfy(
      (e: unknown) => e instanceof DependencyError && e.code === 'cycle',
    );
  });
});

describe('edge rules', () => {
  it('rejects cross-project dependencies', async () => {
    const a = await makeTask('backlog', 1);
    const now = new Date();
    const otherProject = ulid();
    await db.insert(schema.projects).values({
      id: otherProject,
      name: 'Other',
      slug: 'other',
      repoUrl: 'https://github.com/acme/other',
      defaultBranch: 'main',
      workflowMd: '# wf',
      concurrencyLimit: 2,
      createdAt: now,
      updatedAt: now,
    });
    const [foreign] = await db
      .insert(schema.tasks)
      .values({
        id: ulid(),
        projectId: otherProject,
        number: 1,
        title: 'Foreign',
        description: '',
        status: 'backlog',
        priority: 2,
        createdBy: 't@e.com',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await expect(addDependency(db, a.id, foreign?.id ?? '', 'h')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DependencyError &&
        (e.code === 'cross_project' || e.code === 'blocker_not_found'),
    );
  });

  it('duplicate edges are idempotent no-ops on both paths', async () => {
    const a = await makeTask('backlog', 1);
    const b = await makeTask('backlog', 2);
    await addDependency(db, a.id, b.id, 'h');
    await expect(addDependency(db, a.id, b.id, 'h')).resolves.toBeTruthy();
    await expect(addDependencyForAgent(db, a.id, b.id)).resolves.toBeTruthy();
    expect(await listBlockers(db, a.id)).toHaveLength(1);
  });

  it('locks dependency edits on running/review/done tasks for humans only', async () => {
    const blocker = await makeTask('backlog', 9);
    for (const status of ['running', 'review', 'done'] as const) {
      const t = await makeTask(status, 10 + Math.floor(Math.random() * 1000));
      await expect(addDependency(db, t.id, blocker.id, 'h')).rejects.toSatisfy(
        (e: unknown) => e instanceof DependencyError && e.code === 'task_locked',
      );
    }
    // ...but the agent path may declare mid-run.
    const running = await makeTask('running', 2000);
    await expect(addDependencyForAgent(db, running.id, blocker.id)).resolves.toBeTruthy();
  });
});

describe('gateReadyTransition', () => {
  it('returns ready when no blockers exist', async () => {
    const a = await makeTask('backlog', 1);
    expect(await gateReadyTransition(db, a.id)).toBe('ready');
  });

  it('returns blocked while any blocker is unresolved', async () => {
    const a = await makeTask('backlog', 1);
    const b = await makeTask('backlog', 2);
    await addDependency(db, a.id, b.id, 'h');
    expect(await gateReadyTransition(db, a.id)).toBe('blocked');
  });

  it('treats done AND cancelled blockers as resolved', async () => {
    const a = await makeTask('backlog', 1);
    const b = await makeTask('backlog', 2);
    const c = await makeTask('backlog', 3);
    await addDependency(db, a.id, b.id, 'h');
    await addDependency(db, a.id, c.id, 'h');
    await setStatus(b.id, 'done');
    await setStatus(c.id, 'cancelled');
    expect(await gateReadyTransition(db, a.id)).toBe('ready');
    expect(await unresolvedBlockers(db, a.id)).toHaveLength(0);
  });
});

describe('resolveDependents', () => {
  it('unblocks and enqueues a dependent once ALL blockers are resolved (AND-semantics)', async () => {
    const dep = await makeTask('blocked', 1);
    const b1 = await makeTask('backlog', 2);
    const b2 = await makeTask('backlog', 3);
    await addDependency(db, dep.id, b1.id, 'h');
    await addDependency(db, dep.id, b2.id, 'h');

    await setStatus(b1.id, 'done');
    expect(await resolveDependents(env, db, b1.id)).toHaveLength(0); // b2 still open
    expect(sent).toHaveLength(0);

    await setStatus(b2.id, 'cancelled'); // cancelled counts as resolved
    const unblocked = await resolveDependents(env, db, b2.id);
    expect(unblocked.map((t) => t.id)).toEqual([dep.id]);
    expect(sent).toEqual([{ taskId: dep.id, projectId }]);

    const refreshed = await unresolvedBlockers(db, dep.id);
    expect(refreshed).toHaveLength(0);
  });

  it('only touches dependents currently in blocked', async () => {
    const dep = await makeTask('backlog', 1); // parked in backlog, not blocked
    const b = await makeTask('backlog', 2);
    await addDependency(db, dep.id, b.id, 'h');
    await setStatus(b.id, 'done');
    expect(await resolveDependents(env, db, b.id)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('records which terminal status resolved the blocker in the unblock event', async () => {
    const dep = await makeTask('blocked', 1);
    const b = await makeTask('backlog', 2);
    await addDependency(db, dep.id, b.id, 'h');
    await setStatus(b.id, 'cancelled');
    await resolveDependents(env, db, b.id);
    const events = await db.select().from(schema.events).all();
    const unblock = events.find((e) => e.taskId === dep.id);
    expect(unblock?.payload).toMatchObject({ resolvedBy: b.id, resolvedStatus: 'cancelled' });
  });
});

describe('listBlockers / listBlocking / removeDependency', () => {
  it('exposes both directions of the edge and removal works', async () => {
    const a = await makeTask('backlog', 1);
    const b = await makeTask('backlog', 2);
    await addDependency(db, a.id, b.id, 'h');
    expect((await listBlockers(db, a.id)).map((t) => t.id)).toEqual([b.id]);
    expect((await listBlocking(db, b.id)).map((t) => t.id)).toEqual([a.id]);
    await removeDependency(db, a.id, b.id);
    expect(await listBlockers(db, a.id)).toHaveLength(0);
    expect(await listBlocking(db, b.id)).toHaveLength(0);
  });
});
