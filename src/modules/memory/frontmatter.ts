/**
 * frontmatter 剖析：`parseFrontmatterBlock` 的唯一實作。
 *
 * `workflow_l1_check` 檢查 state.md 等檔案的 frontmatter 時依賴這個解析器。
 * 解析規則與舊版逐字一致，不要順手「改進」：寬鬆或嚴格一點都會讓既有檔案讀出不同結果。
 * 記憶主題有自己更嚴格的解析（`topic.ts`），不共用這裡。
 */

function parseArrayLiteral(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inside = trimmed.slice(1, -1).trim();
  if (!inside) return [];
  return inside.split(",").map((s) => s.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")).filter(Boolean);
}

export function parseFrontmatterBlock(raw: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!key) continue;
    if (val.startsWith("[") && val.endsWith("]")) { out[key] = parseArrayLiteral(val); continue; }
    out[key] = val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return out;
}
