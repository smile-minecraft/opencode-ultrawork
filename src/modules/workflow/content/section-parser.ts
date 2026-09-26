/**
 * opencode-ultrawork — section parser helpers
 *
 * 角色：
 *   - Plan content markdown 的 **section 邊界解析 / upsert** 純函式。
 *   - `findSectionBounds` 是唯一的邊界判定；`extractTaskSection` /
 *     `upsertTaskSection` 都建構在它之上，read API 的 outline / section /
 *     grep 也共用它。
 *   - 本模組維持 leaf boundary，不反向依賴 runtime entry。
 *
 * 對外規則（不可破壞）：
 *   - fence-aware：fenced code block（``` / ~~~）內的 `#` / `### task:` /
 *     `<!-- task-anchor:` 不觸發邊界（修正原本會被 fenced 範例誤判的 bug）。
 *   - 邊界條件 extract / upsert 已收斂為同一組（見下）；原本 upsert 內層迴圈
 *     漏檢 anchor 的不一致已修掉。
 *   - 僅依賴 `../core/markdown-fence.ts`（純函式 leaf）與字串處理，不引入外部相依。
 *
 * Section 識別規則：
 *   - task section 由兩行 marker 開頭（正常相連、無空行）：
 *       `### task: {taskId}` + `<!-- task-anchor: {taskId} -->`
 *   - heading section 由一行 `## Heading` 或 `### Heading` 開頭。
 *   - 邊界行（第一個 `!fence[i]` 且滿足其一）：
 *       task selector：下一個 `### task:`、不同 taskId 的 `<!-- task-anchor:`、H1
 *       heading selector：以上，再加任一 `## ` / `### ` 標題（含 `### task:`）
 *
 * @see ../core/markdown-fence.ts
 */

import { lineFenceState } from "../core/markdown-fence.ts";

export type SectionSelector =
  | { kind: "task"; taskId: string }
  | { kind: "heading"; heading: string; occurrence?: number };

export interface SectionBounds {
  /** section 第一行（heading 或 anchor）的行索引。 */
  start: number;
  /** section 結束的行索引（exclusive；邊界行本身不含）。 */
  end: number;
  /** 該 section 標題行的層級：1 / 2 / 3。 */
  level: number;
}

const TASK_HEADING_PREFIX = "### task:";
const TASK_ANCHOR_PREFIX = "<!-- task-anchor:";

function isH1(line: string): boolean {
  return line.startsWith("# ") && !line.startsWith("##");
}

function isAnyHeading(line: string): boolean {
  return /^#{1,3}\s/.test(line);
}

