/**
 * Local-dev wrapper for `wrangler dev`.
 *
 * The root wrangler.jsonc declares secrets_store_secrets with empty store_ids
 * (filled in by `pnpm bootstrap`). Miniflare's local mode asserts these are
 * non-empty, so we generate a transient wrangler.dev.jsonc with placeholder
 * IDs and point wrangler at that.
 *
 * Usage: `pnpm dev` — passes through any extra argv to wrangler (e.g. --port).
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'jsonc-parser';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = resolve(ROOT, 'wrangler.jsonc');
const OUT = resolve(ROOT, 'wrangler.dev.jsonc');

const cfg = parse(readFileSync(SRC, 'utf8'));

for (const s of cfg.secrets_store_secrets ?? []) {
  if (!s.store_id) s.store_id = 'local-dev-store';
}
for (const db of cfg.d1_databases ?? []) {
  if (!db.database_id) db.database_id = 'local-dev-db';
}

writeFileSync(OUT, JSON.stringify(cfg, null, 2));

const extra = process.argv.slice(2);
const child = spawn(
  'wrangler',
  ['dev', '--config', 'wrangler.dev.jsonc', ...extra],
  { cwd: ROOT, stdio: 'inherit' },
);
child.on('exit', (code) => process.exit(code ?? 0));
