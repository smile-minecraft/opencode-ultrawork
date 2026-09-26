/**
 * 原子寫入：先寫唯一 temp 檔再 rename，失敗不動原檔並清掉 temp。
 *
 * temp 路徑帶 pid＋時間＋亂數，兩台伺服器同時寫也不互踩。
 * 對呼叫端維持同步介面。
 */

import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** 可注入的檔案操作，測試用來模擬失敗路徑。 */
export interface AtomicWriteOps {
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  existsSync: typeof existsSync;
  unlinkSync: typeof unlinkSync;
}

/** 原子寫入的可注入版本：temp 獨佔建立，rename 失敗清 temp 後原樣丟錯。 */
export function atomicWriteFileWithOps(absolutePath: string, content: string, ops: AtomicWriteOps): void {
  const dir = dirname(absolutePath);
  const tempPath = join(
    dir,
    `.${basename(absolutePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}.tmp`,
  );
  try {
    ops.writeFileSync(tempPath, content, { encoding: "utf-8", flag: "wx" });
    ops.renameSync(tempPath, absolutePath);
  } catch (error) {
    try {
      if (ops.existsSync(tempPath)) ops.unlinkSync(tempPath);
    } catch {
      // 清理失敗不蓋掉主錯誤。
    }
    throw error;
  }
}

/** 原子寫入：內部用真實檔案操作。 */
export function atomicWriteFile(absolutePath: string, content: string): void {
  atomicWriteFileWithOps(absolutePath, content, {
    writeFileSync,
    renameSync,
    existsSync,
    unlinkSync,
  });
}
