/**
 * Shared types for the Worker. Env mirrors the bindings declared in
 * wrangler.jsonc; keep them in sync. See SPEC §16.
 */

import type { Sandbox as CFSandbox } from '@cloudflare/sandbox';

export interface Env {
  ASSETS: Fetcher;

  DB: D1Database;
  ARTIFACTS: R2Bucket;
  DISPATCH: Queue;

  TASKS_ROOM: DurableObjectNamespace;
  ORCHESTRATOR: DurableObjectNamespace;
  Sandbox: DurableObjectNamespace<CFSandbox>;
  RUN: Workflow;

  // Three required secrets (SPEC §7.3) — INTERNAL_API_TOKEN was removed in
  // v2: the TasksRoom /broadcast route is binding-internal, nothing verifies it.
  ANTHROPIC_API_KEY: SecretsStoreSecret;
  GITHUB_TOKEN: SecretsStoreSecret;
  RUN_TOKEN_SECRET: SecretsStoreSecret;

  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  API_BASE: string;
}

export interface AccessUser {
  email: string;
  sub: string;
  identityNonce?: string;
}

export type Variables = {
  user: AccessUser;
};
