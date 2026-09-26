/**
 * opencode-ultrawork — markdown render helpers
 *
 * 角色：
 *   - Plan / Task content markdown 的 **frontmatter render 純函式**：
 *     `renderPlanContentMarkdown` 與 `renderTaskContentMarkdown` 分別產出
 *     對應的 YAML frontmatter + body markdown。
 *     維持 leaf boundary，不反向依賴 runtime entry。
 *
 * 對外規則（不可破壞）：
 *     欄位順序、title JSON-stringify、updatedAt ISO timestamp 格式。
 *   - TypeScript structural typing：本檔案獨立定義的 Plan / Task 介面與
 *     index.ts 內同名介面結構對應，跨模組互相可代入。
 *     引用；引入反向 import 會形成循環依賴。
 *   - 僅依賴 `Date` 與 `../core/markdown-canonical.ts`（純函式 leaf），不引入外部相依。
 *
 * Timestamp 策略：
 *   - 採用 module-local `nowIso()` 直接呼叫 `new Date().toISOString()`，
 *   - 與原版語意一致：每次呼叫都產生當下的 timestamp。
 *
 * @see ../../../../README.md                           — 模組一覽
 */

import { stripTrailingBlankLines } from "../core/markdown-canonical.ts";

/**
 * 直接呼叫 `new Date().toISOString()` 以避免 closure 依賴。
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 結尾正規化：移除結尾空白行、補恰好一個 `\n`。
 * 用 `stripTrailingBlankLines` 而非 `.trimEnd()`——後者會清掉最後一行行末的
 * hard-break 空白（Markdown 行末兩個空白）。
 */
function finishBody(text: string): string {
  return `${stripTrailingBlankLines(text)}\n`;
}

/**
 * Plan 介面（structural typing mirror）。
 */
export interface PlanLike {
  planId: string;
  projectId: string;
  projectPath: string;
  title?: string;
}

/**
 * Task 介面（structural typing mirror）。
 */
export interface TaskLike {
  taskId: string;
  projectId: string;
}

/**
 * Render a plan content markdown file with frontmatter.
 *
 * @param plan 對應的 plan 物件（提供 frontmatter 欄位）
 * @param bodyContent frontmatter 之後的 markdown body
 * @param contentVersion 此版內容版本號（會寫入 frontmatter 與 history 對齊）
 * @returns 完整 markdown 字串（含 frontmatter + body + trailing newline）
 */
export function renderPlanContentMarkdown(plan: PlanLike, bodyContent: string, contentVersion: number): string {
  const timestamp = nowIso();
  const lines = [
    "---",
    `type: plan-content`,
    `contentVersion: ${contentVersion}`,
    `planId: ${plan.planId}`,
    `projectId: ${plan.projectId}`,
    `projectPath: ${plan.projectPath}`,
    `title: ${JSON.stringify(plan.title || "")}`,
    `updatedAt: ${timestamp}`,
    "---",
    "",
    bodyContent,
  ];
  return finishBody(lines.join("\n"));
}

/**
 * Render a task content markdown file with frontmatter.
 *
 * @param task 對應的 task 物件（提供 frontmatter 欄位）
 * @param planId 所屬 plan id（與 task.planId 可能不同，因 task 可跨 plan 引用）
 * @param bodyContent frontmatter 之後的 markdown body
 * @param contentVersion 此版內容版本號（會寫入 frontmatter 與 history 對齊）
 * @returns 完整 markdown 字串（含 frontmatter + body + trailing newline）
 */
export function renderTaskContentMarkdown(task: TaskLike, planId: string, bodyContent: string, contentVersion: number): string {
  const timestamp = nowIso();
  const lines = [
    "---",
    `type: task-content`,
    `contentVersion: ${contentVersion}`,
    `taskId: ${task.taskId}`,
    `planId: ${planId}`,
    `projectId: ${task.projectId}`,
    `updatedAt: ${timestamp}`,
    "---",
    "",
    bodyContent,
  ];
  return finishBody(lines.join("\n"));
}

/**
 * Render a standalone task content markdown file（無 planId）：
 *   - 對應 `task_content_update` standalone file mode 路徑；
 *     frontmatter 不含 `planId:` 欄位，避免與 plan registry 耦合。
 *   - 與 `renderTaskContentMarkdown` 行為對齊：相同欄位順序、相同的
 *     contentVersion / updatedAt 語意；唯一差異為省略 planId。
 *   - 不破壞既有 linked render（呼叫端依既有 planId 必傳規則不變）。
 *
 * @param task 對應的 task 物件（提供 frontmatter 欄位）
 * @param bodyContent frontmatter 之後的 markdown body
 * @param contentVersion 此版內容版本號（task-local，獨立於 plan.contentVersion）
 * @returns 完整 markdown 字串（含 frontmatter + body + trailing newline）
 */
export function renderStandaloneTaskContentMarkdown(task: TaskLike, bodyContent: string, contentVersion: number): string {
  const timestamp = nowIso();
  const lines = [
    "---",
    `type: task-content`,
    `contentVersion: ${contentVersion}`,
    `taskId: ${task.taskId}`,
    `projectId: ${task.projectId}`,
    `updatedAt: ${timestamp}`,
    "---",
    "",
    bodyContent,
  ];
  return finishBody(lines.join("\n"));
}
