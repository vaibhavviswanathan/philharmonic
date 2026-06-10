/**
 * TasksRoom — one Durable Object instance per project. Fans out live updates
 * to connected SPA clients using the WebSocket Hibernation API (acceptWebSocket
 * / webSocketMessage / webSocketClose). See SPEC §10.
 *
 * Heartbeats are hibernation-friendly (SPEC §10.4): clients send the literal
 * string `ping` and the runtime auto-responds `pong` WITHOUT waking the DO
 * (setWebSocketAutoResponse). Liveness is enforced by a low-frequency alarm
 * (plus an opportunistic broadcast-time sweep) that closes sockets whose last
 * auto-response is older than 90s — three missed 25s pings.
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
  /** Liveness fallback for sockets that haven't pinged yet (serialized at attach). */
  attachedAt: number;
}

const PING_TIMEOUT_MS = 90_000; // 3 missed 25s client pings
const SWEEP_INTERVAL_MS = 3 * 60_000;

export class TasksRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The runtime answers heartbeats without waking a hibernated DO.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/broadcast') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }
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
      attachedAt: Date.now(),
    };
    server.serializeAttachment(attachment);

    this.ctx.acceptWebSocket(server);
    await this.ensureSweepAlarm();

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
    // Heartbeat 'ping' frames are answered by the runtime's auto-response and
    // never reach this handler — everything arriving here is JSON.
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

  /** Low-frequency liveness sweep; re-armed only while sockets remain. */
  override async alarm(): Promise<void> {
    this.sweepStaleSockets();
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }

  private async ensureSweepAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }

  /** When the client last proved liveness: last auto-pong, else attach time. */
  private lastSeen(ws: WebSocket): number {
    const autoPong = this.ctx.getWebSocketAutoResponseTimestamp(ws);
    if (autoPong) return autoPong.getTime();
    const att = ws.deserializeAttachment() as Attachment | null;
    return att?.attachedAt ?? 0;
  }

  private isStale(ws: WebSocket): boolean {
    return Date.now() - this.lastSeen(ws) > PING_TIMEOUT_MS;
  }

  private sweepStaleSockets(): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.isStale(ws)) {
        try {
          ws.close(1000, 'idle');
        } catch {
          /* ignore */
        }
      }
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

      // Opportunistic liveness sweep — the 3-minute alarm is the backstop.
      if (this.isStale(ws)) {
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
