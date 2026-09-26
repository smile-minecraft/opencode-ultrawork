/**
 * commentSignal 模組：hook adapter。
 *
 * 提供 `execute.before`／`execute.after` 用的 pure helper 與 guard factory：
 * 路徑抽取、多路徑 patch 解析、P0 阻斷、highRisk warning。
 * 行為跟舊版一致，差別只有：guard closure 改成非同步（狀態走 storage）、
 * 成功判定改由 V2 的 `status === "completed"`（舊的字串解析 helper 不移植）。
 */

import type { CommentSignalWarning } from "./state.ts";
import { isMarkdownPath } from "./guard.ts";
import { parseCommentSignals } from "./parser.ts";
import { validateSource } from "./validator.ts";
import { detectHighRiskComments } from "./guard.ts";
import { checkFile } from "./guard.ts";

// ─── Constants ───────────────────────────────────────────────

/** 會觸發 Comment Signal 保護的工具名稱（V2 名稱＋舊 V1 名稱相容）。 */
export const FILE_MODIFYING_TOOLS: readonly string[] = [
  "edit",
  "write",
  "patch",
  "apply_patch",
];

// ─── Pure helpers ────────────────────────────────────────────

/**
 * 嘗試從 args 抽取 filePath。
 * 覆蓋常見欄位（filePath／path／file／target／targetFile／filename），
 * 以及 patch 類工具的 `patchText`（多檔 patch 內每條路徑）。
 *
 * @returns 命中時回傳第一條字串；無命中或 args 非物件回傳 null。
 */
export function extractFilePathFromArgs(args: unknown): string | null {
  const all = extractFilePathsFromArgs(args);
  return all.length > 0 ? all[0] : null;
}

/** 可能裝著整份 patch 文字的 args 欄位。 */
const PATCH_TEXT_KEYS: readonly string[] = ["patchText", "patch", "input", "diff"];

/**
 * 從一段 patch 文字抽出全部檔案路徑。
 * 認得的標頭：
 *   - `*** Add File: <path>`（新增）
 *   - `*** Update File: <path>`（更新）
 *   - `*** Delete File: <path>`（刪除）
 *   - `*** Move to: <newPath>`（緊接 Update 的搬移目標，也要保護）
 *
 * @returns 去重後、依出現順序的非空路徑；無標頭回空陣列。
 */
export function extractPatchPaths(patchText: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const markers = ["*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:"];
  for (const line of patchText.split("\n")) {
    const trimmed = line.trim();
    for (const marker of markers) {
      if (trimmed.startsWith(marker)) {
        const p = trimmed.slice(marker.length).trim();
        if (p.length > 0 && !seen.has(p)) {
          seen.add(p);
          paths.push(p);
        }
        break;
      }
    }
  }
  return paths;
}

/**
 * 從 args 抽取全部檔案路徑。
 * 單一路徑欄位與 patch 文字欄位的命中結果合併去重（單一路徑在前）：
 * 兩邊同時出現時每一條都要過保護，不能只取單一路徑而放過 patch 內的路徑。
 *
 * @returns 去重後、依優先順序的非空路徑；無命中或 args 非物件回空陣列。
 */
