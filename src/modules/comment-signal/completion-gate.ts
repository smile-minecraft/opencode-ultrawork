/**
 * opencode-ultrawork — Comment Signal Module：結案 gate 的聚合判定
 *
 * 角色：把一個工作階段的 Comment Signal 狀態（storage 上的原始值）收斂成
 * 結案 gate 的唯一結論。`validateCommentSignalForCompletion`（workflow 執行期）
 * 與 Comment Signal 狀態層都走這裡，避免兩份各自實作的判定日久分歧。
 *
 * 為什麼是獨立模組：workflow runtime 只拿到 `storage`，若直接 import
 * `state.ts` 會把 store 類別與寫入鎖一起拖進依賴圖。這裡刻意只依賴
 * `types.ts` 的型別（type-only），保持純函式、無 IO、無副作用。
 *
 * 判定語意：
 *   - 以「每個檔案的最新 per-file 報告」為準。任一件 `shouldBlockCompletion`
 *     為真即阻斷；後寫入的別檔報告不會把先前的阻斷蓋掉。
 *   - 同一檔被重新檢查後，乾淨報告會覆蓋舊的阻斷報告，所以問題修好即解除，
 *     不會永久誤擋。
 *   - 收集範圍是全部 per-file 報告，不與 `modifiedFiles` 取交集：
 *     `comment_signal_check`（指定 path）會寫報告但不一定把檔案記成已修改，
 *     若取交集，「已檢出問題卻沒編輯過」的情形會被漏放。
 *   - 完全沒有任何報告（沒改過檔、也沒跑過 check）→ `not-reported`，
 *     不阻斷也不假裝通過。
 *   - 升級相容：舊版狀態只有 `lastReport`。它記錄的阻斷會被遷移成 per-file
 *     阻斷記錄（見 `migrateLegacyBlockingReports`），因此**不會因為任何一次
 *     狀態寫入而消失**——這是 fail-closed 的底線。解除只能靠明確動作：
 *     重新檢查該檔並確認乾淨（可歸檔時），或一次整工作階段的乾淨重掃
 *     （無法歸檔時）。
 *
 * 對外規則（不可破壞）：
 *   - 純函式：相同輸入必得相同輸出，不讀檔、不寫檔。
 *   - 形狀不合的 `stored` 一律視為沒有報告（`not-reported`），不 throw。
 *   - `blockingFiles` 依路徑排序，讓錯誤訊息與測試斷言穩定。
 */

import { isBlockingViolationCode } from "./policy.ts";
import type { FileReport, Violation } from "./types.ts";

/** gate 結論：`blocked` 阻斷；`passed` 有看過且乾淨；`not-reported` 沒看過。 */
export type CommentSignalGateStatus = "not-reported" | "passed" | "blocked";

export interface CommentSignalGateResult {
  status: CommentSignalGateStatus;
  /** 仍處於阻斷狀態的檔案（已排序；含無歸檔標記時為該標記）。 */
  blockingFiles: string[];
  /** 是否靠舊版 `lastReport` 遷移而來（升級相容路徑）。 */
  legacy: boolean;
  /** 該工作階段記錄的已修改檔數量（僅供診斷顯示）。 */
  modifiedFileCount: number;
  /**
   * 最近一次「工作階段重掃」實際掃到的檔案數；`null` 表示還沒掃過。
   *
   * 訊息分流靠這個而不是 `modifiedFileCount`：修改清單非空不代表有可掃描
   * 的檔案（可能全是 Markdown、隱藏檔或已刪除檔），那種重掃會掃到 0 個，
   * 照「重掃工作階段」的指示做仍然會被擋。
   */
  sessionSweepScannedFileCount: number | null;
}

