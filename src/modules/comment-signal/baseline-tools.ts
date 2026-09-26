/**
 * commentSignal 工具：comment_signal_baseline／comment_signal_suppress／
 * comment_signal_only_new。
 *
 * 行為、args schema、回傳欄位跟舊版一致：
 * - baseline：把目前 session 的 report（或指定 path 掃描結果）寫成
 *   `comment-signal-baseline.json`；已存在且 force=false 時拒絕覆寫。
 * - suppress：精準抑制 (filePath, line, code) 三元組；只加 suppressed 標記，
 *   不得隱性刪除 highRisk violation。
 * - only_new：相對於 baseline 比對，回報新增的 violations。
 *
 * 差別只有外殼與路徑：defineTool＋zod、狀態走 storage、
 * 快照檔固定在 `<專案>/.ultrawork/`（企劃書第 4.3 節），不再走
 * 舊版 `.opencode/memory/`。
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineTool } from "../../kit/define-tool.ts";
import { jsonResult } from "../../kit/json.ts";
import { defaultCommentSignalPolicy } from "./policy.ts";
import type { CommentSignalReport, CommentSignalPolicy, Violation } from "./types.ts";
import { checkFile, checkFiles, checkChangedFiles, isMarkdownPath, type CheckFileEntry } from "./guard.ts";
import { isScannableExplicitPath, toPolicyRelativePath } from "./file-scan.ts";
import type { CommentSignalToolDeps } from "./tool-deps.ts";
import {
  applySuppressions,
  computeViolationsSignature,
  deriveFingerprints,
  readBaseline,
  readSuppressionStore,
  suppressionKey,
  writeBaseline,
  writeSuppressionStore,
  type BaselineFingerprint,
  type CommentSignalBaseline,
  type CommentSignalSuppression,
  type CommentSignalSuppressionStore,
} from "./baseline.ts";

// ─── 路徑 helper ───────────────────────────────────────────────

/** 快照 JSON 檔名（固定於專案 `.ultrawork/`）。 */
export const BASELINE_FILENAME = "comment-signal-baseline.json";
/** suppression JSON 檔名（固定於專案 `.ultrawork/`）。 */
export const SUPPRESSIONS_FILENAME = "comment-signal-suppressions.json";

/** 專案的 `.ultrawork/` 目錄；不存在時呼叫端負責建立。 */
export function resolveMemoryDir(worktree: string): string {
  return join(worktree, ".ultrawork");
}

/** 由 worktree 路徑衍生 projectId（跟舊版同規則：最後一段小寫）。 */
export function deriveProjectId(worktree: string): string {
  return worktree.split("/").pop()?.toLowerCase() || "project";
}

function ensureMemoryDir(memoryDir: string): void {
  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
}

// ─── comment_signal_baseline ─────────────────────────────────

const baselineInputSchema = z.object({
  sessionID: z.string().optional(),
  path: z.string().optional(),
  changedOnly: z.boolean().optional(),
  force: z.boolean().optional(),
});

type BaselineArgs = z.infer<typeof baselineInputSchema>;

export interface BaselineOkResult {
  ok: true;
  baselinePath: string;
  createdAt: string;
  scannedFileCount: number;
  violationCount: number;
  errorCount: number;
  warningCount: number;
  highRiskCount: number;
  shouldBlockCompletion: boolean;
  violationsSignature: string;
  fingerprintCount: number;
  humanSummary: string;
}

export interface BaselineErrorResult {
  ok: false;
  code: "BASELINE_EXISTS" | "NO_VIOLATIONS_SNAPSHOT" | "INVALID_PATH" | "MARKDOWN_PATH";
  error: string;
  hint: string;
  /** BASELINE_EXISTS 時附帶：既有快照的建立時間。 */
  existingCreatedAt?: string;
  /** BASELINE_EXISTS 時附帶：既有快照的 violations signature。 */
  existingViolationsSignature?: string;
}

export type BaselineResult = BaselineOkResult | BaselineErrorResult;

/**
 * 將 report 轉換為快照物件。
 * 純函式：無 IO，便於測試。
 */