export function extractFilePathsFromArgs(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const obj = args as Record<string, unknown>;
  const paths: string[] = [];
  const seen = new Set<string>();
  const push = (p: string): void => {
    if (p.length > 0 && !seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  };
  const candidates = ["filePath", "path", "file", "target", "targetFile", "filename"];
  for (const key of candidates) {
    const val = obj[key];
    if (typeof val === "string") push(val);
  }
  for (const key of PATCH_TEXT_KEYS) {
    const val = obj[key];
    if (typeof val === "string" && val.length > 0) {
      for (const p of extractPatchPaths(val)) push(p);
    }
  }
  return paths;
}

// ─── Guard factory deps ──────────────────────────────────────

/**
 * `makeGuardBeforeEdit`／`makeGuardAfterEdit` 所需的依賴注入。
 * factory 模式：測試可注入假 sourceResolver／spy recordWarning。
 */
export interface GuardAdapterDeps {
  /** 讀檔：(worktree, filePath) → source 或 null（null 表示檔案不存在）。 */
  sourceResolver(worktree: string, filePath: string): string | null;
  /** 推入 pre-edit／post-edit warning。 */
  recordWarning(sessionID: string, warning: CommentSignalWarning): Promise<void>;
  /** 推入最近一次 report（給 touched_report／後續 check 使用）。 */
  recordLastReport(sessionID: string, report: unknown): Promise<void>;
}

// ─── guardBeforeEdit ─────────────────────────────────────────

/**
 * 建立 guardBeforeEdit closure：
 * 在 file-modifying tool 執行前，讀檔 → 解析 → 偵測 highRisk；
 * AI_DO_NOT_EDIT:P0 丟錯阻斷，其他 highRisk 推入 warnings。
 *
 * Markdown 檔案由呼叫端在 hook 內以 isMarkdownPath 提前過濾；本函式不做 MD 過濾。
 *
 * @throws 當偵測到 AI_DO_NOT_EDIT:P0 highRisk 時。
 */
export function makeGuardBeforeEdit(deps: GuardAdapterDeps) {
  return async function guardBeforeEdit(
    sessionID: string,
    filePath: string,
    worktree: string,
  ): Promise<void> {
    const source = deps.sourceResolver(worktree, filePath);
    if (source === null) return;
    const parsed = parseCommentSignals(source, filePath);
    const validated = validateSource(source, parsed.signals, { filePath });
    const highRisk = detectHighRiskComments(validated.highRisk);

    const blocking = highRisk.find((h) => h.tag === "AI_DO_NOT_EDIT" && h.severity === "P0");
    if (blocking) {
      const line = typeof blocking.line === "number" ? `:${blocking.line}` : "";
      throw new Error(
        `Comment Signal guard: AI_DO_NOT_EDIT:P0 found in ${filePath}${line} — ${blocking.body ?? "禁止 AI 修改此檔案"}`,
      );
    }

    if (highRisk.length === 0) return;
    const now = new Date().toISOString();
    for (const item of highRisk) {
      const lineSuffix = typeof item.line === "number" ? `:${item.line}` : "";
      const msg = item.body ?? "";
      await deps.recordWarning(sessionID, {
        filePath,
        tag: item.tag,
        severity: item.severity,
        message: `pre-edit highRisk [${item.tag}:${item.severity}] at ${filePath}${lineSuffix} — ${msg}`.trim(),
        createdAt: now,
      });
    }
  };
}

// ─── guardAfterEdit ──────────────────────────────────────────

/**
 * 建立 guardAfterEdit closure：
 * 在 file-modifying tool 成功後，讀檔 → 解析 → 偵測 highRisk／產生 report
 * → recordLastReport。
 *
 * @throws 永不 throw；任何內部錯誤由呼叫端 swallow。
 */
export function makeGuardAfterEdit(deps: GuardAdapterDeps) {
  return async function guardAfterEdit(
    sessionID: string,
    filePath: string,
    worktree: string,
  ): Promise<void> {
    const source = deps.sourceResolver(worktree, filePath);
    if (source === null) return;
    const parsed = parseCommentSignals(source, filePath);
    const validated = validateSource(source, parsed.signals, { filePath });
    const highRisk = detectHighRiskComments(validated.highRisk);

    if (highRisk.length > 0) {
      const now = new Date().toISOString();
      for (const item of highRisk) {
        const lineSuffix = typeof item.line === "number" ? `:${item.line}` : "";
        const msg = item.body ?? "";
        await deps.recordWarning(sessionID, {
          filePath,
          tag: item.tag,
          severity: item.severity,
          message: `post-edit highRisk [${item.tag}:${item.severity}] at ${filePath}${lineSuffix} — ${msg}`.trim(),
          createdAt: now,
        });
      }
    }

    if (validated.violations.length > 0 || highRisk.length > 0) {
      const report = checkFile(filePath, source);
      await deps.recordLastReport(sessionID, report);
    }
  };
}

// ─── Helper re-exports（避免 caller 額外 import）────────────

/** Re-export isMarkdownPath 給 hook 端統一使用單一來源。 */
export { isMarkdownPath };