/** 取出 storage 上形狀正確的 per-file 報告；`undefined` 代表該欄位不存在。 */
function readFileReportsField(stored: Record<string, unknown>): Record<string, FileReport> | undefined {
  const raw = stored.fileReports;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, FileReport> = {};
  for (const [filePath, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const candidate = value as Partial<FileReport>;
    // 形狀不合的 entry 略過：它無法證明任何阻斷，也不能反過來讓 gate 誤判。
    if (typeof candidate.shouldBlockCompletion !== "boolean") continue;
    out[filePath] = candidate as FileReport;
  }
  return out;
}

function countModifiedFiles(stored: Record<string, unknown>): number {
  return Array.isArray(stored.modifiedFiles) ? stored.modifiedFiles.length : 0;
}

/** 讀出最近一次工作階段重掃的實際掃描結果；形狀不合或沒掃過回 null。 */
function readSessionSweepCount(stored: Record<string, unknown>): number | null {
  const sweep = stored.sweep;
  if (!sweep || typeof sweep !== "object") return null;
  const count = (sweep as { scannedFileCount?: unknown }).scannedFileCount;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

/**
 * 舊版阻斷無法歸檔時使用的保留標記。
 *
 * 它不是一個真實檔案路徑（`touched_report` 不會列出它，因為該工具只走
 * `modifiedFiles`），只存在於 per-file 報告集合裡當阻斷記號。解除方式見
 * `dischargeUnattributedLegacyBlock`。
 */
export const UNATTRIBUTED_LEGACY_BLOCK_KEY = "<legacy-unattributed>";

/** 遷移出來的阻斷報告：帶著原始 violation，讓 gate 訊息與報告工具說得出原因。 */
function migratedBlockingReport(filePath: string, violations: Violation[]): FileReport {
  return {
    filePath,
    scanned: true,
    signals: [],
    violations,
    highRisk: [],
    shouldBlockCompletion: true,
    errorCount: violations.length,
    warningCount: 0,
    highRiskCount: 0,
  };
}

/**
 * 把舊版 `lastReport` 記錄的阻斷遷移成 per-file 阻斷記錄。
 *
 * 為什麼需要遷移：舊版狀態只有 `lastReport` 一個彙總值，沒有 per-file 欄位。
 * 若不遷移，狀態層任何一次寫入都會先由 `normalizeState` 補出空的
 * `fileReports`，從此 gate 以為「已經有 per-file 資料、而且都乾淨」，
 * 舊阻斷就這樣被靜默放行——升級 fail-closed 被自己的寫入路徑破掉。
 * 遷移把阻斷變成跟其他 per-file 阻斷同形的資料，「重新檢查該檔且乾淨」
 * 這個既有解除機制自然就對它生效，不需要另設特例。
 *
 * 解除條件：
 *   - 可歸檔（`lastReport.violations` 帶得出檔案）：該檔被重新檢查並寫入
 *     乾淨報告時覆蓋掉，阻斷解除。
 *   - 無法歸檔（彙總報告說有阻斷卻說不出是哪個檔）：寫入
 *     `UNATTRIBUTED_LEGACY_BLOCK_KEY` 標記，只能由
 *     `dischargeUnattributedLegacyBlock` 解除。
 *
 * @returns 遷移出的阻斷記錄；非舊版形狀、或舊版報告未阻斷時回空物件。
 */
export function migrateLegacyBlockingReports(stored: unknown): Record<string, FileReport> {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const record = stored as Record<string, unknown>;
  // 已經有 per-file 欄位 = 新版寫下的狀態，沒有東西要遷移。
  if (readFileReportsField(record) !== undefined) return {};
  const lastReport = record.lastReport;
  if (!lastReport || typeof lastReport !== "object") return {};
  if ((lastReport as { shouldBlockCompletion?: unknown }).shouldBlockCompletion !== true) return {};

  const rawViolations = Array.isArray((lastReport as { violations?: unknown }).violations)
    ? (lastReport as { violations: unknown[] }).violations
    : [];
  const byFile = new Map<string, Violation[]>();
  for (const item of rawViolations) {
    if (!item || typeof item !== "object") continue;
    const violation = item as Partial<Violation>;
    // 障礙的定義與 guard／validator 一致：policy 的 blocking violation code。
    if (typeof violation.code !== "string" || !isBlockingViolationCode(violation.code)) continue;
    if (typeof violation.filePath !== "string" || violation.filePath.length === 0) continue;
    const bucket = byFile.get(violation.filePath);
    if (bucket) bucket.push(violation as Violation);
    else byFile.set(violation.filePath, [violation as Violation]);
  }

  const out: Record<string, FileReport> = {};
  for (const [filePath, violations] of byFile) {
    out[filePath] = migratedBlockingReport(filePath, violations);
  }
  if (Object.keys(out).length > 0) return out;

  // 阻斷卻歸不出檔案：保留明確標記，讓 gate 繼續擋下來等一次完整重掃。
  out[UNATTRIBUTED_LEGACY_BLOCK_KEY] = migratedBlockingReport(UNATTRIBUTED_LEGACY_BLOCK_KEY, []);
  return out;
}

/**
 * 把工作階段狀態收斂成結案 gate 結論。
 * @param stored `session/<id>/comment-signal` 的原始值（可能不存在或形狀不合）。
 */
export function aggregateCommentSignalGate(stored: unknown): CommentSignalGateResult {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return {
      status: "not-reported",
      blockingFiles: [],
      legacy: false,
      modifiedFileCount: 0,
      sessionSweepScannedFileCount: null,
    };
  }
  const record = stored as Record<string, unknown>;
  // 舊版阻斷遷移成 per-file 記錄；真的 per-file 報告一律優先（那代表
  // 「這一檔最近一次被檢查成什麼樣」，自然包含解除的機會）。
  const migrated = migrateLegacyBlockingReports(record);
  const fileReports = { ...migrated, ...(readFileReportsField(record) ?? {}) };
  const modifiedFileCount = countModifiedFiles(record);
  const sessionSweepScannedFileCount = readSessionSweepCount(record);

  const blockingFiles = Object.entries(fileReports)
    .filter(([, report]) => report.shouldBlockCompletion === true)
    .map(([filePath]) => filePath)
    .sort();
  if (blockingFiles.length > 0) {
    // 只要有阻斷記錄來自舊版遷移，就維持 legacy 標記，訊息才會提示怎麼解除。
    const legacy = blockingFiles.some((filePath) => migrated[filePath] !== undefined);
    return {
      status: "blocked",
      blockingFiles,
      legacy,
      modifiedFileCount,
      sessionSweepScannedFileCount,
    };
  }
  const sawAnything = Object.keys(fileReports).length > 0 || modifiedFileCount > 0;
  return {
    status: sawAnything ? "passed" : "not-reported",
    blockingFiles: [],
    legacy: false,
    modifiedFileCount,
    sessionSweepScannedFileCount,
  };
}

/**
 * 阻斷時給使用者的訊息。必須說得出「為什麼被擋」與「怎麼解除」，
 * 否則升級遺留的阻斷會變成走不出來的死路。
 *
 * 無歸檔標記的解除指示依**實際重掃結果**分流，不看 `modifiedFiles` 數量：
 *   - 已經掃過、而且掃到 0 個檔：工作階段重掃確定沒用（清單裡全是
 *     Markdown／隱藏檔／已刪除檔之類），直接指向整專案重掃並說明原因。
 *   - 還沒掃過：先建議便宜的工作階段重掃，並附上整專案重掃的後路，
 *     兩種指示都做得到。
 */
export function describeGateBlock(result: CommentSignalGateResult): string {
  const hasUnattributed = result.blockingFiles.includes(UNATTRIBUTED_LEGACY_BLOCK_KEY);
  const files = result.blockingFiles.filter((filePath) => filePath !== UNATTRIBUTED_LEGACY_BLOCK_KEY);
  const parts: string[] = [];
  if (files.length > 0) {
    parts.push(`阻斷檔案：${files.join("、")}（修正後重新檢查該檔即可解除）`);
  }
  if (hasUnattributed) {
    const WORKTREE_STEP = 'comment_signal_check 指定 path: "."、changedOnly: false 重掃整個專案';
    const nextStep =
      result.sessionSweepScannedFileCount === 0
        ? `本工作階段最近一次重掃實際掃到 0 個檔案（修改清單裡沒有可掃描的檔案），請改以 ${WORKTREE_STEP}`
        : result.sessionSweepScannedFileCount !== null
          ? `本工作階段最近一次重掃掃到 ${result.sessionSweepScannedFileCount} 個檔案且未解除，請確認那些檔案的問題已修正後再重掃一次；若重掃仍無法解除，改以 ${WORKTREE_STEP}`
          : `請先呼叫 comment_signal_check（不帶 path）重掃本工作階段；若仍被擋，改以 ${WORKTREE_STEP}`;
    parts.push(
      `另有升級前的阻斷記錄無法歸檔（舊版報告未標明是哪個檔案，標記 ${UNATTRIBUTED_LEGACY_BLOCK_KEY}）：${nextStep}，確認乾淨後即解除`,
    );
  }
  return `Comment Signal 發現尚未排除的註解必要檢查問題，不能完成任務（${parts.join("；")}）。`;
}
