/**
 * opencode-ultrawork — Comment Signal Module：guard
 *
 * 角色：
 *   - 提供檔案層級檢查入口（checkFile / checkFiles / checkChangedFiles），
 *     串接既有 parser / validator / reporter。
 *   - 提供 `detectHighRiskComments`：根據 policy.highRiskTags + highRiskSeverities
 *     過濾 highRisk items（給 hook 與 UI 用）。
 *   - 提供 `shouldBlockCompletion`：依 policy 指定的障礙 violation codes
 *     決定是否形成完成障礙（其他 warning 不形成障礙，但仍需 agentFeedback）。
 *   - 提供 `isMarkdownPath`：判斷檔案路徑是否為 Markdown（.md / .markdown）。
 *     Comment Signal 系統完全避開 Markdown：MD 屬於文件而非程式碼，且 MD 語法
 *     （[link](url)、# heading、```code fence```）會讓 parser 誤判為 functional
 *     tag（特別是 `[文字]` 內含英數字串時會被視為 UNKNOWN_TAG）。此 helper 是
 *     guard / tools / registry / hook 統一過濾 Markdown 的 single 唯一正式資料。
 *
 * 設計重點：
 *   - 純函式 / pure module 風格：不直接讀檔、不引入 IO；source 由呼叫端注入。
 *     測試以 Map / Record 形式的 sourceResolver 注入；hooks 層再決定
 *     如何從檔案系統讀 source（Bun.file / fs.readFileSync 等）。
 *   - checkFile / checkFiles / checkChangedFiles 統一回傳 CommentSignalReport，
 *     便於工具層（`tools.ts`）直接 dispatch。
 *   - checkChangedFiles 接受 session state，預設檢查 state.modifiedFiles；
 *     指定 path 時僅納入符合路徑前綴或等於精確路徑的檔案（支援檔案或資料夾）。
 *   - checkFile / checkFiles / checkChangedFiles 統一在掃描前先以 isMarkdownPath
 *     過濾；MD 檔案直接回傳空 report，不計入 scannedFileCount，亦不呼叫
 *     sourceResolver 讀取內容（避免 IO + parser 誤判）。
 *
 * 對外規則（不可破壞）：
 *   - shouldBlockCompletion 僅因 policy 內的障礙 violation code 為 true；
 *     其他 warning 一律不形成障礙。
 *   - detectHighRiskComments 採用 defaultCommentSignalPolicy（可由 options.policy 覆寫）。
 *   - checkChangedFiles 在 sourceResolver 回傳 null 時跳過該檔案（不視為 scan 失敗），
 *     符合 hook 在檔案尚不存在或已被刪除時的容錯需求。
 *   - isMarkdownPath 大小寫不敏感；以 basename（最後一段）為判斷依據。
 *
 * 限制：
 *   - 不放 IO；不放 plugin hooks import。
 *   - 不修改 state；state mutation 由呼叫端（hooks 層或本檔 caller）負責。
 *
 * @see ./types.ts                                         — 型別
 * @see ./policy.ts                                        — 障礙 / highRisk 判定
 * @see ./validator.ts                                     — validateSource
 * @see ./reporter.ts                                      — buildReport
 * @see ./state.ts                                         — session state 容器
 */

import type {
  CommentSignalReport,
  FileReport,
  HighRiskItem,
  CommentSignalPolicy,
  ValidateOptions,
  Violation,
} from "./types.ts";
import { defaultCommentSignalPolicy, isBlockingViolationCode } from "./policy.ts";
import { parseCommentSignals } from "./parser.ts";
import { validateSource } from "./validator.ts";
import { buildReport } from "./reporter.ts";
import { isScannableExplicitPath, toPolicyRelativePath } from "./file-scan.ts";
import type { CommentSignalState } from "./state.ts";

// ─── Public Options ──────────────────────────────────────────

/**
 * checkChangedFiles 選項；繼承 ValidateOptions 並擴充 path filter。
 */
export interface CheckChangedFilesOptions extends ValidateOptions {
  /**
   * 篩選要檢查的檔案路徑：
   *   - 不指定時：檢查 session.modifiedFiles 全部檔案。
   *   - 指定時：納入檔案路徑等於 path 或以 path 開頭的檔案
   *     （例如 "src/auth" 命中 "src/auth/login.ts"、
   *      "src/auth.ts" 命中精確檔案 "src/auth.ts"）。
   */
  path?: string;
  /**
   * 工作階段根目錄：有值時政策判定先 canonical 化（symlink 別名現形），
   * 省略時沿用字面路徑判定（純函式單元測試與舊呼叫端行為不變）。
   */
  worktree?: string;
}

/** 餵給 checkFiles 的單筆 entry。 */
export interface CheckFileEntry {
  filePath: string;
  source: string;
}

// ─── High Risk Detection ─────────────────────────────────────

