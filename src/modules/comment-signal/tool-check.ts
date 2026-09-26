/**
 * commentSignal 工具：comment_signal_check。
 *
 * 行為、args schema、回傳欄位、session 語意跟舊版一致：
 * 預設 changedOnly=true 走工作階段 modifiedFiles；指定 path 可搭配
 * changedOnly 走前綴過濾，或 changedOnly=false 直接掃檔案／資料夾；
 * 結果寫入 lastReport 供 touched_report 讀取。
 * 差別只有外殼：defineTool＋zod、狀態走 storage、位置走工作階段解析。
 */

import { z } from "zod";
import { defineTool } from "../../kit/define-tool.ts";
import { jsonResult } from "../../kit/json.ts";
import {
  checkFile,
  checkFiles,
  checkChangedFiles,
  isMarkdownPath,
  type CheckChangedFilesOptions,
  type CheckFileEntry,
} from "./guard.ts";
import { isScannableExplicitPath, toPolicyRelativePath } from "./file-scan.ts";
import { defaultCommentSignalPolicy } from "./policy.ts";
import type { CommentSignalReport } from "./types.ts";
import type { CommentSignalToolDeps } from "./tool-deps.ts";

const checkInputSchema = z.object({
  path: z.string().optional(),
  changedOnly: z.boolean().optional(),
  json: z.boolean().optional(),
});

type CheckArgs = z.infer<typeof checkInputSchema>;

/**
 * 依 comment_signal_check 參數決定檢查選項。
 * - 預設 `changedOnly=true`：取工作階段 modifiedFiles 內所有檔案。
 * - 指定 `path`：以 path 為前綴／精確檔案過濾。
 * - 指定 `path`＋`changedOnly=false`：呼叫端直接讀 path，不走此 helper。
 */
export function resolveCheckInputs(
  args: { path?: string; changedOnly?: boolean },
  deps: Pick<CommentSignalToolDeps, "today">,
): CheckChangedFilesOptions {
  const changedOnly = args.changedOnly !== false; // 預設 true
  const today = deps.today ?? "1970-01-01";
  const options: CheckChangedFilesOptions = {
    today,
    policy: defaultCommentSignalPolicy,
  };
  if (args.path) options.path = args.path;
  if (!changedOnly) options.path = options.path ?? ".";
  return options;
}

/**
 * 判斷 `path` 是否看起來像資料夾路徑（不以支援的 executable 副檔名結尾）。
 * 用於區分 explicit path 是單檔或資料夾。
 */
function isDirectoryLikePath(path: string): boolean {
  if (path.endsWith("/")) return true;
  // 含點號且以常見 executable 副檔名結尾 → 視為單檔
  if (/\.[a-zA-Z0-9]+$/.test(path)) return false;
  return true;
}

/**
 * 將 fail-closed report 加上 metadata 與障礙旗標。
 * - Markdown-only 顯式 path 由呼叫端負責不要觸發（透過 isMarkdownPath
 *   或 `directoryInspector` 判斷 directory 內容）。
 */
function markFailClosed(
  report: CommentSignalReport,
  reason: string,
  unreadableFileCount: number,
): CommentSignalReport {
  report.shouldBlockCompletion = true;
  report.failClosedReason = reason;
  report.unreadableFileCount = (report.unreadableFileCount ?? 0) + unreadableFileCount;
  // agentFeedback 仍保留既有 4 條規則但附帶 fail-closed 提示，避免覆蓋。
  if (!report.agentFeedback.includes("fail-closed")) {
    report.agentFeedback = [
      `Comment Signal fail-closed：${reason}（unreadableFileCount=${unreadableFileCount}）`,
      "請確認 path 存在且可讀取；Markdown-only 為唯一允許的零掃描顯式 path。",
      "",
      report.agentFeedback,
    ].join("\n");
  }
  return report;
}

/**
 * 將 directoryResolver 回空陣列的 case 拆解為 Markdown-only／empty／
 * 非 Markdown 三類，僅後兩者觸發 `no_supported_files` fail-closed。
 * - Markdown-only → 不形成障礙、不計 unreadable。
 * - 其餘（含未提供 `directoryInspector` 的保守 fallback）→ 既有
 *   `no_supported_files` fail-closed 行為。
 */
function buildEmptyDirectoryReport(
  worktree: string,
  dirPath: string,
  deps: CommentSignalToolDeps,
  today: string,
): CommentSignalReport {
  const base = checkFiles([], { today, policy: defaultCommentSignalPolicy });
  const kind = deps.directoryInspector
    ? deps.directoryInspector(worktree, dirPath)
    : null;
  if (kind === "markdownOnly") {
    base.unreadableFileCount = 0;
    return base;
  }
  return markFailClosed(base, "no_supported_files", 1);
}

