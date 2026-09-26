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
 *   - 參照的**判定**只有一份：`resolvePlansContentRef`（它呼叫與讀寫工具同一個
 *     `assertSafePlansPath`）。周邊的 `tryResolvePlansContentRef` /
 *     `inspectContentRef` / `resolveRegisteredContentRef` 都是它的包裝，分別服務
 *     「只需要知道能不能解析」（prune 比對名單）、「要回報給人看」（doctor）、
 *     「要擋下並說清楚是誰的參照」（內容工具）。任何地方都不許再寫一份前綴規則。
 *
 * @see ../../../../README.md                           — 模組一覽
 * @see ../../../kit/atomic-write.ts                    — atomic write 底層
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AssertPathOutsideWorktree, assertContainedPath } from "../../../kit/path-guard.ts";
import { isLegacyContentRef, legacyContentRefTarget } from "../../../migrate/index.ts";
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
 * 註冊檔裡的參照是誰的、放在哪個欄位。
 *
 * 診斷與錯誤訊息都要能點名「是哪一個計畫／任務的哪個欄位出了問題」——只有參照字串
 * 不足以讓使用者知道要改哪裡，所以持有者資訊是判定結果的一部分，不在呼叫端拼。
 */
export interface ContentRefOwner {
  owner: "plan" | "task";
  id: string;
  field: "contentRef" | "contentPath" | "taskContentPath";
}

/** 持有者的人話標籤（`計畫 x` / `任務 x`）。 */
export function contentRefOwnerLabel(owner: ContentRefOwner): string {
  return `${owner.owner === "plan" ? "計畫" : "任務"} ${owner.id}`;
}

/** 診斷訊息共用的尾巴：告訴使用者去哪裡一次看齊。 */
const SEE_DOCTOR = "用 workflow_doctor 看齊所有需要修的引用（它會逐項點名計畫／任務與修法）。";

/**
 * `resolvePlansContentRef` 的 best-effort 版：守衛擋下就回 `null`。
 *
 * 給「只需要知道這筆能不能解析成內容庫內的路徑」的呼叫端（prune 的比對名單、
 * 掃描其他計畫的共用內容檢查）。**不是放寬守衛**：這些呼叫端本來就只把結果拿來
 * 比對／列名單，真正要讀寫的目標仍各自過 `assertSafeContentPath`。
 *
 * 回 `null` 的參照一定在 `PLANS_DIR` 之外，所以它不可能與任何候選目標同名同路；
 * 跳過它不會讓比對結果變寬鬆（原本會被擋的名單項，本來就刪不到東西）。
 */
export function tryResolvePlansContentRef(
  contentRef: string,
  root: string,
  plansDir: string,
): string | null {
  try {
    return resolvePlansContentRef(contentRef, root, plansDir);
  } catch {
    return null;
  }
}

/** 參照的缺陷種類。`null` 代表沒問題。 */
export type ContentRefDefect = "legacy-prefix" | "outside-store" | "missing-file" | "not-a-file" | null;

export interface ContentRefInspection {
  defect: ContentRefDefect;
  /** 能解析時的絕對路徑；解析不到為 `null`。 */
  resolvedPath: string | null;
  /** 缺陷的完整說明（點名持有者、原始值、修法）；沒有缺陷時為 `null`。 */
  message: string | null;
}

/**
 * 目標現在是不是「可讀的普通檔」，以及不是的時候原因是什麼。
 *
 * 為什麼不能用 `existsSync`：內容庫裡本來就有目錄（`.ultrawork/plans/tasks/`），
 * 而 `existsSync` 對目錄也回 true。引用指到目錄會被判成有效，但讀正文一定失敗 ——
 * `readPlanContent` 的 `readFileSync` 對目錄丟 EISDIR、被 catch 成 `null`，工具端
 * 最後只會回一句 `CONTENT_FILE_NOT_FOUND`。那就是「診斷說正常、其實壞了」。
 *
 * 為什麼用 `statSync` 而不是 `lstatSync`：`assertContainedPath`（`assertSafePlansPath`
 * 的底層）已經逐段拒絕 anchor 與 target 之間的 symlink，**連目標自身那個 segment
 * 都在檢查迴圈裡**，所以能走到這裡的路徑不可能是 symlink。`stat` 的跟隨因此不會改變
 * 判定，用它只是為了拿到 `isFile()`；containment 的判定完全沒有被這裡重新做一遍。
 *
 * 讀不到型態（權限、迴圈等）算 `not-a-file` 而不是「有效」：診斷在無法確認目標可用時
 * 必須報問題，不能回「正常」。這是與 `existsSync` 相比唯一新增的失敗方向 —— 原先會
 * 判有效的路徑，現在可能被判有問題，但不會有「本來有效」被誤判成無效。
 */
