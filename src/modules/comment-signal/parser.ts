/**
 * opencode-ultrawork — Comment Signal Module：parser（純解析）
 *
 * 角色：
 *   - 從 source 文字中抽取 CommentSignal，記錄 tag / severity / metadata /
 *     body / line。不做政策判斷（屬 validator 職責），僅做結構化解析。
 *   - 提供 `detectUnformattedFunctionalComment` 給 validator 對未被
 *     正式 tag 化的功能型註解（例如 `TODO fix later`、`FIXME 之後處理`）
 *     偵測命中 keyword，回傳供 validator 標記 UNFORMATTED_FUNCTIONAL_COMMENT。
 *
 * 設計重點：
 *   - 純函式：僅接收字串與 filePath，回傳結構化物件；無 IO、無 closure。
 *   - 行號以 1-based 紀錄；支援 `//` 與 block comment 兩種註解標記。
 *   - parser 不 narrow tag 是否合法（UNKNOWN_TAG 由 validator 判定），
 *     但 descriptive / functional 仍依 tag 是否在 descriptiveTags 集合分流。
 *   - body 抽取規則：tag header（含方括號）後第一段非空白視為 body；
 *     續行（緊鄰同註解區塊）以空白串接成單一字串，幫助 reporter
 *     顯示完整說明。
 *   - metadata 解析只接受 `key=value` 形式；非法格式不會放入 metadata，
 *     validator 之後會額外標 BAD_METADATA（parser 不丟失原始 header）。
 *
 * 對外規則（不可破壞）：
 *   - `parseCommentSignals` 對空字串 / 無註解輸入回傳 `{ signals: [] }`。
 *   - `detectUnformattedFunctionalComment` 對已正式格式化的註解回傳 null。
 *   - `extractSourceCommentLines`（附：`extractJsStyleCommentLines` /
 *     `extractHashCommentLines` / `extractHtmlFamilyCommentLines` /
 *     `SourceCommentLine`）為本檔對外提供之 lexical helper；validator
 *     與 reporter 共用，避免把字串 / template literal / regex
 *     內的 `[TAG:..]` 誤判為 source comment。
 *
 * 限制：
 *   - 不得引入 IO / 副作用。
 *   - 不得 import runtime helper。
 *
 * @see ./types.ts                                         — CommentSignal 形狀
 * @see ./policy.ts                                        — tag 白名單
 * @see ./validator.ts                                     — reuse lexical helpers
 */

import type { CommentSignal, UnformattedFunctionalHit, SourceCommentLine } from "./types.ts";
import { defaultCommentSignalPolicy } from "./policy.ts";
import { extractSourceCommentLines, HASH_COMMENT_EXTENSIONS } from "./lexer.ts";

export type { SourceCommentLine } from "./types.ts";
export {
  extractSourceCommentLines,
  extractJsStyleCommentLines,
  extractHashCommentLines,
  extractHtmlFamilyCommentLines,
} from "./lexer.ts";

// ─── Regex Patterns ──────────────────────────────────────────
// 注意：以下 regex 為 module-level constant，避免每次呼叫重建。

/** 註解起始（line-comment 或 block-comment 兩種；`#` 只在 hash 語言啟用）。 */
const COMMENT_START = /(\/\/|\/\*)/;

