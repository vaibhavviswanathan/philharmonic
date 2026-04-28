/**
 * Philharmonic Worker — M0 stub.
 *
 * Serves the SPA via the ASSETS binding and answers /api/* with a placeholder
 * JSON response so health checks succeed end-to-end.
 *
 * Real routes (auth, projects, tasks, runs, WS upgrade) land in M1+ per SPEC §17.
 */

export interface Env {
  ASSETS: Fetcher;

  // Resources — present in wrangler.jsonc, unused at M0.
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  DISPATCH: Queue;

  // Secrets Store bindings.
  ANTHROPIC_API_KEY: SecretsStoreSecret;
  GITHUB_TOKEN: SecretsStoreSecret;
  RUN_TOKEN_SECRET: SecretsStoreSecret;
  INTERNAL_API_TOKEN: SecretsStoreSecret;

  // Plain vars (filled in post-deploy).
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  API_BASE: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
      return Response.json({
        ok: true,
        name: 'philharmonic',
        milestone: 'M0',
        setupRequired: !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN,
      });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