export function buildBaselineFromReport(
  report: CommentSignalReport,
  options: {
    projectId: string;
    sessionID?: string;
    path?: string;
    changedOnly: boolean;
    source?: string;
    createdAt?: string;
  },
): CommentSignalBaseline {
  const fingerprints = deriveFingerprints(
    report.violations.map((v: Violation) => ({
      filePath: v.filePath,
      line: v.line,
      code: v.code,
      severity: v.severity,
    })),
  );
  const violationsSignature = computeViolationsSignature(fingerprints);
  return {
    version: "1.0",
    projectId: options.projectId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    sessionID: options.sessionID,
    source: options.source ?? "comment_signal_baseline",
    path: options.path,
    changedOnly: options.changedOnly,
    scannedFileCount: report.scannedFileCount,
    checkedCommentCount: report.checkedCommentCount,
    violationCount: report.violationCount,
    errorCount: report.errorCount,
    warningCount: report.warningCount,
    highRiskCount: report.highRiskCount,
    shouldBlockCompletion: report.shouldBlockCompletion,
    violationsSignature,
    fingerprints,
  };
}

/**
 * 建立 `comment_signal_baseline` 工具定義（transform 外先建好，無副作用）。
 *
 * 行為：
 *   - 預設走工作階段 modifiedFiles（changedOnly=true）；指定 path 時可走
 *     指定檔案／資料夾掃描（不依賴 session state）。
 *   - 將當次 report 的 metrics＋fingerprint 清單原子寫入
 *     `<專案>/.ultrawork/comment-signal-baseline.json`。
 *   - 既有快照存在且 `force=false` 時拒絕覆寫（回 BASELINE_EXISTS）。
 *   - 不修改任何 session state。
 */
