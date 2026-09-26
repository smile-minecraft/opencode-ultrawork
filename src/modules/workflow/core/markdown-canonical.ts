/**
 * opencode-ultrawork — content 檔 canonical form + frontmatter patch（純函式 leaf）
 *
 * 角色（內容工具設計 / §3.2）：
 *   - `normalize(raw)`：把 content 檔正規化成穩定的 canonical 形式，供 sha
 *     計算與 splice 使用。**冪等**。
 *   - `stripTrailingBlankLines(text)`：移除結尾的空白行，保留內容行行末空白
 *     （Markdown 行末兩個空白 = hard break）。`render.ts` 用它取代 `.trimEnd()`。
 *   - `patchFrontmatter(fm, patch)`：只改指定的 frontmatter key，其餘 key
 *     （含人手加的）原樣保留、順序不變；無法解析回傳 null。
 *
 * canonical 規則：
 *   - `\r\n` 與裸 `\r` → `\n`
 *   - 結尾統一成恰好一個 `\n`（整份空白 → 空字串）
 *   - 移除結尾的空白行；**不移除**內容行行末空白、不動內部空行、不動行內
 *
 * 純函式 / pure module，僅字串處理，不引入 IO 或 runtime helper。
 */

/** 移除結尾的空白行（僅空白 / 空的整行）；保留內容行行末空白。 */
export function stripTrailingBlankLines(text: string): string {
  const lines = text.split("\n");
  while (lines.length > 0 && /^[ \t]*$/.test(lines[lines.length - 1]!)) {
    lines.pop();
  }
  return lines.join("\n");
}

/** content 檔 canonical form。冪等。 */
export function normalize(raw: string): string {
  const lf = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const stripped = stripTrailingBlankLines(lf);
  return stripped === "" ? "" : `${stripped}\n`;
}

const FRONTMATTER_KEY = /^([A-Za-z0-9_-]+):(?:[ \t](.*))?$/;

/**
 * 只覆寫 `patch` 指定的 frontmatter key；其餘行（含空行、含人手加的 key）
 * 原樣保留、順序不變。`patch` 中不存在的 key 追加在最後。
 *
 * @param fm `splitFrontmatter().frontmatter` 回傳的字串（`---` 之間、不含 marker）
 * @returns 新的 frontmatter 字串；任一非空行不是 `key: value` 形式 → null
 */
export function patchFrontmatter(fm: string, patch: Record<string, string>): string | null {
  const lines = fm.split("\n");
  const applied = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    const m = FRONTMATTER_KEY.exec(line);
    if (!m) return null;
    const key = m[1]!;
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      out.push(`${key}: ${patch[key]}`);
      applied.add(key);
    } else {
      out.push(line);
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!applied.has(key)) out.push(`${key}: ${value}`);
  }
  return out.join("\n");
}
