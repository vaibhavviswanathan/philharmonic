#!/usr/bin/env node
/**
 * Tasks MCP server. Runs inside the per-task sandbox container, hooked up to
 * Claude via stdio. Exposes the philharmonic.* tool surface from SPEC §14.1.
 *
 * Authenticated by the run token at $PHILHARMONIC_RUN_TOKEN_FILE; every API
 * call hits {API_BASE}/api/internal/* with `Authorization: Bearer <token>`.
 *
 * Failure semantics (SPEC §14.3): retry network errors and 5xx only (3
 * attempts, exponential backoff); never retry 4xx; never retry after a 2xx.
 * Tool errors surface the API's structured error body, and response bodies
 * are parsed defensively (edge HTML error pages fall back to raw text).
 */

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const API_BASE = process.env.PHILHARMONIC_API_BASE;
const TOKEN_FILE = process.env.PHILHARMONIC_RUN_TOKEN_FILE;

if (!API_BASE) {
  console.error('PHILHARMONIC_API_BASE is not set.');
  process.exit(2);
}
if (!TOKEN_FILE) {
  console.error('PHILHARMONIC_RUN_TOKEN_FILE is not set.');
  process.exit(2);
}

const TOKEN = readFileSync(TOKEN_FILE, 'utf-8').trim();

const MAX_ATTEMPTS = 3;

