/**
 * opencode-ultrawork — skiller draft 內容助手（outline / section / 套用）
 *
 * 角色：
 *   - 給 `skiller-draft-read` 與 `skiller-draft-update` 共用的 markdown
 *     結構操作：outline、section 定位、section 級 replace/append/prepend/delete。
 *   - 重用既有 content leaf 的通用 primitive（`normalize`、`splitFrontmatter`、
 *     `findSectionBounds`、`grepContent`、`unifiedLineDiff`），不另造一套 parser。
 *
 * 為什麼不直接用 `content-apply.ts` 的 `buildUpdatedContent`：
 *   那支是 plan / task content 檔專用——它會 patch `contentVersion` 與
 *   `updatedAt` frontmatter、強制 non-fence H1、檢查 task anchor marker。
 *   SKILL.md 的 frontmatter 是 `name` / `description` 合約，多塞欄位會直接
 *   破壞 skill 載入判定，所以這裡改為「frontmatter 逐字保留、只動 body」。
 *
 * 限制：
 *   - 不得 import `src/index.ts`。
 */

import { createHash } from "node:crypto";
import { splitFrontmatter } from "./core-helpers.ts";
import { lineFenceState } from "./markdown-fence.ts";
import { normalize } from "./markdown-canonical.ts";
import { findSectionBounds, type SectionSelector } from "./section-parser.ts";

export type DraftContentOp = "replace" | "append" | "prepend" | "delete";

export interface DraftOutlineEntry {
  level: number;
  heading: string;
  /** 同名標題的 0-based 出現序；配合 `occurrence` 參數精確定位。 */
  occurrence: number;
  /** body 內 1-based 行號（不含 frontmatter）。 */
  line: number;
  /** 該 section 的 body 位元組數（含標題行）。 */
  bytes: number;
}

export interface DraftDocument {
  /** LF 正規化後的完整檔案內容（含 frontmatter）。 */
  raw: string;
  /** frontmatter 原文（不含 `---` marker）；沒有 frontmatter 時為 null。 */
  frontmatter: string | null;
  /** 去掉 frontmatter 的正文。 */
  body: string;
}

export type DraftApplyResult =
  | { ok: true; proposed: string; sectionBefore: string | null }
  | { ok: false; code: string; message: string };

/** 完整檔案（正規化後）的 SHA-256，供 expectedSha256 併發保護使用。 */
export function draftSha256(raw: string): string {
  return createHash("sha256").update(Buffer.from(normalize(raw), "utf-8")).digest("hex");
}

export function parseDraftDocument(raw: string): DraftDocument {
  const normalized = normalize(raw);
  const { frontmatter, body } = splitFrontmatter(normalized);
  return { raw: normalized, frontmatter, body };
}

/** 把 frontmatter 與 body 組回完整檔案；frontmatter 逐字保留、不做任何 patch。 */
function wrapDocument(frontmatter: string | null, body: string): string {
  const normalizedBody = normalize(body);
  if (frontmatter === null) return normalizedBody;
  return `---\n${frontmatter}\n---\n${normalizedBody}`;
}

/** 列出 body 內所有非 fence 的 H1/H2/H3 標題。 */
export function buildDraftOutline(body: string): DraftOutlineEntry[] {
  const lines = body.split("\n");
  const fence = lineFenceState(lines);
  const counts = new Map<string, number>();
  const entries: DraftOutlineEntry[] = [];
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (fence[i]) continue;
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(lines[i]!);
    if (!match) continue;
    const level = match[1]!.length;
    const heading = match[2]!.trim();
    const occurrence = counts.get(heading) ?? 0;
    counts.set(heading, occurrence + 1);
    entries.push({ level, heading, occurrence, line: i + 1, bytes: 0 });
    starts.push(i);
  }
  // section 位元組數：本標題行到下一個同層或更高層標題之前。
  for (let idx = 0; idx < entries.length; idx += 1) {
    const start = starts[idx]!;
    let end = lines.length;
    for (let next = idx + 1; next < entries.length; next += 1) {
      if (entries[next]!.level <= entries[idx]!.level) {
        end = starts[next]!;
        break;
      }
    }
    entries[idx]!.bytes = Buffer.byteLength(lines.slice(start, end).join("\n"), "utf-8");
  }
  return entries;
}

function selectorFor(section: string, occurrence: number): SectionSelector {
  return { kind: "heading", heading: section, occurrence };
}

