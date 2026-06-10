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
 *   3. Generates RUN_TOKEN_SECRET and stores it.
 *   4. Prompts the user for ANTHROPIC_API_KEY and GITHUB_TOKEN, stores them.
 *   5. Writes the new D1 database_id and Secrets Store ID back into
 *      wrangler.jsonc, preserving JSONC comments via jsonc-parser.
 *   6. Runs database migrations against the remote D1.
 *   7. Prints next steps.
 *
 * Designed to be safe to re-run: every step checks current state first.
 * Pass --rotate to regenerate RUN_TOKEN_SECRET and re-prompt for the
 * external credentials.
 *
 * Wrangler CLI shapes used here are the verified wrangler 4.x ones (SPEC
 * §16.2): secrets-store subcommands take the store ID as a positional, need
 * `--remote` (or they hit a local simulated store), have no `--json` output,
 * and secret values go in via stdin — never `--value`, which leaks the
 * secret through argv.
 *
 * The Deploy-to-Cloudflare button provisions the same control-plane
 * resources automatically, so this script is for users on the manual install
 * path (and for finishing a button install — it is idempotent).
 */

import { type SpawnSyncOptions, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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
function sh(cmd: string, args: string[], opts: Omit<SpawnSyncOptions, 'encoding'> = {}): string {
  const result = spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    die(`${cmd} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout ?? '';
}

/** Run a command but tolerate failure; returns { ok, stdout, stderr }. */
function shTry(
  cmd: string,
  args: string[],
): {
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

/**
 * Pipe a value into a command's stdin and wait for it to finish.
 *
 * Used for secret values: wrangler's `secrets-store secret create|update`
 * reads the value from stdin when `--value` is omitted and stdin is not a
 * TTY, so the secret never appears in argv or shell history.
 */
function shWithStdin(
  cmd: string,
  args: string[],
  stdinValue: string,
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, { encoding: 'utf-8', input: stdinValue });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Random base64url string for HMAC secrets. */
function randomSecret(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/** Strip ANSI escape codes so table parsing is colour-proof. */
function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC byte is the point
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Parse a cli-table3 box table (what wrangler's `logger.table` prints —
 * `secrets-store` has no `--json` flag) into rows of trimmed cells.
 * Border-only lines (`├──┼──┤`) contain no `│` cell separators and are
 * skipped naturally.
 */
function parseTableRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of stripAnsi(text).split('\n')) {
    if (!line.includes('│')) continue;
    const cells = line
      .split('│')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
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
  const wasRaw = input.isTTY && (input as unknown as { isRaw?: boolean }).isRaw;
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
        }
        if (ch === '\u0003') {
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

/** Look up a D1 database ID by name via `d1 list --json`. */
function findD1Id(name: string): string | undefined {
  const list = shTry('wrangler', ['d1', 'list', '--json']);
  if (!list.ok) return undefined;
  try {
    const dbs = JSON.parse(list.stdout);
    const existing = Array.isArray(dbs)
      ? (dbs as Array<{ name?: string; uuid?: string }>).find((d) => d.name === name)
      : undefined;
    return typeof existing?.uuid === 'string' ? existing.uuid : undefined;
  } catch {
    return undefined;
  }
}

function ensureD1(): string {
  step('D1 database');
  const existing = findD1Id('philharmonic');
  if (existing) {
    ok(`Found existing database: ${existing}`);
    return existing;
  }
  info('Creating new D1 database "philharmonic"...');
  const created = sh('wrangler', ['d1', 'create', 'philharmonic']);
  // Most robust: re-list and find by name. The create output is a config
  // snippet whose format varies (JSONC for JSON-config projects, TOML
  // otherwise), so it is only the fallback.
  const id = findD1Id('philharmonic');
  if (id) {
    ok(`Created: ${id}`);
    return id;
  }
  const m = created.match(/"?database_id"?\s*[:=]\s*"([0-9a-f-]+)"/i);
  if (!m?.[1]) {
    process.stderr.write(created);
    die(
      'Failed to determine the new D1 database_id (tried `wrangler d1 list --json` and the create output).',
    );
  }
  ok(`Created: ${m[1]}`);
  return m[1];
}

function ensureR2(): void {
  step('R2 bucket');
  const list = shTry('wrangler', ['r2', 'bucket', 'list']);
  // Tokenize so the check matches whole names only.
  const tokens = new Set(list.ok ? stripAnsi(list.stdout).split(/[\s│|]+/) : []);
  if (tokens.has('philharmonic-artifacts')) {
    ok('Bucket "philharmonic-artifacts" already exists');
    return;
  }
  sh('wrangler', ['r2', 'bucket', 'create', 'philharmonic-artifacts']);
  ok('Created bucket "philharmonic-artifacts"');
}

function ensureQueues(): void {
  step('Queues');
  const list = shTry('wrangler', ['queues', 'list']);
  // Tokenize so "philharmonic-dispatch" cannot substring-match the DLQ name.
  const tokens = new Set(list.ok ? stripAnsi(list.stdout).split(/[\s│|]+/) : []);
  for (const name of ['philharmonic-dispatch', 'philharmonic-dispatch-dlq']) {
    if (tokens.has(name)) {
      ok(`Queue "${name}" already exists`);
      continue;
    }
    sh('wrangler', ['queues', 'create', name]);
    ok(`Created queue "${name}"`);
  }
}

/**
 * List Secrets Store stores as `{ name, id }`.
 *
 * `store list` has no `--json` flag and exits non-zero when the account has
 * no stores at all, so: a "no stores" failure is an empty list, any other
 * failure (or unparseable output) is `null` = "unknown".
 */
function listStores(): Array<{ name: string; id: string }> | null {
  const r = shTry('wrangler', ['secrets-store', 'store', 'list', '--per-page', '100', '--remote']);
  if (!r.ok) {
    return /returned no stores/i.test(stripAnsi(r.stdout + r.stderr)) ? [] : null;
  }
  const stores = parseTableRows(r.stdout)
    .filter((cells) => cells.length >= 2 && cells[0] !== 'Name')
    .map((cells) => ({ name: cells[0] ?? '', id: cells[1] ?? '' }))
    .filter((s) => s.name !== '' && /^[0-9a-f-]{8,}$/i.test(s.id));
  return stores.length > 0 ? stores : null;
}

/** Ensure the Secrets Store exists (remotely). Returns its ID. */
function ensureSecretsStore(): string {
  step('Secrets Store');
  const stores = listStores();
  const existing = stores?.find((s) => s.name === SECRETS_STORE_NAME);
  if (existing) {
    ok(`Found existing store: ${existing.id}`);
    return existing.id;
  }
  if (stores === null) {
    info('Could not list existing stores; attempting to create...');
  }
  // `--remote` is required: without it wrangler creates a LOCAL simulated
  // store and the deployed Worker would never see the secrets.
  const r = shTry('wrangler', ['secrets-store', 'store', 'create', SECRETS_STORE_NAME, '--remote']);
  if (r.ok) {
    // Success output: `✅ Created store! (Name: <name>, ID: <id>)`
    const m = stripAnsi(r.stdout).match(/ID:\s*([0-9a-f-]{8,})\)?/i);
    if (m?.[1]) {
      ok(`Created store: ${m[1]}`);
      return m[1];
    }
  }
  // Create failed (e.g. it already exists) or the output changed shape —
  // fall back to listing by name.
  const after = listStores();
  const found = after?.find((s) => s.name === SECRETS_STORE_NAME);
  if (found) {
    ok(`Found store: ${found.id}`);
    return found.id;
  }
  process.stderr.write(r.stdout + r.stderr);
  die(
    `Could not create or find the "${SECRETS_STORE_NAME}" Secrets Store. Check \`wrangler secrets-store store list --remote\` and the Cloudflare dashboard.`,
  );
}

/**
 * List secrets in a store as `{ name, id }`.
 *
 * `secret list` takes the store ID as a positional, needs `--remote`, has no
 * `--json` flag, and exits non-zero when the store is empty. Returns `[]`
 * for a known-empty store and `null` when the state is unknown (command
 * failed some other way, or the table could not be parsed).
 */
function listSecrets(storeId: string): Array<{ name: string; id: string }> | null {
  const r = shTry('wrangler', [
    'secrets-store',
    'secret',
    'list',
    storeId,
    '--per-page',
    '100',
    '--remote',
  ]);
  if (!r.ok) {
    return /returned no secrets/i.test(stripAnsi(r.stdout + r.stderr)) ? [] : null;
  }
  const secrets = parseTableRows(r.stdout)
    .filter((cells) => cells.length >= 2 && cells[0] !== 'Name')
    .map((cells) => ({ name: cells[0] ?? '', id: cells[1] ?? '' }))
    .filter((s) => s.name !== '' && /^[0-9a-f-]{8,}$/i.test(s.id));
  return secrets.length > 0 ? secrets : null;
}

/** Whether a secret exists in the store; `null` = could not determine. */
function secretExists(storeId: string, name: string): boolean | null {
  const secrets = listSecrets(storeId);
  if (secrets === null) return null;
  return secrets.some((s) => s.name === name);
}

async function putSecret(
  storeId: string,
  name: string,
  value: string,
  { overwrite = false }: { overwrite?: boolean } = {},
): Promise<void> {
  const secrets = listSecrets(storeId);

  if (secrets === null) {
    // Unknown state: never silently overwrite — ask first, then attempt a
    // create (update is impossible anyway without the secret's ID).
    warn(`Could not list existing secrets, so it's unknown whether ${name} is already set.`);
    if (!(await confirm(`Try to create ${name} anyway?`))) {
      info(`Skipped ${name}`);
      return;
    }
    const created = shWithStdin(
      'wrangler',
      [
        'secrets-store',
        'secret',
        'create',
        storeId,
        '--name',
        name,
        '--scopes',
        'workers',
        '--remote',
      ],
      value,
    );
    if (!created.ok) {
      process.stderr.write(created.stdout + created.stderr);
      die(
        `Failed to create ${name}. If it already exists, rotate it in the Cloudflare ` +
          `dashboard (Secrets Store → ${SECRETS_STORE_NAME}) or retry once \`wrangler ` +
          `secrets-store secret list ${storeId} --remote\` works.`,
      );
    }
    ok(`Stored ${name}`);
    return;
  }

  const existing = secrets.find((s) => s.name === name);
  if (existing && !overwrite) {
    info(`${name} already set (skipping; pass --rotate to overwrite)`);
    return;
  }
  // Update addresses the secret by ID (`--secret-id`), not by name; the
  // value goes in via stdin in both cases.
  const args = existing
    ? ['secrets-store', 'secret', 'update', storeId, '--secret-id', existing.id, '--remote']
    : [
        'secrets-store',
        'secret',
        'create',
        storeId,
        '--name',
        name,
        '--scopes',
        'workers',
        '--remote',
      ];
  const r = shWithStdin('wrangler', args, value);
  if (!r.ok) {
    process.stderr.write(r.stdout + r.stderr);
    die(`Failed to ${existing ? 'update' : 'create'} ${name}`);
  }
  ok(`${existing ? 'Rotated' : 'Stored'} ${name}`);
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
function patchJsonc(source: string, path: jsoncParser.JSONPath, value: unknown): string {
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
  });
  ok('Migrations applied');
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const rotate = process.argv.includes('--rotate');

  process.stdout.write(`${c.bold}🎼 Philharmonic bootstrap${c.reset}\n`);
  info('Provisions Cloudflare resources for a fresh deploy.');
  info('Safe to re-run. Pass --rotate to rotate RUN_TOKEN_SECRET and re-prompt credentials.');

  ensureWranglerLogin();

  // Idempotent resource creation.
  const d1Id = ensureD1();
  ensureR2();
  ensureQueues();
  const storeId = ensureSecretsStore();

  // Patch wrangler.jsonc with discovered IDs.
  await patchD1Id(d1Id);
  await patchSecretsStoreIds(storeId);

  // Generate and store the internal secret.
  step('Internal secret (HMAC key for run tokens)');
  await putSecret(storeId, 'RUN_TOKEN_SECRET', randomSecret(), { overwrite: rotate });

  // Prompt for external credentials.
  step('External credentials');
  info('These are stored in Cloudflare Secrets Store and never written to disk.');

  const credentials = [
    {
      name: 'ANTHROPIC_API_KEY',
      question: 'Paste your ANTHROPIC_API_KEY (input hidden):',
    },
    {
      name: 'GITHUB_TOKEN',
      question: 'Paste your GITHUB_TOKEN (fine-grained PAT, repo + PR scope, input hidden):',
    },
  ];
  for (const { name, question } of credentials) {
    const exists = secretExists(storeId, name);
    if (exists === true && !rotate) {
      info(`${name} already set (skipping; pass --rotate to replace)`);
      continue;
    }
    if (exists === null) {
      warn(`Could not determine whether ${name} is already set.`);
    }
    const value = await promptSecret(question);
    if (!value) die(`${name} is required.`);
    await putSecret(storeId, name, value, { overwrite: true });
  }

  rl.close();

  // Migrations.
  runMigrations();

  // Done.
  process.stdout.write(`\n${c.green}${c.bold}✓ Bootstrap complete.${c.reset}\n\n`);
  process.stdout.write(`${c.bold}Next:${c.reset}\n`);
  process.stdout.write(
    `  1. ${c.bold}pnpm run deploy${c.reset} ${c.dim}(needs Docker running — the sandbox container image builds during deploy)${c.reset}\n`,
  );
  process.stdout.write('  2. Configure Cloudflare Access pointing at the deployed Worker URL\n');
  process.stdout.write(
    `  3. Set ${c.cyan}ACCESS_TEAM_DOMAIN${c.reset} and ${c.cyan}ACCESS_AUD${c.reset} in wrangler.jsonc \`vars\`, then re-run \`pnpm run deploy\`\n`,
  );
  process.stdout.write(
    `  4. Visit your Worker URL — Philharmonic's PostDeploySetup screen will guide you the rest of the way\n\n`,
  );
}

main().catch((err) => {
  rl.close();
  die(err instanceof Error ? err.message : String(err));
});