export function createCommentSignalBaselineTool(deps: CommentSignalToolDeps) {
  return defineTool({
    name: "comment_signal_baseline",
    description:
      "建立 Comment Signal 的目前問題快照，供後續比較新增問題。檔案已存在且未指定 force 時不會覆寫。",
    inputSchema: baselineInputSchema,
    execute: async (args: BaselineArgs, toolCtx) => {
      const sessionID = args.sessionID ?? toolCtx.sessionID;
      const worktree = await deps.resolveRoot(toolCtx);
      const memoryDir = resolveMemoryDir(worktree);
      const baselinePath = join(memoryDir, BASELINE_FILENAME);
      const changedOnly = args.changedOnly !== false; // 預設 true
      const force = args.force === true;

      // path 為 Markdown 時直接拒絕（與 check 一致）
      if (args.path && isMarkdownPath(args.path)) {
        const err: BaselineErrorResult = {
          ok: false,
          code: "MARKDOWN_PATH",
          error: `comment_signal_baseline 不接受 Markdown 路徑: ${args.path}`,
          hint: "Comment Signal 系統完全跳過 .md/.markdown 檔案。",
        };
        return jsonResult(err);
      }

      // 既有快照檢查
      const existing = readBaseline(baselinePath);
      if (existing && !force) {
        const err: BaselineErrorResult = {
          ok: false,
          code: "BASELINE_EXISTS",
          error: `目前問題快照已存在於 ${baselinePath}`,
          hint: "重複呼叫時請傳 force=true 以覆寫；或使用 comment_signal_only_new 進行增量比對。",
          existingCreatedAt: existing.createdAt,
          existingViolationsSignature: existing.violationsSignature,
        };
        return jsonResult(err);
      }

      // 產生 report
      const today = deps.today ?? "1970-01-01";
      const policy: CommentSignalPolicy = defaultCommentSignalPolicy;
      let report: CommentSignalReport;
      if (args.path && args.changedOnly === false) {
        const path = args.path;
        if (path.endsWith("/") || !/\.[a-zA-Z0-9]+$/.test(path)) {
          const entries: CheckFileEntry[] = [];
          const filePaths = (deps.directoryResolver ? deps.directoryResolver(worktree, path) : null) ?? [];
          for (const fp of filePaths) {
            const source = deps.sourceResolver(worktree, fp);
            if (source === null) continue;
            entries.push({ filePath: fp, source });
          }
          report = checkFiles(entries, { today, policy });
        } else if (!isScannableExplicitPath(toPolicyRelativePath(worktree, path))) {
          // 跟 check 工具一致：dotfile／不支援副檔名／敏感路徑的顯式單檔不讀不掃。
          // 路徑先 canonical 化再判定（symlink 別名現形）。
          report = checkFiles([], { today, policy });
        } else {
          const source = deps.sourceResolver(worktree, path);
          if (source === null) {
            report = checkFile(path, "", { today, policy });
          } else {
            report = checkFile(path, source, { today, policy });
          }
        }
      } else {
        // 預設：工作階段 modifiedFiles
        const modifiedFiles = await deps.store.getModifiedFiles(sessionID);
        const resolver = (filePath: string): string | null =>
          deps.sourceResolver(worktree, filePath);
        const opts: Parameters<typeof checkChangedFiles>[2] = { today, policy };
        if (args.path) opts.path = args.path;
        // changed-only 政策判定 canonical 化（symlink 別名現形）。
        opts.worktree = worktree;
        report = checkChangedFiles({ sessionID, modifiedFiles, lastReport: null, warnings: [] }, resolver, opts);
      }

      // 構造快照
      const projectId = deriveProjectId(worktree);
      const baseline = buildBaselineFromReport(report, {
        projectId,
        sessionID,
        path: args.path,
        changedOnly,
        source: "comment_signal_baseline",
      });

      ensureMemoryDir(memoryDir);
      writeBaseline(baselinePath, baseline);

      const ok: BaselineOkResult = {
        ok: true,
        baselinePath,
        createdAt: baseline.createdAt,
        scannedFileCount: baseline.scannedFileCount,
        violationCount: baseline.violationCount,
        errorCount: baseline.errorCount,
        warningCount: baseline.warningCount,
        highRiskCount: baseline.highRiskCount,
        shouldBlockCompletion: baseline.shouldBlockCompletion,
        violationsSignature: baseline.violationsSignature,
        fingerprintCount: baseline.fingerprints.length,
        humanSummary: `Comment Signal 目前問題快照已建立（${baseline.fingerprints.length} 筆指紋，特徵碼 ${baseline.violationsSignature.slice(0, 8)}…）`,
      };
      return jsonResult(ok, null, 2);
    },
  });
}

// ─── comment_signal_suppress ──────────────────────────────────

const suppressInputSchema = z.object({
  filePath: z.string(),
  line: z.number().int(),
  code: z.string(),
  reason: z.string().optional(),
  severity: z.enum(["blocking", "warning"]).optional(),
  sessionID: z.string().optional(),
});

type SuppressArgs = z.infer<typeof suppressInputSchema>;

export interface SuppressOkResult {
  ok: true;
  action: "added" | "updated" | "removed" | "already-exists";
  id: string;
  storePath: string;
  totalSuppressions: number;
  affected: { filePath: string; line: number; code: string };
  suppression: CommentSignalSuppression;
  humanSummary: string;
  /** 標示該 suppression 的 reason 是否為空（audit 提醒；不影響成功與否）。 */
  reasonMissing?: boolean;
}

export interface SuppressErrorResult {
  ok: false;
  /** 錯誤代碼：`INVALID_ARGS`（基本引數檢查）／`STORE_CORRUPTED`（store 損壞）。 */
  code: "INVALID_ARGS" | "STORE_CORRUPTED";
  error: string;
  hint: string;
}

export type SuppressResult = SuppressOkResult | SuppressErrorResult;

/**
 * 建立 `comment_signal_suppress` 工具定義（transform 外先建好，無副作用）。
 *
 * 行為：
 *   - 必填 filePath／line／code。reason 為 optional（缺漏不 throw，由 audit
 *     端／`reasonMissing` 旗標提醒補強；強制必填會讓 idempotent suppression
 *     補登流程誤判失敗）。
 *   - 同 (filePath, line, code) 重複呼叫視為更新 reason＋severity＋createdBy。
 *   - suppression 永遠寫入 store；reporter／only_new 透過 applySuppressions
 *     標記 suppressed: true，但**不會**從 violations 移除（保留 audit trail）。
 *   - 不得隱性刪除 highRisk violation（即使 severity=blocking 仍寫入）；
 *     audit 端可由 suppressions.json 反查所有被 suppress 的 highRisk。
 *   - 若 reason 前綴為 "remove:"（大小寫不敏感）→ 視為刪除既有 suppression。
 */
