/**
 * memory 模組路徑：工作階段位置底下的 `.ultrawork/` 配置。
 *
 * 舊外掛用 `.opencode/memory/`，V2 移植改用 `.ultrawork/`；
 * 版面（project.md、receipts/）與檔名維持不變。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertContainedPath } from "../../kit/path-guard.ts";

export interface MemoryPaths {
  memoryDir: string;
  projectMd: string;
  receiptsDir: string;
}

/** memory 專案層路徑的嚴格 containment；`.ultrawork` 與其子路徑不得經過 symlink。 */
export function assertSafeMemoryPath(projectRoot: string, targetPath: string): string {
  return assertContainedPath(projectRoot, targetPath, { label: "Memory path guard" });
}

/** 依工作階段位置算出 memory 相關路徑；純函式，不碰檔案系統。 */
export function getMemoryPaths(projectRoot: string): MemoryPaths {
  const memoryDir = join(projectRoot, ".ultrawork");
  const paths = {
    memoryDir,
    projectMd: join(memoryDir, "project.md"),
    receiptsDir: join(memoryDir, "receipts"),
  };
  return paths;
}

/** 同步紀錄目錄：workflow 的完成前檢查也用這個位置找收據。 */
export function getReceiptsDir(projectRoot: string): string {
  return join(projectRoot, ".ultrawork", "receipts");
}

/** 單一收據檔路徑（呼叫端保證 receiptId 已驗證過不含路徑分隔符）。 */
export function getReceiptPath(projectRoot: string, receiptId: string): string {
  return join(getReceiptsDir(projectRoot), `${receiptId}.json`);
}

/** 確保目錄存在（含中間層）；已存在時不做事。 */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
