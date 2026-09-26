/**
 * opencode-ultrawork — Comment Signal Module：比較起點 / suppress 持久化
 *
 * 角色：
 *   - 提供 `comment_signal_baseline` 與 `comment_signal_suppress` / `_only_new`
 *     三個 tool 所需的純資料型別 + project-local 安全持久化 helper。
 *   - 檔案位置固定於 `.opencode/memory/comment-signal-baseline.json` 與
 *     `comment-signal-suppressions.json`，不掃 worktree、不寫出 worktree。
 *   - 所有 IO 透過注入的 path（含 MEMORY_DIR）避免硬編路徑；測試可直接傳入 tmp 目錄。
 *   - 設計重點：
 *       · 純資料：比較起點 / SuppressionEntry 為 plain object，可 JSON roundtrip。
 *       · 精準且可追蹤：suppression 必須含 (filePath, line, code) 三元組 +
 *         唯一 id（SHA-256 hash）+ reason + createdAt，便於 audit。
 *       · suppress 不得隱性刪除 highRisk violation；只標記 suppression 狀態，
 *         仍由 reporter 暴露於 report.violations（保留 audit trail）。
 *       · 比較起點 為 comment_signal_check 結果的 fingerprint 快照：
 *         (scannedFileCount, checkedCommentCount, violationCount, errorCount,
 *          warningCount, highRiskCount, violationsSignature)，不含 raw source。
 *
 * 對外規則（不可破壞）：
 *   - 結構穩定：新增欄位時向後相容；移除 / 改名欄位需 migration。
 *   - 路徑策略：呼叫端須提供完整路徑（已是 memoryDir/比較起點.json 形式）；
 *     本模組不假設 MEMORY_DIR 結構，便於測試隔離。
 *
 * 限制：
 *   - 純 IO + 純函式；不引入 plugin hooks、不引入 registry runtime。
 *   - 不寫出 caller 提供的根目錄；只寫到 caller 指定的路徑。
 *
 * @see ./tools.ts                                              — Comment Signal tools
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { atomicWriteFile } from "../../kit/atomic-write.ts";
import { assertSafeCommentSignalPath } from "./containment.ts";

// ─── Types ────────────────────────────────────────────────────

/**
 * 比較起點 fingerprint 摘要。
 *
 * 設計考量：
 *   - 為避免 比較起點 與當前 report 比較時讀完整 violation 列表（O(N)），
 *     採「數量 + 簽章」結構：violationsSignature 為 violations 序列化後的
 *     SHA-256（截前 32 hex）。若數量變動或任一欄位變動即視為差異。
 *   - 不存 raw source（避免敏感資訊外洩）；存 violations 清單的最小 fingerprint
 *     （filePath + line + code + severity）。
 */
export interface CommentSignalBaseline {
  /** schema version。便於未來遷移。 */
  version: "1.0";
  /** 當前 projectId。 */
  projectId: string;
  /** 寫入時間（ISO-8601）。 */
  createdAt: string;
  /** 觸發 比較起點 的 sessionID（可選；給 audit 用）。 */
  sessionID?: string;
  /** 觸發者（tool caller）。預設 "comment_signal_baseline"。 */
  source: "comment_signal_baseline" | "ultrawork_selftest" | string;
  /** 比較起點 來源路徑（可選；便於追溯）。 */
  path?: string;
  /** 是否來自 changedOnly scan（true = session.modifiedFiles）。 */
  changedOnly: boolean;
  /** 比較起點 摘要 metrics。 */
  scannedFileCount: number;
  checkedCommentCount: number;
  violationCount: number;
  errorCount: number;
  warningCount: number;
  highRiskCount: number;
  shouldBlockCompletion: boolean;
  /** violations 排序後序列化的 SHA-256（前 32 hex）。 */
  violationsSignature: string;
  /**
   * 最小 fingerprint 清單（每筆：filePath + line + code + severity），
   * 給 only_new 比對使用。不存 raw message / suggestion 以減少 footprint。
   */
  fingerprints: BaselineFingerprint[];
}

/**
 * 比較起點 用的最小 fingerprint（不存 message / suggestion，避免膨脹）。
 */
export interface BaselineFingerprint {
  filePath: string;
  line: number;
  code: string;
  severity: "blocking" | "warning";
}

/**
 * 抑制項目：精準記錄 (filePath, line, code) + audit metadata。
 *
 * 設計重點：
 *   - `id`：SHA-256(filePath + "|" + line + "|" + code) 截前 16 hex；
 *     用於 list / delete 時的 stable key。
 *   - `severity`：記錄被 suppress 的原始 severity，方便 audit；
 *     不影響 violation 是否進 report（永遠進 report，但加 suppressed 標記）。
 *   - `createdBy`：記錄觸發者（user / selftest / 比較起點 diff）。
 */
