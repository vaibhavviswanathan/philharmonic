/**
 * Shared types for the Worker. Env mirrors the bindings declared in
 * wrangler.jsonc; keep them in sync. See SPEC §16.
 */

export interface Env {
  ASSETS: Fetcher;

  DB: D1Database;
  ARTIFACTS: R2Bucket;
  DISPATCH: Queue;

  ANTHROPIC_API_KEY: SecretsStoreSecret;
  GITHUB_TOKEN: SecretsStoreSecret;
  RUN_TOKEN_SECRET: SecretsStoreSecret;
  INTERNAL_API_TOKEN: SecretsStoreSecret;

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
