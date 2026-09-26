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
 *   - `isUnsafeRoot(path)` 黑名單只有 kit 一份（`src/kit/path-guard.ts`：
 *     `/`／`""`／`"."`／`".."`／`/Users`／`/Volumes`／家目錄本身，另對
 *     symlink 解析後的真實路徑套用同一份黑名單）。家目錄入列是使用者裁定；
 *     這裡只轉匯出，不再自帶黑名單。
 *   - `getPathsForRoot(projectRoot)` 對根目錄的 layout
 *     （`.ultrawork/{memory/, state.md, tasks.json, plans.json,
 *     memory/}` 與 `.ultrawork/plans/`）必須與原 closure 版本完全相同，
 *     因為 `lazyEnsure` / `readRegistry` / `writeRegistry` 等都依賴這些
 *     相對位置。
 *
 * 限制：
 *   - 本檔為 pure leaf module，**不得** import runtime module 內其他檔案
 *     （`./context-builder.ts` / `./registry-io.ts` 等），亦**不得** import
 *   - 僅依賴 `node:path`、`../../kit/path-guard.ts`（unsafe-root 唯一判定）與
 *     `./../core/helpers.ts` 的 `deriveProjectId`。
 *
 * @see ../../../../README.md                              — 模組一覽
 */

import { join, resolve } from "node:path";
import { deriveProjectId } from "../core/helpers.ts";

/** 全外掛唯一的 unsafe-root 判定在 kit；這裡轉匯出，保持既有 import 路徑可用。 */
export { isUnsafeRoot } from "../../../kit/path-guard.ts";

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
  MEMORY_STORE_DIR: string;
  STATE_MD: string;
  TASKS_JSON: string;
  PLANS_JSON: string;
  PLANS_DIR: string;
  /**
   * 稽核紀錄（v4.2）：只增不改的 JSON Lines 檔。
   * 與 tasks.json / plans.json 的職責刻意分開——那兩份回答「現在怎麼樣」，
   * 所以必須被裁剪；這一份回答「當時發生過什麼」，價值完全來自不被裁剪。
   */
  AUDIT_LOG: string;
}

/**
 * 根據指定的 projectRoot 計算所有 .opencode 路徑。
 *
 * 任何既有 caller（`getPaths` / `readRegistry` / `writeRegistry` /
 * `readPlansRegistry` / `writePlansRegistry` / `updateStateMd` /
 * `lazyEnsure` / `validateMemoryDispositionForTask` / 多個 plan / task content
 * tool）皆解構此回傳形狀。
 */
export function getPathsForRoot(projectRoot: string): Paths {
  const PROJECT_ROOT = resolve(projectRoot);
  const PROJECT_ID = deriveProjectId(PROJECT_ROOT);
  const MEMORY_DIR = join(PROJECT_ROOT, ".ultrawork");
  const MEMORY_STORE_DIR = join(MEMORY_DIR, "memory");
  const STATE_MD = join(MEMORY_DIR, "state.md");
  const TASKS_JSON = join(MEMORY_DIR, "tasks.json");
  const PLANS_JSON = join(MEMORY_DIR, "plans.json");
  const AUDIT_LOG = join(MEMORY_DIR, "audit.jsonl");
  const PLANS_DIR = join(MEMORY_DIR, "plans");
  return { PROJECT_ROOT, PROJECT_ID, OPENCODE_DIR: MEMORY_DIR, MEMORY_DIR, MEMORY_STORE_DIR, STATE_MD, TASKS_JSON, PLANS_JSON, PLANS_DIR, AUDIT_LOG };
}
