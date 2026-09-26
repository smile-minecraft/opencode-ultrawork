/**
 * opencode-ultrawork — Comment Signal Module：validator（純檢查）
 *
 * 角色：
 *   - 對 parser 抽出的 CommentSignal 套用 defaultCommentSignalPolicy，
 *     產出 Violation 清單與 highRisk 清單，供 reporter 聚合。
 *   - 對 source comment 中未被 formal header 包裝的「未格式化功能型註解」
 *     （TODO fix later / FIXME 之後處理 / WARNING: 文字 等）補上
 *     UNFORMATTED_FUNCTIONAL_COMMENT warning。
 *
 * 設計重點：
 *   - 純函式：接收 source + signals 或僅 signals，回傳結構化結果。
 *   - 對於 parser 已記錄但 tag 不在 policy.functionalTags 的情況，
 *     validator 標記 UNKNOWN_TAG（blocking）。
 *   - severity 缺失 / 非法分別標 MISSING_SEVERITY / INVALID_SEVERITY（blocking）。
 *   - metadata 中若 token 不符合 `key=value` 或 key 不在白名單，
 *     validator 從原始 raw 重新解析，命中即標 BAD_METADATA（blocking）。
 *   - NO_CHINESE / TOO_SHORT / GENERIC_COMMENT / MISSING_REASON 為 warning。
 *   - EXPIRED_COMMENT / OVERDUE_COMMENT 透過 today 比較，warning。
 *   - MISSING_OWNER / MISSING_ISSUE 依 policy 設定，warning。
 *   - highRisk 偵測獨立於 violation；同一信號可同時有 violation 與 highRisk。
 *
 * 對外規則（不可破壞）：
 *   - `validateCommentSignals` 必須回傳完整 ValidationResult，
 *     包含 `shouldBlockCompletion`（聚合 blocking code 數）。
 *   - 對空 signals 回傳空 violations / empty highRisk、shouldBlockCompletion=false。
 *
 * 限制：
 *   - 不得引入 IO / 副作用。
 *   - 不得 import runtime helper。
 *
 * @see ./types.ts                                         — Violation 形狀
 * @see ./policy.ts                                        — default policy
 * @see ./parser.ts                                        — input source
 */

import type {
  CommentSignal,
  Violation,
  HighRiskItem,
  CommentSignalPolicy,
  CommentSignalSeverity,
  ValidationResult,
  ValidateOptions,
} from "./types.ts";
import { defaultCommentSignalPolicy, isHighRisk, isBlockingViolationCode } from "./policy.ts";
import { detectUnformattedFunctionalComment } from "./parser.ts";
import { extractSourceCommentLines } from "./lexer.ts";

/** 以日期與流水號結尾的 Plan／Task instance ID。 */
const TIMESTAMP_WORKFLOW_ID_RE = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-20\d{6}-\d{3,}\b/i;