function classifyContentTarget(path: string): { verdict: "ok" | "missing" | "not-a-file"; reason?: string } {
  try {
    const stat = statSync(path);
    if (stat.isFile()) return { verdict: "ok" };
    return { verdict: "not-a-file", reason: stat.isDirectory() ? "該路徑是目錄" : "該路徑不是普通檔" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { verdict: "missing" };
    return { verdict: "not-a-file", reason: `讀不到該路徑的檔案型態（${code ?? "未知錯誤"}）` };
  }
}

/**
 * 逐項判定一個註冊檔參照能不能用，並把「不能用」講成可執行的修法。
 *
 * 判定順序刻意分成三級，因為三者對操作者的後果不同：
 *
 * - `legacy-prefix` / `outside-store`（守衛擋下）：這筆引用**用不了** —— 讀寫工具
 *   會被它擋下。
 * - `not-a-file`（守衛放行、但目標是目錄或型態讀不到）：引用格式沒問題，位置也在
 *   內容庫內，但正文一樣讀不到。目錄從來不是合法的正文目標，所以這與項目狀態無關。
 * - `missing-file`（守衛放行、檔案不在）：引用格式沒問題，缺的只是正文。已封存／
 *   已完成的項目本來就常是這個狀態（正文被清掉、引用留著）；**進行中**的項目則是
 *   真的讀不到東西。個別嚴重度由呼叫端依持有者狀態決定（doctor 用），本函式只負責
 *   如實說明事實與修法。
 *
 * 「是不是舊前綴」不自己比字串，而是問搬遷那一側同一個判斷
 * （`isLegacyContentRef`）—— 兩邊對同一個值一定給同一個答案。
 */
export function inspectContentRef(
  contentRef: string,
  root: string,
  plansDir: string,
  owner: ContentRefOwner,
): ContentRefInspection {
  const label = `${contentRefOwnerLabel(owner)} 的 ${owner.field}`;
  const resolvedPath = tryResolvePlansContentRef(contentRef, root, plansDir);
  if (resolvedPath === null) {
    return {
      defect: isLegacyContentRef(contentRef) ? "legacy-prefix" : "outside-store",
      resolvedPath: null,
      message: isLegacyContentRef(contentRef)
        ? `${label}（${contentRef}）還指著已搬走的舊前綴 .opencode/，但內容庫現在是 .ultrawork/plans/。` +
            `修法：把它改成 ${legacyContentRefTarget(contentRef)}（#task-… 片段不動），` +
            `或重跑搬遷讓外掛改寫註冊檔複本。${SEE_DOCTOR}`
        : `${label}（${contentRef}）解析後在內容庫 .ultrawork/plans/ 之外，` +
            `路徑守衛不認這個位置，讀寫工具會被它擋下。` +
            `修法：改成 .ultrawork/plans/ 底下的相對路徑（例如 .ultrawork/plans/<id>.md）；` +
            `若這份內容確實不在專案內，用 plan-content-create 重新建立。${SEE_DOCTOR}`,
    };
  }
  const target = classifyContentTarget(resolvedPath);
  if (target.verdict === "missing") {
    return {
      defect: "missing-file",
      resolvedPath,
      message:
        `${label}（${contentRef}）指向的內容檔不存在：${resolvedPath}。` +
        `引用格式沒問題，缺的只是正文；要恢復正文用 plan-content-create 重新建立。` +
        (owner.owner === "task" ? `（${label} 的計畫正文也可能在別處，doctor 會分別點名。）` : ``) +
        SEE_DOCTOR,
    };
  }
  if (target.verdict === "not-a-file") {
    return {
      defect: "not-a-file",
      resolvedPath,
      message:
        `${label}（${contentRef}）指向的位置不是普通檔（${target.reason}）：${resolvedPath}。` +
        `位置在內容庫內但正文讀不到（讀取時會變成 CONTENT_FILE_NOT_FOUND）。` +
        `修法：把引用指到 .ultrawork/plans/ 底下的 .md 檔；若內容真的還沒建立，` +
        `用 plan-content-create 重新建立。${SEE_DOCTOR}`,
    };
  }
  return { defect: null, resolvedPath, message: null };
}

/**
 * 解析**註冊檔裡的**參照，失敗時拋出點名持有者與修法的錯誤。
 *
 * 錯誤型別維持 `AssertPathOutsideWorktree`（只換訊息），上層既有的 fail-closed
 * 處理不變。用途是「被擋的操作確實要用到這筆引用」——例如更新那個計畫自己的
 * 正文。跟別人無關的掃描不該用這個，請用 `tryResolvePlansContentRef`。
 */
export function resolveRegisteredContentRef(
  contentRef: string,
  root: string,
  plansDir: string,
  owner: ContentRefOwner,
): string {
  try {
    return resolvePlansContentRef(contentRef, root, plansDir);
  } catch (error) {
    if (error instanceof AssertPathOutsideWorktree) {
      const inspection = inspectContentRef(contentRef, root, plansDir, owner);
      throw new AssertPathOutsideWorktree(
        error.filePath,
        error.worktreeRoot,
        inspection.message ?? error.message,
      );
    }
    throw error;
  }
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

