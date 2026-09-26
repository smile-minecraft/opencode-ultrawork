/**
 * commentSignal 模組：hook adapter。
 *
 * 提供 `execute.before`／`execute.after` 用的 pure helper 與 guard factory：
 * 路徑抽取、多路徑 patch 解析、P0 阻斷、highRisk warning。
 * 行為跟舊版一致，差別只有：guard closure 改成非同步（狀態走 storage）、
 * 成功判定改由 V2 的 `status === "completed"`（舊的字串解析 helper 不移植）。
 */

import type { CommentSignalWarning } from "./state.ts";
import type { FileReport } from "./types.ts";
import { isMarkdownPath } from "./guard.ts";
import { parseCommentSignals } from "./parser.ts";
import { validateSource } from "./validator.ts";
import { detectHighRiskComments } from "./guard.ts";
import { checkFile, checkFileDetailed } from "./guard.ts";

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

/** 可能裝著檔案路徑的欄位名。
 *
 * 涵蓋 V2 契約的 `path`／`filePath`、舊 V1 別名，以及 snake_case 變體：
 * 欄位名不一致時抽取不到路徑 → pre-edit 直接阻斷整個工具呼叫，等於把
 * 正常編輯全部擋下來，所以寧可多認幾個名字。**多認只會讓更多檔案被檢查**
 * （方向是更嚴），不會讓任何該檢查的檔案被跳過。
 */
const PATH_FIELD_KEYS: readonly string[] = [
  "filePath", "filepath", "file_path", "path",
  "file", "files", "filename", "fileName", "file_name",
  "target", "targetFile", "target_file",
  "absolute_path", "abs_path",
];

/** args 外層可能的包覆鍵：工具呼叫被多包一層時（例如 `{ args: {...} }`、
 *  `{ state: { input: {...} } }`）。只在這一層裡「完全沒有」已知欄位時才
 *  往下看，避免誤把 patch 文字當成 args。 */
const WRAPPER_KEYS: readonly string[] = ["args", "arguments", "params", "parameters", "state", "input"];

/** 陣列／巢狀包覆的展開深度上限：避免惡意或異常輸入造成無限展開。 */
const MAX_UNWRAP_DEPTH = 4;

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

/** 把候選值收成路徑：字串本身、字串陣列、單一元素陣列都認。 */
function pushPathLike(value: unknown, push: (p: string) => void): void {
  if (typeof value === "string") {
    push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") push(item);
    }
  }
}

/** 這個鍵的欄位是否已經當成 patch 文字處理過（值是字串時）。 */
function isPatchTextField(key: string, value: unknown): boolean {
  return typeof value === "string" && (PATCH_TEXT_KEYS as readonly string[]).includes(key);
}

/** 把 input 正規化成物件。
 *
 * `tool.execute.before` 的 `input` 契約型別是 `unknown`，實務上見過三種形狀：
 * 直接的 args 物件、序列化過的 JSON 字串、或多包一層的 `{ args: {...} }`。
 * 形狀認不出來時回 null，呼叫端仍然 fail closed 阻斷——這裡只負責讓正確認得
 * 出來的形狀不要被誤擋。
 */
