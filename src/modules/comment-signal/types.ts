/**
 * opencode-ultrawork — Comment Signal Module：共用型別
 *
 * 角色：
 *   - 提供 Comment Signal 純模組的型別規則，給 parser / policy / validator /
 *     reporter 共同引用。本檔為 pure type module，不放 runtime 邏輯。
 *   - 本模組不接 hooks / runtime state / custom tools，因此本檔不依賴
 *     `core/types.ts` 的 PluginInput / ToolContext 等 runtime 型別。
 *
 * 設計重點：
 *   - 將 Comment Signal 結構切為四層：
 *       1. `CommentSignal` —— 從 source 抽出的一筆已結構化註解。
 *       2. `Violation`     —— validator 對單一信號的檢查結果（含 code / severity）。
 *       3. `FileReport`    —— 單一檔案的掃描結果聚合。
 *       4. `CommentSignalReport` —— 多檔案 aggregate，reporter 最終輸出。
 *   - `Violation` 內含 `severity: "blocking" | "warning"`，方便 reporter
 *     直接分流 `errorCount` 與 `warningCount`，無需事後 lookup policy。
 *   - 所有時間欄位統一以 `YYYY-MM-DD` 字串表達；本模組不引入 Date 物件，
 *     方便測試固定 `today` 並保持純函式特性。
 *
 * 對外規則（不可破壞）：
 *   - 各欄位命名必須與 plan 第 7 節 reporter 輸出欄位一致。
 *   - `agentFeedback` 必含 4 條規則（只修註解 / 不改邏輯 / 不刪除高風險 /
 *     修正後再次 check），由 reporter 內部保證。
 *
 * 限制：
 *   - 不得 import runtime helper（`src/index.ts` / `tools/registry.ts` 等）。
 *   - 不得引入 IO / 副作用。
 *
 * @see ../../../tests/v2/native/diagnostics/tool-parity.test.ts — 凍結清單
 */

// ─── Severity & Tag Types ─────────────────────────────────────

/** 支援的 severity 字串（P0/P1/P2/P3）。 */
export type CommentSignalSeverity = "P0" | "P1" | "P2" | "P3";

/** 註解主類型：說明型（不需 severity）或功能型（需 severity）。 */
export type CommentSignalKind = "descriptive" | "functional";

/** 說明型 tag 字面量集合。使用 string literal 方便擴充。 */
export type DescriptiveTag =
  | "目的"
  | "原因"
  | "限制"
  | "範例"
  | "AI脈絡";

/** 功能型 tag 字面量集合；與 policy.functionalTags 對齊。 */
export type FunctionalTag =
  // 工作流
  | "TODO" | "FIXME" | "REVIEW" | "VERIFY" | "TEST"
  // 風險
  | "WARNING" | "DANGER" | "SECURITY" | "PRIVACY" | "DATA" | "COMPAT"
  // 工程
  | "PERF" | "CACHE" | "SIDE_EFFECT"
  // 架構
  | "CONTRACT" | "INVARIANT" | "BOUNDARY" | "LIFECYCLE" | "OWNERSHIP"
  // AI 專用
  | "AI_TRAP" | "AI_CHECK" | "AI_HANDOFF" | "AI_ASSUMPTION" | "AI_DO_NOT_EDIT";

/** 已知 tag 寬鬆型別（parser 不會 narrow，所以用 string）。 */
export type AnyTag = string;

/** metadata key 名稱（owner/issue/due/expires/test/policy/scope）。 */
export type MetadataKey =
  | "owner"
  | "issue"
  | "due"
  | "expires"
  | "test"
  | "policy"
  | "scope";

// ─── Source Comment Lexer Entry ───────────────────────────────

/**
 * 由 source comment lexer（`lexer.ts` / `extractSourceCommentLines`）
 * 回傳的單筆 entry。同一個 block comment 跨多行時會拆成多個 entry
 * （每行一個），由 parser 用「行號連續性」coalesce 後重建 raw。
 */
export interface SourceCommentLine {
  /** comment 起始的 1-based 行號。 */
  line: number;
  /** 移除 // 或 星號斜線 markers 後保留的內文（一行）。 */
  text: string;
  /**
   * comment marker 在該行的 0-based 起始欄（以正規化換行後的 source 計）。
   * 只有能精確定位 marker 的 lexer 會填寫（目前為 Swift）；未填寫時
   * parser 沿用既有「整行重找 marker」行為，保持其他語言相容。
   * 用途：呼叫端程式碼與字串內的假 marker（如 `"/// [WARN:P1]"`）不得
   * 污染尾端真實註解的解析，parser 必須從此欄位重建 raw。
   */
  startColumn?: number;
}