/** 明確的英文 Task 編號；分隔符可避免把 taskId 等識別字誤判為追蹤資訊。 */
const EXPLICIT_TASK_NUMBER_RE = /\btask(?:\s+|#)\s*#?\d{3,}\b/i;

/** 明確的中文任務編號。 */
const EXPLICIT_CJK_TASK_NUMBER_RE = /任務\s*#?\s*\d{3,}/;

/** kebab-case instance slug；至少含一個數字以降低一般技術術語的誤判。 */
const WORKFLOW_SLUG_RE = /\b(?=[a-z0-9-]*\d)[a-z0-9]+(?:-[a-z0-9]+)+\b/i;

/** plan／task 後方的 kebab-case instance slug。 */
const EXPLICIT_WORKFLOW_SLUG_RE = /\b(?:plan|task)\s+(?=[a-z0-9-]*\d)[a-z0-9]+(?:-[a-z0-9]+)+\b/i;

// ─── Validator Entry ─────────────────────────────────────────

/**
 * 驗證 parser 抽出的 signals，產出 validation result。
 *
 * @param signals 來自 parseCommentSignals 的信號清單。
 * @param options 執行選項（today、policy override）。
 */
export function validateCommentSignals(
  signals: CommentSignal[],
  options: ValidateOptions = {},
): ValidationResult {
  const policy = options.policy ?? defaultCommentSignalPolicy;
  const today = options.today ?? "1970-01-01";

  const violations: Violation[] = [];
  const highRisk: HighRiskItem[] = [];

  for (const sig of signals) {
    validateSingleSignal(sig, policy, today, violations, highRisk);
  }

  // 統計
  let errorCount = 0;
  let warningCount = 0;
  for (const v of violations) {
    if (isBlockingViolationCode(v.code, policy)) errorCount++;
    else warningCount++;
  }

  return {
    violations,
    highRisk,
    shouldBlockCompletion: errorCount > 0,
    errorCount,
    warningCount,
    highRiskCount: highRisk.length,
  };
}

/**
 * 對 source 整體掃描未格式化的功能型註解（即使 parser 已抓到 formal header
 * 也要檢查其他行）。給 validator 一次掃完後與既有 violations 合併。
 *
 * @param source 原始檔案內容。
 * @param filePath 來源檔案路徑。
 * @param options 執行選項。
 */
export function validateSourceForUnformatted(
  source: string,
  filePath: string,
  options: ValidateOptions = {},
): Violation[] {
  const out: Violation[] = [];
  const comments = extractSourceCommentLines(source, filePath);

  // 與 workflow ID scanner 共用語言感知 lexer，避免把 import path、URL、
  // 字串或 executable identifier 內的 TEST／REVIEW 等字樣誤判為註解。
  for (const comment of comments) {
    const hit = detectUnformattedFunctionalComment(comment.text);
    if (!hit) continue;

    // 排除已含 `[TAG...]` 開頭的情況（parser 已抓過）
    if (/\[[^\]]+\]/.test(comment.text)) continue;

    out.push({
      code: "UNFORMATTED_FUNCTIONAL_COMMENT",
      severity: "warning",
      filePath,
      line: comment.line,
      message: `未格式化的功能型註解：行內含 ${hit.matchedKeywords.join(", ")}，但未使用 [TAG:SEVERITY] 格式。`,
      suggestion: "改為 [TAG:P0|P1|P2|P3] 並提供繁體中文說明，例如 [TODO:P2] 之後補上單元測試。",
    });
  }

  return out;
}

/**
 * 找出 source comment 內的具體工作流 instance ID。
 *
 * 只檢查 lexer 抽出的 line／block comment，不掃 executable code 或字串內容。
 * 一般技術詞彙（plan state、task registry、taskId、plan.taskIds）不符合
 * instance pattern，因此不會被標記。
 */
export function validateSourceForWorkflowIds(
  source: string,
  filePath: string,
): Violation[] {
  const violations: Violation[] = [];
  const comments = extractSourceCommentLines(source, filePath);

  for (let index = 0; index < comments.length; index++) {
    const comment = comments[index];
    const previous = comments[index - 1];
    const continuedSlug = previous
      && comment.line === previous.line + 1
      && /\b(?:plan|task)\s*$/i.test(previous.text.trim())
      ? comment.text.match(WORKFLOW_SLUG_RE)
      : null;
    const matched = comment.text.match(TIMESTAMP_WORKFLOW_ID_RE)
      ?? comment.text.match(EXPLICIT_TASK_NUMBER_RE)
      ?? comment.text.match(EXPLICIT_CJK_TASK_NUMBER_RE)
      ?? comment.text.match(EXPLICIT_WORKFLOW_SLUG_RE)
      ?? continuedSlug;
    if (!matched) continue;

    violations.push({
      code: "WORKFLOW_ID_IN_COMMENT",
      severity: "blocking",
      filePath,
      line: comment.line,
      message: `註解含具體 Plan／Task instance ID：「${matched[0]}」。`,
      suggestion: "移除註解中的工作流識別資訊；Task／Plan ID 應寫入固定格式文件或 registry，註解只保留持久的技術原因、限制與不變量。",
    });
  }

  return violations;
}

// ─── Single Signal Validation ────────────────────────────────

