/**
 * 搬遷的型別契約。
 *
 * 這裡只描述形狀，不碰檔案系統；逐項演算法在 `migrate.ts`，
 * 舊→新對照表在 `items.ts`。
 */

import type { AtomicWriteOps } from "../kit/atomic-write.ts";

/**
 * 搬遷用到的檔案操作。
 *
 * 沿用 `atomicWriteFileWithOps` 的注入風格：真實執行用 `nodeMigrateFsOps()`，
 * 測試用同一個形狀覆寫其中一兩個方法來模擬「搬到一半失敗」。
 * 擴充 `AtomicWriteOps` 是為了直接把它交給原子寫入，不另外橋接。
 */
export interface MigrateFsOps extends AtomicWriteOps {
  statSync(path: string): { isDirectory(): boolean; isFile(): boolean };
  /** 不跟隨 symlink 的 `stat`；用來判斷頂層舊項目「本身」是否存在。 */
  lstatSync(path: string): { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };
  mkdirSync(path: string, options: { recursive: true }): void;
  readdirSync(path: string): string[];
  copyFileSync(source: string, destination: string): void;
  readFileSync(path: string, encoding: "utf-8"): string;
  /** 只用於清掉自己建立的搬遷暫存路徑；不會刪任何使用者資料。 */
  rmSync(path: string, options: { recursive: true; force: boolean }): void;
}

/** 單一搬遷項目的結果。 */
export type MigrationItemStatus = "migrated" | "skipped" | "failed";

export interface MigrationItemOutcome {
  /** 舊位置的絕對路徑。 */
  from: string;
  /** 新位置的絕對路徑。 */
  to: string;
  status: MigrationItemStatus;
  /**
   * 原因代碼（`skipped`／`failed` 才有）：
   * `source-missing`（舊位置本來就沒有）、`target-exists`（新位置已有資料）、
   * `copy-failed`（複製或改名失敗）、`unsafe-path`（該路徑的父層沒通過
   * canonical containment，例如 `.opencode` 或 `.ultrawork` 是 symlink）、
   * `root-missing`（該層根目錄不合法）。
   */
  reason?: string;
  /** 給人看的說明，會出現在警告與標記檔裡。 */
  detail?: string;
  /** 舊檔改名保留後的絕對路徑；只有成功搬移才有。 */
  archivedTo?: string;
}

/** 一層（專案層或全域層）搬遷的結果。 */
export interface MigrationResult {
  layer: "project" | "global";
  /** 該層根目錄（專案根目錄或全域設定資料夾）。 */
  root: string;
  /** 標記檔路徑。 */
  markerPath: string;
  /**
   * 標記檔已存在、且 `.ultrawork/` 的父層通過封頂 → 這一層這次完全沒做事。
   *
   * 標記在但父層不安全時維持 `false`：那一層沒有真的完成搬遷，該回報
   * `unsafe-path` 失敗，讓下次啟動仍會嘗試。
   */
  alreadyMigrated: boolean;
  /** 沒有任何失敗（全部跳過也算成功）時為 true。 */
  ok: boolean;
  /** 成功搬到新位置的項目。 */
  migrated: MigrationItemOutcome[];
  /** 跳過的項目：舊位置不存在，或新位置已有資料而未覆寫。 */
  skipped: MigrationItemOutcome[];
  /** 失敗的項目；只要有 failed 就不寫標記檔。 */
  errors: MigrationItemOutcome[];
  /** 上面三個集合的合併結果，順序即處理順序。 */
  items: MigrationItemOutcome[];
}

export interface MigrationGitignoreOutcome {
  path: string;
  /** 這次是否建立了 `.gitignore`。 */
  created: boolean;
  /** 檔案已存在且內容與預設不同時的警告；內容相同則為 undefined。 */
  warning?: string;
}

export type ProjectMigrationResult = MigrationResult & {
  gitignore: MigrationGitignoreOutcome;
};

/** 搬遷某一層的輸入。 */
export interface MigrateLayerOptions {
  /** 該層根目錄：專案層是專案根目錄，全域層是全域設定資料夾。 */
  root: string;
  /** 檔案操作；不給就用真實的 node:fs。 */
  fs?: MigrateFsOps;
  /** 時間戳來源；測試注入固定時間。 */
  now?: () => Date;
}

/** 搬遷狀態診斷（供 `workflow_doctor` 用）。 */
export interface MigrationStateReport {
  markerPath: string;
  /**
   * 涵蓋專案層的標記存在（新格式看 `layers.project`，舊格式看條目落點；
   * 空的舊標記不算涵蓋，見 `marker.ts`）。
   */
  markerExists: boolean;
  /** 標記檔本身在不在磁碟上（無論涵蓋哪一層；訊息用，不做判定）。 */
  markerFilePresent: boolean;
  /** 仍然存在的舊資料位置（相對於專案根目錄）。 */
  legacySources: string[];
  /** 需要回報「搬遷未完成或失敗」：舊資料還在但沒有涵蓋本層的標記，或標記在而 `.ultrawork/` 的父層沒通過封頂。 */
  pending: boolean;
  /**
   * pending 的原因代碼，與搬移端 `MigrationItemOutcome.reason` 同一套值。
   *
   * 只有診斷端能重演得出來的原因才會給（目前是 `unsafe-path`：路徑的父層沒通過
   * canonical containment）。判斷不出來就是 `undefined`，代表只是還沒搬完，
   * 呼叫端沿用原本的「未完成」語意。
   */
  reason?: string;
  /** 原因的具體說明（搬移端同一個失敗項目的 `detail`）。 */
  detail?: string;
}

/** 兩層一起跑的回傳，供入口接線用。 */
export interface RunMigrationsResult {
  project: ProjectMigrationResult;
  global: MigrationResult;
  /** 值得打到 console 的警告（只含真正需要注意的情況）。 */
  warnings: string[];
}

export interface RunMigrationsOptions {
  projectDir?: string;
  globalDir?: string;
  fs?: MigrateFsOps;
  now?: () => Date;
}
