import type { ManagerPhase, ManagerState } from "@phil/shared";
import type Anthropic from "@anthropic-ai/sdk";

type MessageParam = Anthropic.MessageParam;

const KEY_PREFIX = "manager:";

function key(taskId: string, suffix: string): string {
  return `${KEY_PREFIX}${taskId}:${suffix}`;
}

export async function loadManagerState(
  storage: DurableObjectStorage,
  taskId: string,
): Promise<ManagerState | null> {
  return (await storage.get<ManagerState>(key(taskId, "state"))) ?? null;
}

export async function saveManagerState(
  storage: DurableObjectStorage,
  taskId: string,
  state: ManagerState,
): Promise<void> {
  await storage.put(key(taskId, "state"), state);
}

export async function loadConversation(
  storage: DurableObjectStorage,
  taskId: string,
): Promise<MessageParam[]> {
  return (await storage.get<MessageParam[]>(key(taskId, "messages"))) ?? [];
}

export async function saveConversation(
  storage: DurableObjectStorage,
  taskId: string,
  messages: MessageParam[],
): Promise<void> {
  await storage.put(key(taskId, "messages"), messages);
}

export async function clearManagerData(
  storage: DurableObjectStorage,
  taskId: string,
): Promise<void> {
  await storage.delete(key(taskId, "state"));
  await storage.delete(key(taskId, "messages"));
}

export function defaultManagerState(): ManagerState {
  return {
    phase: "booting",
    waitingForUser: false,
  };
}
