/**
 * Dispatch Queue consumer. Forwards every batch to the singleton Orchestrator
 * DO, which decides per message: claimed / skipped / requeue. See SPEC §11.1.
 *
 * Backpressure NEVER uses message.retry() — retries burn the delivery budget
 * (max_retries: 5) and a healthy task waiting behind a busy project would
 * dead-letter after ~2.5 minutes. `requeue` outcomes ack and re-send a fresh
 * message with a 30s delay instead. retry() is reserved for genuine
 * processing failures (Orchestrator unreachable, missing result) so the DLQ
 * keeps meaning "something is broken", not "we were busy".
 */

import { ulid } from 'ulid';
import type { DispatchMessage, DispatchResult } from '../do/Orchestrator';
import { safeBroadcast } from '../lib/broadcast';
import { getDb, schema } from '../lib/db';
import { eventDto } from '../lib/dto';
import type { Env } from '../lib/types';

const REQUEUE_DELAY_SECONDS = 30;
/** ~2h of 30s waits — past this, surface the problem instead of spinning. */
const MAX_REQUEUE_COUNT = 240;

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
    // Orchestrator failure — let the whole batch retry on the genuine budget.
    throw new Error(`Orchestrator dispatch failed: ${res.status} ${await res.text()}`);
  }
  const { results } = (await res.json()) as { results: DispatchResult[] };

  const byTaskId = new Map<string, DispatchResult>();
  for (const r of results) byTaskId.set(r.taskId, r);

  for (const m of batch.messages) {
    const result = byTaskId.get(m.body.taskId);
    if (!result) {
      // No verdict for this message — genuine processing failure.
      m.retry({ delaySeconds: REQUEUE_DELAY_SECONDS });
      continue;
    }
    if (result.outcome === 'requeue') {
      const count = m.body.requeueCount ?? 0;
      if (count >= MAX_REQUEUE_COUNT) {
        await surfaceRequeueCap(env, m.body);
      } else {
        await env.DISPATCH.send(
          { ...m.body, requeueCount: count + 1 },
          { delaySeconds: REQUEUE_DELAY_SECONDS },
        );
      }
      m.ack();
    } else {
      m.ack();
    }
  }
}

/**
 * The task has waited past the requeue cap for a free concurrency slot.
 * Leave it in `ready` (a human can pause or re-ready it) but write a system
 * event so the wait is visible on the task card.
 */
async function surfaceRequeueCap(env: Env, msg: DispatchMessage): Promise<void> {
  try {
    const db = getDb(env.DB);
    const inserted = await db
      .insert(schema.events)
      .values({
        id: ulid(),
        taskId: msg.taskId,
        runId: null,
        type: 'system',
        author: 'system',
        payload: {
          message:
            'Dispatch gave up: the task waited too long (~2h) for a free ' +
            'concurrency slot. Move it out of ready and back to retry.',
        },
        createdAt: new Date(),
      })
      .returning();
    if (inserted[0]) {
      await safeBroadcast(env, msg.projectId, {
        type: 'event.created',
        taskId: msg.taskId,
        event: eventDto(inserted[0]),
      });
    }
  } catch (err) {
    // The insert references tasks.id — a deleted task would throw here.
    console.warn('failed to surface requeue cap:', err);
  }
}
