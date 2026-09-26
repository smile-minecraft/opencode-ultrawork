/** 搬遷測試的共用 harness：真實暫存目錄 + 舊資料鋪設。 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MigrateFsOps } from "../../../../src/migrate/index.ts";
import { nodeMigrateFsOps } from "../../../../src/migrate/index.ts";

const roots: string[] = [];

/** 固定時間戳，讓「舊檔改名」的名稱可預期。 */
export const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

export function tempRoot(prefix = "uw-migrate-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

export function cleanupTempRoots(): void {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
}

/** 在某層根目錄下寫一個檔案（自動建立中間層）。 */
export function writeFile(root: string, relativePath: string, content: string): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
  return path;
}

export function writeJson(root: string, relativePath: string, value: unknown): string {
  return writeFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** 真實檔案操作 + 覆寫；`override` 沒給的方法直接用 node:fs。 */
export function withOps(override: Partial<MigrateFsOps> = {}): MigrateFsOps {
  return { ...nodeMigrateFsOps(), ...override };
}

/** 舊檔改名保留後的檔名（撞名時加序號）。 */
export function archivedName(originalName: string, index?: number): string {
  const suffix = index === undefined ? "" : `-${index}`;
  return `${originalName}.migrated-20260101T000000Z${suffix}`;
}
