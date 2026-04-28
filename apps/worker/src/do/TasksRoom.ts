/**
 * TasksRoom — one Durable Object instance per project. Fans out live updates
 * to connected SPA clients using the WebSocket Hibernation API (acceptWebSocket
 * / webSocketMessage / webSocketClose). See SPEC §10.
 *
 * Each WebSocket carries a small attachment: the set of run IDs the client has
 * opted-in to log streaming for. Default subscription is task.* + event.* +
 * run.created/updated; run.log is per-run opt-in.
 */

import { DurableObject } from 'cloudflare:workers';
import type { ClientMessage, ServerMessage } from '@philharmonic/shared/ws-protocol';
import type { Env } from '../lib/types';

interface Attachment {
  projectId: string;
  subscribedRuns: string[];
  lastPingAt: number;
}

const PING_TIMEOUT_MS = 90_000;

export class TasksRoom extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/broadcast') {
      const message = (await request.json()) as ServerMessage;
      this.broadcast(message);
      return new Response(null, { status: 204 });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const projectId = url.searchParams.get('projectId') ?? 'unknown';
    const { 0: client, 1: server } = new WebSocketPair();

    const attachment: Attachment = {
      projectId,
      subscribedRuns: [],
      lastPingAt: Date.now(),
    };
    server.serializeAttachment(attachment);

    this.ctx.acceptWebSocket(server);

    server.send(
      JSON.stringify({
        type: 'hello',
        projectId,
        serverTime: Date.now(),
      } satisfies ServerMessage),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;

    switch (parsed.type) {
      case 'ping':
        att.lastPingAt = Date.now();
        ws.serializeAttachment(att);
        ws.send(JSON.stringify({ type: 'pong', t: parsed.t } satisfies ServerMessage));
        break;
      case 'subscribe.run':
        if (!att.subscribedRuns.includes(parsed.runId)) {
          att.subscribedRuns = [...att.subscribedRuns, parsed.runId];
          ws.serializeAttachment(att);
        }
        break;
      case 'unsubscribe.run':
        att.subscribedRuns = att.subscribedRuns.filter((id) => id !== parsed.runId);
        ws.serializeAttachment(att);
        break;
    }
  }

  override async webSocketClose(): Promise<void> {
    // Hibernation API cleans up the WebSocket entry automatically.
  }

  override async webSocketError(ws: WebSocket, _err: unknown): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch {
      /* ignore */
    }
  }

  /** Broadcast to all connected clients, applying per-message routing rules. */
  private broadcast(message: ServerMessage): void {
    const sockets = this.ctx.getWebSockets();
    const text = JSON.stringify(message);
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att) continue;

      // run.log is opt-in.
      if (message.type === 'run.log' && !att.subscribedRuns.includes(message.runId)) continue;

      // Drop sockets that haven't pinged recently — hibernation lets us scan cheaply.
      if (Date.now() - att.lastPingAt > PING_TIMEOUT_MS) {
        try {
          ws.close(1000, 'idle');
        } catch {
          /* ignore */
        }
        continue;
      }

      try {
        ws.send(text);
      } catch {
        /* socket gone; hibernation will reap it */
      }
    }
  }
}