// ─── Comment Signal (single parsed signal) ────────────────────

/** 從 source 抽出的一筆結構化註解。 */
export interface CommentSignal {
  /** 來源檔案路徑（parser 注入，方便 reporter 直接顯示 file:line）。 */
  filePath: string;
  /** 1-based 行號。 */
  line: number;
  /** 說明型 vs 功能型。 */
  kind: CommentSignalKind;
  /** 解析出的 tag 名稱（如 "TODO" / "目的" / "WARN"）。 */
  tag: AnyTag;
  /** 功能型才會有 severity；說明型為 null。 */
  severity: CommentSignalSeverity | null;
  /** metadata 鍵值對；只記錄合法 key=value。 */
  metadata: Partial<Record<MetadataKey, string>>;
  /** 註解主體（去掉 tag header 後的純文字說明）。 */
  body: string;
  /** 原始字串（含 `//` 或 block-comment 標記），供 reporter / explain tool 使用。 */
  raw: string;
}

// ─── Violation (validator output) ────────────────────────────

/**
 * 障礙 violation codes：出現時 reporter 應將 `shouldBlockCompletion`
 * 設為 true。此 union 與 policy.blockingViolationCodes 對齊。
 */
export type BlockingViolationCode =
  | "UNKNOWN_TAG"
  | "MISSING_SEVERITY"
  | "INVALID_SEVERITY"
  | "BAD_METADATA"
  | "WORKFLOW_ID_IN_COMMENT";

/**
 * 非阻斷 codes：初版不形成 completion 障礙，但 agentFeedback 仍需列出。
 */
export type WarningViolationCode =
  | "UNFORMATTED_FUNCTIONAL_COMMENT"
  | "NO_CHINESE"
  | "TOO_SHORT"
  | "GENERIC_COMMENT"
  | "MISSING_REASON"
  | "EXPIRED_COMMENT"
  | "OVERDUE_COMMENT"
  | "MISSING_OWNER"
  | "MISSING_ISSUE";

/** 全部 violation code 寬鬆 union；reporter / policy 仍以寬鬆 string 接收。 */
export type ViolationCode = BlockingViolationCode | WarningViolationCode | (string & {});

/** 嚴重度（blocking = error / warning = warning）。 */
export type ViolationSeverity = "blocking" | "warning";

/** validator 對單一 signal / line 的檢查結果。 */
export interface Violation {
  /** violation code。 */
  code: ViolationCode;
  /** 障礙 vs 警示。 */
  severity: ViolationSeverity;
  /** 命中位置（可能來自 CommentSignal 或 raw line）。 */
  filePath: string;
  line: number;
  /** 命中 tag（若有）。 */
  tag?: string;
  /** 命中 severity（若有）。 */
  signalSeverity?: CommentSignalSeverity | null;
  /** 違反事實摘要（給 humanSummary / agentFeedback 使用）。 */
  message: string;
  /** 建議修正方向（給 agentFeedback 使用；可省略）。 */
  suggestion?: string;
}

// ─── High Risk Item ──────────────────────────────────────────

/** 高風險註解摘要（檔案層級提醒用）。 */
export interface HighRiskItem {
  filePath: string;
  line: number;
  tag: string;
  severity: CommentSignalSeverity;
  body: string;
}

// ─── Validation Result (validator output) ────────────────────

/** validator 對單檔（或一組 signals）回傳的結果。 */
export interface ValidationResult {
  violations: Violation[];
  highRisk: HighRiskItem[];
  shouldBlockCompletion: boolean;
  errorCount: number;
  warningCount: number;
  highRiskCount: number;
}

// ─── File Report ─────────────────────────────────────────────

/** 單一檔案的掃描結果。reporter 接收多份 FileReport 並 aggregate。 */
export interface FileReport {
  filePath: string;
  /** 是否成功掃描；預設為 true（無 IO 失敗情境）。 */
  scanned: boolean;
  signals: CommentSignal[];
  violations: Violation[];
  highRisk: HighRiskItem[];
  shouldBlockCompletion: boolean;
  errorCount: number;
  warningCount: number;
  highRiskCount: number;
}

// ─── Aggregate Report ────────────────────────────────────────

