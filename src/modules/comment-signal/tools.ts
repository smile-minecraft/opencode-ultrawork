/**
 * commentSignal 工具 barrel：4 個 tool factory 的薄 composition 層。
 *
 * 對外規則：
 *   - 4 個工具名稱：`comment_signal_check`／`comment_signal_policy`／
 *     `comment_signal_touched_report`／`comment_signal_explain`。
 *   - factory 簽名、args schema、回傳欄位、session 語意完全相容舊版。
 *   - `CommentSignalToolDeps` 型別維持匯出。
 *   - `__commentSignalToolInternals` 維持匯出（hook 共用 helper）。
 *
 * 本檔只做 re-export 與 internals 重組，不含 factory 本體邏輯。
 */

import { isBlockingViolationCode, isHighRisk } from "./policy.ts";
import { detectHighRiskComments, shouldBlockCompletion } from "./guard.ts";
import { resolveCheckInputs } from "./tool-check.ts";
import { COMMON_MISTAKES } from "./tool-policy.ts";
import { diagnoseRawLine } from "./tool-explain.ts";

export type { CommentSignalToolDeps } from "./tool-deps.ts";
export { createCommentSignalCheckTool } from "./tool-check.ts";
export { createCommentSignalPolicyTool } from "./tool-policy.ts";
export { createCommentSignalTouchedReportTool } from "./tool-touched-report.ts";
export { createCommentSignalExplainTool } from "./tool-explain.ts";

/**
 * helper exports（給 hook integration 使用，避免重複邏輯）。
 * 語意跟舊版一致。
 */
export const __commentSignalToolInternals = {
  resolveCheckInputs,
  diagnoseRawLine,
  COMMON_MISTAKES,
  isHighRisk,
  isBlockingViolationCode,
  detectHighRiskComments,
  shouldBlockCompletion,
};