function headingLevel(line: string): number {
  const m = /^(#{1,3})\s/.exec(line);
  return m ? m[1]!.length : 0;
}

/**
 * 定位一個 section 的行範圍。fence-aware。找不到回傳 null。
 *
 * task selector：start 指向第一個匹配的 marker 行（heading 或 anchor，
 * 通常是 heading）。heading selector：start 指向第 `occurrence`（0-indexed，
 * 預設 0）個匹配的 `## Heading` / `### Heading` 行。
 */
export function findSectionBounds(
  content: string,
  selector: SectionSelector,
): SectionBounds | null {
  const lines = content.split("\n");
  const fence = lineFenceState(lines);

  let start = -1;
  let level = 0;

  if (selector.kind === "task") {
    const targetHeading = `${TASK_HEADING_PREFIX} ${selector.taskId}`;
    const targetAnchor = `<!-- task-anchor: ${selector.taskId} -->`;
    for (let i = 0; i < lines.length; i++) {
      if (fence[i]) continue;
      const t = lines[i]!.trim();
      if (t === targetHeading || t === targetAnchor) {
        start = i;
        level = 3;
        break;
      }
    }
  } else {
    const wanted = selector.heading.trim();
    const occurrence = selector.occurrence ?? 0;
    let seen = 0;
    for (let i = 0; i < lines.length; i++) {
      if (fence[i]) continue;
      const m = /^(#{2,3})\s+(.+?)\s*$/.exec(lines[i]!);
      if (!m) continue;
      if (m[2]!.trim() !== wanted) continue;
      if (seen === occurrence) {
        start = i;
        level = m[1]!.length;
        break;
      }
      seen += 1;
    }
  }

  if (start === -1) return null;

  const isHeadingSelector = selector.kind === "heading";
  const selfAnchor =
    selector.kind === "task" ? `<!-- task-anchor: ${selector.taskId} -->` : null;

  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (fence[j]) continue;
    const line = lines[j]!;
    const t = line.trim();
    if (t.startsWith(TASK_HEADING_PREFIX)) {
      end = j;
      break;
    }
    if (t.startsWith(TASK_ANCHOR_PREFIX) && t !== selfAnchor) {
      end = j;
      break;
    }
    if (isH1(line)) {
      end = j;
      break;
    }
    if (isHeadingSelector && isAnyHeading(line)) {
      end = j;
      break;
    }
  }

  return { start, end, level };
}

/**
 * Extract task section body from plan markdown content.
 * 回傳 marker 兩行之後的 body（trim 過），找不到或空 section 回傳 null。
 *
 * 行為契約（08-content-leaf-sanity）：回傳不含 `### task:` / anchor 兩行，
 * 且 trim 兩端；真正空的 section 回傳 null。
 */
/**
 * 從 section 開頭略過實際的 marker 行（heading / anchor / 兩者之間的空行），
 * 回傳 body 第一行的索引。**只吃 section 最前面連續的 marker/空行**——不用
 * 全域文字比對，所以 body 裡（含 fenced code block）與 marker 相同的行不會
 * 被誤刪。
 */
function taskBodyStart(
  lines: string[],
  bounds: SectionBounds,
  heading: string,
  anchor: string,
): number {
  let i = bounds.start;
  while (i < bounds.end) {
    const t = lines[i]!.trim();
    if (t === "" || t === heading || t === anchor) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

export function extractTaskSection(content: string, taskId: string): string | null {
  const bounds = findSectionBounds(content, { kind: "task", taskId });
  if (!bounds) return null;
  const lines = content.split("\n");
  const heading = `${TASK_HEADING_PREFIX} ${taskId}`;
  const anchor = `<!-- task-anchor: ${taskId} -->`;
  const bodyStart = taskBodyStart(lines, bounds, heading, anchor);
  const joined = lines.slice(bodyStart, bounds.end).join("\n").trim();
  return joined.length > 0 ? joined : null;
}

/**
 * Update or insert a task section in plan markdown content. Returns new content.
 *
 * @param content plan markdown 全文（無 frontmatter；由 caller 處理）
 * @param taskId 目標 task id
 * @param newSectionContent section 內文（不含 marker）
 * @param mode replace / append / prepend
 */
export function upsertTaskSection(
  content: string,
  taskId: string,
  newSectionContent: string,
  mode: "replace" | "append" | "prepend",
): string {
  const heading = `${TASK_HEADING_PREFIX} ${taskId}`;
  const anchor = `<!-- task-anchor: ${taskId} -->`;
  const bounds = findSectionBounds(content, { kind: "task", taskId });

  const renderSection = (bodyText: string): string =>
    [heading, anchor, "", bodyText].join("\n");

  if (!bounds) {
    const newSection = renderSection(newSectionContent);
    if (mode === "prepend") return `${newSection}\n\n${content}`;
    return `${content.trimEnd()}\n\n${newSection}\n`;
  }

  const lines = content.split("\n");
  // 既有 body：只略過 section 開頭實際的 marker/空行，其餘（含 fenced 內容
  // 裡與 marker 相同的行）逐字保留。
  const bodyStart = taskBodyStart(lines, bounds, heading, anchor);
  const existingBody = lines.slice(bodyStart, bounds.end).join("\n").trim();

  let combined: string;
  if (mode === "replace") combined = newSectionContent;
  else if (mode === "append") combined = `${existingBody}\n\n${newSectionContent}`;
  else combined = `${newSectionContent}\n\n${existingBody}`;

  const updatedSection = renderSection(combined);
  return [...lines.slice(0, bounds.start), updatedSection, ...lines.slice(bounds.end)].join("\n");
}
