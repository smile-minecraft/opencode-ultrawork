/**
 * opencode-ultrawork — Comment Signal Module：reporter（純聚合）
 *
 * 角色：
 *   - 接收多份 FileReport，聚合為 CommentSignalReport aggregate。
 *   - 產出 `humanSummary`（繁體中文人類閱讀摘要）與 `agentFeedback`
 *     （給主要 agent 的可執行修正指令）。
 *
 * 設計重點：
 *   - 純函式：無 IO、不讀檔、不寫檔；輸入 FileReport[] 與 ValidateOptions，
 *     輸出 CommentSignalReport。
 *   - agentFeedback 結構穩定：固定包含 4 條規則 +
 *     違規清單（最多 N 筆，超量摘要）+ 重試指令。
 *   - humanSummary 使用繁體中文，符合 AGENTS.md 全域語言規範。
 *   - shouldBlockCompletion 採 OR 聚合（任一檔案有障礙即為 true）。
 *
 * 對外規則（不可破壞）：
 *   - 輸出欄位命名與 plan 第 7 節 reporter 需求逐字一致。
 *   - agentFeedback 必須含 4 條修正規則 + comment_signal_check 重試指令。
 *
 * 限制：
 *   - 不得引入 IO / 副作用。
 *   - 不得 import runtime helper。
 *
 * @see ./types.ts                                         — FileReport / Report 形狀
 * @see ./policy.ts                                        — 障礙判定
 */

import type {
  CommentSignalReport,
  FileReport,
  Violation,
  ValidateOptions,
  CommentSignalPolicy,
} from "./types.ts";
import { defaultCommentSignalPolicy, isBlockingViolationCode } from "./policy.ts";

// ─── Aggregate Entry ─────────────────────────────────────────

/** agentFeedback 中列出的違規上限（避免 prompt 膨脹）。 */
const AGENT_FEEDBACK_MAX_VIOLATIONS = 20;

/** agentFeedback 軟上限（字元數）。超過時提示看 structured report。 */
const AGENT_FEEDBACK_SOFT_LIMIT = 4000;

/**
 * 聚合多份 FileReport 為 CommentSignalReport aggregate。
 *
 * @param fileReports 各檔掃描結果（已含 violations / highRisk 等）。
 * @param options 執行選項（today、policy override）。
 */
export function buildReport(
  fileReports: FileReport[],
  options: ValidateOptions = {},
): CommentSignalReport {
  const policy = options.policy ?? defaultCommentSignalPolicy;
  const today = options.today ?? "1970-01-01";
  void today; // today 已在 validator 使用；reporter 僅作參數保留供未來擴充

  // 聚合 counts
  let scannedFileCount = 0;
  let checkedCommentCount = 0;
  let violationCount = 0;
  let errorCount = 0;
  let warningCount = 0;
  let highRiskCount = 0;
  let shouldBlockCompletion = false;
  const violations: Violation[] = [];
  const highRiskAgg = [...fileReports]
    .sort((a, b) => a.filePath.localeCompare(b.filePath))
    .flatMap((fr) => fr.highRisk.map((h) => ({ ...h, filePath: fr.filePath })));

  for (const fr of fileReports) {
    if (fr.scanned) scannedFileCount++;
    checkedCommentCount += fr.signals.length;
    violationCount += fr.violations.length;
    errorCount += fr.errorCount;
    warningCount += fr.warningCount;
    highRiskCount += fr.highRiskCount;
    if (fr.shouldBlockCompletion) shouldBlockCompletion = true;
    for (const v of fr.violations) violations.push(v);
  }

  // 排序：障礙在前、warning 在後；同類依 filePath + line
  violations.sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity === "blocking" ? -1 : 1;
    }
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    return a.line - b.line;
  });

  const agentFeedback = renderAgentFeedback(violations, shouldBlockCompletion, policy);
  const humanSummary = renderHumanSummary({
    scannedFileCount,
    checkedCommentCount,
    violationCount,
    errorCount,
    warningCount,
    highRiskCount,
    shouldBlockCompletion,
  });

  return {
    scannedFileCount,
    checkedCommentCount,
    violationCount,
    errorCount,
    warningCount,
    highRiskCount,
    shouldBlockCompletion,
    agentFeedback,
    violations,
    highRisk: highRiskAgg,
    humanSummary,
  };
}

// ─── Human Summary ───────────────────────────────────────────

interface HumanSummaryInput {
  scannedFileCount: number;
  checkedCommentCount: number;
  violationCount: number;
  errorCount: number;
  warningCount: number;
  highRiskCount: number;
  shouldBlockCompletion: boolean;
}

