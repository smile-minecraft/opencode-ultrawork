import type { KeyValueStorage } from "../../../state/store.ts";

export interface SessionBinding {
  taskId: string | null;
  boundAt: string;
}

const TOMBSTONE_KEY = "session/tombstones/task-binding";
const TOMBSTONE_LIMIT = 1000;
let storageRef: KeyValueStorage | undefined;
let operationQueue: Promise<void> = Promise.resolve();

function bindingKey(sessionID: string): string {
  return `session/${sessionID}/task-binding`;
}

async function enqueue(operation: () => Promise<void>): Promise<void> {
  const previous = operationQueue;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  operationQueue = previous.then(() => gate, () => gate);
  await previous.catch(() => {});
  try {
    await operation();
  } finally {
    release();
  }
}

async function deletedSessions(): Promise<Set<string>> {
  const value = await storageRef!.get(TOMBSTONE_KEY);
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
}

export function configureSessionBindingStore(storage: KeyValueStorage): void {
  storageRef = storage;
}

export function markSessionTaskBound(sessionID: string | undefined, taskId?: string): Promise<void> {
  const id = sessionID?.trim();
  if (!id || !storageRef) return Promise.resolve();
  return enqueue(async () => {
    if ((await deletedSessions()).has(id)) return;
    const value: SessionBinding = {
      taskId: taskId?.trim() || null,
      boundAt: new Date().toISOString(),
    };
    await storageRef!.set(bindingKey(id), value);
  });
}

export async function isSessionTaskBound(sessionID: string | undefined): Promise<boolean> {
  const id = sessionID?.trim();
  if (!id || !storageRef) return false;
  return (await storageRef.get(bindingKey(id))) !== undefined;
}

export async function getBoundTaskId(sessionID: string | undefined): Promise<string | null> {
  const id = sessionID?.trim();
  if (!id || !storageRef) return null;
  const value = await storageRef.get(bindingKey(id)) as SessionBinding | undefined;
  return value?.taskId ?? null;
}

export async function clearSessionBinding(sessionID: string | undefined): Promise<void> {
  const id = sessionID?.trim();
  if (!id || !storageRef) return;
  await enqueue(async () => {
    await storageRef!.remove(bindingKey(id));
    const tombstones = await deletedSessions();
    tombstones.add(id);
    const next = [...tombstones];
    while (next.length > TOMBSTONE_LIMIT) next.shift();
    await storageRef!.set(TOMBSTONE_KEY, next);
  });
}
