/**
 * frontmatter 剖析：`parseFrontmatterBlock` 的唯一實作。
 *
 * 專案記憶政策（project-md-policy）與 `workflow_l1_check` 的 `limit` 檢查都
 * 依賴這個解析器。解析規則是凍結介面，與舊版逐字一致，不要順手「改進」：
 * 寬鬆或嚴格一點都會讓既有的 project.md 讀出不同結果。
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
