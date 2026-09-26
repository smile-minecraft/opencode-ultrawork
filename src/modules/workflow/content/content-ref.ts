/**
 * opencode-ultrawork — content/path utilities + I/O helpers
 *
 * 角色：
 *   - Plan / Task content file 的 **path utilities 與 I/O 輔助函式**：
 *     safety check（path traversal 防護）、file name sanitization、
 *     contentRef 建構、resolvePlansContentRef、檔案讀寫刪除，皆由本模組提供。
 *     本模組維持 leaf boundary，不反向依賴 runtime entry。
 *
 * 對外規則（不可破壞）：
 *   - TypeScript structural typing：本檔案獨立定義的型別與 index.ts 內同名
 *     型別結構對應，跨模組互相可代入。
 *     引用；引入反向 import 會形成循環依賴。
 *   - 不引入新相依（僅 `node:fs` / `node:path`，以及 `../../../kit/atomic-write.ts`）。
 *
 * 設計重點：
 *   - `writePlanContent` 的 `createDir` 參數為可選 callback：測試或 caller 可注入
 *     自定的 dir 建立策略（含 unsafe-root 防護等）；預設採 `mkdirSync recursive`。
 *     這樣可以在不破壞既有 `ensureDir(path, context)` 行為的前提下，讓 leaf
 *     module 保持 self-contained、無 closure 依賴。
 *
 * @see ../../../../README.md                           — 模組一覽
 * @see ../../../kit/atomic-write.ts                    — atomic write 底層
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertContainedPath } from "../../../kit/path-guard.ts";
import { assertSafeContentPath, assertSafeContentRoot } from "./content-store.ts";
import { atomicWriteFile } from "../../../kit/atomic-write.ts";

/**
 * Module-local debug logger；只在 `DEBUG=true/1` 時輸出 stderr。
 */
function localDebugLog(msg: string): void {
  if (process.env.DEBUG === "true" || process.env.DEBUG === "1") {
    process.stderr.write(`[DEBUG] ${msg}\n`);
  }
}

/**
 * Assert that a path is safely inside the plans directory.
 * Prevents path traversal attacks.
 *
 * 拋出錯誤（含原始 path 與 plansDir）以利診斷。
 */
export function assertSafePlansPath(path: string, plansDir: string): void {
  assertContainedPath(plansDir, path, {
    allowMissingAnchor: true,
    label: "Workflow plans reference path guard",
  });
}

/**
 * Sanitize a content file name. Only allows [a-zA-Z0-9._-].
 * Other characters are replaced with '-'.
 */
export function safeContentFileName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/**
 * Get the plan content file path for a given planId.
 * Returns the 固定格式 relative path inside .ultrawork/plans/
 */
export function planContentPath(planId: string, plansDir: string): string {
  const safeName = safeContentFileName(planId);
  return join(plansDir, `${safeName}.md`);
}

/**
 * Get the task content file path for a given taskId.
 * Returns the 固定格式 relative path for storage in task.taskContentPath.
 * Format: .ultrawork/plans/tasks/{taskId}.md
 */
export function taskContentFilePath(taskId: string): string {
  const safeName = safeContentFileName(taskId);
  return `.ultrawork/plans/tasks/${safeName}.md`;
}

/**
 * Build the 固定格式 contentRef for a plan.
 */
export function planContentRef(planId: string): string {
  return `.ultrawork/plans/${safeContentFileName(planId)}.md`;
}

/**
 * Build the 固定格式 task section anchor contentRef for a task within a plan.
 */
export function taskSectionContentRef(planId: string, taskId: string): string {
  return `.ultrawork/plans/${safeContentFileName(planId)}.md#task-${taskId}`;
}

/**
 * Build the 固定格式 task file contentRef for file mode.
 */
export function taskFileContentRef(taskId: string): string {
  const safeName = safeContentFileName(taskId);
  return `.ultrawork/plans/tasks/${safeName}.md`;
}

/**
 * Resolve a contentRef (relative path possibly with #anchor) to absolute path.
 * Strips #anchor before resolution, then validates path traversal.
 *
 * Path safety:
 * - Relative contentRef (starting with . or /) must resolve inside PLANS_DIR.
 * - Absolute paths outside PLANS_DIR (e.g. /tmp/a.md) are rejected.
 */
