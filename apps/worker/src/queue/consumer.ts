/**
 * Dispatch Queue consumer. Forwards every message to the singleton Orchestrator
 * DO, which decides whether to claim or requeue. See SPEC §11.
 *
 * Concurrency-limited tasks are retried via `message.retry({ delaySeconds: 30 })`
 * — the Queue's retry budget (max_retries: 5 in wrangler.jsonc) catches genuinely
 * stuck messages.
 */

import type { DispatchMessage, DispatchResult } from '../do/Orchestrator';
import type { Env } from '../lib/types';

export async function handleDispatchQueue(
  batch: MessageBatch<DispatchMessage>,
  env: Env,
): Promise<void> {
  const id = env.ORCHESTRATOR.idFromName('singleton');
  const stub = env.ORCHESTRATOR.get(id);

  const messages = batch.messages.map((m) => m.body);
  const res = await stub.fetch('https://internal/dispatch', {
    method: 'POST',
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) {
    throw new Error(`Orchestrator dispatch failed: ${res.status} ${await res.text()}`);
  }
  const { results } = (await res.json()) as { results: DispatchResult[] };

  const byTaskId = new Map<string, DispatchResult>();
  for (const r of results) byTaskId.set(r.taskId, r);

  for (const m of batch.messages) {
    const result = byTaskId.get(m.body.taskId);
    if (!result) {
      m.retry({ delaySeconds: 30 });
      continue;
    }
    if (result.outcome === 'requeue') {
      m.retry({ delaySeconds: 30 });
    } else {
      m.ack();
    }
  }
}
