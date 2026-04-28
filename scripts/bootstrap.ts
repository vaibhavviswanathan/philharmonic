#!/usr/bin/env tsx
/**
 * scripts/bootstrap.ts
 *
 * One-shot installer for Philharmonic's Cloudflare resources.
 *
 * What this does, in order:
 *   1. Verifies wrangler is logged in.
 *   2. Creates the D1 database, R2 bucket, queues, and Secrets Store store
 *      (idempotent — skips anything that already exists).
 *   3. Generates RUN_TOKEN_SECRET and INTERNAL_API_TOKEN and stores them.
 *   4. Prompts the user for ANTHROPIC_API_KEY and GITHUB_TOKEN, stores them.
 *   5. Writes the new D1 database_id back into wrangler.jsonc, preserving
 *      JSONC comments via @cloudflare/jsonc-parser.
 *   6. Runs database migrations against the remote D1.
 *   7. Prints next steps.
 *
 * Designed to be safe to re-run: every step checks current state first.
 *
 * The Deploy-to-Cloudflare button does the equivalent of this automatically,
 * so this script is for users on the manual install path.
 */

import { spawn, spawnSync, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import * as jsoncParser from 'jsonc-parser';

const WRANGLER_CONFIG_PATH = 'wrangler.jsonc';
const SECRETS_STORE_NAME = 'philharmonic-secrets';

// ─── small utilities ────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
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
function die(msg: string): never {
  process.stderr.write(`\n${c.red}✗${c.reset} ${msg}\n`);
  process.exit(1);
}

/** Run a command, capture stdout, exit on failure. */
function sh(cmd: string, args: string[], opts: SpawnOptionsWithoutStdio = {}): string {
  const result = spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    die(`${cmd} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout ?? '';
}

/** Run a command but tolerate failure; returns { ok, stdout, stderr }. */
function shTry(cmd: string, args: string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(cmd, args, { encoding: 'utf-8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Pipe a value into stdin of a wrangler command (used for `secret put`). */
function shWithStdin(cmd: string, args: string[], stdinValue: string): void {
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.write(stdinValue);
  child.stdin.end();
  return new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} failed with code ${code}`));
    });
  }) as unknown as void;
}

/** Random base64url string for HMAC secrets. */
function randomSecret(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

// ─── prompt helpers ─────────────────────────────────────────────────────────

const rl = readline.createInterface({ input, output });

async function prompt(question: string): Promise<string> {
  const answer = await rl.question(`  ${c.cyan}?${c.reset} ${question} `);
  return answer.trim();
}

async function promptSecret(question: string): Promise<string> {
  // Hide input by suppressing terminal echo while the user types.
  output.write(`  ${c.cyan}?${c.reset} ${question} `);
  const wasRaw = input.isTTY && (input as any).isRaw;
  if (input.isTTY) input.setRawMode(true);

  const value = await new Promise<string>((resolve) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          input.off('data', onData);
          if (input.isTTY) input.setRawMode(wasRaw ?? false);
          output.write('\n');
          resolve(buf);
          return;
        } else if (ch === '\u0003') {
          // Ctrl-C
          process.exit(130);
        } else if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
        }
      }
    };
    input.on('data', onData);
  });

  return value.trim();
}

async function confirm(question: string, dflt = true): Promise<boolean> {
  const suffix = dflt ? '[Y/n]' : '[y/N]';
  const answer = (await prompt(`${question} ${suffix}`)).toLowerCase();
  if (answer === '') return dflt;
  return answer === 'y' || answer === 'yes';
}

// ─── wrangler operations ─────────────────────────────────────────────────────

function ensureWranglerLogin(): void {
  step('Checking Cloudflare login');
  const r = shTry('wrangler', ['whoami']);
  if (!r.ok) {
    die('Not logged in to Cloudflare. Run `wrangler login` first, then re-run bootstrap.');
  }
  // Extract account email if printed.
  const emailMatch = r.stdout.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  ok(`Logged in${emailMatch ? ` as ${emailMatch[0]}` : ''}`);
}

function ensureD1(): string {
  step('D1 database');
  // Try to read existing.
  const list = shTry('wrangler', ['d1', 'list', '--json']);
  if (list.ok) {
    try {
      const dbs = JSON.parse(list.stdout);
      const existing = Array.isArray(dbs)
        ? dbs.find((d: any) => d.name === 'philharmonic')
        : undefined;
      if (existing?.uuid) {
        ok(`Found existing database: ${existing.uuid}`);
        return existing.uuid;
      }
    } catch {
      /* fall through to create */
    }
  }
  info('Creating new D1 database "philharmonic"...');
  const created = sh('wrangler', ['d1', 'create', 'philharmonic']);
  // Output contains a TOML-ish snippet with database_id = "..."
  const m = created.match(/database_id\s*=\s*"([0-9a-f-]+)"/i);
  if (!m) {
    process.stderr.write(created);
    die('Failed to parse database_id from `wrangler d1 create` output.');
  }
  ok(`Created: ${m[1]}`);
  return m[1];
}

