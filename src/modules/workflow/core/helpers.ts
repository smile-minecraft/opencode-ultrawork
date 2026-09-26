/**
 * opencode-ultrawork — core helpers
 *
 * 角色：
 *   - 專案比對與狀態判定：`sameProject` / `isFinishedPlanState` /
 *     `isFinishedTaskState` / `uniq` / `deriveProjectId`。
 *   - 純字串 / frontmatter / path-segment 工具 `parseJsonSafe` /
 *     `sanitizePathSegment` / `normalizeNewline` / `normalizeTag` /
 *     `splitFrontmatter`。這些都是
 *     純函式、無 IO、無 plugin 內部狀態依賴，可安全置於 module level。
 *   - 所有 helpers 為 module-level pure 函式，不依賴 closure，亦不持有
 *     plugin 內部狀態。
 *
 * 設計重點：
 *   - `sameProject` 使用 `resolve` 比對絕對路徑，避免相對路徑造成 false negative。
 *   - `isFinishedPlanState` / `isFinishedTaskState` 接受寬鬆 `string` 並在內部
 *     以 `as` narrow 至 `FINISHED_*_STATES` literal union，保持與 index.ts 原
 *     行為一致。
 *   - `uniq` 為 generic array 去重（使用 Set）。
 *   - `deriveProjectId` 從 project path 派生 stable id（lowercase、ASCII 友善、
 *     中文字符保留、移除非法字元並轉 `-`，截斷 48 字元）。
 *   - `parseJsonSafe<T>` 為 JSON.parse 包裝，try/catch 包住、parse 失敗回傳 null；
 *   - `sanitizePathSegment` 用於 card_type / projectId / lock name 等 path 片段
 *     之 NFKC 正規化 + 非法字元替換；fallback 為強制非空字串。
 *   - `normalizeNewline` 把 `\r\n` 統一為 `\n`，僅作 line-ending 正規化。
 *   - `normalizeTag` 去除前綴 `#`、trim、lowercase。
 *   - `splitFrontmatter` 解析 `---\n...frontmatter...\n---\n...body...` 格式；
 *     內部呼叫 `normalizeNewline` 保證跨平台一致。
 *
 * 對外規則（不可破壞）：
 *   - 不可 import `src/gates/plan-link-validation.ts` 的同名 `sameProject`
 *     區域副本——兩者結構保持相同（structural typing），但本檔獨立實作
 *     以維持單向依賴。
 *
 * 限制：
 *   - 僅依賴 `node:path`（`resolve`、`basename`）與 `./constants.ts`。
 *   - 不得引入 IO / 副作用。
 *
 * @see ./constants.ts                                     — 狀態集合常數
 * @see ../content/content-sha.ts                          — frontmatter 消費端
 * @see ../content/content-apply.ts                        — 內容套用時的 body 比對
 */

import { basename, resolve } from "node:path";
import type { ProjectBinding } from "./types.ts";
import { FINISHED_PLAN_STATES, FINISHED_TASK_STATES } from "./constants.ts";

/**
 * 判斷兩個 ProjectBinding 是否指向同一專案（projectId 一致且
 * projectPath 經 `resolve` 後絕對路徑一致）。
 */
export function sameProject(a: ProjectBinding, b: ProjectBinding): boolean {
  return a.projectId === b.projectId && resolve(a.projectPath) === resolve(b.projectPath);
}

/**
 * 判斷 plan state 是否為 finished（COMPLETED / FAILED / CANCELLED）。
 * 使用 `FINISHED_PLAN_STATES` literal union 維持型別 narrow。
 */
export function isFinishedPlanState(state: string): boolean {
  return FINISHED_PLAN_STATES.includes(state as (typeof FINISHED_PLAN_STATES)[number]);
}

/**
 * 判斷 task state 是否為 finished（COMPLETED / FAILED / CANCELLED）。
 * 使用 `FINISHED_TASK_STATES` literal union 維持型別 narrow。
 *
 * 原行為完全一致（`FINISHED_TASK_STATES.includes(state as literal)`）；
 * 因為只依賴常數、無 closure 依賴，搬遷對 runtime 行為零影響。
 */
export function isFinishedTaskState(state: string): boolean {
  return FINISHED_TASK_STATES.includes(state as (typeof FINISHED_TASK_STATES)[number]);
}

/**
 * Generic array 去重（保留首次出現順序，使用 Set）。
 */
export function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/**
 * 從 project absolute path 派生 stable project id：
 *   - 取 basename（資料夾名）
 *   - lowercase
 *   - 將非 `[a-z0-9\u4e00-\u9fff]+` 序列替換為單一 `-`
 *   - 移除頭尾 `-`
 *   - 截斷至 48 字元
 *   - 結果為空時 fallback 為 `"project"`
 */
export function deriveProjectId(projectPath: string): string {
  return (basename(resolve(projectPath)) || "project")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
}

// ─── 字串與 frontmatter 工具 ────────────────────────────────
// 這組函式僅引用常數與純函式、無 IO、無 plugin 內部狀態依賴，因此放在
// module level，不需要由呼叫端注入 closure。

/**
 * 安全版 JSON.parse：parse 失敗回傳 null，不拋例外。
 * 用於解析 frontmatter scalar、AI memory source / edges 等 optional JSON 字串欄位。
 *
 * 原行為完全一致（`JSON.parse` 包 try/catch、失敗回 null）。
 */
export function parseJsonSafe<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Sanitize 路徑片段（card_type / projectId / lock name 等）。
 *   - NFKC 正規化
 *   - 將 `[<>:\"\/\\|?*\u0000-\u001F]+` 替換為單一 `-`
 *   - 將連續 whitespace 釐清為 `-`
 *   - 將連續 `-` 釐清為單一 `-`
 *   - 去除首尾 `[. -]`
 *   - lowercase
 *   - 若結果為空則回傳 `fallback`
 *
 */
export function sanitizePathSegment(value: string, fallback: string): string {
  const sanitized = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[. -]+|[. -]+$/g, "")
    .toLowerCase();
  return sanitized || fallback;
}

/**
 * 統一 line-ending：把 `\r\n` 替換為 `\n`。
 * 用於 frontmatter 解析前的輸入正規化（讓 splitFrontmatter 與 parseMemoryFrontmatter
 * 在 CRLF / LF 環境下行為一致）。
 *
 */
export function normalizeNewline(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/**
 * 正規化 tag 字串：
 *   - 移除前綴 `#`
 *   - trim
 *   - lowercase
 *
 * 供 `normalizeMemoryTags` 等記憶體 helper 使用。
 */
export function normalizeTag(tag: string): string {
  return tag.replace(/^#/, "").trim().toLowerCase();
}

/**
 * 將 markdown 文件拆為 frontmatter 區塊與 body。
 *  - 必須以 `---\n` 開頭；找到下一個 `\n---\n` 為 frontmatter 結尾。
 *  - 缺開頭或結尾時回傳 `{ frontmatter: null, body: 全文 }`。
 *  - 內部呼叫 `normalizeNewline` 保證跨平台 line-ending 一致。
 *
 * 原行為完全一致（不變更既有呼叫點語義）。
 */
export function splitFrontmatter(doc: string): { frontmatter: string | null; body: string } {
  const normalized = normalizeNewline(doc);
  if (!normalized.startsWith("---\n")) return { frontmatter: null, body: normalized };
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: null, body: normalized };
  return { frontmatter: normalized.slice(4, end), body: normalized.slice(end + 5) };
}
