import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** 以 temp 檔＋rename 還原原始位元組，不經過字串編碼轉換。 */
export function restoreBytesAtomic(absolutePath: string, bytes: Buffer, beforeWrite?: () => void): void {
  beforeWrite?.();
  const tempPath = join(
    dirname(absolutePath),
    `.${basename(absolutePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.restore.tmp`,
  );
  try {
    writeFileSync(tempPath, bytes, { flag: "wx" });
    renameSync(tempPath, absolutePath);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // 清理失敗不能蓋掉原始還原錯誤。
    }
    throw error;
  }
}
