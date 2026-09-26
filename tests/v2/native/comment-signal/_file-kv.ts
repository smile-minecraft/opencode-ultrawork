/**
 * 測試用檔案後端 KeyValueStorage：給雙行程鎖測試共用。
 *
 * key → base64url 檔名，一 key 一 JSON 檔；set 走 tmp＋rename 原子寫入。
 * 只為測試跨行程序列化而存在，不進正式程式碼。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyValueStorage } from "../../../../src/state/store.ts";

export function fileNameFor(dir: string, key: string): string {
  return join(dir, Buffer.from(key, "utf-8").toString("base64url") + ".json");
}

export function createFileKvStorage(dir: string): KeyValueStorage {
  mkdirSync(dir, { recursive: true });

  async function get(key: string): Promise<unknown> {
    const f = fileNameFor(dir, key);
    if (!existsSync(f)) return undefined;
    return JSON.parse(readFileSync(f, "utf-8"));
  }

  async function set(key: string, value: unknown): Promise<void> {
    const f = fileNameFor(dir, key);
    const tmp = `${f}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, f);
  }

  async function remove(key: string): Promise<void> {
    try {
      rmSync(fileNameFor(dir, key));
    } catch {
      // 不存在即成功。
    }
  }

  async function scan(options: { prefix: string; after?: string; limit?: number }) {
    const keys: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const key = Buffer.from(name.slice(0, -".json".length), "base64url").toString("utf-8");
      if (key.startsWith(options.prefix)) keys.push(key);
    }
    keys.sort();
    let start = 0;
    if (options.after !== undefined) {
      const idx = keys.findIndex((k) => k > options.after!);
      start = idx === -1 ? keys.length : idx;
    }
    const sliced = options.limit === undefined ? keys.slice(start) : keys.slice(start, start + options.limit);
    const entries = [];
    for (const key of sliced) entries.push({ key, value: await get(key) });
    if (start + sliced.length < keys.length) return { entries, next: sliced[sliced.length - 1] };
    return { entries };
  }

  return { get, set, remove, scan };
}
