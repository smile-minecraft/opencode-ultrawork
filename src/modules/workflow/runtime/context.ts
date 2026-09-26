/**
 * opencode-ultrawork — runtime context primitives
 *
 * 角色：
 *   - 提供 runtime module 共用的「path / binding 純函式」，作為
 *     `UltraworkRuntimeContext` 與 registry IO / state projection / 更新紀錄
 *     validator 等 module 的基礎建設。
 *   - 本檔僅放 pure module-level 函式 + `Paths` 型別；不依賴 closure、
 *     不持有 plugin 內部狀態、不做 IO（僅作路徑推導）。
 *
 * 對外規則（不可破壞）：
 *     回傳物件**逐字一致**，以維持 TypeScript structural typing 相容性。
 *     解構、或 `writeRegistry` 的 `MEMORY_DIR / TASKS_JSON` 解構）都依
 *     賴此形狀。
 *   - `isUnsafeRoot(path)` 黑名單（`/` / `""` / `"."` / `".."` / `/Users` /
 *     `/Volumes`）必須與原 closure 內版本一致，禁止新增/移除項目，避免
 *     既有防呆失效。
 *   - `getPathsForRoot(projectRoot)` 對根目錄的 layout
 *     （`.ultrawork/{project.md, state.md, tasks.json, plans.json,
 *     receipts/}` 與 `.ultrawork/plans/`）必須與原 closure 版本完全相同，
 *     因為 `lazyEnsure` / `readRegistry` / `writeRegistry` 等都依賴這些
 *     相對位置。
 *
 * 限制：
 *   - 本檔為 pure leaf module，**不得** import runtime module 內其他檔案
 *     （`./context-builder.ts` / `./registry-io.ts` 等），亦**不得** import
 *   - 僅依賴 `node:path`、`node:fs`（realpath containment 用）與
 *     `./../core/helpers.ts` 的 `deriveProjectId`。
 *
 * @see ../../../../README.md                              — 模組一覽
 */

import { join, resolve, dirname, sep } from "node:path";
import { realpathSync } from "node:fs";
import { deriveProjectId } from "../core/helpers.ts";

/**
 * `getPathsForRoot` 回傳形狀一致）。
 *
 * 欄位皆為絕對路徑（透過 `resolve(projectRoot)` 處理），可直接餵給
 * `fs.existsSync` / `readFileSync` / `writeFileSync` 等。
 */
export interface Paths {
  PROJECT_ROOT: string;
  PROJECT_ID: string;
  OPENCODE_DIR: string;
  MEMORY_DIR: string;
  PROJECT_MD: string;
  STATE_MD: string;
  TASKS_JSON: string;
  PLANS_JSON: string;
  RECEIPTS_DIR: string;
  PLANS_DIR: string;
  /**
   * 稽核紀錄（v4.2）：只增不改的 JSON Lines 檔。
   * 與 tasks.json / plans.json 的職責刻意分開——那兩份回答「現在怎麼樣」，
   * 所以必須被裁剪；這一份回答「當時發生過什麼」，價值完全來自不被裁剪。
   */
  AUDIT_LOG: string;
}

/**
 * 判斷路徑是否屬於「unsafe root」黑名單：
 *   - 空字串、`/`、`.`、`..`
 *   - `/Users`、`/Volumes`（macOS 系統關鍵目錄，避免誤在根或使用者根
 *     建立 `.opencode`）
 *
 * 除 lexical 黑名單外，另做 realpath containment：把同一份黑名單套用到
 * symlink 解析後的真實路徑（目標不存在時取最近存在祖先）。否則指向
 * `/`、`/Users`、`/Volumes` 的 symlink alias 會通過 lexical 檢查，讓
 * registry / state / receipt 寫入落在系統關鍵目錄。無法確認 containment
 * 時一律 fail closed。
 *
 * 用於 registry IO / lazyEnsure / ensureDir 等寫入動作前的安全檢查。
 * 僅新增對 realpath 的第二層套用，不新增／移除黑名單項目。
 */
export function isUnsafeRoot(path: string): boolean {
  if (!path) return true;
  const resolved = resolve(path);
  const protectedRoots = new Set([sep, join(sep, "Users"), join(sep, "Volumes")]);
  if (protectedRoots.has(resolved)) return true;
  const real = resolveExistingRealpath(resolved);
  // 無法解析出任何存在祖先 → 無法確認 containment → fail closed。
  if (!real) return true;
  return protectedRoots.has(real);
}

/**
 * 回傳 target 的真實路徑；target 不存在時逐層向上找最近的存在祖先解析，
 * 讓「root 尚未建立但其父鏈含 symlink」的情況也能被 containment 檢查涵蓋。
 * 連檔案系統根都無法解析時回傳 undefined（呼叫端 fail closed）。
 */
function resolveExistingRealpath(target: string): string | undefined {
  let current = target;
  for (;;) {
    try {
      return realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

/**
 * 根據指定的 projectRoot 計算所有 .opencode 路徑。
 *
 * 任何既有 caller（`getPaths` / `readRegistry` / `writeRegistry` /
 * `readPlansRegistry` / `writePlansRegistry` / `updateStateMd` /
 * `lazyEnsure` / `validateMemoryReceiptForTask` / 多個 plan / task content
 * tool）皆解構此回傳形狀。
 */
export function getPathsForRoot(projectRoot: string): Paths {
  const PROJECT_ROOT = resolve(projectRoot);
  const PROJECT_ID = deriveProjectId(PROJECT_ROOT);
  const MEMORY_DIR = join(PROJECT_ROOT, ".ultrawork");
  const PROJECT_MD = join(MEMORY_DIR, "project.md");
  const STATE_MD = join(MEMORY_DIR, "state.md");
  const TASKS_JSON = join(MEMORY_DIR, "tasks.json");
  const PLANS_JSON = join(MEMORY_DIR, "plans.json");
  const RECEIPTS_DIR = join(MEMORY_DIR, "receipts");
  const AUDIT_LOG = join(MEMORY_DIR, "audit.jsonl");
  const PLANS_DIR = join(MEMORY_DIR, "plans");
  return { PROJECT_ROOT, PROJECT_ID, OPENCODE_DIR: MEMORY_DIR, MEMORY_DIR, PROJECT_MD, STATE_MD, TASKS_JSON, PLANS_JSON, RECEIPTS_DIR, PLANS_DIR, AUDIT_LOG };
}