export function createCommentSignalSuppressTool(deps: CommentSignalToolDeps) {
  return defineTool({
    name: "comment_signal_suppress",
    description:
      "精準抑制 Comment Signal violation。必填 (filePath, line, code)；reason 為 optional（缺漏以 reasonMissing audit 提醒、不 throw）。同三元組重複呼叫更新 reason/severity/createdBy；reason 以 'remove:' 開頭時刪除既有 suppression。suppression 不會從 report 移除 highRisk violation，僅加 suppressed 標記保留 audit trail。",
    inputSchema: suppressInputSchema,
    execute: async (args: SuppressArgs, toolCtx) => {
      const worktree = await deps.resolveRoot(toolCtx);
      const memoryDir = resolveMemoryDir(worktree);
      const storePath = join(memoryDir, SUPPRESSIONS_FILENAME);
      const projectId = deriveProjectId(worktree);

      // 基本引數檢查
      const filePath = (args.filePath ?? "").trim();
      const code = (args.code ?? "").trim();
      // reason 為 optional（audit metadata）；空字串時仍允許寫入並以空 reason 標記，
      // 由 audit 另行提醒補強。
      const reason = (args.reason ?? "").trim();
      const lineNum = Number(args.line);
      if (!filePath || !code || !Number.isInteger(lineNum) || lineNum < 1) {
        const err: SuppressErrorResult = {
          ok: false,
          code: "INVALID_ARGS",
          error: "filePath / line (>=1) / code 皆為必填且不可為空",
          hint: "範例：{ filePath: 'src/auth/login.ts', line: 12, code: 'UNKNOWN_TAG', reason: '已轉換至 token-vault 模組，duplicate tag 為歷史文件' }",
        };
        return jsonResult(err);
      }
      const reasonMissing = !reason;

      const isRemove = /^remove\s*:/i.test(reason);
      const cleanedReason = isRemove ? reason.replace(/^remove\s*:\s*/i, "") : reason;

      // 讀取既有 store；損壞時拒絕寫入避免覆蓋
      const store = readSuppressionStore(storePath);
      if (store === null) {
        const err: SuppressErrorResult = {
          ok: false,
          code: "STORE_CORRUPTED",
          error: `suppression store 損壞，拒絕寫入以避免覆蓋：${storePath}`,
          hint: "請手動檢查 comment-signal-suppressions.json 內容；若需重建請先刪除檔案。",
        };
        return jsonResult(err);
      }
      // 第一次寫入時補上 projectId
      if (!store.projectId) store.projectId = projectId;

      const id = suppressionKey(filePath, lineNum, code);
      const existingIdx = store.suppressions.findIndex((s) => s.id === id);
      let action: "added" | "updated" | "removed" | "already-exists" = "added";
      let entry: CommentSignalSuppression;
      let storeDirty = false;

      if (isRemove) {
        if (existingIdx < 0) {
          // 無既有 suppression：仍記錄一個 audit entry 表示「嘗試刪除不存在的」
          // 採取 fail-soft：回 ok 但 action=removed 且 totalSuppressions 不變
          const result: SuppressOkResult = {
            ok: true,
            action: "removed",
            id,
            storePath,
            totalSuppressions: store.suppressions.length,
            affected: { filePath, line: lineNum, code },
            suppression: {
              id,
              filePath,
              line: lineNum,
              code,
              severity: args.severity ?? "warning",
              reason: cleanedReason,
              createdBy: `session=${args.sessionID ?? toolCtx.sessionID}`,
              createdAt: new Date().toISOString(),
            },
            humanSummary: `這筆屏蔽不存在，沒有變動（id=${id}）`,
            reasonMissing: reasonMissing || undefined,
          };
          return jsonResult(result, null, 2);
        }
        store.suppressions.splice(existingIdx, 1);
        action = "removed";
        entry = {
          id,
          filePath,
          line: lineNum,
          code,
          severity: args.severity ?? "warning",
          reason: cleanedReason,
          createdBy: `session=${args.sessionID ?? toolCtx.sessionID}`,
          createdAt: new Date().toISOString(),
        };
        storeDirty = true;
      } else {
        entry = {
          id,
          filePath,
          line: lineNum,
          code,
          severity: args.severity ?? "warning",
          reason: cleanedReason,
          createdBy: `session=${args.sessionID ?? toolCtx.sessionID}`,
          createdAt: new Date().toISOString(),
        };
        if (existingIdx >= 0) {
          const existing = store.suppressions[existingIdx];
          // idempotent：reason／severity／createdBy 完全一致時不寫入 store，
          // 回 action="already-exists"；有任一欄位變動才 "updated"。
          // 注意：createdBy 未納入比對（舊版行為逐字保留）。
          if (
            existing.reason === entry.reason &&
            existing.severity === entry.severity
          ) {
            action = "already-exists";
            // 回傳既有 entry（保留原始 createdAt），避免覆蓋 audit 時間軸
            entry = { ...existing };
          } else {
            store.suppressions[existingIdx] = entry;
            action = "updated";
            storeDirty = true;
          }
        } else {
          store.suppressions.push(entry);
          action = "added";
          storeDirty = true;
        }
      }

      if (storeDirty) {
        store.updatedAt = new Date().toISOString();
        ensureMemoryDir(memoryDir);
        writeSuppressionStore(storePath, store);
      }

      const result: SuppressOkResult = {
        ok: true,
        action,
        id,
        storePath,
        totalSuppressions: store.suppressions.length,
        affected: { filePath, line: lineNum, code },
        suppression: entry,
        humanSummary: `屏蔽已${({ added: "新增", updated: "更新", removed: "移除", "already-exists": "存在（本來就有）" } as const)[action]}（id=${id}，目前共 ${store.suppressions.length} 筆${reasonMissing ? "，這筆缺 reason，之後要補上供稽核" : ""}）`,
        reasonMissing: reasonMissing || undefined,
      };
      return jsonResult(result, null, 2);
    },
  });
}

