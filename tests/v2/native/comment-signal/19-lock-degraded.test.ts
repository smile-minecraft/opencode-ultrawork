/**
 * 19 — 鎖解析／建鎖失敗不寫入（Red first）。
 *
 * 審查發現（第三輪 #2）：resolver 失敗或 mkdir 失敗時舊碼靜默退回
 * in-process 直接寫入 → 跨實例遺失更新且無警告輸出。
 * 要求：三情境（resolver 回 null／resolver throw／mkdir 失敗）一律
 * 不執行 mutation——併發寫入全 resolve（不 throw）、回安全預設、
 * 警告至少一次、storage 不變。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommentSignalStore } from "../../../../src/modules/comment-signal/state.ts";
import type { KeyValueStorage } from "../../../../src/state/store.ts";

/** 延遲記憶體 storage：放大 RMW 交錯，讓靜默寫入必然遺失更新。 */
function delayedStorage(baseDelayMs = 5): KeyValueStorage {
  const map = new Map<string, unknown>();
  const delay = () => new Promise((r) => setTimeout(r, baseDelayMs));
  const scan = async ({ prefix, after, limit }: { prefix: string; after?: string; limit?: number }) => {
    await delay();
    const keys = [...map.keys()].filter((key) => key.startsWith(prefix)).sort();
    let start = 0;
    if (after !== undefined) {
      const index = keys.findIndex((key) => key > after);
      start = index === -1 ? keys.length : index;
    }
    const sliced = limit === undefined ? keys.slice(start) : keys.slice(start, start + limit);
    const entries = sliced.map((key) => ({ key, value: map.get(key) }));
    if (start + sliced.length < keys.length) return { entries, next: sliced[sliced.length - 1] };
    return { entries };
  };
  return {
    get: async (key: string) => {
      await delay();
      return map.get(key);
    },
    set: async (key: string, value: unknown) => {
      await delay();
      map.set(key, value);
    },
    remove: async (key: string) => {
      await delay();
      map.delete(key);
    },
    scan,
  };
}

/** 攔截 console.warn 記下訊息；呼叫端負責還原。 */
function captureWarns(): { warns: string[]; restore: () => void } {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(String(args[0] ?? ""));
  };
  return { warns, restore: () => { console.warn = orig; } };
}

async function storageKeys(storage: KeyValueStorage): Promise<string[]> {
  const out: string[] = [];
  let after: string | undefined;
  for (;;) {
    const result = await storage.scan({ prefix: "session/", after });
    for (const entry of result.entries) out.push(entry.key);
    if (result.next === undefined) break;
    after = result.next;
  }
  return out.sort();
}

describe("19 - 鎖失敗時不寫入（安全預設＋警告）", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "uw-cs-lockfail-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("resolver 回 null：併發 20 筆全 resolve、無寫入、安全預設、有警告", async () => {
    const storage = delayedStorage();
    const store = new CommentSignalStore(storage as never, { resolveLockDir: async () => null });
    const { warns, restore } = captureWarns();
    try {
      const results = await Promise.all([
        ...Array.from({ length: 20 }, (_, i) => store.recordModifiedFile("s", `f-${i}.ts`)),
        store.registerSessionParent("child", "parent"),
      ]);
      // 全部 resolve（不 throw）；register 回安全預設 false。
      expect(results.length).toBe(21);
      expect(results[20]).toBe(false);
      // 無任何寫入。
      expect(await store.getModifiedFiles("s")).toEqual([]);
      expect(await storageKeys(storage)).toEqual([]);
      // 警告至少一次（per-store 只一次，不刷屏）。
      expect(warns.filter((w) => w.includes("comment-signal")).length).toBe(1);
    } finally {
      restore();
    }
  });

  test("resolver throw：同上（三情境之一）", async () => {
    const storage = delayedStorage();
    const store = new CommentSignalStore(storage as never, {
      resolveLockDir: async () => { throw new Error("boom"); },
    });
    const { warns, restore } = captureWarns();
    try {
      const results = await Promise.all([
        ...Array.from({ length: 20 }, (_, i) => store.recordModifiedFile("s", `f-${i}.ts`)),
        store.registerSessionParent("child", "parent"),
      ]);
      expect(results.length).toBe(21);
      expect(results[20]).toBe(false);
      expect(await store.getModifiedFiles("s")).toEqual([]);
      expect(await storageKeys(storage)).toEqual([]);
      expect(warns.filter((w) => w.includes("comment-signal")).length).toBe(1);
    } finally {
      restore();
    }
  });

  test("mkdir 失敗（鎖位卡在檔案上）：同上（三情境之一）", async () => {
    const blocker = join(base, "blocker-file");
    writeFileSync(blocker, "x", "utf-8");
    const storage = delayedStorage();
    const store = new CommentSignalStore(storage as never, {
      resolveLockDir: async () => join(blocker, "locks"),
    });
    const { warns, restore } = captureWarns();
    try {
      const results = await Promise.all([
        ...Array.from({ length: 20 }, (_, i) => store.recordModifiedFile("s", `f-${i}.ts`)),
        store.registerSessionParent("child", "parent"),
      ]);
      expect(results.length).toBe(21);
      expect(results[20]).toBe(false);
      expect(await store.getModifiedFiles("s")).toEqual([]);
      expect(await storageKeys(storage)).toEqual([]);
      expect(warns.filter((w) => w.includes("comment-signal")).length).toBe(1);
    } finally {
      restore();
    }
  });
});
