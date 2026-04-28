#!/usr/bin/env node
/**
 * Tasks MCP server. Runs inside the per-task sandbox container, hooked up to
 * Claude via stdio. Exposes the philharmonic.* tool surface from SPEC §14.1.
 *
 * Authenticated by the run token at $PHILHARMONIC_RUN_TOKEN_FILE; every API
 * call hits {API_BASE}/api/internal/* with `Authorization: Bearer <token>`.
 */

import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

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

interface ApiResult {
  status: number;
  body: unknown;
}

async function api(path: string, init: RequestInit = {}, retries = 3): Promise<ApiResult> {
  const url = `${API_BASE}${path}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${TOKEN}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (res.status === 401) {
        // Token rejected — surface immediately, no point retrying.
        return { status: 401, body };
      }
      if (!res.ok && res.status >= 500) {
        // Retry transient server errors.
        lastErr = new Error(`HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        continue;
      }
      return { status: res.status, body };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
  throw lastErr ?? new Error('api call failed');
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

const server = new Server(
  { name: 'philharmonic-tasks-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'read_task',
      description: 'Return the current task as JSON.',
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
        'Attach proof of work (text content or a file path uploaded via the upload endpoint).',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['pr_diff', 'screenshot', 'video', 'logs', 'ci_summary', 'other'],
          },
          caption: { type: 'string' },
          content: { type: 'string' },
          uploadId: { type: 'string' },
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
        if (r.status >= 400) return asError(`read_task failed (${r.status})`);
        return asTextResult(r.body);
      }
      case 'post_comment': {
        const r = await api('/api/internal/comments', {
          method: 'POST',
          body: JSON.stringify({ body: (args as { body: string }).body }),
        });
        if (r.status >= 400) return asError(`post_comment failed (${r.status})`);
        return asTextResult(r.body);
      }
      case 'update_status': {
        const r = await api('/api/internal/status', {
          method: 'POST',
          body: JSON.stringify({ to: (args as { to: string }).to }),
        });
        if (r.status >= 400) return asError(`update_status failed (${r.status})`);
        return asTextResult(r.body);
      }
      case 'add_proof_of_work': {
        const r = await api('/api/internal/proof', {
          method: 'POST',
          body: JSON.stringify(args),
        });
        if (r.status >= 400) return asError(`add_proof_of_work failed (${r.status})`);
        return asTextResult(r.body);
      }
      case 'read_workflow_md': {
        const r = await api('/api/internal/workflow-md');
        if (r.status >= 400) return asError(`read_workflow_md failed (${r.status})`);
        return asTextResult(r.body);
      }
      case 'declare_dependency': {
        const r = await api('/api/internal/dependencies', {
          method: 'POST',
          body: JSON.stringify(args),
        });
        if (r.status >= 400) return asError(`declare_dependency failed (${r.status})`);
        return asTextResult(r.body);
      }
      default:
        return asError(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return asError(err instanceof Error ? err.message : String(err));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