/**
 * 從 highRisk items 中過濾出符合 highRisk tags + severity 的子集。
 *
 * 規則（plan 第 6 節）：
 *   - tag ∈ policy.highRiskTags（DANGER / SECURITY / PRIVACY / DATA /
 *     INVARIANT / AI_TRAP / AI_DO_NOT_EDIT）。
 *   - severity ∈ policy.highRiskSeverities（P0 / P1）。
 *
 * @param highRisk 已聚合的 highRisk items（通常來自 validator / reporter）。
 * @param policy 可選 policy override；不指定時使用 default。
 */
export function detectHighRiskComments(
  highRisk: HighRiskItem[],
  policy: CommentSignalPolicy = defaultCommentSignalPolicy,
): HighRiskItem[] {
  const tags = policy.highRiskTags as readonly string[];
  const sevs = policy.highRiskSeverities as readonly string[];
  return highRisk.filter((h) => tags.includes(h.tag) && sevs.includes(h.severity));
}

// ─── shouldBlockCompletion ───────────────────────────────────

/**
 * 依 policy 決定是否形成完成障礙。
 * 只有 blockingViolationCodes 內的 code 會形成障礙；其他 warning codes 一律不形成障礙
 * （但 reporter.agentFeedback 仍會給修正建議）。
 *
 * @param violations validator / buildReport 後的 violation 清單。
 * @param policy 可選 policy override；不指定時使用 default。
 */
export function shouldBlockCompletion(
  violations: Violation[],
  policy: CommentSignalPolicy = defaultCommentSignalPolicy,
): boolean {
  return violations.some((v) => isBlockingViolationCode(v.code, policy));
}

// ─── File-level Check ────────────────────────────────────────

/**
 * 檢查單一檔案並回傳 CommentSignalReport aggregate。
 * 接受 filePath + source 字串，無 IO；source 由呼叫端負責取得。
 *
 * 若 filePath 為 Markdown（.md / .markdown，大小寫不敏感），直接回傳空 report
 * （不計入 scannedFileCount、不解析 source）。詳見 isMarkdownPath。
 *
 * @param filePath 檔案路徑（會注入至 FileReport.filePath 與各 violation.filePath）。
 * @param source  檔案原始內容。
 * @param options 執行選項（today、policy override）。
 */
export function checkFile(
  filePath: string,
  source: string,
  options: ValidateOptions = {},
): CommentSignalReport {
  if (isMarkdownPath(filePath)) {
    return buildReport([], options);
  }
  return checkFiles([{ filePath, source }], options);
}

/**
 * 檢查多個檔案並回傳 CommentSignalReport aggregate。
 * 接受 entries（filePath + source）陣列，無 IO。
 *
 * 會從 entries 中過濾掉 Markdown 檔案（呼叫 isMarkdownPath）；其餘 entries 才會
 * 進入 parse + validate 流程。過濾後的 fileReports 與 buildReport aggregate
 * 一致：scannedFileCount 只反映非 MD 檔案數。
 *
 * @param entries 多筆檔案內容。
 * @param options 執行選項（today、policy override）。
 */
export function checkFiles(
  entries: CheckFileEntry[],
  options: ValidateOptions = {},
): CommentSignalReport {
  // 先過濾 Markdown：避免 parser 對 MD 語法（[link] / # heading / ``` fence）誤判
  const filtered = entries.filter((e) => !isMarkdownPath(e.filePath));
  const skippedFileCount = entries.length - filtered.length;
  const fileReports: FileReport[] = filtered.map((entry) => {
    const parsed = parseCommentSignals(entry.source, entry.filePath);
    const v = validateSource(entry.source, parsed.signals, {
      ...options,
      filePath: entry.filePath,
    });
    return {
      filePath: entry.filePath,
      scanned: true,
      signals: parsed.signals,
      violations: v.violations,
      highRisk: v.highRisk,
      shouldBlockCompletion: v.shouldBlockCompletion,
      errorCount: v.errorCount,
      warningCount: v.warningCount,
      highRiskCount: v.highRiskCount,
    };
  });

  const report = buildReport(fileReports, options);
  report.skippedFileCount = skippedFileCount;
  return report;
}

/**
 * 檢查 session state 的 modifiedFiles。
 * 預設檢查全部 modifiedFiles；指定 options.path 時僅納入符合路徑
 * （精確檔案路徑或資料夾前綴）的檔案。
 *
 * 非 Markdown 但不合掃描政策（敏感／dotfile／不支援副檔名）者同樣在讀取前排除、
 * 不計入 scanned、計入 skipped（跟目錄掃描與顯式單檔分支一致）。
 *
 * Markdown 檔案會在 matchesPathFilter 之後、呼叫 sourceResolver 之前被排除：
 *   - 不計入 scannedFileCount。
 *   - 不會觸發 sourceResolver（避免 IO + parser 誤判）。
 *   - state.modifiedFiles 本身**不會**被修改；filter 只發生於掃描當下。
 *   - 計入 `skippedFileCount`（讓 caller 區分 scanned / skipped / unreadable）。
 *
 * sourceResolver 為「給定 filePath 回傳 source 或 null」的函式；
 * 回傳 null 表示該檔案無法讀取（不存在 / 已刪除 / 權限不足等），
 * 此時該檔案會被跳過，不計入 scannedFileCount，也不視為 scan 失敗。
 * 該檔會計入 `unreadableFileCount`。
 *
 * @param state 該 session 的 CommentSignalState（提供 modifiedFiles）。
 * @param sourceResolver 給定檔案路徑回傳 source 或 null。
 * @param options 執行選項（today、policy override、可選 path filter）。
 */
