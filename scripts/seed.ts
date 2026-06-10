#!/usr/bin/env tsx
/**
 * scripts/seed.ts
 *
 * Seeds the LOCAL dev database with a demo project + sample tasks so a fresh
 * clone has something on the board.
 *
 * - The project uses the canonical default template from
 *   containers/sandbox/WORKFLOW.md (read from disk — same file the worker
 *   seeds new projects from).
 * - Runs `wrangler d1 execute --local` against the generated wrangler.dev.jsonc
 *   (see scripts/dev.ts) so the rows land in the same .wrangler/state database
 *   that `pnpm dev` serves.
 * - Idempotent: exits early if the demo project already exists.
 * - Dependency-free: node built-ins + the wrangler CLI only.
 *
 * Run `pnpm migrate:local` first; this script tells you if you haven't.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { materializeDevConfig } from './dev.ts';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_MD_PATH = resolve(ROOT, 'containers/sandbox/WORKFLOW.md');

// ─── helpers ────────────────────────────────────────────────────────────────

function die(msg: string): never {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(1);
}

/** Minimal ULID (Crockford base32, 10 time chars + 16 random chars). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (const byte of randomBytes(16)) rand += CROCKFORD[byte % 32];
  return time + rand;
}

/** SQL string literal: single quotes doubled. Values go in via a .sql file, never a shell. */
function sq(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Run SQL against the local D1 database; returns parsed --json results or null. */
function d1ExecLocal(
  configPath: string,
  args: string[],
): { ok: boolean; results: unknown[] | null; raw: string } {
  const r = spawnSync(
    'wrangler',
    ['d1', 'execute', 'philharmonic', '--local', '--config', configPath, '--json', ...args],
    { encoding: 'utf-8', cwd: ROOT },
  );
  const raw = (r.stdout ?? '') + (r.stderr ?? '');
  if (r.status !== 0) return { ok: false, results: null, raw };
  try {
    // --json output: [{ results: [...], success: true, meta: {...} }, ...]
    const parsed = JSON.parse(r.stdout ?? '');
    const first = Array.isArray(parsed) ? parsed[0] : undefined;
    return { ok: true, results: Array.isArray(first?.results) ? first.results : [], raw };
  } catch {
    return { ok: true, results: null, raw };
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

process.stdout.write('🎼 Philharmonic seed (local dev database)\n');

const configPath = materializeDevConfig();

// 1. Has the local DB been migrated?
const tables = d1ExecLocal(configPath, [
  '--command',
  "SELECT name FROM sqlite_master WHERE type='table' AND name='projects'",
]);
if (!tables.ok || !tables.results || tables.results.length === 0) {
  if (!tables.ok) process.stderr.write(tables.raw);
  die(
    'The local database has no schema yet. Run `pnpm migrate:local` first, then re-run `pnpm seed`.',
  );
}

// 2. Already seeded?
const existing = d1ExecLocal(configPath, [
  '--command',
  "SELECT id FROM projects WHERE slug='demo'",
]);
if (existing.ok && existing.results && existing.results.length > 0) {
  process.stdout.write('✓ Demo project already seeded — nothing to do.\n');
  process.exit(0);
}

// 3. Build the seed SQL.
const workflowMd = readFileSync(WORKFLOW_MD_PATH, 'utf-8');
const now = Date.now();
const projectId = ulid(now);
const createdBy = 'seed@localhost';

const tasks = [
  {
    id: ulid(now),
    number: 1,
    title: 'Add a project README badge row',
    description: 'Add CI and license badges to the top of the README. Keep it to one line.',
    status: 'ready',
    priority: 2,
  },
  {
    id: ulid(now),
    number: 2,
    title: 'Dark-mode toggle for the docs site',
    description: 'Persist the choice in localStorage. Default to the OS preference.',
    status: 'backlog',
    priority: 3,
  },
  {
    id: ulid(now),
    number: 3,
    title: 'Fix flaky date-formatting test',
    description: 'The `formats relative dates` test fails around midnight UTC. Pin the clock.',
    status: 'done',
    priority: 1,
  },
  {
    id: ulid(now),
    number: 4,
    title: 'Announce the badge row in the changelog',
    description: 'Blocked on DEMO-1 — write the changelog entry once the badges land.',
    status: 'blocked',
    priority: 2,
  },
] as const;

const statements = [
  `INSERT INTO projects (id, name, slug, repo_url, default_branch, workflow_md, concurrency_limit, created_at, updated_at)
   VALUES (${sq(projectId)}, 'Demo Project', 'demo', 'https://github.com/YOUR_ORG/YOUR_REPO', 'main', ${sq(workflowMd)}, 2, ${now}, ${now});`,
  ...tasks.map(
    (t) =>
      `INSERT INTO tasks (id, project_id, number, title, description, status, priority, created_by, created_at, updated_at)
   VALUES (${sq(t.id)}, ${sq(projectId)}, ${t.number}, ${sq(t.title)}, ${sq(t.description)}, ${sq(t.status)}, ${t.priority}, ${sq(createdBy)}, ${now}, ${now});`,
  ),
  // DEMO-4 is blocked by DEMO-1 (an unresolved blocker, so `blocked` is genuine).
  `INSERT INTO task_dependencies (task_id, blocked_by, created_at, created_by)
   VALUES (${sq(tasks[3].id)}, ${sq(tasks[0].id)}, ${now}, ${sq(createdBy)});`,
];

// 4. Apply via a temp .sql file — no shell, no argv-length or quoting hazards.
const tmpDir = mkdtempSync(join(tmpdir(), 'philharmonic-seed-'));
const sqlPath = join(tmpDir, 'seed.sql');
try {
  writeFileSync(sqlPath, statements.join('\n'));
  const result = d1ExecLocal(configPath, ['--file', sqlPath]);
  if (!result.ok) {
    process.stderr.write(result.raw);
    die('Seeding failed — see wrangler output above.');
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

process.stdout.write(
  `✓ Seeded project "Demo Project" (demo) with ${tasks.length} tasks (one blocked by a dependency).
  Start the app with \`pnpm dev\` and open the board at /projects/demo.
  Note: repo_url is a placeholder — point it at a real repo in project settings before running tasks.
`,
);