function renderHumanSummary(s: HumanSummaryInput): string {
  const blockDecision = s.shouldBlockCompletion ? "有障礙，尚未完成" : "通過";
  const lines: string[] = [];
  lines.push(`Comment Signal 檢查結果：${blockDecision}`);
  lines.push(`- 掃描檔案：${s.scannedFileCount}`);
  lines.push(`- 檢查註解：${s.checkedCommentCount}`);
  lines.push(`- 違規總計：${s.violationCount}（障礙 ${s.errorCount} / 警示 ${s.warningCount}）`);
  lines.push(`- 高風險註解：${s.highRiskCount}`);
  return lines.join("\n");
}

// ─── Agent Feedback ──────────────────────────────────────────

function renderAgentFeedback(
  violations: Violation[],
  shouldBlockCompletion: boolean,
  policy: CommentSignalPolicy,
): string {
  if (!shouldBlockCompletion && violations.length === 0) {
    return [
      "Comment Signal 檢查通過：未發現障礙或警示問題，可回報任務完成。",
      "若後續修改檔案，請於 final 前再次呼叫 comment_signal_check。",
    ].join("\n");
  }

  if (!shouldBlockCompletion && violations.length > 0) {
    // 純 warning 路徑（沒有障礙），仍需給主要 agent 修正指引
    return renderWarningFeedback(violations, policy);
  }

  return renderBlockingFeedback(violations, policy);
}

/** 純 warning 路徑：給主要 agent 改善建議，但允許最終回報。 */
function renderWarningFeedback(
  violations: Violation[],
  policy: CommentSignalPolicy,
): string {
  const lines: string[] = [];
  lines.push("Comment Signal 檢查發現警告層級註解問題，本次沒有障礙但建議修正。");
  lines.push("");
  lines.push("修正限制：");
  lines.push("1. 只修正註解。");
  lines.push("2. 不要修改程式邏輯。");
  lines.push("3. 不要刪除高風險註解來規避檢查。");
  lines.push("4. 修正後再次呼叫 comment_signal_check 驗證。");
  lines.push("");
  lines.push(`問題清單（共 ${violations.length} 筆）：`);
  appendViolationList(lines, violations, policy);
  return maybeTruncate(lines.join("\n"));
}

/** 有障礙的路徑：必須先修正的問題清單 + 重試指令。 */
function renderBlockingFeedback(
  violations: Violation[],
  policy: CommentSignalPolicy,
): string {
  const blocking = violations.filter((v) => isBlockingViolationCode(v.code, policy));
  const warning = violations.filter((v) => !isBlockingViolationCode(v.code, policy));

  const lines: string[] = [];
  lines.push(`Comment Signal 檢查發現 ${blocking.length} 個障礙，必須先修正才能回報任務完成。`);
  lines.push("");
  lines.push("修正限制：");
  lines.push("1. 只修正註解。");
  lines.push("2. 不要修改程式邏輯。");
  lines.push("3. 不要刪除高風險註解來規避檢查。");
  lines.push("4. 修正後必須再次呼叫 comment_signal_check。");
  lines.push("");
  lines.push(`障礙清單（共 ${blocking.length} 筆）：`);
  appendViolationList(lines, blocking, policy);

  if (warning.length > 0) {
    lines.push("");
    lines.push(`其他警告（共 ${warning.length} 筆，建議一併修正）：`);
    appendViolationList(lines, warning, policy);
  }

  return maybeTruncate(lines.join("\n"));
}

function appendViolationList(
  lines: string[],
  list: Violation[],
  _policy: CommentSignalPolicy,
): void {
  const slice = list.slice(0, AGENT_FEEDBACK_MAX_VIOLATIONS);
  slice.forEach((v, idx) => {
    lines.push(`${idx + 1}. ${v.filePath}:${v.line}`);
    lines.push(`   問題：${v.message}`);
    if (v.suggestion) lines.push(`   建議：${v.suggestion}`);
  });
  if (list.length > AGENT_FEEDBACK_MAX_VIOLATIONS) {
    lines.push(
      `…另有 ${list.length - AGENT_FEEDBACK_MAX_VIOLATIONS} 筆未列示，請看 violations 結構化結果。`,
    );
  }
}

/** 軟上限截斷：保留必要指令 + 提示看結構化結果。 */
function maybeTruncate(text: string): string {
  if (text.length <= AGENT_FEEDBACK_SOFT_LIMIT) return text;
  const keep = text.slice(0, AGENT_FEEDBACK_SOFT_LIMIT);
  return `${keep}\n\n…（內容過長已截斷，請查看 CommentSignalReport.violations 取得完整清單）`;
}
