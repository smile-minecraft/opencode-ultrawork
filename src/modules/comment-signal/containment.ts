/**
 * commentSignal 模組：canonical 路徑 containment。
 *
 * lexical 的 `resolveInsideWorktree` 擋得住 `..` 逃逸與絕對路徑，
 * 但擋不住 worktree 內的 symlink（`link.ts -> /outside/...` lexical
 * 看起來在 root 內，實際讀到外面）。這裡多做一層 canonical 化：
 * realpath 完整目標；目標不存在時逐層向上取最近存在祖先再接回尾段，
 * 讓「尚不存在的新檔」與「symlink 目錄下的未建檔」也能被檢查涵蓋。
 * canonical 前後都必須在 root 內，否則丟 AssertPathOutsideWorktree。
 *
 * 作法參考 search 模組的 resolveExistingRealpath＋containment 姿態，
 * 自帶在本模組內（不跨模組 import）。
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  AssertPathOutsideWorktree,
  assertContainedPath,
  assertSafeWorktreePath,
  resolveInsideWorktree,
} from "../../kit/path-guard.ts";

/**
 * 回傳 target 的真實路徑；target 不存在時逐層向上找最近的存在祖先，
 * realpath 後再把尾段接回來（尾段皆為 basename，不含 `..`）。
 * 連檔案系統根都無法解析時回傳 undefined（呼叫端 fail closed）。
 */
export function resolveCanonicalTarget(lexicalAbs: string): string | undefined {
  let current = lexicalAbs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** 回傳 worktree 根的真實路徑；無法確認時回傳 undefined（呼叫端 fail closed）。 */
export function resolveCanonicalRoot(worktreeRoot: string): string | undefined {
  return resolveCanonicalTarget(resolve(worktreeRoot));
}

/**
 * 以工作區為基準解析路徑，並以 canonical 比對確認仍在工作區內。
 * lexical 與 canonical 兩層都要過；任一層超出即丟錯。
 *
 * @returns lexical 絕對路徑（呼叫端照舊用它讀檔；已確認其 canonical 在 root 內）。
 */
export function resolveCanonicalInsideWorktree(filePath: string, worktreeRoot: string): string {
  const lexical = resolveInsideWorktree(filePath, worktreeRoot);
  const canonicalRoot = resolveCanonicalRoot(worktreeRoot);
  if (canonicalRoot === undefined) {
    throw new AssertPathOutsideWorktree(filePath, worktreeRoot);
  }
  const canonicalTarget = resolveCanonicalTarget(lexical);
  if (canonicalTarget === undefined) {
    throw new AssertPathOutsideWorktree(filePath, worktreeRoot);
  }
  assertSafeWorktreePath(canonicalTarget, canonicalRoot);
  return lexical;
}

/**
 * 判斷已解析的絕對路徑 canonical 後是否仍在工作區內；無法確認回 false。
 * 給目錄走訪用（逐 entry 跳過，不丟錯）。
 */
export function isCanonicalInsideWorktree(absolutePath: string, canonicalRoot: string): boolean {
  if (!absolutePath || typeof absolutePath !== "string") return false;
  if (!canonicalRoot || typeof canonicalRoot !== "string") return false;
  const canonicalTarget = resolveCanonicalTarget(resolve(absolutePath));
  if (canonicalTarget === undefined) return false;
  const target = canonicalTarget.split("\\").join("/");
  const root = canonicalRoot.split("\\").join("/");
  if (target === root) return true;
  return target.startsWith(`${root}/`);
}

/**
 * 專案層 `.ultrawork` I/O 的嚴格 containment：錨點使用 project realpath，
 * `.ultrawork` 到目標的每一段都必須不是 symlink，最後再確認 canonical
 * 目標仍在 project 內。目標尚不存在時，從最近存在祖先推導未來位置。
 */
export function assertSafeUltraworkPath(projectRoot: string, targetPath: string): string {
  return assertContainedPath(projectRoot, targetPath, { label: "Comment Signal path guard" });
}

/** 以路徑中的 `.ultrawork` 推回專案錨點，供檔案工具的測試 seam 使用。 */
export function assertSafeCommentSignalPath(targetPath: string): string {
  const target = resolve(targetPath);
  const marker = `${sep}.ultrawork${sep}`;
  const markerIndex = target.indexOf(marker);
  if (markerIndex < 0) return target;
  return assertSafeUltraworkPath(target.slice(0, markerIndex), target);
}

/** 以 lock 路徑中的 `.ultrawork` 推回專案錨點，供 store 的測試 seam 使用。 */
export function assertSafeLockPath(lockDir: string, lockPath: string): void {
  const marker = `${sep}.ultrawork${sep}`;
  const markerIndex = lockDir.indexOf(marker);
  if (markerIndex < 0) return;
  const projectRoot = lockDir.slice(0, markerIndex);
  assertSafeUltraworkPath(projectRoot, lockPath);
}