interface ApiResult {
  status: number;
  ok: boolean;
  /** Parsed JSON body, or null when the response wasn't JSON. */
  body: unknown;
  /** Raw response text — the fallback when JSON parsing fails. */
  rawText: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Call the Philharmonic API. `path` may be absolute-path ("/api/internal/…")
 * or any worker-relative URL (e.g. the uploadUrl returned by POST /uploads) —
 * both resolve against PHILHARMONIC_API_BASE.
 */
async function api(path: string, init: RequestInit = {}): Promise<ApiResult> {
  const url = new URL(path, API_BASE).toString();
  let lastNetworkErr: unknown;
  let last5xx: ApiResult | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${TOKEN}`,
          ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch (err) {
      // Network failure — never got a response; safe-ish to retry (at-least-once).
      lastNetworkErr = err;
      continue;
    }

    const rawText = await res.text().catch(() => '');
    // Defensive parse: an HTML edge error page must not crash the tool or be
    // misclassified as retryable.
    let body: unknown = null;
    if (rawText) {
      try {
        body = JSON.parse(rawText);
      } catch {
        body = null;
      }
    }
    const result: ApiResult = { status: res.status, ok: res.ok, body, rawText };

    if (res.status >= 500) {
      // Transient server error — retry.
      last5xx = result;
      continue;
    }
    // 2xx and 4xx are final: never retry a success (at-least-once POSTs would
    // duplicate comments) and never retry a client error.
    return result;
  }

  if (last5xx) return last5xx;
  throw lastNetworkErr ?? new Error('Philharmonic API call failed');
}

function asTextResult(body: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
  };
}

function asError(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

/** Render the API's structured error body ({ error: { code, message } }), falling back to raw text. */
function describeApiError(r: ApiResult): string {
  const body = r.body as { error?: { code?: string; message?: string } } | null;
  if (body && typeof body === 'object' && body.error && typeof body.error === 'object') {
    const code = body.error.code ?? 'error';
    const message = body.error.message ?? JSON.stringify(body.error);
    return `${code}: ${message}`;
  }
  if (r.rawText) return r.rawText.slice(0, 500);
  return 'no response body';
}

function toolError(tool: string, r: ApiResult) {
  return asError(`${tool} failed (HTTP ${r.status}) — ${describeApiError(r)}`);
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.patch': 'text/x-diff',
  '.diff': 'text/x-diff',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

function guessContentType(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * file_path proof flow (SPEC §14.1): the MCP server performs the upload
 * itself — POST /uploads → PUT the bytes → returns the uploadId for /proof.
 */
async function uploadFile(
  filePath: string,
): Promise<{ uploadId: string } | ReturnType<typeof asError>> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (err) {
    return asError(
      `add_proof_of_work: cannot read file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const filename = basename(filePath);
  const contentType = guessContentType(filename);

  const created = await api('/api/internal/uploads', {
    method: 'POST',
    body: JSON.stringify({ filename, contentType, sizeBytes: bytes.byteLength }),
  });
  if (created.status >= 400) return toolError('add_proof_of_work (create upload)', created);
  const { uploadId, uploadUrl } = (created.body ?? {}) as {
    uploadId?: string;
    uploadUrl?: string;
  };
  if (!uploadId || !uploadUrl) {
    return asError(
      `add_proof_of_work: upload endpoint returned no uploadId/uploadUrl — ${created.rawText.slice(0, 300)}`,
    );
  }

  // The uploadUrl is worker-relative; api() resolves it against API_BASE.
  const put = await api(uploadUrl, {
    method: 'PUT',
    body: bytes,
    headers: { 'Content-Type': contentType },
  });
  if (put.status >= 400) return toolError('add_proof_of_work (upload bytes)', put);

  return { uploadId };
}

const server = new Server(
  { name: 'philharmonic-tasks-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'read_task',
      description: 'Return the current task and its project as JSON.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'post_comment',
      description: 'Post a comment from the agent on the task.',
      inputSchema: {
        type: 'object',
        properties: { body: { type: 'string', minLength: 1 } },
        required: ['body'],
        additionalProperties: false,
      },
    },
    {
      name: 'update_status',
      description: 'Move the task to a new status. Only "review" is honored by the API.',
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string', enum: ['review', 'ready'] } },
        required: ['to'],
        additionalProperties: false,
      },
    },
    {
      name: 'add_proof_of_work',
      description:
        'Attach proof of work to the task. Pass inline text via `content`, or a file on disk via `file_path` (the server uploads it for you). Provide exactly one of the two.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['pr_diff', 'screenshot', 'video', 'logs', 'ci_summary', 'other'],
          },
          caption: { type: 'string' },
          content: {
            type: 'string',
            description: 'Inline text proof (CI summary, log digest, …).',
          },
          file_path: {
            type: 'string',
            description: 'Absolute path of a file to upload (screenshot, video, log, …).',
          },
        },
        required: ['kind'],
        additionalProperties: false,
      },
    },
    {
      name: 'read_workflow_md',
      description: 'Return the project WORKFLOW.md template.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'declare_dependency',
      description:
        'Mark this task as blocked by another task. Use when you discover the work cannot be completed until another task ships. After calling this, post a brief explanatory comment and exit — the run will be re-queued automatically once the blocker resolves.',
      inputSchema: {
        type: 'object',
        properties: {
          blockedBy: {
            type: 'string',
            description: "Task identifier (e.g. 'PHIL-7') or task UUID, in this project.",
          },
          reason: {
            type: 'string',
            description: 'Short explanation of why this work depends on that task.',
          },
        },
        required: ['blockedBy'],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case 'read_task': {
        const r = await api('/api/internal/task');
        if (r.status >= 400) return toolError('read_task', r);
        return asTextResult(r.body);
      }
      case 'post_comment': {
        const r = await api('/api/internal/comments', {
          method: 'POST',
          body: JSON.stringify({ body: (args as { body: string }).body }),
        });
        if (r.status >= 400) return toolError('post_comment', r);
        return asTextResult(r.body);
      }
      case 'update_status': {
        const r = await api('/api/internal/status', {
          method: 'POST',
          body: JSON.stringify({ to: (args as { to: string }).to }),
        });
        if (r.status >= 400) return toolError('update_status', r);
        return asTextResult(r.body);
      }
      case 'add_proof_of_work': {
        const { kind, caption, content, file_path } = args as {
          kind: string;
          caption?: string;
          content?: string;
          file_path?: string;
        };
        if (content !== undefined && file_path !== undefined) {
          return asError('add_proof_of_work: provide either content or file_path, not both.');
        }
        if (content === undefined && file_path === undefined) {
          return asError(
            'add_proof_of_work: provide content (inline text) or file_path (file upload).',
          );
        }

        let uploadId: string | undefined;
        if (file_path !== undefined) {
          const uploaded = await uploadFile(file_path);
          if ('isError' in uploaded) return uploaded;
          uploadId = uploaded.uploadId;
        }

        const r = await api('/api/internal/proof', {
          method: 'POST',
          body: JSON.stringify({ kind, caption, content, uploadId }),
        });
        if (r.status >= 400) return toolError('add_proof_of_work', r);
        return asTextResult(r.body);
      }
      case 'read_workflow_md': {
        const r = await api('/api/internal/workflow-md');
        if (r.status >= 400) return toolError('read_workflow_md', r);
        return asTextResult(r.body);
      }
      case 'declare_dependency': {
        const r = await api('/api/internal/dependencies', {
          method: 'POST',
          body: JSON.stringify(args),
        });
        if (r.status >= 400) return toolError('declare_dependency', r);
        return asTextResult(r.body);
      }
      default:
        return asError(`Unknown tool: ${name}`);
    }
  } catch (err) {
    // Reached only when retries are exhausted on network errors / repeated
    // 5xx-with-no-response — never silently succeed.
    return asError(
      `Philharmonic API unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
