/**
 * opencode-ultrawork — Comment Signal Module：default policy
 *
 * 角色：
 *   - 提供 `defaultCommentSignalPolicy` 常數，作為 validator / reporter
 *     在無外部 policy 注入時的 fallback。
 *   - 將 plan 第 4~5 節全部規則釐清為單一物件，便於 state 層
 *     與工具層重複引用；同時便於測試以 `policy` 覆寫部分欄位。
 *
 * 設計重點：
 *   - policy 為 pure data object（無函式、無 closure），可序列化、可 diff。
 *   - 障礙與 highRisk 分離：障礙決定 shouldBlockCompletion、
 *     highRisk 決定 highRiskCount / pre-edit warning 行為（供 hooks 層使用）。
 *   - 中文字符偵測 regex 採 `\u4e00-\u9fff` Unicode 範圍，
 *     與既有 `core/helpers.ts` 之 `deriveProjectId` 採同範圍，避免策略漂移。
 *
 * 對外規則（不可破壞）：
 *   - default policy 必須包含 plan 第 4.3 節全部 functional tag 與
 *     第 4.4 節全部 severity、第 4.5 節全部 metadata key、第 5 節
 *     障礙 violation code、第 6 節 highRisk tags / severities。
 *   - 變更 policy 欄位值需同步更新 `02-validator.test.ts` 的 policy coverage。
 *
 * 限制：
 *   - 純常數 + 純函式；不得引入 IO / 副作用。
 *   - 不得 import runtime helper。
 *
 * @see ./types.ts                                         — CommentSignalPolicy 形狀
 */

import type {
  CommentSignalPolicy,
  DescriptiveTag,
  FunctionalTag,
  MetadataKey,
  CommentSignalSeverity,
  BlockingViolationCode,
} from "./types.ts";

/** 全部說明型 tag（plan 第 4.1 節）。 */
const DESCRIPTIVE_TAGS: readonly DescriptiveTag[] = [
  "目的",
  "原因",
  "限制",
  "範例",
  "AI脈絡",
] as const;

/** 全部功能型 tag（plan 第 4.3 節）。 */
const FUNCTIONAL_TAGS: readonly FunctionalTag[] = [
  // 工作流
  "TODO", "FIXME", "REVIEW", "VERIFY", "TEST",
  // 風險
  "WARNING", "DANGER", "SECURITY", "PRIVACY", "DATA", "COMPAT",
  // 工程
  "PERF", "CACHE", "SIDE_EFFECT",
  // 架構
  "CONTRACT", "INVARIANT", "BOUNDARY", "LIFECYCLE", "OWNERSHIP",
  // AI 專用
  "AI_TRAP", "AI_CHECK", "AI_HANDOFF", "AI_ASSUMPTION", "AI_DO_NOT_EDIT",
] as const;

/** 全部 severity（plan 第 4.4 節）。 */
const SEVERITIES: readonly CommentSignalSeverity[] = ["P0", "P1", "P2", "P3"] as const;

/** 全部 metadata key（plan 第 4.5 節）。 */
const METADATA_KEYS: readonly MetadataKey[] = [
  "owner",
  "issue",
  "due",
  "expires",
  "test",
  "policy",
  "scope",
] as const;

/** 障礙 violation codes（plan 第 5 節「初版完成條件」）。 */
const BLOCKING_VIOLATION_CODES: readonly BlockingViolationCode[] = [
  "UNKNOWN_TAG",
  "MISSING_SEVERITY",
  "INVALID_SEVERITY",
  "BAD_METADATA",
  "WORKFLOW_ID_IN_COMMENT",
] as const;

/** 高風險 tag（plan 第 6 節）。 */
const HIGH_RISK_TAGS: readonly FunctionalTag[] = [
  "DANGER",
  "SECURITY",
  "PRIVACY",
  "DATA",
  "INVARIANT",
  "AI_TRAP",
  "AI_DO_NOT_EDIT",
] as const;

/** 高風險 severity（plan 第 6 節）。 */
const HIGH_RISK_SEVERITIES: readonly CommentSignalSeverity[] = ["P0", "P1"] as const;

/**
 * default policy：
 *   - 全部 tag / severity / metadata / blocking / highRisk 取自上方常數。
 *   - requireOwnerForP0 = true：P0 functional 必須有 owner metadata。
 *   - requireIssueForFixmeHighSeverity = true：FIXME:P0/P1 必須有 issue metadata。
 *   - minBodyLength = 4：低於此值（如「注意」「TODO」）視為 TOO_SHORT。
 *   - chineseCharPattern：CJK Unified Ideographs 基本平面 U+4E00–U+9FFF。
 *
 * 對外規則：測試 `02-validator.test.ts` policy coverage 須對應本物件內容。
 */
export const defaultCommentSignalPolicy: CommentSignalPolicy = {
  descriptiveTags: [...DESCRIPTIVE_TAGS],
  functionalTags: [...FUNCTIONAL_TAGS],
  severities: [...SEVERITIES],
  metadataKeys: [...METADATA_KEYS],
  blockingViolationCodes: [...BLOCKING_VIOLATION_CODES],
  highRiskTags: [...HIGH_RISK_TAGS],
  highRiskSeverities: [...HIGH_RISK_SEVERITIES],
  requireOwnerForP0: true,
  requireIssueForFixmeHighSeverity: true,
  minBodyLength: 4,
  chineseCharPattern: /[\u4e00-\u9fff]/,
};

/**
 * 判斷 violation code 是否代表障礙（命中即無法完成）。
 * 集中於 policy 是為了 state 層 / 工具層可自訂 blocking 子集。
 */
export function isBlockingViolationCode(
  code: string,
  policy: CommentSignalPolicy = defaultCommentSignalPolicy,
): boolean {
  return (policy.blockingViolationCodes as readonly string[]).includes(code);
}

/**
 * 判斷 (tag, severity) 是否構成 highRisk。
 * 高風險 = tag ∈ highRiskTags 且 severity ∈ highRiskSeverities。
 */
export function isHighRisk(
  tag: string,
  severity: CommentSignalSeverity,
  policy: CommentSignalPolicy = defaultCommentSignalPolicy,
): boolean {
  return (
    (policy.highRiskTags as readonly string[]).includes(tag)
    && (policy.highRiskSeverities as readonly string[]).includes(severity)
  );
}
