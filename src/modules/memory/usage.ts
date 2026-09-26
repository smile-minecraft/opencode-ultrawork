/**
 * 主題讀取次數 `usage.json`：`memory-read` 成功後累加，`memory-maintain report`
 * 用它找出太久沒被讀的主題（參考 Codex 以使用次數汰舊的做法）。
 *
 * 這是輔助資料：寫不進去只回警告，不影響讀取結果。搜尋命中不算使用。
 */

import { atomicWriteFile } from "../../kit/atomic-write.ts";
import { memoryPath, readOptional, withMemoryLock, type MemoryLayer } from "./layers.ts";

export interface Usage {
  reads: number;
  lastReadAt: string;
}

export function readUsage(layer: MemoryLayer): Record<string, Usage> {
  const parsed: unknown = JSON.parse(readOptional(memoryPath(layer, "usage.json")) ?? "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("usage.json 的根必須是物件");
  }
  return parsed as Record<string, Usage>;
}

/** 記一次讀取；失敗時回警告字串，不拋錯。 */
export async function recordRead(layer: MemoryLayer, topic: string): Promise<string[]> {
  try {
    await withMemoryLock(layer, () => {
      const usage = readUsage(layer);
      const previous = Number.isFinite(usage[topic]?.reads) ? usage[topic]!.reads : 0;
      usage[topic] = { reads: previous + 1, lastReadAt: new Date().toISOString() };
      atomicWriteFile(memoryPath(layer, "usage.json"), JSON.stringify(usage));
    });
    return [];
  } catch {
    return ["無法更新 usage.json，記憶內容已成功讀取。"];
  }
}
