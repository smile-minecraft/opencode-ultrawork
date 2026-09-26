/**
 * commentSignal 工具：comment_signal_touched_report。
 *
 * 回報目前工作階段的 modifiedFiles、每檔狀態、lastReport、warnings 摘要。
 * 行為、args、回傳欄位跟舊版一致，差別只有外殼（defineTool＋zod）
 * 與狀態來源（storage）。
 */

import { z } from "zod";
import { defineTool } from "../../kit/define-tool.ts";
import { jsonResult } from "../../kit/json.ts";
import type { CommentSignalReport, HighRiskItem, Violation } from "./types.ts";
import type { CommentSignalWarning } from "./state.ts";
import type { CommentSignalToolDeps } from "./tool-deps.ts";

const touchedReportInputSchema = z.object({
  sessionID: z.string().optional(),
});

type TouchedReportArgs = z.infer<typeof touchedReportInputSchema>;

interface PerFileStatus {
  filePath: string;
  /** 是否曾被 check 掃描過。 */
  checked: boolean;
  /** 該檔案的高風險命中數（>=0）。 */
  highRiskCount: number;
  /** 該檔案的障礙 violation 數（>=0）。 */
  blockingCount: number;
  /** 該檔案的 warning 數（>=0）。 */
  warningCount: number;
}

interface TouchedReport {
  ok: true;
  sessionID: string;
  modifiedFiles: string[];
  perFile: PerFileStatus[];
  lastReport: CommentSignalReport | null;
  warnings: CommentSignalWarning[];
  humanSummary: string;
}

/**
 * 建立 `comment_signal_touched_report` 工具定義（transform 外先建好，無副作用）。
 *
 * 參數：
 *   - `sessionID`：可選；未指定時 fallback 為工具執行 context 的 sessionID。
 */
export function createCommentSignalTouchedReportTool(deps: CommentSignalToolDeps) {
  return defineTool({
    name: "comment_signal_touched_report",
    description:
      "回報目前 session 的 modifiedFiles 清單、每檔掃描狀態、lastReport 摘要、warnings 摘要。給主要 agent 自我診斷與 final 前確認使用。",
    inputSchema: touchedReportInputSchema,
    execute: async (args: TouchedReportArgs, toolCtx) => {
      const sessionID = args.sessionID ?? toolCtx.sessionID;
      const modifiedFiles = await deps.store.getModifiedFiles(sessionID);
      const lastReport = await deps.store.getLastReport(sessionID);
      const warnings = await deps.store.getWarnings(sessionID);

      const perFile: PerFileStatus[] = modifiedFiles.map((filePath) => {
        const checked = lastReport?.violations.some((v: Violation) => v.filePath === filePath) ?? false;
        const highRiskCount = lastReport?.highRisk.filter((h: HighRiskItem) => h.filePath === filePath).length ?? 0;
        const blockingCount = lastReport?.violations.filter(
          (v: Violation) => v.filePath === filePath && v.severity === "blocking",
        ).length ?? 0;
        const warningCount = lastReport?.violations.filter(
          (v: Violation) => v.filePath === filePath && v.severity === "warning",
        ).length ?? 0;
        return { filePath, checked, highRiskCount, blockingCount, warningCount };
      });

      const report: TouchedReport = {
        ok: true,
        sessionID,
        modifiedFiles,
        perFile,
        lastReport,
        warnings,
        humanSummary: renderTouchedHumanSummary(sessionID, modifiedFiles, lastReport, warnings),
      };
      return jsonResult(report, null, 2);
    },
  });
}

function renderTouchedHumanSummary(
  sessionID: string,
  modifiedFiles: string[],
  lastReport: CommentSignalReport | null,
  warnings: CommentSignalWarning[],
): string {
  const lines: string[] = [];
  lines.push(`Comment Signal Touched Report（session=${sessionID}）`);
  lines.push(`- 本輪修改檔案：${modifiedFiles.length} 個`);
  if (modifiedFiles.length > 0) {
    for (const fp of modifiedFiles) lines.push(`  · ${fp}`);
  }
  if (lastReport) {
    lines.push(
      `- 最近檢查：scannedFileCount=${lastReport.scannedFileCount}, 障礙=${lastReport.errorCount}, warning=${lastReport.warningCount}, highRisk=${lastReport.highRiskCount}, shouldBlockCompletion=${lastReport.shouldBlockCompletion}`,
    );
  } else {
    lines.push("- 最近檢查：尚未執行 comment_signal_check。");
  }
  lines.push(`- pre-edit warnings：${warnings.length} 筆`);
  return lines.join("\n");
}