function stripSelfHeading(newBody: string, section: string): string {
  const lines = normalize(newBody).split("\n");
  const first = lines[0]?.trim() ?? "";
  const match = /^(#{1,3})\s+(.+?)\s*$/.exec(first);
  if (match && match[2]!.trim() === section) {
    return normalize(lines.slice(1).join("\n"));
  }
  return normalize(newBody);
}

/**
 * 套用一次 section 級（或整份 body）更新，回傳提議後的完整檔案內容。
 * 不寫檔、不驗證 skill 語意——呼叫端負責 preview/confirm 與後續驗證。
 *
 * 規則：
 *   - 沒給 `section` → 目標是整份 body：replace 換掉正文、append/prepend
 *     接在正文前後；delete 不允許（要刪整份草稿請用 skiller-draft-delete）。
 *   - 給了 `section` → 以非 fence 的 H1/H2/H3 標題文字定位（`occurrence`
 *     指定同名標題的第幾次出現，0-based）。找不到時 append/prepend 會在
 *     正文尾／首建立一個新的 H2 section；replace 與 delete 則回
 *     SECTION_NOT_FOUND，不靜默新建。
 *   - frontmatter 一律逐字保留；提議內容自帶 frontmatter 時會被拒絕，
 *     避免 body 裡混進第二份 frontmatter。
 */
export function applyDraftUpdate(params: {
  raw: string;
  section?: string;
  occurrence?: number;
  op: DraftContentOp;
  content?: string;
}): DraftApplyResult {
  const { section, op } = params;
  const doc = parseDraftDocument(params.raw);
  const occurrence = Number.isInteger(params.occurrence) ? Number(params.occurrence) : 0;
  if (occurrence < 0) {
    return { ok: false, code: "INVALID_OCCURRENCE", message: "occurrence 必須是 0 或正整數" };
  }

  if (op !== "delete") {
    if (typeof params.content !== "string" || params.content.length === 0) {
      return { ok: false, code: "CONTENT_REQUIRED", message: `op:${op} 需要非空 content` };
    }
    if (splitFrontmatter(normalize(params.content)).frontmatter !== null) {
      return {
        ok: false,
        code: "CONTENT_HAS_FRONTMATTER",
        message: "content 不得自帶 frontmatter；frontmatter 由草稿原檔逐字保留，需要改 frontmatter 請用 skiller-draft 整檔覆寫",
      };
    }
  }

  const bodyTail = doc.body.replace(/\n+$/, "");

  // ── 整份 body ──
  if (section === undefined || section.trim().length === 0) {
    if (op === "delete") {
      return {
        ok: false,
        code: "DELETE_TARGET_INVALID",
        message: "整份 body 不支援 op:delete；要刪除整份草稿請用 skiller-draft-delete",
      };
    }
    const incoming = normalize(params.content!);
    const nextBody = op === "replace"
      ? incoming
      : op === "append"
        ? `${bodyTail}\n\n${incoming}`
        : `${incoming.replace(/\n+$/, "")}\n\n${doc.body}`;
    return { ok: true, proposed: wrapDocument(doc.frontmatter, nextBody), sectionBefore: null };
  }

  const heading = section.trim();
  const bounds = findSectionBounds(doc.body, selectorFor(heading, occurrence));
  const bodyLines = doc.body.split("\n");

  if (bounds === null) {
    if (op === "replace" || op === "delete") {
      return { ok: false, code: "SECTION_NOT_FOUND", message: `找不到 section：${heading}（occurrence=${occurrence}）` };
    }
    const block = `## ${heading}\n\n${stripSelfHeading(params.content!, heading)}`;
    const nextBody = op === "prepend" ? `${block}\n\n${doc.body}` : `${bodyTail}\n\n${block}`;
    return { ok: true, proposed: wrapDocument(doc.frontmatter, nextBody), sectionBefore: null };
  }

  const sectionBefore = bodyLines.slice(bounds.start, bounds.end).join("\n");

  if (op === "delete") {
    const nextBody = [...bodyLines.slice(0, bounds.start), ...bodyLines.slice(bounds.end)].join("\n");
    return { ok: true, proposed: wrapDocument(doc.frontmatter, nextBody), sectionBefore };
  }

  const headingLine = bodyLines[bounds.start]!;
  const incoming = stripSelfHeading(params.content!, heading);
  const inner = bodyLines.slice(bounds.start + 1, bounds.end).join("\n").replace(/^\n+|\n+$/g, "");
  const nextSection = op === "replace"
    ? `${headingLine}\n\n${incoming}`
    : op === "append"
      ? `${headingLine}\n\n${inner ? `${inner}\n\n` : ""}${incoming}`
      : `${headingLine}\n\n${incoming.replace(/\n+$/, "")}${inner ? `\n\n${inner}` : ""}`;

  const nextBody = [
    ...bodyLines.slice(0, bounds.start),
    ...normalize(nextSection).split("\n"),
    "",
    ...bodyLines.slice(bounds.end),
  ].join("\n");
  return { ok: true, proposed: wrapDocument(doc.frontmatter, nextBody), sectionBefore };
}