// ─── comment_signal_only_new ─────────────────────────────────

const onlyNewInputSchema = z.object({
  sessionID: z.string().optional(),
  path: z.string().optional(),
  changedOnly: z.boolean().optional(),
});

type OnlyNewArgs = z.infer<typeof onlyNewInputSchema>;

export interface OnlyNewOkResult {
  ok: true;
  hasBaseline: boolean;
  baselinePath?: string;
  baselineCreatedAt?: string;
  baselineViolationsSignature?: string;
  scannedFileCount: number;
  /** 相對於快照新增的 violations（含 severity 與 filePath:line）。 */
  newViolations: Array<{
    filePath: string;
    line: number;
    code: string;
    severity: "blocking" | "warning";
    message: string;
  }>;
  /** 已 suppress 的新增 violation（仍會列示，不刪除）。 */
  suppressedNewCount: number;
  /** shouldBlockCompletion：依新增 violations 中是否有 blocking。 */
  shouldBlockCompletion: boolean;
  /** 給主要 agent 的修正指引。 */
  agentFeedback: string;
  humanSummary: string;
}

export interface OnlyNewErrorResult {
  ok: false;
  code: "MARKDOWN_PATH" | "NO_BASELINE";
  error: string;
  hint: string;
  baselinePath?: string;
}

export type OnlyNewResult = OnlyNewOkResult | OnlyNewErrorResult;

/**
 * 將快照 fingerprint 集合轉為 set，便於 O(1) 查詢。
 */
export function fingerprintSet(fingerprints: ReadonlyArray<BaselineFingerprint>): Set<string> {
  return new Set(fingerprints.map((f) => `${f.filePath}|${f.line}|${f.code}|${f.severity}`));
}

