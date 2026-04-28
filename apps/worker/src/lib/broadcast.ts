/**
 * Helper for pushing events into the per-project TasksRoom Durable Object.
 *
 * Always called from inside the API Worker — same Worker, same script, same
 * binding boundary, so we don't need INTERNAL_API_TOKEN here. That token is for
 * cross-Worker calls (e.g. the egress proxy reporting upstream).
 */

import type { ServerMessage } from '@philharmonic/shared/ws-protocol';
import type { Env } from './types';

export async function broadcast(
  env: Env,
  projectId: string,
  message: ServerMessage,
): Promise<void> {
  const id = env.TASKS_ROOM.idFromName(projectId);
  const stub = env.TASKS_ROOM.get(id);
  // Fire-and-forget is fine — the API write has already committed to D1; the
  // broadcast is a UX nicety, not a correctness requirement.
  await stub.fetch('https://internal/broadcast', {
    method: 'POST',
    body: JSON.stringify(message),
  });
}

export function safeBroadcast(
  env: Env,
  projectId: string,
  message: ServerMessage,
): Promise<void> {
  return broadcast(env, projectId, message).catch((err) => {
    console.warn('broadcast failed:', err);
  });
}
