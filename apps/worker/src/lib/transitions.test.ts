import { describe, expect, it } from 'vitest';
import type { TaskStatus } from './schema';
import { type Actor, TransitionError, assertAllowed } from './transitions';

const STATUSES: TaskStatus[] = [
  'backlog',
  'blocked',
  'ready',
  'running',
  'review',
  'done',
  'cancelled',
];
const ACTORS: Actor[] = ['human', 'orch', 'agent'];

/** The full §8.1 matrix: from → to → sole allowed actor. */
const ALLOWED: Array<[TaskStatus, TaskStatus, Actor]> = [
  ['backlog', 'ready', 'human'],
  ['backlog', 'blocked', 'human'],
  ['backlog', 'cancelled', 'human'],
  ['blocked', 'backlog', 'human'],
  ['blocked', 'ready', 'human'],
  ['blocked', 'cancelled', 'human'],
  ['ready', 'backlog', 'human'],
  ['ready', 'blocked', 'human'],
  ['ready', 'running', 'orch'],
  ['ready', 'cancelled', 'human'],
  ['running', 'review', 'agent'],
  ['running', 'blocked', 'agent'], // declare-dependency lane only
  ['running', 'ready', 'human'], // pull back a stuck run
  ['running', 'cancelled', 'human'],
  ['review', 'done', 'human'],
  ['review', 'ready', 'human'],
  ['review', 'cancelled', 'human'],
  ['cancelled', 'ready', 'human'],
  ['cancelled', 'backlog', 'human'],
];

describe('transitions', () => {
  it.each(ALLOWED)('%s → %s is allowed for %s and only %s', (from, to, actor) => {
    expect(() => assertAllowed(from, to, actor)).not.toThrow();
    for (const other of ACTORS.filter((a) => a !== actor)) {
      expect(() => assertAllowed(from, to, other)).toThrowError(TransitionError);
      try {
        assertAllowed(from, to, other);
      } catch (err) {
        expect((err as TransitionError).code).toBe('forbidden');
      }
    }
  });

  it('rejects every edge not in the matrix as invalid, for every actor', () => {
    const allowedKeys = new Set(ALLOWED.map(([f, t]) => `${f}>${t}`));
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (from === to || allowedKeys.has(`${from}>${to}`)) continue;
        for (const actor of ACTORS) {
          try {
            assertAllowed(from, to, actor);
            expect.unreachable(`${from} → ${to} as ${actor} should have thrown`);
          } catch (err) {
            expect(err).toBeInstanceOf(TransitionError);
            expect((err as TransitionError).code).toBe('invalid');
          }
        }
      }
    }
  });

  it('done is strictly terminal — not even cancellation', () => {
    for (const to of STATUSES.filter((s) => s !== 'done')) {
      expect(() => assertAllowed('done', to, 'human')).toThrowError(TransitionError);
    }
  });
});
