#!/usr/bin/env tsx
/**
 * scripts/postdeploy.ts
 *
 * Runs after `wrangler deploy` to apply any pending D1 migrations against the
 * remote database. Idempotent — safe to run on every deploy.
 *
 * Also prints the deployed Worker URL when it's discoverable from `wrangler`'s
 * output, so the deploy ends with something the user can click.
 *
 * See SPEC §17 M0 step 5.
 */

import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function step(msg: string) {
  process.stdout.write(`\n${c.cyan}→${c.reset} ${c.bold}${msg}${c.reset}\n`);
}
function ok(msg: string) {
  process.stdout.write(`  ${c.green}✓${c.reset} ${msg}\n`);
}
function info(msg: string) {
  process.stdout.write(`  ${c.dim}${msg}${c.reset}\n`);
}
function warn(msg: string) {
  process.stdout.write(`  ${c.yellow}!${c.reset} ${msg}\n`);
}

async function migrationsExist(): Promise<boolean> {
  try {
    const files = await readdir('migrations');
    return files.some((f) => f.endsWith('.sql'));
  } catch {
    return false;
  }
}

async function applyMigrations() {
  step('Applying D1 migrations (--remote)');
  if (!(await migrationsExist())) {
    warn('No migrations/*.sql yet — skipping.');
    info('Migrations land in M2 once the Drizzle schema is generated.');
    return;
  }
  const r = spawnSync(
    'wrangler',
    ['d1', 'migrations', 'apply', 'philharmonic', '--remote'],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) {
    process.stderr.write(`\n${c.red}✗${c.reset} Migration apply failed.\n`);
    process.exit(r.status ?? 1);
  }
  ok('Migrations applied');
}

function printDeployedUrl() {
  step('Deployed Worker');
  const r = spawnSync('wrangler', ['deployments', 'list', '--name', 'philharmonic'], {
    encoding: 'utf-8',
  });
  const text = (r.stdout ?? '') + (r.stderr ?? '');
  const urlMatch = text.match(/https?:\/\/[^\s)]+\.workers\.dev[^\s)]*/);
  if (urlMatch) {
    ok(`Live at ${c.bold}${urlMatch[0]}${c.reset}`);
  } else {
    info(
      'Could not auto-detect URL. Run `wrangler deployments list` or check the Cloudflare dashboard.',
    );
  }
}

async function main() {
  process.stdout.write(`${c.bold}🎼 Philharmonic post-deploy${c.reset}\n`);
  await applyMigrations();
  printDeployedUrl();
  process.stdout.write(`\n${c.green}${c.bold}✓ Done.${c.reset}\n`);
}

main().catch((err) => {
  process.stderr.write(`\n${c.red}✗${c.reset} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
