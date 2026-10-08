import type { KeyValueStorage } from "../../../state/store.ts";

export interface SessionBinding {
  taskId: string | null;
  boundAt: string;
}

const TOMBSTONE_KEY = "session/tombstones/task-binding";
const TOMBSTONE_LIMIT = 1000;

export interface SessionBindingStore {
  markSessionTaskBound(sessionID: string | undefined, taskId?: string): Promise<void>;
  isSessionTaskBound(sessionID: string | undefined): Promise<boolean>;
  getBoundTaskId(sessionID: string | undefined): Promise<string | null>;
  clearSessionBinding(sessionID: string | undefined): Promise<void>;
}

function bindingKey(sessionID: string): string {
  return `session/${sessionID}/task-binding`;
}

export function createSessionBindingStore(storage: KeyValueStorage): SessionBindingStore {
  let operationQueue: Promise<void> = Promise.resolve();

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
    const value = await storage.get(TOMBSTONE_KEY);
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  }

  return {
    markSessionTaskBound(sessionID, taskId) {
      const id = sessionID?.trim();
      if (!id) return Promise.resolve();
      return enqueue(async () => {
        if ((await deletedSessions()).has(id)) return;
        const value: SessionBinding = {
          taskId: taskId?.trim() || null,
          boundAt: new Date().toISOString(),
        };
        await storage.set(bindingKey(id), value);
      });
    },
    async isSessionTaskBound(sessionID) {
      const id = sessionID?.trim();
      if (!id) return false;
      return (await storage.get(bindingKey(id))) !== undefined;
    },
    async getBoundTaskId(sessionID) {
      const id = sessionID?.trim();
      if (!id) return null;
      const value = await storage.get(bindingKey(id)) as SessionBinding | undefined;
      return value?.taskId ?? null;
    },
    async clearSessionBinding(sessionID) {
      const id = sessionID?.trim();
      if (!id) return;
      await enqueue(async () => {
        await storage.remove(bindingKey(id));
        const tombstones = await deletedSessions();
        tombstones.add(id);
        const next = [...tombstones];
        while (next.length > TOMBSTONE_LIMIT) next.shift();
        await storage.set(TOMBSTONE_KEY, next);
      });
    },
  };
}