export function checkChangedFiles(
  state: CommentSignalState,
  sourceResolver: (filePath: string) => string | null,
  options: CheckChangedFilesOptions = {},
): CommentSignalReport {
  const { path: pathFilter } = options;
  // 先按 path filter 篩選；再區分 Markdown（計入 skipped，不呼叫 resolver）
  // 與待掃描檔案（呼叫 resolver，null 計入 unreadable）。如此才能在
  // changedOnly 路徑下同時區分 scanned / skipped / unreadable 三類。
  const inFilter = state.modifiedFiles.filter((fp) => matchesPathFilter(fp, pathFilter));
  const markdownSkipped = inFilter.filter((fp) => isMarkdownPath(fp));
  // 跟目錄掃描／顯式單檔一致：敏感／dotfile／不支援副檔名不讀不掃，計入 skipped。
  // 政策判定一律看 canonical 相對路徑（symlink 別名現形）；無 worktree 時
  // 回退字面判定（純函式既有行為不變）。
  const policyRel = (fp: string): string =>
    options.worktree === undefined ? fp : toPolicyRelativePath(options.worktree, fp);
  const policySkipped = inFilter.filter((fp) => !isMarkdownPath(fp) && !isScannableExplicitPath(policyRel(fp)));
  const targetFiles = inFilter.filter((fp) => !isMarkdownPath(fp) && isScannableExplicitPath(policyRel(fp)));
  const entries: CheckFileEntry[] = [];
  let unreadableFileCount = 0;
  for (const filePath of targetFiles) {
    const source = sourceResolver(filePath);
    if (source === null) {
      unreadableFileCount++;
      continue; // 檔案不可讀取：跳過，不計入 scanned；計入 unreadableFileCount
    }
    entries.push({ filePath, source });
  }
  const report = checkFiles(entries, options);
  // 始終指派數字型 skippedFileCount / unreadableFileCount，讓 caller
  // 可 deterministic 地區分三類（0 也是合法值）。
  report.skippedFileCount = (report.skippedFileCount ?? 0) + markdownSkipped.length + policySkipped.length;
  report.unreadableFileCount = unreadableFileCount;
  return report;
}

// ─── Path matching helper ────────────────────────────────────

/**
 * 判斷 filePath 是否符合 path filter。
 *   - filter 為 undefined 時全部命中。
 *   - filter 與 filePath 完全相等時命中。
 *   - filter 以 "/" 結尾或為資料夾前綴時，filePath 為 filter 前綴亦命中。
 *   - 其他情況視為精確檔案路徑比對。
 */
function matchesPathFilter(filePath: string, filter: string | undefined): boolean {
  if (!filter) return true;
  if (filePath === filter) return true;
  // 資料夾前綴：以 "/" 結尾或為目錄前綴
  if (filePath.startsWith(`${filter}/`)) return true;
  return false;
}

// ─── Markdown detection────

/**
 * 判斷 filePath 是否為 Markdown 檔案（.md / .markdown，大小寫不敏感）。
 *
 * Comment Signal 系統完全不掃描 Markdown：
 *   - MD 屬於文件而非程式碼，無需此系統檢查。
 *   - MD 語法（如 `[link](url)`、`# heading`、```code fence```）會讓 parser 誤判
 *     `[link]` 為 functional tag 並擷取出非法 `link` 字串當作 tag name，
 *     進而觸發 UNKNOWN_TAG 障礙與莫名其妙的 warning。
 *   - 使用者明確要求：MD 檔案不需要這個系統。
 *
 * 規則：
 *   - 取路徑最後一段（basename）作為判斷依據，避免目錄名含 `.md` 時誤判
 *     （例如 `src/module.md/foo.ts` 不算 MD）。
 *   - 大小寫不敏感（README.MD / Changelog.MarkDown 都視為 MD）。
 *   - 空字串或非字串回傳 false（不 throw，便於測試與呼叫端容錯）。
 *
 * @param filePath 檔案路徑（相對或絕對皆可；含 `/` 或 `\` 都會取最後一段）。
 */
export function isMarkdownPath(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") return false;
  // 取最後一段：同時處理 POSIX 與 Windows 路徑分隔符
  const segments = filePath.split(/[/\\]/);
  const basename = segments[segments.length - 1] ?? "";
  if (!basename) return false;
  const lower = basename.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}
