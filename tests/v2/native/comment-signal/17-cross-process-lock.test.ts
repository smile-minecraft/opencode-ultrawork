/**
 * 17 — 跨實例／跨行程寫入序列化（Red first）。
 *
 * 審查發現 #2（第二輪）：in-process mutex 只保護單一 store 實例；
 * 兩個實例共用同一 async storage 時 concurrent RMW 會遺失更新。
 * 要求：kit withContentWriteLock 跨行程序列化＋有界重試＋忙碌放棄
 *（放棄時工具不受影響），鎖檔放該專案 `.ultrawork/cache/locks/`。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommentSignalStore } from "../../../../src/modules/comment-signal/state.ts";
import type { KeyValueStorage } from "../../../../src/state/store.ts";
import { createFileKvStorage } from "./_file-kv.ts";
import {
  createWorkspace,
  setupCommentSignal,
  run,
  type CommentSignalFixture,
} from "./_helpers.ts";

// 鎖檔名（須與 state.ts 的 STATE_LOCK_FILENAME 一致；用字面量避免
// import 失敗掩蓋行為型 Red）。
const STATE_LOCK_FILENAME = "comment-signal-state.lock";

/** 共用記憶體 storage：async get/set 讓 RMW 交錯得以發生。 */
function memoryStorage(): KeyValueStorage {
  const map = new Map<string, unknown>();
  return {
    get: async (key: string) => map.get(key),
    set: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    remove: async (key: string) => {
      map.delete(key);
    },
    scan: async ({ prefix, after, limit }: { prefix: string; after?: string; limit?: number }) => {
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
    },
  };
}

describe("17 - 跨實例寫入序列化", () => {
  test("同行程雙實例共用 storage＋共用 lock 目錄：併發記錄全數保留", async () => {
    const base = mkdtempSync(join(tmpdir(), "uw-cs-lock-a-"));
    try {
      const lockDir = join(base, "locks");
      mkdirSync(lockDir, { recursive: true });
      const storage = memoryStorage();
      const a = new CommentSignalStore(storage as never, { lockDir });
      const b = new CommentSignalStore(storage as never, { lockDir });
      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) => a.recordModifiedFile("s", `a-${i}.ts`)),
        ...Array.from({ length: 10 }, (_, i) => b.recordModifiedFile("s", `b-${i}.ts`)),
      ]);
      const files = (await a.getModifiedFiles("s")).sort();
      expect(files).toEqual(
        [...Array.from({ length: 10 }, (_, i) => `a-${i}.ts`), ...Array.from({ length: 10 }, (_, i) => `b-${i}.ts`)].sort(),
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("雙行程共用檔案後端 storage＋共用 lock 目錄：併發記錄全數保留", async () => {
    const base = mkdtempSync(join(tmpdir(), "uw-cs-lock-b-"));
    try {
      const storageDir = join(base, "storage");
      const lockDir = join(base, "locks");
      mkdirSync(storageDir, { recursive: true });
      mkdirSync(lockDir, { recursive: true });
      const worker = join(import.meta.dir, "_lock-worker.ts");
      const filesA = Array.from({ length: 10 }, (_, i) => `pa-${i}.ts`);
      const filesB = Array.from({ length: 10 }, (_, i) => `pb-${i}.ts`);
      const spawnWorker = (files: string[]): Promise<void> => {
        const proc = Bun.spawn([process.execPath, worker, storageDir, lockDir, "s", ...files], {
          stdout: "pipe",
          stderr: "pipe",
        });
        return proc.exited.then(async (code) => {
          if (code !== 0) {
            const err = await new Response(proc.stderr).text();
            throw new Error(`worker exit=${code}: ${err}`);
          }
        });
      };
      await Promise.all([spawnWorker(filesA), spawnWorker(filesB)]);
      const store = new CommentSignalStore(createFileKvStorage(storageDir), { lockDir });
      const files = (await store.getModifiedFiles("s")).sort();
      expect(files).toEqual([...filesA, ...filesB].sort());
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 30000);
});

describe("17 - 鎖忙碌降級", () => {
  let ws: ReturnType<typeof createWorkspace>;
  let fx: CommentSignalFixture;
  beforeEach(async () => {
    ws = createWorkspace();
    fx = await setupCommentSignal(ws.root);
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "a.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
  });
  afterEach(async () => {
    await fx.cleanup();
    ws.cleanup();
  });

  test("鎖被占用時：有界重試後放棄、工具不失敗、後續仍可記錄", async () => {
    // 模組 store 的鎖位：<專案>/.ultrawork/cache/locks/comment-signal-state.lock
    const lockDir = join(ws.root, ".ultrawork", "cache", "locks");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, STATE_LOCK_FILENAME);
    // 佔住鎖（別人的鎖：不刪、不回收，只等它）。
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99999999, createdAt: new Date().toISOString(), token: "other" }),
    );

    // 工具執行不受影響（recordLastReport 被放棄，但 check 照常回 ok）。
    const out = await run(fx.tools["comment_signal_check"], { path: "src/a.ts", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    // 本次記錄被放棄：lastReport 沒落地。
    expect(await fx.store.getLastReport("s1")).toBeNull();

    // 鎖釋放後，後續記錄照常。
    rmSync(lockPath);
    const out2 = await run(fx.tools["comment_signal_check"], { path: "src/a.ts", changedOnly: false });
    expect(out2.ok).toBe(true);
    expect(await fx.store.getLastReport("s1")).not.toBeNull();
  });
});