function toArgsObject(input: unknown, depth: number): Record<string, unknown> | null {
  if (!input) return null;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      return toArgsObject(JSON.parse(trimmed), depth);
    } catch {
      return null;
    }
  }
  if (typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

/**
 * 從一個物件層級抽出路徑，並把包裝層裡的路徑一併併進來。
 *
 * 為什麼要「全部合併」而不是「碰到第一個有已知欄位的物件就停」：input 可能
 * 同時帶著多個路徑來源（例如外層有 `path`、內層 `args` 又有 `path`）。只取
 * 第一個來源，另一個就沒被檢查——若真正被編輯的正是沒被檢查的那一個，等於
 * 繞過 P0 保護。合併後每個來源都會被 guard 檢查，方向恆為「檢查更多檔案」。
 */
function collectPathsFromObject(
  obj: Record<string, unknown>,
  push: (p: string) => void,
  depth: number,
): void {
  for (const key of PATH_FIELD_KEYS) {
    pushPathLike(obj[key], push);
  }
  for (const key of PATCH_TEXT_KEYS) {
    const val = obj[key];
    if (typeof val === "string" && val.length > 0) {
      for (const p of extractPatchPaths(val)) push(p);
    }
  }
  if (depth >= MAX_UNWRAP_DEPTH) return;
  for (const key of WRAPPER_KEYS) {
    const inner = obj[key];
    if (inner === undefined) continue;
    // 同時是 patch 欄位且值是字串者，上面已當 patch 文字處理，不重複當包裝。
    if (isPatchTextField(key, inner)) continue;
    const resolved = toArgsObject(inner, depth + 1);
    if (resolved === null) continue;
    collectPathsFromObject(resolved, push, depth + 1);
  }
}

/**
 * 從 args 抽取全部檔案路徑。
 *
 * 涵蓋的形狀：純 args 物件、JSON 序列化字串、多包一層的
 * `args`／`arguments`／`params`／`parameters`／`state`／`input`
 * （含 `state.input`）、snake_case 欄位名、以及陣列值的檔案欄位。
 *
 * **同一份 input 裡的所有候選來源都會合併回傳**（外層在前、依序去重），
 * 不是只取第一個來源：多個來源各自都可能是真正被編輯的檔案，漏掉任何一個
 * 就是漏檢。呼叫端會對每一條路徑個別走 P0 檢查，所以合併只會讓更多檔案被
 * 檢查，方向恆為更嚴。
 *
 * 認不出形狀時回空陣列，呼叫端會 fail closed 阻斷——這是刻意的：抽不到路徑
 * 就等於跳過修改前檢查，寧可擋下來也不要放行。
 *
 * @returns 去重後、依優先順序的非空路徑。
 */
export function extractFilePathsFromArgs(args: unknown): string[] {
  const obj = toArgsObject(args, 0);
  if (obj === null) return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  const push = (p: string): void => {
    if (p.length > 0 && !seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  };
  collectPathsFromObject(obj, push, 0);
  return paths;
}

/**
 * 描述工具 input 的「欄位名與型態」，供抽不到路徑時的阻斷訊息使用。
 *
 * 只輸出鍵名與值的型別，**絕不輸出值**：`edit`／`write` 的欄位值可能是整份
 * 檔案內容（oldString／newString／content），寫進錯誤訊息等於外洩。
 * 物件值會再往下一層展開鍵名（最多兩層），這樣「路徑藏在包裝裡」的情況
 * 一眼就看得出來，而不必回去猜。
 *
 * 欄位過多時截斷，避免訊息爆長把真正的重點洗掉。
 */
export function describeToolInputFields(input: unknown): string {
  return describeShape(input, 0, true);
}

/** 欄位／巢狀層級的顯示上限。 */
const MAX_SHAPE_FIELDS = 12;
/** 物件值往下展開的最大深度。 */
const MAX_SHAPE_DEPTH = 2;

function describeShape(value: unknown, depth: number, topLevel: boolean): string {
  if (value === null || value === undefined) return topLevel ? "（無 input）" : "null";
  if (typeof value === "string") {
    if (!topLevel) return `string(len=${value.length})`;
    const kind = value.trim().startsWith("{") ? "string(JSON 樣式)" : "string";
    return `（${kind}，長度 ${value.length}）`;
  }
  if (typeof value !== "object") return topLevel ? `（${typeof value}）` : typeof value;
  if (Array.isArray(value)) {
    return topLevel ? `（陣列，長度 ${value.length}）` : `array(${value.length})`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (topLevel && entries.length === 0) return "（無欄位）";
  const described = entries
    .slice(0, MAX_SHAPE_FIELDS)
    .map(([key, inner]) => `${key}(${describeShape(inner, depth + 1, false)})`);
  if (entries.length > MAX_SHAPE_FIELDS) {
    described.push(`…另有 ${entries.length - MAX_SHAPE_FIELDS} 個欄位`);
  }
  return described.join("、");
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
  /** 寫入單檔最新報告（結案 gate 按檔聚合用；乾淨報告也會覆蓋舊阻斷）。 */
  recordFileReport(sessionID: string, filePath: string, report: FileReport): Promise<void>;
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
 * → recordLastReport＋recordFileReport。
 *
 * 每一次成功編輯都會刷新該檔的最新 per-file 報告：含問題時記阻斷，
 * 修乾淨時以乾淨報告覆蓋（結案 gate 才不會被舊阻斷永久誤擋，
 * 也不會被別檔的後續報告遮蔽）。
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
    const detailed = checkFileDetailed(filePath, source);
    // Markdown 由呼叫端過濾；直接呼叫時遇到 MD 則沿用舊語意（不記錄、不警告）。
    if (detailed === null) return;
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

    await deps.recordFileReport(sessionID, filePath, detailed);
    const report = checkFile(filePath, source);
    await deps.recordLastReport(sessionID, report);
  };
}

// ─── Helper re-exports（避免 caller 額外 import）────────────

/** Re-export isMarkdownPath 給 hook 端統一使用單一來源。 */
export { isMarkdownPath };