function ensureR2(): void {
  step('R2 bucket');
  const list = shTry('wrangler', ['r2', 'bucket', 'list']);
  if (list.ok && list.stdout.includes('philharmonic-artifacts')) {
    ok('Bucket "philharmonic-artifacts" already exists');
    return;
  }
  sh('wrangler', ['r2', 'bucket', 'create', 'philharmonic-artifacts']);
  ok('Created bucket "philharmonic-artifacts"');
}

function ensureQueues(): void {
  step('Queues');
  for (const name of ['philharmonic-dispatch', 'philharmonic-dispatch-dlq']) {
    const list = shTry('wrangler', ['queues', 'list']);
    if (list.ok && list.stdout.includes(name)) {
      ok(`Queue "${name}" already exists`);
      continue;
    }
    sh('wrangler', ['queues', 'create', name]);
    ok(`Created queue "${name}"`);
  }
}

/**
 * Ensure a Secrets Store exists. Returns its ID.
 *
 * `wrangler secrets-store store create <name>` is idempotent on most
 * Cloudflare CLI versions; if not, we look it up first.
 */
function ensureSecretsStore(): string {
  step('Secrets Store');
  const list = shTry('wrangler', ['secrets-store', 'store', 'list', '--json']);
  if (list.ok) {
    try {
      const stores = JSON.parse(list.stdout);
      const existing = Array.isArray(stores)
        ? stores.find((s: any) => s.name === SECRETS_STORE_NAME)
        : undefined;
      if (existing?.id) {
        ok(`Found existing store: ${existing.id}`);
        return existing.id;
      }
    } catch {
      /* fall through */
    }
  }
  const out = sh('wrangler', ['secrets-store', 'store', 'create', SECRETS_STORE_NAME]);
  const m = out.match(/[0-9a-f]{32,}/i);
  if (!m) {
    process.stderr.write(out);
    die('Failed to parse Secrets Store ID from create output.');
  }
  ok(`Created store: ${m[0]}`);
  return m[0];
}

function secretExists(storeId: string, name: string): boolean {
  const r = shTry('wrangler', [
    'secrets-store',
    'secret',
    'list',
    '--store-id',
    storeId,
    '--json',
  ]);
  if (!r.ok) return false;
  try {
    const secrets = JSON.parse(r.stdout);
    return Array.isArray(secrets) && secrets.some((s: any) => s.name === name);
  } catch {
    return false;
  }
}

async function putSecret(
  storeId: string,
  name: string,
  value: string,
  { overwrite = false }: { overwrite?: boolean } = {},
): Promise<void> {
  const exists = secretExists(storeId, name);
  if (exists && !overwrite) {
    info(`${name} already set (skipping; pass --rotate to overwrite)`);
    return;
  }
  const args = [
    'secrets-store',
    'secret',
    exists ? 'update' : 'create',
    name,
    '--store-id',
    storeId,
    '--value',
    value,
  ];
  sh('wrangler', args);
  ok(`${exists ? 'Rotated' : 'Stored'} ${name}`);
}

// ─── wrangler.jsonc rewriting ───────────────────────────────────────────────

async function readWranglerConfig(): Promise<string> {
  try {
    return await readFile(WRANGLER_CONFIG_PATH, 'utf-8');
  } catch (err) {
    die(
      `Could not read ${WRANGLER_CONFIG_PATH}. Are you in the repo root?\n${(err as Error).message}`,
    );
  }
}

async function writeWranglerConfig(text: string): Promise<void> {
  await writeFile(WRANGLER_CONFIG_PATH, text);
}

/**
 * Set a value at a JSONC path, preserving comments and formatting.
 * Path is an array of property names / array indices.
 */
function patchJsonc(
  source: string,
  path: jsoncParser.JSONPath,
  value: unknown,
): string {
  const edits = jsoncParser.modify(source, path, value, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });
  return jsoncParser.applyEdits(source, edits);
}