/** hash 語言的註解起始：沿用 `//`／`/*`（無退化），另接受 `#`。 */
const COMMENT_START_HASH = /(\/\/|\/\*|#)/;

/**
 * 從註解內容的第一個語意項目抓取 tag header（含 severity 與 metadata）。
 * 前綴只允許 line/block comment marker（雙斜線、slash-star 系列）、
 * JSDoc 的 `*` 與空白；因此註解內的程式碼索引、連結或 CLI
 * optional-argument 不會被誤認為 Comment Signal。
 * 三斜線 doc（`///`）只在 lexer 能精確定位 marker 起始欄時使用
 * （見 `TAG_HEADER_TRIPLE_SLASH_RE`，目前為 Swift `startColumn` 路徑）；
 * 其他語言沿用既有整行 fallback，只能用原本雙斜線前綴，避免字串內的
 * `/// [TAG]` 被整行重找 marker 時誤判為 tag。
 * - `(?<tag>[^:\]\s]+)`：tag 名稱（不含空白、冒號、方括號）。
 * - `(?::(?<sev>[A-Z0-9]+))?`：可選 severity（如 P0/P1/P2/P3）。
 * - `(?<meta>\s+[^\]]+)?`：可選 metadata 區段；採寬鬆匹配（允許非 key=value
 *   的 token），由 validator 的 `detectBadMetadata` 從 raw 重新解析並
 *   標記 BAD_METADATA（parser 不丟失原始 header）。
 * 使用方括號配對鎖定到對應右中括號。
 */
const TAG_HEADER_RE = /(?:^|\n)\s*(?:(?:\/\/|\/\*+|\*)\s*)\[(?<tag>[^\]:\s]+)(?::(?<sev>[A-Z0-9]+))?(?<meta>\s+[^\]]+)?\]/;

/**
 * 精確路徑專用 tag header：除 `TAG_HEADER_RE` 的前綴外，另接受三斜線
 * doc（`///`）。只有 raw 已從 lexer 提供的 marker 起始欄重建（目前為
 * Swift `startColumn`）時使用；整行 fallback 不得使用，避免字串內的
 * `/// [TAG]` 污染真實註解的解析。
 */
const TAG_HEADER_TRIPLE_SLASH_RE = /(?:^|\n)\s*(?:(?:\/\/\/?|\/\*+|\*)\s*)\[(?<tag>[^\]:\s]+)(?::(?<sev>[A-Z0-9]+))?(?<meta>\s+[^\]]+)?\]/;

/**
 * hash 語言（`#` 註解：`.sh`／`.yaml`／`.yml`／`.py`／`.toml`）專用
 * tag header：除 `TAG_HEADER_RE` 的前綴外，另接受 `#`。只在副檔名屬於
 * `HASH_COMMENT_EXTENSIONS` 時使用；`//` 系語言的行為完全不變。
 */
