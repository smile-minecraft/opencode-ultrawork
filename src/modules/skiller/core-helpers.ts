/** skiller draft 使用的最小純函式集合，行為沿用舊版 core helpers。 */

export function normalizeNewline(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export function splitFrontmatter(doc: string): { frontmatter: string | null; body: string } {
  const normalized = normalizeNewline(doc);
  if (!normalized.startsWith("---\n")) return { frontmatter: null, body: normalized };
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: null, body: normalized };
  return { frontmatter: normalized.slice(4, end), body: normalized.slice(end + 5) };
}
