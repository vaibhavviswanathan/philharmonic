/**
 * REST API request/response DTOs shared between the Worker, the SPA, and the
 * Tasks MCP server. Filled out in M2 per SPEC §8. M0 ships a stable surface.
 */

export type ApiError = {
  error: {
    code: string;
    message: string;
  };
};