const TAG_HEADER_HASH_RE = /(?:^|\n)\s*(?:(?:\/\/|\/\*+|\*|#)\s*)\[(?<tag>[^\]:\s]+)(?::(?<sev>[A-Z0-9]+))?(?<meta>\s+[^\]]+)?\]/;

/** metadata token：`key=value`，key 只允許英數底線與 dash。 */
const META_TOKEN_RE = /([a-zA-Z_][\w-]*)=([^\s\]]+)/g;

/** 未格式化功能型註解偵測：第一個語意項目為 TODO / FIXME / REVIEW / VERIFY / TEST。 */
const UNFMT_WORKFLOW_RE = /^(TODO|FIXME|REVIEW|VERIFY|TEST)\b/i;

/** 未格式化功能型註解偵測：第一個語意項目為風險關鍵字。 */
const UNFMT_RISK_RE = /^(WARNING|DANGER|SECURITY|PRIVACY|DATA|COMPAT)\b/i;

/** 未格式化功能型註解偵測：中文常見寫法「待辦 / 之後處理 / 注意」。 */
const UNFMT_CJK_RE = /^(待辦|之後處理|之後再|之後再說|之後補|之後再改|待補|待修)/;

// ─── Parser Entry ────────────────────────────────────────────

/**
 * 解析 source 文字並回傳檔案層級結果。
 *
 * 策略：以 lexer 抽取出「真實的」line/block comment 區段（忽略字串、
 * template literal raw、regex、import path 內的 slashes），避免把
 * `["// [TAG:..]"]` 之類字串內容誤判為 comment。Lexer 給的是「哪些行
 * 有 comment」這個語意資訊，不再依賴逐行 regex 對原 source 全文匹配，
 * 這也是把字串 / template / JSDoc 內容排除後才能讓 TAG 範例不被誤判
 * 為 functional tag 的根因。
 *
 * 行為：
 *   - 對 lexer 回傳的每段 comment line（每行一個 entry，多行 block 會拆成
 *     多筆），以「連續行號」與「comment 類型」分組成 logical comment group：
 *       · 相鄰且同類型（連續多行 block 中介於 open/close 之間的內容）才合併。
 *       · 兩個獨立的 line comment（即使行號連續，例如連續兩行 // A 與 // B）
 *         不會合併，因為行 comment 永遠只佔一行。
 *       · 多行 block comment 中，連續行號 + 第一行是 `/*` 開頭、後續行
 *         首字為 `*` 才視為同一個 block。
  *   - 對單行 group 直接以 source 對應行作為 raw（保留原縮排與前綴），
  *     丟給既有 tryExtractFromLine 規則；對多行 group 把 source 的整段
  *     行重新 join（保留原始 star-prefix 與 open/close markers），再以
  *     對應的 tag header regex（精確路徑另含 `///`）找出實際 header 所在的行。
 *   - 對非 TS/JS 副檔名（如 yaml/yml/sh/py/toml, html/vue/svelte, css,
 *     json, txt）走語言原生 lexer；與既有 validator 路徑一致。
 *     hash 語言的單行 entry 以 `"# " + entry.text` 重建 raw（lexer 已做
 *     字串邊界判定），行尾註解與字串內的 `#` 不會誤判。
 *
 * @param source 檔案原始內容（含換行）。
 * @param filePath 來源檔案路徑（注入到每個 CommentSignal，同時用於副檔名判斷）。
 */
export function parseCommentSignals(source: string, filePath: string): { filePath: string; signals: CommentSignal[] } {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const comments = extractSourceCommentLines(source, filePath);
  const signals: CommentSignal[] = [];
  // hash 語言（`#` 註解）的 entry 一律是單行 `#` 註解：raw 直接從 lexer
  // 已做字串邊界判定的 entry.text 重建（`"# " + text`），行尾註解與
  // 字串內的 `#`（如 `"a#b"`）都不會誤判；`//` 系語言沿用整行 raw。
  const extension = filePath.toLowerCase().match(/\.[^.\/]+$/)?.[0] ?? "";
  const allowHashMarker = HASH_COMMENT_EXTENSIONS.has(extension);

  // 將 lexer 回傳的 comment lines 依「類型 + 行號連續性」分組成 logical
  // comment：line comment（src 行首為 `//`）永遠是 1-entry group；
  // single-line block（src 行同含 `/*` 與 `*/`）亦為 1-entry group；
  // multi-line block（`/*` 開頭後接續 ` *` 行直到 `*/`）才合併多筆 entry。
  const groups: SourceCommentLine[][] = [];
  let currentGroup: SourceCommentLine[] | null = null;
  let currentIsMultiLineBlock = false;

  const flush = () => {
    if (currentGroup) {
      groups.push(currentGroup);
      currentGroup = null;
      currentIsMultiLineBlock = false;
    }
  };

  for (const entry of comments) {
    const srcLine = (lines[entry.line - 1] ?? "").trimStart();
    const isLineComment = srcLine.startsWith("//");
    const isBlockOpener = srcLine.startsWith("/*");
    const isSingleLineBlock = isBlockOpener && srcLine.includes("*/", 2);
    const isBlockContinuation = !isLineComment
      && !isBlockOpener
      && srcLine.startsWith("*");
    const closesBlock = srcLine.includes("*/");

    if (isLineComment || isSingleLineBlock) {
      // Line comment 或 single-line block：永遠單獨一筆。
      flush();
      groups.push([entry]);
      continue;
    }

    if (isBlockOpener) {
      // Multi-line block opener。
      flush();
      currentGroup = [entry];
      currentIsMultiLineBlock = true;
      if (closesBlock) {
        flush();
      }
      continue;
    }

    if (isBlockContinuation && currentIsMultiLineBlock && currentGroup) {
      // 連續行 + 是當前 block 的續行（行首為 `*`）。
      currentGroup.push(entry);
      if (closesBlock) {
        flush();
      }
      continue;
    }

    // 其他情況（無法歸類）退回單筆 group。
    flush();
    groups.push([entry]);
  }
  flush();

  for (const group of groups) {
    if (group.length === 1) {
      // 單行 comment（line comment 或同一行的 single-line block comment）。
      // lexer 若提供 marker 起始欄（Swift），直接從該欄重建 raw，並允許
      // 三斜線 doc 前綴；避免整行重找 marker 時命中字串內的假 marker
      // （如 `"/// [WARN:P1]"`）；未提供時沿用既有整行行為與雙斜線前綴
      //（其他語言相容）。
      // hash 語言另從 entry.text 重建 `"# " + text`（見上方說明）。
      const entry = group[0];
      const fullRaw = lines[entry.line - 1] ?? "";
      const allowTripleSlash = entry.startColumn !== undefined;
      const raw = allowTripleSlash
        ? fullRaw.slice(entry.startColumn as number)
        : allowHashMarker
          ? `# ${entry.text}`
          : fullRaw;
      const parsed = tryExtractFromLine(raw, filePath, entry.line, false, allowTripleSlash, allowHashMarker);
      if (parsed) signals.push(parsed);
      continue;
    }

    // 多行 block comment：直接以 source 的連續行為 raw，
    // 既有的 tryExtractFromLine 已經能處理（regex 依精確 / fallback 選擇）。
    // 首行若有 lexer 起始欄，從該欄切除行首程式碼，避免 opener 前的
    // 字串假 marker 污染；續行完整保留以維持行號與 star-prefix。
    const startSrcLine = group[0].line;
    const endSrcLine = group[group.length - 1].line;
    const blockLines = lines.slice(startSrcLine - 1, endSrcLine);
    const allowTripleSlash = group[0].startColumn !== undefined;
    if (allowTripleSlash) {
      blockLines[0] = (blockLines[0] ?? "").slice(group[0].startColumn as number);
    }
    const merged = blockLines.join("\n");

    // 找出 tag header 實際落在 merged 的哪一行（0-based offset）。
    const tagRe = allowTripleSlash ? TAG_HEADER_TRIPLE_SLASH_RE : allowHashMarker ? TAG_HEADER_HASH_RE : TAG_HEADER_RE;
    const mergedLines = merged.split("\n");
    let headerOffset = 0;
    for (let i = 0; i < mergedLines.length; i++) {
      if (tagRe.test(mergedLines[i])) {
        headerOffset = i;
        break;
      }
    }
    const startLine = startSrcLine + headerOffset;

    const parsed = tryExtractFromLine(merged, filePath, startLine, true, allowTripleSlash, allowHashMarker);
    if (parsed) signals.push(parsed);
  }

  return { filePath, signals };
}

/**
 * 嘗試從單行（或單一合併 block）抽出 CommentSignal。
 * 命中 tag header 才回傳；無命中則回 null。
 * `allowTripleSlash` 只在 raw 已從 lexer 提供的 marker 起始欄重建時
 * 為 true（目前為 Swift `startColumn` 路徑），此時才接受 `///` 前綴；
 * 整行 fallback 一律 false，維持原本雙斜線行為。
 * `allowHashMarker` 只在副檔名屬於 hash 語言時為 true，此時另接受 `#`
 * 前綴；`//` 系語言一律 false，行為不變。
 */
function tryExtractFromLine(
  raw: string,
  filePath: string,
  line: number,
  _isBlock: boolean,
  allowTripleSlash = false,
  allowHashMarker = false,
): CommentSignal | null {
  const commentStart = raw.search(allowHashMarker ? COMMENT_START_HASH : COMMENT_START);
  if (commentStart < 0) return null;
  const commentRaw = raw.slice(commentStart);

  const tagRe = allowTripleSlash
    ? TAG_HEADER_TRIPLE_SLASH_RE
    : allowHashMarker
      ? TAG_HEADER_HASH_RE
      : TAG_HEADER_RE;
  const m = commentRaw.match(tagRe);
  if (!m || !m.groups) return null;

  const tag = m.groups.tag ?? "";
  const sevRaw = m.groups.sev ?? "";
  const metaRaw = m.groups.meta ?? "";

  const policy = defaultCommentSignalPolicy;
  const isDescriptive = (policy.descriptiveTags as readonly string[]).includes(tag);

  // severity：說明型為 null；功能型需嘗試 narrow
  const severity = isDescriptive
    ? null
    : (policy.severities as readonly string[]).includes(sevRaw)
      ? (sevRaw as CommentSignal["severity"])
      : (sevRaw ? (sevRaw as CommentSignal["severity"]) : null);

  // metadata 解析
  const metadata: CommentSignal["metadata"] = {};
  for (const tok of metaRaw.matchAll(META_TOKEN_RE)) {
    const k = tok[1];
    const v = tok[2];
    if ((policy.metadataKeys as readonly string[]).includes(k)) {
      (metadata as Record<string, string>)[k] = v;
    }
  }

  // body：tag header（含方括號）後所有文字，去頭尾空白
  const headerEnd = (m.index ?? 0) + m[0].length;
  let body = commentRaw.slice(headerEnd);
  // 去掉 block comment 結尾標記
  body = body.replace(/\*\//g, "");
  // 去掉行內註解標記後綴
  body = body.replace(/^\s*:?\s*/, "");
  body = body.replace(/\s+/g, " ").trim();

  // kind：依照 tag 屬於 descriptive 或 functional 決定
  const kind: CommentSignal["kind"] = isDescriptive ? "descriptive" : "functional";

  // raw 去掉前導縮排：parser 從原始程式碼行抽取，縮排屬於程式語境；
  // 對 validator / reporter 而言，重要的是註解本體（含 // 或 /* */），
  // 故統一 trimStart 後再儲存。
  const trimmedRaw = raw.trimStart();

  return {
    filePath,
    line,
    kind,
    tag,
    severity,
    metadata,
    body,
    raw: trimmedRaw,
  };
}

// ─── Unformatted Functional Comment Detection ────────────────

/**
 * 偵測一行內是否含「未格式化的功能型註解」。
 *
 * 規則：
 *   - 行首為 line comment 或 block comment 標記且第一個 token 為 tag header
 *     （含方括號）視為已格式化，回傳 null。
 *   - 否則若第一個語意項目為 TODO/FIXME/REVIEW/VERIFY/TEST、任一風險
 *     keyword（WARNING/DANGER/SECURITY/PRIVACY/DATA/COMPAT），或中文常見寫法
 *     「待辦 / 之後處理 / 之後再 / 之後補 / 待補 / 待修」，視為未格式化。
 *
 * @param line 單行原始文字（不含換行）。
 */
export function detectUnformattedFunctionalComment(line: string): UnformattedFunctionalHit | null {
  if (!line) return null;
  const semantic = line.replace(/^\s*(?:(?:\/\/|\/\*+)\s*|\*\s*)?/, "");
  // 已格式化（tag header）就不算未格式化
  if (/^\[[^\]]+\]/.test(semantic)) return null;

  const matched: string[] = [];
  const workflowMatch = semantic.match(UNFMT_WORKFLOW_RE);
  const riskMatch = semantic.match(UNFMT_RISK_RE);
  if (workflowMatch) matched.push(workflowMatch[1].toUpperCase());
  if (riskMatch) matched.push(riskMatch[1].toUpperCase());
  const cjkMatch = semantic.match(UNFMT_CJK_RE);
  if (cjkMatch) matched.push(cjkMatch[1]);

  if (matched.length === 0) return null;

  return {
    matchedKeywords: dedupe(matched),
    raw: line,
    line: null,
  };
}

/** 簡單 array 去重（保留首次出現順序）。 */
function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
