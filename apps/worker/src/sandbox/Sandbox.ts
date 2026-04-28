/**
 * Re-export the Sandbox Durable Object class from @cloudflare/sandbox so it can
 * be wired up as a binding in wrangler.jsonc. SPEC §13.
 *
 * One sandbox per task (sandbox_id == task_id). The Workflow's `prepare` step
 * checks the repo out into /workspace; `runAgent` runs `claude -p` (M6) or
 * `echo` (M5) inside it.
 */

export { Sandbox } from '@cloudflare/sandbox';
