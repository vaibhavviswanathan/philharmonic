/**
 * WebSocket client. One connection per open project tab. Reconnects with
 * exponential backoff (start 250ms, cap 30s, jitter ±20%) per SPEC §9.2.
 *
 * On reconnect the SPA refetches state via REST — no message replay yet.
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
  let closed = false;
  let state: 'connecting' | 'open' | 'closed' = 'connecting';

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
      attempts = 0;
      state = 'open';
      pingTimer = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: 'ping', t: Date.now() } satisfies ClientMessage));
        } catch {
          /* socket gone; close handler will reconnect */
        }
      }, PING_INTERVAL_MS);
    });

    ws.addEventListener('message', (ev) => {
      try {
        const message = JSON.parse(ev.data) as ServerMessage;
        onMessage(message);
      } catch {
        /* drop malformed frames */
      }
    });

    ws.addEventListener('close', () => {
      clearPing();
      socket = null;
      state = 'closed';
      if (closed) return;
      const delay = backoffDelay(attempts++);
      onReconnect?.();
      setTimeout(open, delay);
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
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    },
    close() {
      closed = true;
      clearPing();
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