function validateSingleSignal(
  sig: CommentSignal,
  policy: CommentSignalPolicy,
  today: string,
  violations: Violation[],
  highRisk: HighRiskItem[],
): void {
  // descriptive tag：只檢查有無中文（NO_CHINESE / TOO_SHORT / GENERIC_COMMENT）
  if (sig.kind === "descriptive") {
    validateDescriptiveBody(sig, policy, violations);
    return;
  }

  // functional tag：以下檢查
  // 1) UNKNOWN_TAG
  if (!(policy.functionalTags as readonly string[]).includes(sig.tag)) {
    violations.push({
      code: "UNKNOWN_TAG",
      severity: "blocking",
      filePath: sig.filePath,
      line: sig.line,
      tag: sig.tag,
      message: `未知的 tag：「${sig.tag}」不在功能型白名單內。`,
      suggestion: `改用合法 tag：${(policy.functionalTags).slice(0, 8).join(", ")}…等。`,
    });
    // UNKNOWN_TAG 之下不再續檢（severity / metadata 等都不可信）
    return;
  }

  // 2) MISSING_SEVERITY / INVALID_SEVERITY
  if (!sig.severity) {
    violations.push({
      code: "MISSING_SEVERITY",
      severity: "blocking",
      filePath: sig.filePath,
      line: sig.line,
      tag: sig.tag,
      message: `功能型 tag「${sig.tag}」缺少 severity。`,
      suggestion: `改為 [${sig.tag}:P0|P1|P2|P3] 並補上繁體中文說明。`,
    });
    return; // 沒有 severity 後續也無從判斷
  } else if (!(policy.severities as readonly string[]).includes(sig.severity)) {
    violations.push({
      code: "INVALID_SEVERITY",
      severity: "blocking",
      filePath: sig.filePath,
      line: sig.line,
      tag: sig.tag,
      signalSeverity: sig.severity,
      message: `非法的 severity：「${sig.severity}」不在 P0/P1/P2/P3 內。`,
      suggestion: `改為 [${sig.tag}:P0|P1|P2|P3]。`,
    });
    return;
  }

  // 3) BAD_METADATA：從 raw 重新解析 token，檢查是否有非 key=value 形式
  detectBadMetadata(sig, policy, violations);

  // 4) NO_CHINESE / TOO_SHORT / GENERIC_COMMENT
  validateFunctionalBody(sig, policy, violations);

  // 5) MISSING_REASON（P0/P1 須說明違反後果）
  if (sig.severity === "P0" || sig.severity === "P1") {
    if (!hasReasonPhrase(sig.body)) {
      violations.push({
        code: "MISSING_REASON",
        severity: "warning",
        filePath: sig.filePath,
        line: sig.line,
        tag: sig.tag,
        signalSeverity: sig.severity,
        message: `${sig.tag}:${sig.severity} 缺少違反後果說明。`,
        suggestion: "補上「否則 / 會造成 / 將導致 / 不可逆 / 必須」等後果詞，幫助 reviewer 判斷風險。",
      });
    }
  }

  // 6) EXPIRED_COMMENT / OVERDUE_COMMENT
  if (sig.metadata.expires) {
    if (compareDate(sig.metadata.expires, today) < 0) {
      violations.push({
        code: "EXPIRED_COMMENT",
        severity: "warning",
        filePath: sig.filePath,
        line: sig.line,
        tag: sig.tag,
        message: `expires=${sig.metadata.expires} 已過期（today=${today}）。`,
        suggestion: "延長 expires 或移除此註解。",
      });
    }
  }
  if (sig.metadata.due) {
    if (compareDate(sig.metadata.due, today) < 0) {
      violations.push({
        code: "OVERDUE_COMMENT",
        severity: "warning",
        filePath: sig.filePath,
        line: sig.line,
        tag: sig.tag,
        message: `due=${sig.metadata.due} 已過期（today=${today}）。`,
        suggestion: "更新 due 或 close 對應工作項。",
      });
    }
  }

  // 7) MISSING_OWNER / MISSING_ISSUE
  if (policy.requireOwnerForP0 && sig.severity === "P0" && !sig.metadata.owner) {
    violations.push({
      code: "MISSING_OWNER",
      severity: "warning",
      filePath: sig.filePath,
      line: sig.line,
      tag: sig.tag,
      signalSeverity: sig.severity,
      message: `${sig.tag}:${sig.severity} 缺少 owner metadata。`,
      suggestion: "補上 owner=@name 指明負責人。",
    });
  }
  if (
    policy.requireIssueForFixmeHighSeverity
    && sig.tag === "FIXME"
    && (sig.severity === "P0" || sig.severity === "P1")
    && !sig.metadata.issue
  ) {
    violations.push({
      code: "MISSING_ISSUE",
      severity: "warning",
      filePath: sig.filePath,
      line: sig.line,
      tag: sig.tag,
      signalSeverity: sig.severity,
      message: `FIXME:${sig.severity} 缺少 issue metadata。`,
      suggestion: "補上 issue=#123 串接追蹤項目。",
    });
  }

  // 8) highRisk 判定（與 violation 無關）
  if (isHighRisk(sig.tag, sig.severity, policy)) {
    highRisk.push({
      filePath: sig.filePath,
      line: sig.line,
      tag: sig.tag,
      severity: sig.severity,
      body: sig.body,
    });
  }
}

