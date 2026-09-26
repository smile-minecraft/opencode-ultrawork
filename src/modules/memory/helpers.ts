/**
 * memory 模組共用純函式：自舊外掛 core/helpers 逐字搬入。
 *
 * sameProject 用 resolve 比對絕對路徑，避免相對路徑造成誤判；
 * splitFrontmatter 先經 normalizeNewline，CRLF／LF 行為一致；
 * deriveProjectId 供收據建立時的專案綁定 fallback（舊版
 * getCurrentProject 同語意），與收據驗證的綁定比對成對。
 */

import { basename, resolve } from "node:path";

export interface ProjectBinding {
  projectId: string;
  projectPath: string;
}

/**
 * 判斷兩個 ProjectBinding 是否指向同一專案（projectId 一致且
 * projectPath 經 `resolve` 後絕對路徑一致）。
 */
export function sameProject(a: ProjectBinding, b: ProjectBinding): boolean {
  return a.projectId === b.projectId && resolve(a.projectPath) === resolve(b.projectPath);
}

/**
 * 從 project absolute path 派生 stable project id：
 * 取 basename、lowercase、非法字元轉 `-`、截斷 48 字元，
 * 結果為空時 fallback 為 `"project"`。
 */
export function deriveProjectId(projectPath: string): string {
  return (basename(resolve(projectPath)) || "project")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
}

/** 統一 line-ending：把 `\r\n` 替換為 `\n`。 */
export function normalizeNewline(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/**
 * 將 markdown 文件拆為 frontmatter 區塊與 body。
 * 必須以 `---\n` 開頭；找到下一個 `\n---\n` 為 frontmatter 結尾。
 * 缺開頭或結尾時回傳 `{ frontmatter: null, body: 全文 }`。
 */
export function splitFrontmatter(doc: string): { frontmatter: string | null; body: string } {
  const normalized = normalizeNewline(doc);
  if (!normalized.startsWith("---\n")) return { frontmatter: null, body: normalized };
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: null, body: normalized };
  return { frontmatter: normalized.slice(4, end), body: normalized.slice(end + 5) };
}