async function patchD1Id(d1Id: string): Promise<void> {
  step('Updating wrangler.jsonc with D1 database_id');
  let text = await readWranglerConfig();
  text = patchJsonc(text, ['d1_databases', 0, 'database_id'], d1Id);
  await writeWranglerConfig(text);
  ok('Patched d1_databases[0].database_id');
}

async function patchSecretsStoreIds(storeId: string): Promise<void> {
  step('Updating wrangler.jsonc with Secrets Store ID');
  let text = await readWranglerConfig();
  // Read current to find how many secrets_store_secrets entries exist.
  const parsed = jsoncParser.parse(text) as { secrets_store_secrets?: unknown[] };
  const count = Array.isArray(parsed.secrets_store_secrets)
    ? parsed.secrets_store_secrets.length
    : 0;
  for (let i = 0; i < count; i++) {
    text = patchJsonc(text, ['secrets_store_secrets', i, 'store_id'], storeId);
  }
  await writeWranglerConfig(text);
  ok(`Patched ${count} secrets_store_secrets entries`);
}

// ─── migrations ─────────────────────────────────────────────────────────────

function runMigrations(): void {
  step('Applying database migrations');
  const has = shTry('ls', ['migrations']);
  if (!has.ok || !has.stdout.trim()) {
    warn('No migrations/ directory yet. Skipping.');
    info('Run `pnpm migrate:remote` after generating migrations with drizzle-kit.');
    return;
  }
  sh('wrangler', ['d1', 'migrations', 'apply', 'philharmonic', '--remote'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  } as SpawnOptionsWithoutStdio);
  ok('Migrations applied');
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const rotate = process.argv.includes('--rotate');

  process.stdout.write(`${c.bold}🎼 Philharmonic bootstrap${c.reset}\n`);
  info('Provisions Cloudflare resources for a fresh deploy.');
  info('Safe to re-run. Pass --rotate to regenerate internal secrets.');

  ensureWranglerLogin();

  // Idempotent resource creation.
  const d1Id = ensureD1();
  ensureR2();
  ensureQueues();
  const storeId = ensureSecretsStore();

  // Patch wrangler.jsonc with discovered IDs.
  await patchD1Id(d1Id);
  await patchSecretsStoreIds(storeId);

  // Generate and store internal secrets.
  step('Internal secrets (HMAC keys for run tokens)');
  await putSecret(storeId, 'RUN_TOKEN_SECRET', randomSecret(), { overwrite: rotate });
  await putSecret(storeId, 'INTERNAL_API_TOKEN', randomSecret(), { overwrite: rotate });

  // Prompt for external credentials.
  step('External credentials');
  info('These are stored in Cloudflare Secrets Store and never written to disk.');

  const anthropicExists = secretExists(storeId, 'ANTHROPIC_API_KEY');
  if (anthropicExists && !rotate) {
    info('ANTHROPIC_API_KEY already set (skipping)');
  } else {
    const key = await promptSecret('Paste your ANTHROPIC_API_KEY (input hidden):');
    if (!key) die('ANTHROPIC_API_KEY is required.');
    await putSecret(storeId, 'ANTHROPIC_API_KEY', key, { overwrite: true });
  }

  const githubExists = secretExists(storeId, 'GITHUB_TOKEN');
  if (githubExists && !rotate) {
    info('GITHUB_TOKEN already set (skipping)');
  } else {
    const token = await promptSecret(
      'Paste your GITHUB_TOKEN (fine-grained PAT, repo + PR scope, input hidden):',
    );
    if (!token) die('GITHUB_TOKEN is required.');
    await putSecret(storeId, 'GITHUB_TOKEN', token, { overwrite: true });
  }

  rl.close();

  // Migrations.
  runMigrations();

  // Done.
  process.stdout.write(`\n${c.green}${c.bold}✓ Bootstrap complete.${c.reset}\n\n`);
  process.stdout.write(`${c.bold}Next:${c.reset}\n`);
  process.stdout.write(`  1. ${c.bold}pnpm deploy${c.reset}\n`);
  process.stdout.write(
    `  2. Configure Cloudflare Access pointing at the deployed Worker URL\n`,
  );
  process.stdout.write(
    `  3. Set ${c.cyan}ACCESS_TEAM_DOMAIN${c.reset} and ${c.cyan}ACCESS_AUD${c.reset} ` +
      `in wrangler.jsonc \`vars\`, then re-run \`pnpm deploy\`\n`,
  );
  process.stdout.write(
    `  4. Visit your Worker URL — Philharmonic's PostDeploySetup screen will guide you the rest of the way\n\n`,
  );
}

main().catch((err) => {
  rl.close();
  die(err instanceof Error ? err.message : String(err));
});
