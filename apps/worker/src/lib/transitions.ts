/**
 * Status transition rules for tasks. See SPEC §8.1.
 *
 * Mapped by who's allowed to make the transition:
 *   - 'human'  — anyone with Access (most user-driven moves)
 *   - 'orch'   — only the Orchestrator DO (claim → running)
 *   - 'agent'  — only a run-token holder (running → review)
 *
 * `blocked` is the holding pattern for tasks with unresolved dependencies.
 * The API normally redirects backlog/blocked → ready into the `blocked` lane
 * when a blocker is unresolved (lib/dependencies.ts gateReadyTransition).
 */

import type { TaskStatus } from './schema';

export type Actor = 'human' | 'orch' | 'agent';

const RULES: Record<TaskStatus, Partial<Record<TaskStatus, Actor>>> = {
  backlog: {
    ready: 'human',
    blocked: 'human', // adding a blocker forces this
    cancelled: 'human',
  },
  blocked: {
    backlog: 'human',
    ready: 'human', // manual override; system uses this path on cascade unblock
    cancelled: 'human',
  },
  ready: {
    backlog: 'human',
    blocked: 'human', // adding a new blocker
    running: 'orch',
    cancelled: 'human',
  },
  running: {
    review: 'agent',
    cancelled: 'human',
    ready: 'human', // human override — pulls a stuck run back
  },
  review: {
    done: 'human',
    ready: 'human',
    cancelled: 'human',
  },
  done: {
    // terminal — no transitions out except via reopen which we don't support in v1
  },
  cancelled: {
    ready: 'human', // re-queue
    backlog: 'human',
  },
};

export class TransitionError extends Error {
  constructor(
    public readonly code: 'invalid' | 'forbidden',
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
    public readonly actor: Actor,
  ) {
    super(`Cannot transition ${from} → ${to} as ${actor} (${code})`);
  }
}

export function assertAllowed(from: TaskStatus, to: TaskStatus, actor: Actor): void {
  const allowed = RULES[from]?.[to];
  if (!allowed) {
    throw new TransitionError('invalid', from, to, actor);
  }
  if (allowed !== actor) {
    throw new TransitionError('forbidden', from, to, actor);
  }
}
