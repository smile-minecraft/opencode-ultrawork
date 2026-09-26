/**
 * opencode-ultrawork — content 檔 / section 的 canonical sha（純函式 leaf）
 *
 * 樂觀鎖的地基（內容工具設計）。三處必須用**同一
 * 個定義**：outline 回傳的 per-section sha、`section` / `taskId` read 回傳的
 * sha、`update` 比對的 `expectedSha256`。
 *
 * 定義：
 *   - `canonicalFile = normalize(rawFile)`
 *   - `fileSha256 = sha256(utf8(canonicalFile))`
 *   - `sectionSha256 = sha256(utf8(sectionText))`，其中 sectionText =
 *     canonical body 中 `[bounds.start, bounds.end)` 行 join `\n`，若之後還有
 *     行（邊界行 / body 尾端）再補一個 `\n`。範圍含 heading / anchor / 內文 /
 *     內部空行，不含邊界行。
 *
 * 解析用 JS 字串索引；回傳的 `bytes` 用 `Buffer.byteLength(text, "utf8")`。
 * 不把 JS 字串索引稱作 byte offset。
 */

import { createHash } from "node:crypto";
import { splitFrontmatter } from "../core/helpers.ts";
import { normalize } from "../core/markdown-canonical.ts";
import { findSectionBounds, type SectionBounds, type SectionSelector } from "./section-parser.ts";

function sha256Utf8(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** 從 canonical frontmatter 取 `contentVersion`（無 / 非數字 → null）。裸 CR 也支援。 */
export function frontmatterContentVersion(rawFile: string): number | null {
  const { frontmatter } = splitFrontmatter(normalize(rawFile));
  if (!frontmatter) return null;
  const m = /^contentVersion:\s*(\d+)\s*$/m.exec(frontmatter);
  return m ? Number(m[1]) : null;
}

/** canonical 整檔 sha。輸入是 `readFileSync(path, "utf-8")` 的原字串。 */
export function fileSha256(rawFile: string): string {
  return sha256Utf8(normalize(rawFile));
}

/** canonical body（frontmatter 之後）。 */
export function canonicalBody(rawFile: string): string {
  return splitFrontmatter(normalize(rawFile)).body;
}

/** 依 bounds 取出 section 的 canonical 文字表示。 */
export function sectionText(body: string, bounds: SectionBounds): string {
  const lines = body.split("\n");
  const slice = lines.slice(bounds.start, bounds.end);
  const trailingNewline = bounds.end < lines.length ? "\n" : "";
  return slice.join("\n") + trailingNewline;
}

/** section canonical sha。找不到 section 回傳 null。 */
export function sectionSha256(rawFile: string, selector: SectionSelector): string | null {
  const body = canonicalBody(rawFile);
  const bounds = findSectionBounds(body, selector);
  if (!bounds) return null;
  return sha256Utf8(sectionText(body, bounds));
}

/** 1-based 閉區間行號 + 位元組數，供 read 回傳。 */
export function sectionMeta(
  rawFile: string,
  selector: SectionSelector,
): { lineRange: [number, number]; lines: number; bytes: number; level: number; sha256: string } | null {
  const body = canonicalBody(rawFile);
  const allLines = body.split("\n");
  const bounds = findSectionBounds(body, selector);
  if (!bounds) return null;
  const text = sectionText(body, bounds);
  // canonical body 固定以 \n 結尾，split 會多一個結尾 "" sentinel。section 落在
  // 檔尾時 bounds.end === allLines.length，要把 sentinel 從行數 metadata 扣掉
  // （section hash 的結尾 \n 不受影響）。
  let effectiveEnd = bounds.end;
  if (effectiveEnd === allLines.length && allLines[allLines.length - 1] === "") {
    effectiveEnd -= 1;
  }
  return {
    lineRange: [bounds.start + 1, effectiveEnd],
    lines: effectiveEnd - bounds.start,
    bytes: Buffer.byteLength(text, "utf8"),
    level: bounds.level,
    sha256: sha256Utf8(text),
  };
}