/**
 * 建立 `comment_signal_only_new` 工具定義（transform 外先建好，無副作用）。
 *
 * 行為：
 *   - 讀取快照檔（不存在回 NO_BASELINE）。
 *   - 對目前工作階段／指定 path 執行 check，產生 report。
 *   - 比對「現有 violations 集合 − 快照 fingerprint 集合」即為新增。
 *   - 套用 suppression：命中者仍列示但標記 suppressed（不刪除）。
 *   - 不會自動寫入快照（避免覆蓋，需用 comment_signal_baseline 顯式）。
 */
export function createCommentSignalOnlyNewTool(deps: CommentSignalToolDeps) {
  return defineTool({
    name: "comment_signal_only_new",
    description:
      "報告相較於目前問題快照新增的 Comment Signal violations。不會自動覆寫快照；被抑制的新增問題仍會列出，以保留追蹤紀錄。",
    inputSchema: onlyNewInputSchema,
    execute: async (args: OnlyNewArgs, toolCtx) => {
      const sessionID = args.sessionID ?? toolCtx.sessionID;
      const worktree = await deps.resolveRoot(toolCtx);
      const memoryDir = resolveMemoryDir(worktree);
      const baselinePath = join(memoryDir, BASELINE_FILENAME);
      const suppressionsPath = join(memoryDir, SUPPRESSIONS_FILENAME);

      // Markdown 路徑拒絕
      if (args.path && isMarkdownPath(args.path)) {
        const err: OnlyNewErrorResult = {
          ok: false,
          code: "MARKDOWN_PATH",
          error: `comment_signal_only_new 不接受 Markdown 路徑: ${args.path}`,
          hint: "Comment Signal 系統完全跳過 .md/.markdown 檔案。",
        };
        return jsonResult(err);
      }

      const baseline = readBaseline(baselinePath);
      if (baseline === null) {
        const err: OnlyNewErrorResult = {
          ok: false,
          code: "NO_BASELINE",
          error: `找不到目前問題快照：${baselinePath}`,
          hint: "請先呼叫 comment_signal_baseline 建立目前問題快照。",
          baselinePath,
        };
        return jsonResult(err);
      }

      // 產生當前 report（同 comment_signal_baseline）
      const today = deps.today ?? "1970-01-01";
      const policy: CommentSignalPolicy = defaultCommentSignalPolicy;
      let report: CommentSignalReport;
      if (args.path && args.changedOnly === false) {
        const path = args.path;
        if (path.endsWith("/") || !/\.[a-zA-Z0-9]+$/.test(path)) {
          const entries: CheckFileEntry[] = [];
          const filePaths = (deps.directoryResolver ? deps.directoryResolver(worktree, path) : null) ?? [];
          for (const fp of filePaths) {
            const source = deps.sourceResolver(worktree, fp);
            if (source === null) continue;
            entries.push({ filePath: fp, source });
          }
          report = checkFiles(entries, { today, policy });
        } else if (!isScannableExplicitPath(toPolicyRelativePath(worktree, path))) {
          // 跟 check 工具一致：dotfile／不支援副檔名／敏感路徑的顯式單檔不讀不掃。
          // 路徑先 canonical 化再判定（symlink 別名現形）。
          report = checkFiles([], { today, policy });
        } else {
          const source = deps.sourceResolver(worktree, path);
          if (source === null) {
            report = checkFile(path, "", { today, policy });
          } else {
            report = checkFile(path, source, { today, policy });
          }
        }
      } else {
        const modifiedFiles = await deps.store.getModifiedFiles(sessionID);
        const resolver = (filePath: string): string | null =>
          deps.sourceResolver(worktree, filePath);
        const opts: Parameters<typeof checkChangedFiles>[2] = { today, policy };
        if (args.path) opts.path = args.path;
        // changed-only 政策判定 canonical 化（symlink 別名現形）。
        opts.worktree = worktree;
        report = checkChangedFiles({ sessionID, modifiedFiles, lastReport: null, warnings: [] }, resolver, opts);
      }

      // 套用 suppression（不刪除；只標記）
      const supStore = readSuppressionStore(suppressionsPath) ?? {
        version: "1.0" as const,
        projectId: baseline.projectId,
        updatedAt: new Date().toISOString(),
        suppressions: [],
      };
      const annotated = applySuppressions(report.violations, supStore);

      // 計算新增
      const baselineSet = fingerprintSet(baseline.fingerprints);
      const newViolations: OnlyNewOkResult["newViolations"] = [];
      let suppressedNewCount = 0;
      for (const v of annotated) {
        const key = `${v.filePath}|${v.line}|${v.code}|${v.severity}`;
        if (baselineSet.has(key)) continue;
        newViolations.push({
          filePath: v.filePath,
          line: v.line,
          code: v.code,
          severity: v.severity,
          message: v.message,
        });
        if ((v as { suppressed?: boolean }).suppressed) {
          suppressedNewCount += 1;
        }
      }

      // shouldBlockCompletion：依「新增 violations」中是否有 blocking
      const shouldBlockCompletion = newViolations.some((v) => v.severity === "blocking");

      const ok: OnlyNewOkResult = {
        ok: true,
        hasBaseline: true,
        baselinePath,
        baselineCreatedAt: baseline.createdAt,
        baselineViolationsSignature: baseline.violationsSignature,
        scannedFileCount: report.scannedFileCount,
        newViolations,
        suppressedNewCount,
        shouldBlockCompletion,
        agentFeedback: renderOnlyNewFeedback(newViolations, shouldBlockCompletion),
        humanSummary: renderOnlyNewHumanSummary(newViolations, suppressedNewCount, baseline.createdAt),
      };
      return jsonResult(ok, null, 2);
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────

function renderOnlyNewFeedback(
  newViolations: OnlyNewOkResult["newViolations"],
  shouldBlockCompletion: boolean,
): string {
  if (newViolations.length === 0) {
    return [
      "Comment Signal 比較完成：相較於目前問題快照沒有新增問題。",
      "若後續修改檔案，請於 final 前再次呼叫 comment_signal_only_new。",
    ].join("\n");
  }
  const lines: string[] = [];
  if (shouldBlockCompletion) {
    lines.push(`Comment Signal 增量比對發現 ${newViolations.length} 個新增障礙，必須先修正才能回報任務完成。`);
  } else {
    lines.push(`Comment Signal 增量比對發現 ${newViolations.length} 個新增警告，本次沒有障礙但建議修正。`);
  }
  lines.push("");
  lines.push("修正限制：");
  lines.push("1. 只修正註解。");
  lines.push("2. 不要修改程式邏輯。");
  lines.push("3. 不要刪除高風險註解來規避檢查。");
  lines.push("4. 修正後再次呼叫 comment_signal_only_new 驗證。");
  lines.push("");
  lines.push(`新增清單（共 ${newViolations.length} 筆）：`);
  for (let i = 0; i < Math.min(newViolations.length, 20); i++) {
    const v = newViolations[i];
    lines.push(`${i + 1}. ${v.filePath}:${v.line} [${v.code}] ${v.severity}`);
    lines.push(`   ${v.message}`);
  }
  if (newViolations.length > 20) {
    lines.push(`…另有 ${newViolations.length - 20} 筆未列示，請看 newViolations 結構化結果。`);
  }
  return lines.join("\n");
}

function renderOnlyNewHumanSummary(
  newViolations: OnlyNewOkResult["newViolations"],
  suppressedNewCount: number,
  baselineCreatedAt: string,
): string {
  const lines: string[] = [];
  lines.push(`Comment Signal 只看新增的問題（比較起點：${baselineCreatedAt}）`);
  lines.push(`- 新增的問題：${newViolations.length}`);
  lines.push(`- 其中已被屏蔽的：${suppressedNewCount}`);
  return lines.join("\n");
}

// ─── Helper re-exports（給測試與 caller 直接使用）──────

export const __commentSignalBaselineToolInternals = {
  BASELINE_FILENAME,
  SUPPRESSIONS_FILENAME,
  buildBaselineFromReport,
  fingerprintSet,
  applySuppressions,
};