/** reporter 最終輸出。欄位命名與 plan 第 7 節一致。 */
export interface CommentSignalReport {
  /** 掃描檔案數。 */
  scannedFileCount: number;
  /** 檢查註解數。 */
  checkedCommentCount: number;
  /** 全部 violation 數（blocking + warning）。 */
  violationCount: number;
  /** 障礙 violation 數。 */
  errorCount: number;
  /** 警示 violation 數。 */
  warningCount: number;
  /** 高風險註解數。 */
  highRiskCount: number;
  /** 主要 agent 是否遇到完成障礙。 */
  shouldBlockCompletion: boolean;
  /** 給主要 agent 的可執行修正指令。 */
  agentFeedback: string;
  /** 全部 violation 詳列。 */
  violations: Violation[];
  /** 高風險註解摘要清單。 */
  highRisk: HighRiskItem[];
  /** 給人類閱讀的繁體中文摘要。 */
  humanSummary: string;
  /**
   * 明確跳過的檔案數（目前語意：Markdown 排除等）。
   * Optional 向後相容；舊 caller 不讀取此欄位仍可正常運作。
   * 不計入 `scannedFileCount`。
   */
  skippedFileCount?: number;
  /**
   * 無法讀取的檔案數（resolver 回 null：檔案不存在 / 權限不足 / 讀檔失敗）。
   * Optional 向後相容；不計入 `scannedFileCount`。
   * 當顯式 path 為 supported executable 但 `unreadableFileCount > 0` 且
   * `scannedFileCount === 0` 時，tool layer 會依 實作說明 要求將
   * `shouldBlockCompletion` 設為 true 並填入 `failClosedReason`。
   */
  unreadableFileCount?: number;
  /**
   * 顯式 supported executable path 為零 readable scans 時的 fail-closed
   * 原因。Markdown-only 顯式 path 不會觸發。Optional 向後相容。
   */
  failClosedReason?: string;
}

// ─── Validator / Reporter Options ────────────────────────────

/** validator 與 reporter 共用的執行選項。 */
export interface ValidateOptions {
  /**
   * 判定 expired / overdue 的基準日（YYYY-MM-DD）。
   * 不填時 validator 內部 fallback 為 `1970-01-01`，
   * 使所有 expires / due 都視為未過期（測試隔離用）。
   */
  today?: string;
  /** source-level 檢查使用的來源路徑；沒有 formal signal 時仍能正確定位。 */
  filePath?: string;
  /** policy override；不填時使用 defaultCommentSignalPolicy。 */
  policy?: CommentSignalPolicy;
}

/** parser 對單行的掃描結果（給 detectUnformattedFunctionalComment 使用）。 */
export interface UnformattedFunctionalHit {
  /** 觸發的 keyword（如 "TODO" / "FIXME" / "WARNING" / "待辦" / "之後處理"）。 */
  matchedKeywords: string[];
  /** 命中行 raw 文字。 */
  raw: string;
  /** 行號（由 parser 注入；detectUnformattedFunctionalComment 純函式回 null）。 */
  line: number | null;
}

// ─── Policy (shape only) ─────────────────────────────────────

/**
 * policy 形狀定義；`policy.ts` 匯出 default 實例與 helper。
 * 呼叫端（測試與 state 層）可以傳入自訂 policy，例如放寬部分規則。
 */
export interface CommentSignalPolicy {
  /** 說明型 tag 白名單。 */
  descriptiveTags: DescriptiveTag[];
  /** 功能型 tag 白名單。 */
  functionalTags: FunctionalTag[];
  /** 支援的 severity 白名單。 */
  severities: CommentSignalSeverity[];
  /** 支援的 metadata key 白名單。 */
  metadataKeys: MetadataKey[];
  /** 命中即形成完成障礙的 violation code。 */
  blockingViolationCodes: BlockingViolationCode[];
  /** 高風險 tag。 */
  highRiskTags: FunctionalTag[];
  /** 高風險 severity。 */
  highRiskSeverities: CommentSignalSeverity[];
  /** 是否要求 P0 functional 必須有 owner metadata。 */
  requireOwnerForP0: boolean;
  /** 是否要求 FIXME:P0/P1 functional 必須有 issue metadata。 */
  requireIssueForFixmeHighSeverity: boolean;
  /** 最短 body 長度（含中英文字數 / 不含標點）；低於此值視為 TOO_SHORT。 */
  minBodyLength: number;
  /** 中文字符偵測 regex；命中視為含中文（避免大量補丁。 */
  chineseCharPattern: RegExp;
}
