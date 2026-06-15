/**
 * WebSocket client. One connection per open project tab. Reconnects with
 * exponential backoff (start 250ms, cap 30s, jitter ±20%) per SPEC §9.2.
 *
 * Rules (SPEC §9.2):
 *   - Outbound messages queue until the socket is OPEN, then flush.
 *   - Active run subscriptions are re-sent after every (re)connect — a
 *     `subscribe.run` sent while CONNECTING is silently dropped by the browser.
 *   - The refetch-on-reconnect callback fires when the NEW socket opens,
 *     never in the close handler.
 *   - Heartbeat is the raw string `ping` every 25s; the server auto-responds
 *     `pong` (§10.4). Non-JSON inbound frames are ignored silently.
 */

import type { ClientMessage, ServerMessage } from '@philharmonic/shared';

const PING_INTERVAL_MS = 25_000;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 30_000;

type Handler = (message: ServerMessage) => void;

export interface WsConnection {
  send(message: ClientMessage): void;
  close(): void;
  readonly state: 'connecting' | 'open' | 'closed';
}

export function connectProjectStream(
  slug: string,
  onMessage: Handler,
  onReconnect?: () => void,
): WsConnection {
  let socket: WebSocket | null = null;
  let attempts = 0;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let state: 'connecting' | 'open' | 'closed' = 'connecting';
  let hasConnectedBefore = false;

  /** Messages queued while the socket isn't OPEN; flushed on open. */
  const outbox: ClientMessage[] = [];
  /** Run-log subscriptions to re-establish after every (re)connect. */
  const runSubscriptions = new Set<string>();

  function clearPing() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function open() {
    if (closed) return;
    state = 'connecting';
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws/projects/${encodeURIComponent(slug)}`;
    const ws = new WebSocket(url);
    socket = ws;

    ws.addEventListener('open', () => {
      if (closed || socket !== ws) return;
      attempts = 0;
      state = 'open';

      // Flush queued messages. Run (un)subscriptions are tracked in
      // `runSubscriptions` (updated in send()), so skip stale copies here —
      // the loop below sends the current subscription set to the new socket.
      for (const m of outbox.splice(0)) {
        if (m.type === 'subscribe.run' || m.type === 'unsubscribe.run') continue;
        ws.send(JSON.stringify(m));
      }
      for (const runId of runSubscriptions) {
        ws.send(JSON.stringify({ type: 'subscribe.run', runId } satisfies ClientMessage));
      }

      // Heartbeat: raw string frame, answered by the DO's auto-responder
      // without waking it from hibernation (SPEC §10.4).
      pingTimer = setInterval(() => {
        try {
          ws.send('ping');
        } catch {
          /* socket gone; close handler will reconnect */
        }
      }, PING_INTERVAL_MS);

      // Refetch-the-gap callback: fires on the new socket's open event so the
      // REST refetch races nothing (never in the close handler — refetch
      // storms, and it misses the gap it exists to fill).
      if (hasConnectedBefore) onReconnect?.();
      hasConnectedBefore = true;
    });

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(ev.data) as ServerMessage;
      } catch {
        // Not JSON — e.g. the raw "pong" heartbeat reply. Ignore silently.
        return;
      }
      onMessage(message);
    });

    ws.addEventListener('close', () => {
      if (socket !== ws) return;
      clearPing();
      socket = null;
      state = 'closed';
      if (closed) return;
      const delay = backoffDelay(attempts++);
      reconnectTimer = setTimeout(open, delay);
    });

    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  open();

  return {
    send(message: ClientMessage) {
      // Track run subscriptions so they survive reconnects.
      if (message.type === 'subscribe.run') {
        runSubscriptions.add(message.runId);
      } else if (message.type === 'unsubscribe.run') {
        runSubscriptions.delete(message.runId);
      }
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      } else {
        // Queue until OPEN; flushed by the open handler.
        outbox.push(message);
      }
    },
    close() {
      closed = true;
      clearPing();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
    },
    get state() {
      return state;
    },
  };
}

function backoffDelay(attempt: number): number {
  const base = Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS);
  const jitter = base * (Math.random() * 0.4 - 0.2);
  return Math.max(RECONNECT_MIN_MS, base + jitter);
}
