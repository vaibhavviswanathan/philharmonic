# Tasks MCP server

Implementation lives in `tasks-mcp/`. Built and pre-installed into the sandbox
image starting in M6 per SPEC §14.

The server exposes `philharmonic.*` tools to the in-sandbox agent (`read_task`,
`post_comment`, `update_status`, `add_proof_of_work`, `read_workflow_md`). It
authenticates to the Worker's `/api/internal/*` routes using the run token at
`$PHILHARMONIC_RUN_TOKEN_FILE`.
