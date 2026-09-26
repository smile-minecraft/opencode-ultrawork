import { randomBytes } from "node:crypto";
import type { KeyValueStorage } from "../../../state/store.ts";

export const WORK_ORDER_REF_PREFIX = "work-order:";
const WORK_ORDER_REF_PATTERN = /^work-order:(wo_[0-9a-z]+_[0-9a-f]{8})$/;
const MAX_ENTRIES = 200;
const TTL_MS = 24 * 60 * 60 * 1000;
const KEY_KIND = "/work-order/";

interface WorkOrderEntry {
  prompt: string;
  sessionID: string | null;
  createdAt: number;
}

export type WorkOrderResolution =
  | { kind: "not-a-reference" }
  | { kind: "resolved"; id: string; prompt: string }
  | { kind: "malformed" }
  | { kind: "not-found"; id: string }
  | { kind: "wrong-session"; id: string };

export interface WorkOrderStore {
  save(prompt: string, sessionID: string | null): Promise<string>;
  resolve(rawPrompt: unknown, sessionID: string | null): Promise<WorkOrderResolution>;
  clearSession(sessionID: string): Promise<void>;
}

function keyFor(sessionID: string, id: string): string {
  return `session/${sessionID || "unbound"}${KEY_KIND}${id}`;
}

export function createWorkOrderStore(
  storage: KeyValueStorage,
  now: () => number = Date.now,
): WorkOrderStore {
  async function allEntries(): Promise<Array<{ key: string; entry: WorkOrderEntry }>> {
    const values: Array<{ key: string; entry: WorkOrderEntry }> = [];
    let after: string | undefined;
    for (;;) {
      const page = await storage.scan({ prefix: "session/", after, limit: 200 });
      for (const item of page.entries) {
        if (!item.key.includes(KEY_KIND) || !item.value || typeof item.value !== "object") continue;
        values.push({ key: item.key, entry: item.value as WorkOrderEntry });
      }
      if (page.next === undefined) break;
      after = page.next;
    }
    return values.sort((a, b) => a.entry.createdAt - b.entry.createdAt);
  }

  async function evict(): Promise<void> {
    const cutoff = now() - TTL_MS;
    const entries = await allEntries();
    for (const item of entries) {
      if (item.entry.createdAt < cutoff) await storage.remove(item.key);
    }
    const live = entries.filter((item) => item.entry.createdAt >= cutoff);
    const overflow = live.length - MAX_ENTRIES;
    for (let index = 0; index < overflow; index++) {
      const item = live[index];
      if (item) await storage.remove(item.key);
    }
  }

  return {
    async save(prompt, sessionID) {
      const id = `wo_${now().toString(36)}_${randomBytes(4).toString("hex")}`;
      await storage.set(keyFor(sessionID ?? "", id), { prompt, sessionID, createdAt: now() });
      await evict();
      return id;
    },

    async resolve(rawPrompt, sessionID) {
      if (typeof rawPrompt !== "string") return { kind: "not-a-reference" };
      const trimmed = rawPrompt.trim();
      const match = WORK_ORDER_REF_PATTERN.exec(trimmed);
      if (!match) {
        return trimmed.includes(`${WORK_ORDER_REF_PREFIX}wo_`) ? { kind: "malformed" } : { kind: "not-a-reference" };
      }
      const id = match[1]!;
      await evict();
      const entries = await allEntries();
      const found = entries.find((item) => item.key.endsWith(`/${id}`));
      if (!found) return { kind: "not-found", id };
      if (found.entry.sessionID && sessionID && found.entry.sessionID !== sessionID) {
        return { kind: "wrong-session", id };
      }
      return { kind: "resolved", id, prompt: found.entry.prompt };
    },

    async clearSession(sessionID) {
      const prefix = `session/${sessionID}${KEY_KIND}`;
      let after: string | undefined;
      for (;;) {
        const page = await storage.scan({ prefix, after, limit: 200 });
        for (const item of page.entries) await storage.remove(item.key);
        if (page.next === undefined) break;
        after = page.next;
      }
    },
  };
}