export function resolvePlansContentRef(contentRef: string, root: string, plansDir: string): string {
  const pathOnly = contentRef.replace(/#.*$/, "");
  let absoluteTarget: string;
  if (pathOnly.startsWith("./")) {
    // Relative to root with leading ./: ./opencode/plans/... or ./other/path
    const relativePath = pathOnly.slice(2);
    absoluteTarget = join(root, relativePath);
  } else if (pathOnly.startsWith(".")) {
    // Relative to root without leading /: .ultrawork/plans/...
    // Keep the leading dot (e.g., .opencode) intact
    absoluteTarget = join(root, pathOnly);
  } else if (pathOnly.startsWith("/")) {
    absoluteTarget = resolve(pathOnly);
    // For absolute paths, require they be inside plansDir
    assertSafePlansPath(absoluteTarget, plansDir);
    return absoluteTarget;
  } else {
    absoluteTarget = join(root, pathOnly);
  }
  assertSafePlansPath(absoluteTarget, plansDir);
  return absoluteTarget;
}

/**
 * Read plan content file, returning raw content or null if not found.
 */
export function readPlanContent(projectRoot: string, plansDir: string, absolutePath: string): string | null {
  assertSafeContentPath(projectRoot, plansDir, absolutePath);
  if (!existsSync(absolutePath)) return null;
  try {
    return readFileSync(absolutePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Write plan content file atomically. Caller-supplied `createDir` callback
 * is invoked for the parent directory; defaults to `mkdirSync(dir, { recursive: true })`.
 *
 * @param absolutePath 目標檔案絕對路徑（須在 plansDir 內）
 * @param content 寫入內容
 * @param plansDir plans 目錄絕對路徑（用於 path traversal check）
 * @param createDir 可選 callback，用於建立父目錄；預設使用 mkdirSync recursive
 *
 * @throws 當 absolutePath 在 plansDir 外時拋出（path traversal）
 */
export function writePlanContent(
  projectRoot: string,
  absolutePath: string,
  content: string,
  plansDir: string,
  createDir: (dir: string) => void = (dir) => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  },
): void {
  assertSafePlansPath(absolutePath, plansDir);
  assertSafeContentRoot(projectRoot, plansDir);
  const dir = dirname(absolutePath);
  createDir(dir);
  assertSafeContentPath(projectRoot, plansDir, absolutePath);
  atomicWriteFile(absolutePath, content);
}

/**
 * Delete plan content file, safely bounded by PLANS_DIR.
 * Returns true if the file existed and was deleted; false otherwise.
 *
 * 失敗路徑（含 path traversal 拋錯）一律 catch 並回傳 false，避免汙染
 * 上層 delete tool 的正常回傳語意；DEBUG 模式下會輸出錯誤訊息到 stderr。
 */
export function deletePlanContent(projectRoot: string, absolutePath: string, plansDir: string): boolean {
  try {
    const resolved = resolve(absolutePath);
    assertSafeContentPath(projectRoot, plansDir, resolved);
    if (existsSync(resolved)) {
      unlinkSync(resolved);
      return true;
    }
    return false;
  } catch (error) {
    localDebugLog(`deletePlanContent failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * `deletePlanContent` 的嚴格版：**不吞錯**。
 *
 * - 檔案不存在（或掃到時已被別人刪掉）→ 回 `false`，不視為錯誤。
 * - 檔案存在但 `unlinkSync` 失敗（權限、I/O）→ **throw**，讓交易路徑的
 *   `guardedStoreMutation` 捕捉後從快照全還原，避免「檔案還在、registry
 *   已忘記它」的半完成狀態。
 * - path traversal → throw（同 `assertSafePlansPath`）。
 *
 * @returns 是否真的刪掉了一個既有檔
 */
export function deletePlanContentStrict(projectRoot: string, absolutePath: string, plansDir: string): boolean {
  const resolved = resolve(absolutePath);
  assertSafeContentPath(projectRoot, plansDir, resolved);
  if (!existsSync(resolved)) return false;
  try {
    unlinkSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`刪除 ${resolved} 失敗：${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}