// ─── Body content checks ─────────────────────────────────────

function validateDescriptiveBody(
  sig: CommentSignal,
  policy: CommentSignalPolicy,
  violations: Violation[],
): void {
  const body = sig.body;
  if (body.length === 0) return; // 說明型允許空（搭配區塊說明）
  if (body.length < policy.minBodyLength) {
    violations.push({
      code: "TOO_SHORT",
      severity: "warning",
      filePath: sig.filePath,
      line: sig.line,
      tag: sig.tag,
      message: `說明型 [${sig.tag}] 內容過短（${body.length} 字）。`,
      suggestion: "補充具體說明，至少 4 個字元。",
    });
  }
  if (!policy.chineseCharPattern.test(body)) {
    violations.push({
      code: "NO_CHINESE",
      severity: "warning",
      filePath: sig.filePath,
      line: sig.line,
      tag: sig.tag,
      message: `說明型 [${sig.tag}] 未含繁體中文。`,
      suggestion: "改寫為繁體中文。",
    });
  }
}

function validateFunctionalBody(
  sig: CommentSignal,
  policy: CommentSignalPolicy,
  violations: Violation[],
): void {
  const body = sig.body;
  if (body.length < policy.minBodyLength) {
    violations.push({
      code: "TOO_SHORT",
      severity: "warning",
      filePath: sig.filePath,
      line: sig.line,
      tag: sig.tag,
      signalSeverity: sig.severity,
      message: `[${sig.tag}:${sig.severity}] 內容過短（${body.length} 字）。`,
      suggestion: "補充具體說明，避免「注意 / TODO」這類空泛詞。",
    });
  }
  if (body.length > 0 && !policy.chineseCharPattern.test(body)) {
    violations.push({
      code: "NO_CHINESE",
      severity: "warning",
      filePath: sig.filePath,
      line: sig.line,
      tag: sig.tag,
      signalSeverity: sig.severity,
      message: `[${sig.tag}:${sig.severity}] 內容未含繁體中文。`,
      suggestion: "改寫為繁體中文。",
    });
  }
  if (isGenericFunctionalBody(body)) {
    violations.push({
      code: "GENERIC_COMMENT",
      severity: "warning",
      filePath: sig.filePath,
      line: sig.line,
      tag: sig.tag,
      signalSeverity: sig.severity,
      message: `[${sig.tag}:${sig.severity}] 內容空泛。`,
      suggestion: "說明要做什麼、為什麼、預期影響。",
    });
  }
}

/** 偵測「空泛 / 模糊」功能性 body。 */
function isGenericFunctionalBody(body: string): boolean {
  if (!body) return false;
  const stripped = body.replace(/[\s,.。、!?！？:：;；]/g, "");
  if (stripped.length === 0) return true;
  const GENERIC = [
    "之後處理", "之後再說", "之後再改", "之後補", "之後再加", "之後修正",
    "待辦", "待補", "待修", "之後", "再說", "再改",
    "TBD", "TODO", "FIXME",
  ];
  return GENERIC.includes(stripped);
}

/**
 * 偵測 body 是否含「違反後果」描述詞。
 * P0/P1 應包含「否則 / 將 / 會 / 造成 / 導致 / 不可 / 必須 / 不可逆」等後果詞。
 */
function hasReasonPhrase(body: string): boolean {
  if (!body) return false;
  return /(否則|將導致|會造成|會導致|造成|導致|不可|必須|不可逆|避免|防止|否|影響)/.test(body);
}