/** 建立 `comment_signal_check` 工具定義（transform 外先建好，無副作用）。 */
export function createCommentSignalCheckTool(deps: CommentSignalToolDeps) {
  return defineTool({
    name: "comment_signal_check",
    description:
      "Comment Signal 註解必要檢查：預設檢查目前 session 修改過的檔案，回傳 plan 第 7 節全部欄位（scannedFileCount/checkedCommentCount/violationCount/errorCount/warningCount/highRiskCount/shouldBlockCompletion/agentFeedback/violations/highRisk/humanSummary），並可區別 scanned/skipped/unreadable。指定 path 時可檢查指定檔案或資料夾；changedOnly=false 可脫離 session 限制。顯式 supported executable path 零 readable scans 時 fail closed（會形成障礙）。Markdown-only 仍維持不形成障礙。",
    inputSchema: checkInputSchema,
    execute: async (args: CheckArgs, toolCtx) => {
      const sessionID = toolCtx.sessionID;
      const worktree = await deps.resolveRoot(toolCtx);
      const resolver = (filePath: string): string | null =>
        deps.sourceResolver(worktree, filePath);

      let report: CommentSignalReport;
      const today = deps.today ?? "1970-01-01";

      if (args.changedOnly === false && !args.path) {
        // 防呆：changedOnly=false 但未指定 path 時，不要默默掃整個專案。
        // 回傳空 report 並提示需指定 path。
        report = checkFiles([], { today, policy: defaultCommentSignalPolicy });
      } else if (args.path && args.changedOnly === false) {
        // 指定 path＋changedOnly=false：直接讀檔（單檔或資料夾），不走 session state。
        const path = args.path;

        // Markdown 顯式 path：依既有規則直接回空 report，不觸發 fail-closed。
        if (isMarkdownPath(path)) {
          report = checkFile(path, "", { today, policy: defaultCommentSignalPolicy });
        } else if (isDirectoryLikePath(path)) {
          // 視為資料夾：透過 deps.directoryResolver 取得資料夾內檔案清單。
          const filePaths = deps.directoryResolver
            ? deps.directoryResolver(worktree, path)
            : null;
          if (filePaths === null) {
            // directoryResolver 回 null：目錄不存在／不可列舉
            report = checkFiles([], { today, policy: defaultCommentSignalPolicy });
            report = markFailClosed(report, "directory_unreadable", 1);
          } else if (filePaths.length === 0) {
            // 目錄存在但沒有任何 supported executable 檔案。
            // 需用 `directoryInspector` 進一步區分 Markdown-only／真正空目錄／
            // 非 Markdown unsupported：前者不形成障礙，後兩者沿用既有 fail-closed。
            report = buildEmptyDirectoryReport(worktree, path, deps, today);
          } else {
            // 手動構造 entries 並追蹤 unreadable 數量
            const entries: CheckFileEntry[] = [];
            let unreadableFileCount = 0;
            for (const fp of filePaths) {
              const source = resolver(fp);
              if (source === null) {
                unreadableFileCount++;
                continue;
              }
              entries.push({ filePath: fp, source });
            }
            report = checkFiles(entries, { today, policy: defaultCommentSignalPolicy });
            // 顯式 supported path 卻 zero readable → fail closed。
            if (report.scannedFileCount === 0) {
              report = markFailClosed(
                report,
                "all_files_unreadable",
                unreadableFileCount,
              );
            } else {
              // 非 fail-closed 路徑：始終指派數字型 unreadableFileCount，
              // 讓 caller 與測試確定地區分三類（0 也是合法值）。
              report.unreadableFileCount = unreadableFileCount;
            }
          }
        } else if (!isScannableExplicitPath(toPolicyRelativePath(worktree, path))) {
          // 跟目錄掃描一致：dotfile／不支援副檔名／敏感路徑的顯式單檔不讀不掃，
          // 回空 report（不阻擋、不觸發 fail-closed；敏感內容絕不讀進來）。
          // 路徑先 canonical 化再判定（symlink 別名現形）。
          report = checkFiles([], { today, policy: defaultCommentSignalPolicy });
        } else {
          // 精確檔案（單檔）
          const source = resolver(path);
          if (source === null) {
            // 顯式 supported executable 檔案但讀不到 → fail closed
            // （Markdown 已被前面的 isMarkdownPath 排除）。
            report = checkFiles([], { today, policy: defaultCommentSignalPolicy });
            report = markFailClosed(report, "file_unreadable", 1);
          } else {
            report = checkFile(path, source, { today, policy: defaultCommentSignalPolicy });
          }
        }
      } else {
        // 預設（changedOnly=true 或僅指定 path）：走 checkChangedFiles
        const opts = resolveCheckInputs(args, deps);
        // changed-only 政策判定 canonical 化（symlink 別名現形）。
        opts.worktree = worktree;
        const modifiedFiles = await deps.store.getModifiedFiles(sessionID);
        report = checkChangedFiles({ sessionID, modifiedFiles, lastReport: null, warnings: [] }, resolver, opts);
      }

      // 將本次結果寫入 session state 供 touched_report 讀取
      await deps.store.recordLastReport(sessionID, report);

      return jsonResult({ ok: true, ...report }, null, 2);
    },
  });
}
