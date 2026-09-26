/**
 * 記憶的兩層位置與路徑守衛。
 *
 * - 專案層：`<工作階段位置>/.ultrawork/memory/`，錨定專案根目錄。
 * - 全域層：`<全域設定資料夾>/.ultrawork/memory/`，錨定全域設定資料夾。
 *
 * 所有讀寫都經過 `assertContainedPath`：沿路任何一段是 symlink 就拒絕，
 * 避免記憶被導到層外（例如 `.ultrawork` 指向別的專案）。
 *
 * 專案根目錄就是全域設定資料夾時（在全域設定資料夾本身開工作階段），兩層是同一個
 * 目錄，這裡只回一層：log 只有一份、注入不重複。搬遷標記與 doctor 版控檢查都在
 * 這個情境出過錯，所以判斷集中在 `memoryLayers` 一處。
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertContainedPath, isUnsafeRoot } from "../../kit/path-guard.ts";
import { withContentWriteLock } from "../../kit/write-lock.ts";
import { isSameAsGlobalConfigDir } from "../../settings/paths.ts";

export type LayerName = "project" | "global";

export interface MemoryLayer {
  layer: LayerName;
  /** 層的錨點：專案根目錄或全域設定資料夾。 */
  root: string;
  /** `<root>/.ultrawork/memory` */
  directory: string;
}

/**
 * 記憶工具的結構化錯誤：`code` 直接成為工具回傳的錯誤碼，`details` 併進回傳。
 * 訊息要講清楚下一步，呼叫端不必再解讀。
 */
export class MemoryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** 解析一層的位置；根目錄是 unsafe root（系統根、家目錄等）時拒絕。 */
export function memoryLayer(root: string, layer: LayerName = "project"): MemoryLayer {
  if (isUnsafeRoot(root)) {
    throw new MemoryError("UNSAFE_ROOT", "拒絕使用系統根目錄、系統關鍵目錄或家目錄當記憶位置，請將工作階段綁定到一般專案目錄。");
  }
  const directory = assertContainedPath(root, join(root, ".ultrawork", "memory"));
  return { layer, root, directory };
}

/**
 * 兩層記憶，順序是全域在前、專案在後（注入時照這個順序）。
 * 兩層是同一個資料夾時只回專案層。
 */
export function memoryLayers(projectRoot: string, globalRoot: string): MemoryLayer[] {
  const project = memoryLayer(projectRoot);
  if (isSameAsGlobalConfigDir(projectRoot, globalRoot)) return [project];
  return [memoryLayer(globalRoot, "global"), project];
}

/** 層內路徑；lexical 上不得逃出記憶目錄，沿路不得經過 symlink。 */
export function memoryPath(layer: MemoryLayer, ...parts: string[]): string {
  return assertContainedPath(layer.root, join(layer.directory, ...parts), { lexicalRoot: layer.directory });
}

/** 讀檔；只有 ENOENT 視為不存在，其他 IO 錯誤照樣拋出，不把權限問題當成沒資料。 */
export function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 在該層的寫入鎖內執行。兩個 V2 伺服器可能共用同一個 `.ultrawork/`，
 * log 的 seq 與 hash 鏈只有在鎖內附加才不會分岔。
 */
export async function withMemoryLock<T>(layer: MemoryLayer, action: () => T | Promise<T>): Promise<T> {
  mkdirSync(memoryPath(layer), { recursive: true });
  return withContentWriteLock(memoryPath(layer, ".lock"), async () => action());
}