// ─── Metadata raw re-parse ───────────────────────────────────

function detectBadMetadata(
  sig: CommentSignal,
  policy: CommentSignalPolicy,
  violations: Violation[],
): void {
  // 從 raw 取出 `[TAG ...]` 區段
  const m = sig.raw.match(/\[([^\]]+)\]/);
  if (!m) return;
  const inside = m[1];
  // 拆出 tag 與剩餘 tokens
  const tokens = inside.split(/\s+/);
  if (tokens.length <= 1) return;
  tokens.shift(); // 移除 tag
  // 第一個 token 若形如 TAG:SEV，整體丟棄
  if (tokens[0] && /^[A-Z_]+:[A-Z0-9]+$/.test(tokens[0])) tokens.shift();

  for (const tok of tokens) {
    if (!tok) continue;
    const eqIdx = tok.indexOf("=");
    if (eqIdx === -1) {
      violations.push({
        code: "BAD_METADATA",
        severity: "blocking",
        filePath: sig.filePath,
        line: sig.line,
        tag: sig.tag,
        message: `metadata 不是 key=value 格式：「${tok}」。`,
        suggestion: "改為 owner=@name / issue=#123 等 key=value 形式。",
      });
      continue;
    }
    const key = tok.slice(0, eqIdx);
    if (!(policy.metadataKeys as readonly string[]).includes(key)) {
      violations.push({
        code: "BAD_METADATA",
        severity: "blocking",
        filePath: sig.filePath,
        line: sig.line,
        tag: sig.tag,
        message: `不合法或不在白名單內的 metadata key：「${key}」。`,
        suggestion: `僅允許：${(policy.metadataKeys).join(", ")}。`,
      });
      continue;
    }
    const value = tok.slice(eqIdx + 1);
    if ((key === "expires" || key === "due") && !isValidDate(value)) {
      violations.push({
        code: "BAD_METADATA",
        severity: "blocking",
        filePath: sig.filePath,
        line: sig.line,
        tag: sig.tag,
        message: `${key}=${value} 不是合法 YYYY-MM-DD 日期。`,
        suggestion: "改為 YYYY-MM-DD 形式，例如 2026-12-31。",
      });
    }
  }
}

/** 簡化版日期驗證：`YYYY-MM-DD`。 */
function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  // 不嚴格檢查月份天數範圍，僅檢查格式（避免過度嚴格造成 false negative）
  return true;
}

/** 比較兩個 YYYY-MM-DD 日期字串（a<b 回 -1、a>b 回 1、相等回 0）。 */
function compareDate(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ─── Convenience: merge violations with unformatted scan ─────

/**
 * 便利 helper：合併 validateCommentSignals 與 validateSourceForUnformatted
 * 的結果，並重新計算 shouldBlockCompletion / errorCount / warningCount。
 *
 *  主要給 reporter 內部使用，後續  可直接呼叫。
 */
export function validateSource(
  source: string,
  signals: CommentSignal[],
  options: ValidateOptions = {},
): ValidationResult {
  const policy = options.policy ?? defaultCommentSignalPolicy;
  const today = options.today ?? "1970-01-01";

  // 先取得 signal-level violations
  const signalViolations: Violation[] = [];
  const highRisk: HighRiskItem[] = [];
  for (const sig of signals) {
    validateSingleSignal(sig, policy, today, signalViolations, highRisk);
  }

  // 再加上 source-level 未格式化檢查
  const filePath = options.filePath ?? signals[0]?.filePath ?? "<unknown>";
  const unformatted = validateSourceForUnformatted(source, filePath, options);
  const workflowIds = validateSourceForWorkflowIds(source, filePath);

  const violations = [...signalViolations, ...unformatted, ...workflowIds];

  let errorCount = 0;
  let warningCount = 0;
  for (const v of violations) {
    if (isBlockingViolationCode(v.code, policy)) errorCount++;
    else warningCount++;
  }

  return {
    violations,
    highRisk,
    shouldBlockCompletion: errorCount > 0,
    errorCount,
    warningCount,
    highRiskCount: highRisk.length,
  };
}

/**  ValidationResult 型別出口（避免 reporter 額外 import）。 */
export type { ValidationResult } from "./types.ts";
