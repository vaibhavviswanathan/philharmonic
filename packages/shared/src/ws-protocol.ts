/**
 * WebSocket protocol shared by the Worker (TasksRoom DO) and the SPA client.
 *
 * Fleshed out in M3 per SPEC §10.2. M0 ships a stable export surface so other
 * packages can import without breakage.
 */

export type ServerMessage = {
  type: 'hello';
  projectId: string;
  serverTime: number;
};

export type ClientMessage = {
  type: 'ping';
  t: number;
};