export interface CommentSignalSuppression {
  id: string;
  filePath: string;
  line: number;
  code: string;
  /** 對應原 violation 的 severity。 */
  severity: "blocking" | "warning";
  /** 抑制原因（必填；給 audit 用）。 */
  reason: string;
  /** 觸發者。 */
  createdBy: string;
  /** 建立時間（ISO-8601）。 */
  createdAt: string;
}

export interface CommentSignalSuppressionStore {
  version: "1.0";
  projectId: string;
  /** 寫入時間（ISO-8601）；最後一次 mutate 時間。 */
  updatedAt: string;
  suppressions: CommentSignalSuppression[];
}

// ─── Pure helpers ─────────────────────────────────────────────

/**
 * 由 violation 陣列衍生穩定排序的 fingerprint 清單。
 * 排序規則：先 severity（障礙在前），再 filePath，再 line，再 code。
 */
export function deriveFingerprints(violations: ReadonlyArray<{
  filePath: string;
  line: number;
  code: string;
  severity: "blocking" | "warning";
}>): BaselineFingerprint[] {
  return [...violations]
    .sort((a, b) => {
      if (a.severity !== b.severity) {
        return a.severity === "blocking" ? -1 : 1;
      }
      if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
      if (a.line !== b.line) return a.line - b.line;
      return a.code.localeCompare(b.code);
    })
    .map((v) => ({
      filePath: v.filePath,
      line: v.line,
      code: v.code,
      severity: v.severity,
    }));
}

/**
 * 計算 violationsSignature（fingerprint 清單序列化後 SHA-256，截前 32 hex）。
 * 空清單 → 固定簽章 "empty"，方便測試與 null 判斷。
 */
export function computeViolationsSignature(fingerprints: ReadonlyArray<BaselineFingerprint>): string {
  if (fingerprints.length === 0) return "empty";
  const canonical = JSON.stringify(fingerprints);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * 由 (filePath, line, code) 衍生穩定的 suppression id。
 */
export function suppressionKey(filePath: string, line: number, code: string): string {
  const raw = `${filePath}|${line}|${code}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ─── 比較起點 IO ──────────────────────────────────────────────

/**
 * 讀取 比較起點 檔案。檔案不存在或損壞時回 null（fail-soft，便於 first run）。
 */
export function readBaseline(absolutePath: string): CommentSignalBaseline | null {
  assertSafeCommentSignalPath(absolutePath);
  if (!existsSync(absolutePath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absolutePath, "utf-8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const b = raw as CommentSignalBaseline;
  // 基本 schema validation；缺關鍵欄位視為無效
  if (b.version !== "1.0") return null;
  if (typeof b.projectId !== "string") return null;
  if (!Array.isArray(b.fingerprints)) return null;
  return b;
}

/**
 * 寫入 比較起點 檔案（atomic write）。
 */
export function writeBaseline(absolutePath: string, baseline: CommentSignalBaseline): void {
  assertSafeCommentSignalPath(absolutePath);
  atomicWriteFile(absolutePath, JSON.stringify(baseline, null, 2));
}

// ─── Suppression IO ───────────────────────────────────────────

/**
 * 讀取 suppression store。檔案不存在時回空 store；損壞時回 null。
 */
export function readSuppressionStore(absolutePath: string): CommentSignalSuppressionStore | null {
  if (!existsSync(absolutePath)) {
    return { version: "1.0", projectId: "", updatedAt: new Date().toISOString(), suppressions: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absolutePath, "utf-8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const s = raw as CommentSignalSuppressionStore;
  if (s.version !== "1.0") return null;
  if (!Array.isArray(s.suppressions)) return null;
  return s;
}

/**
 * 寫入 suppression store（atomic write）。
 */
export function writeSuppressionStore(absolutePath: string, store: CommentSignalSuppressionStore): void {
  atomicWriteFile(absolutePath, JSON.stringify(store, null, 2));
}

/**
 * 對一組 violations 套用 suppression 標記，回傳新陣列（不修改原陣列）。
 * - suppression 命中條件：(filePath, line, code) 三元組完全一致。
 * - 命中後新增 `suppressed: true` 與 `suppressionId` 欄位；不從陣列移除。
 * - 這保證 reporter 永遠暴露原 violation（含 highRisk），audit trail 完整。
 */
export function applySuppressions<T extends { filePath: string; line: number; code: string }>(
  violations: ReadonlyArray<T>,
  store: CommentSignalSuppressionStore,
): Array<T & { suppressed?: boolean; suppressionId?: string }> {
  const map = new Map<string, CommentSignalSuppression>();
  for (const s of store.suppressions) {
    map.set(suppressionKey(s.filePath, s.line, s.code), s);
  }
  return violations.map((v) => {
    const key = suppressionKey(v.filePath, v.line, v.code);
    const s = map.get(key);
    if (!s) return { ...v };
    return { ...v, suppressed: true, suppressionId: s.id };
  });
}
