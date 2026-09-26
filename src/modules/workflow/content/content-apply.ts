/**
 * opencode-ultrawork — content update 的「組出 proposed 檔」+ §5.4 驗證（純邏輯）
 *
 * 內容工具設計 / §5.4 / §5.5：在**當下 canonical
 * body** 上依 selector + op splice，frontmatter 只 patch `contentVersion` /
 * `updatedAt`（其餘 key 含自訂原樣保留），最後 normalize 一次確保冪等。
 * 保留內容行行末空白（hard break）——只用 `stripTrailingBlankLines`，不用
 * `trim()` / `trimEnd()`。
 */

import { splitFrontmatter } from "../core/helpers.ts";
import { normalize, patchFrontmatter, stripTrailingBlankLines } from "../core/markdown-canonical.ts";
import { lineFenceState } from "../core/markdown-fence.ts";
import { findSectionBounds, type SectionSelector } from "./section-parser.ts";

export type ContentOp = "replace" | "append" | "prepend" | "delete";

export type UpdateTarget = { kind: "full" } | SectionSelector;

export interface BuildResult {
  proposed: string;
  targetSectionTextBefore: string | null;
}

export interface BuildError {
  code: string;
  error: string;
}

function sectionSlice(bodyLines: string[], start: number, end: number): string {
  const slice = bodyLines.slice(start, end);
  const trailingNewline = end < bodyLines.length ? "\n" : "";
  return slice.join("\n") + trailingNewline;
}

/** 去掉開頭的空白行，保留其餘（含行末 hard-break 空白）。 */
function stripLeadingBlankLines(lines: string[]): string[] {
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i += 1;
  return lines.slice(i);
}

/** `---\n{fm}\n---\n\n{body}`，body 去掉開頭空白行（frontmatter 後只留一個空行），normalize 一次。 */
function wrapDoc(frontmatter: string, bodyText: string): string {
  const body = stripLeadingBlankLines(bodyText.split("\n")).join("\n");
  return normalize(`---\n${frontmatter}\n---\n\n${body}`);
}

/**
 * caller 常把 read 回來的 `sectionContent`（含 `## 標題` 那一行）原樣塞回 update。
 * 若 `newBody` 的第一個非空行剛好是目標 section 的標題（H2/H3 / `### task: <id>`
 * 及其相鄰 anchor），就把那段前綴剝掉，只留標題下面的正文——讓 read → update
 * 能直接往返。
 */
function stripSelfHeading(
  newBody: string,
  target: UpdateTarget,
  taskMarkers?: { heading: string; anchor: string },
): string {
  if (target.kind === "full") return newBody;
  const lines = newBody.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i += 1;
  if (i >= lines.length) return newBody;
  const first = lines[i]!.trim();

  if (target.kind === "task") {
    const h = taskMarkers?.heading ?? `### task: ${target.taskId}`;
    const a = taskMarkers?.anchor ?? `<!-- task-anchor: ${target.taskId} -->`;
    if (first !== h) return newBody;
    i += 1;
    if (i < lines.length && lines[i]!.trim() === a) i += 1;
  } else {
    // `## 標題` 或 `### 標題`（層級不限，剝掉即可）
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(first);
    if (!m || m[2]!.trim() !== target.heading.trim()) return newBody;
    i += 1;
  }
  while (i < lines.length && lines[i]!.trim() === "") i += 1;
  return lines.slice(i).join("\n");
}

// ── §5.4 驗證 ──────────────────────────────────────────────

function h2Counts(body: string): Map<string, number> {
  const lines = body.split("\n");
  const fence = lineFenceState(lines);
  const counts = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    if (fence[i]) continue;
    const m = /^##\s+(.+?)\s*$/.exec(lines[i]!);
    if (!m) continue;
    const h = m[1]!.trim();
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  return counts;
}

export function hasNonFenceH1(body: string): boolean {
  const lines = body.split("\n");
  const fence = lineFenceState(lines);
  return lines.some((l, i) => !fence[i] && /^#\s+\S/.test(l));
}

/** 每個 task heading 都有相鄰的 anchor（反之亦然），且 task id 不重複。 */
function taskMarkersConsistent(body: string): { ok: boolean; reason?: string } {
  const lines = body.split("\n");
  const fence = lineFenceState(lines);
  const headings: string[] = [];
  const anchors: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (fence[i]) continue;
    const h = /^###\s+task:\s+(\S+)\s*$/.exec(lines[i]!.trim());
    const a = /^<!--\s*task-anchor:\s+(\S+)\s*-->$/.exec(lines[i]!.trim());
    if (h) headings.push(h[1]!);
    if (a) anchors.push(a[1]!);
  }
  const dupHeading = headings.find((id, i) => headings.indexOf(id) !== i);
  if (dupHeading) return { ok: false, reason: `重複的 task heading：${dupHeading}` };
  const hset = new Set(headings);
  const aset = new Set(anchors);
  for (const id of hset) if (!aset.has(id)) return { ok: false, reason: `task ${id} 有 heading 沒有 anchor` };
  for (const id of aset) if (!hset.has(id)) return { ok: false, reason: `task ${id} 有 anchor 沒有 heading` };
  return { ok: true };
}

/**
 * §5.4：proposed body 結構驗證。回傳 null = 通過。
 *
 * `opts.requireH1`（預設 `true`）：plan content 檔一律要有 non-fence H1；
 * 專用 task 檔（`source: "file"`）的 body 是自由格式，無 H1 要求 → 傳 `false`。
 */
export function validateProposedBody(
  beforeCanonical: string,
  proposedCanonical: string,
  opts: { requireH1?: boolean } = {},
): BuildError | null {
  const { requireH1 = true } = opts;
  const beforeBody = splitFrontmatter(beforeCanonical).body;
  const afterBody = splitFrontmatter(proposedCanonical).body;

  if (requireH1 && !hasNonFenceH1(afterBody)) {
    return { code: "PROPOSED_BODY_NO_H1", error: "更新後的 body 缺少 non-fence 的 H1 標題。" };
  }
  const beforeH2 = h2Counts(beforeBody);
  const afterH2 = h2Counts(afterBody);
  for (const [h, n] of afterH2) {
    if (n > 1 && n > (beforeH2.get(h) ?? 0)) {
      return { code: "PROPOSED_BODY_DUPLICATE_H2", error: `更新會新增重複的 H2 標題：「${h}」（${beforeH2.get(h) ?? 0} → ${n}）。` };
    }
  }
  const tm = taskMarkersConsistent(afterBody);
  if (!tm.ok) return { code: "PROPOSED_BODY_TASK_MARKERS", error: `task marker 不一致：${tm.reason}` };
  return null;
}

// ── build ──────────────────────────────────────────────

export function buildUpdatedContent(params: {
  rawFile: string;
  nextContentVersion: number;
  updatedAt: string;
  target: UpdateTarget;
  op: ContentOp;
  newBody: string;
  taskMarkers?: { heading: string; anchor: string };
}): BuildResult | BuildError {
  const { rawFile, nextContentVersion, updatedAt, target, op } = params;
  const canonical = normalize(rawFile);
  const { frontmatter, body } = splitFrontmatter(canonical);
  if (frontmatter === null) {
    return { code: "FRONTMATTER_REQUIRED", error: "content 檔缺少 frontmatter，無法保留固定格式更新。" };
  }
  const patchedFm = patchFrontmatter(frontmatter, {
    contentVersion: String(nextContentVersion),
    updatedAt,
  });
  if (patchedFm === null) {
    return { code: "FRONTMATTER_UNPARSEABLE", error: "frontmatter 不是 key: value 形式，拒絕寫入以免遺失 metadata。" };
  }

  const bodyTail = stripTrailingBlankLines(body);
  const newBody = stripSelfHeading(params.newBody, target, params.taskMarkers);
  let newBodyText: string;
  let targetSectionTextBefore: string | null = null;

  if (target.kind === "full") {
    if (op === "delete") return { code: "INVALID_OP", error: "整份 body 不支援 op:delete。" };
    const bodyOnly = splitFrontmatter(newBody).body || newBody;
    newBodyText = op === "replace" ? bodyOnly
      : op === "append" ? `${bodyTail}\n\n${bodyOnly}`
      : `${stripTrailingBlankLines(bodyOnly)}\n\n${body}`;
  } else {
    const bodyLines = body.split("\n");
    const bounds = findSectionBounds(body, target);

    // op:delete 只准 H2（扁平模型）
    if (op === "delete") {
      if (!bounds) return { code: "SECTION_NOT_FOUND", error: "找不到要刪除的 section。" };
      if (target.kind === "task") return { code: "DELETE_TARGET_INVALID", error: "task section 不可刪除。" };
      if (bounds.level !== 2) return { code: "DELETE_TARGET_INVALID", error: `op:delete 只限 H2 section（目標是 H${bounds.level}）。` };
      targetSectionTextBefore = sectionSlice(bodyLines, bounds.start, bounds.end);
      newBodyText = [...bodyLines.slice(0, bounds.start), ...bodyLines.slice(bounds.end)].join("\n");
      return { proposed: wrapDoc(patchedFm, newBodyText), targetSectionTextBefore };
    }

    const headingHashes = target.kind === "heading" ? "#".repeat(bounds?.level ?? 2) : "";

    if (!bounds) {
      // 不存在：append / prepend 到檔尾
      const block = target.kind === "task"
        ? (params.taskMarkers
          ? `${params.taskMarkers.heading}\n${params.taskMarkers.anchor}\n\n${newBody}`
          : null)
        : `## ${target.heading}\n\n${newBody}`;
      if (block === null) return { code: "MISSING_MARKERS", error: "task target 缺 marker。" };
      newBodyText = op === "prepend" ? `${block}\n\n${body}` : `${bodyTail}\n\n${block}`;
    } else {
      targetSectionTextBefore = sectionSlice(bodyLines, bounds.start, bounds.end);
      const before = bodyLines.slice(0, bounds.start);
      const after = bodyLines.slice(bounds.end);

      // 既有 inner：略過 marker / 開頭空行，保留行末空白
      let innerLines: string[];
      if (target.kind === "task" && params.taskMarkers) {
        const { heading, anchor } = params.taskMarkers;
        let i = bounds.start;
        while (i < bounds.end) {
          const t = bodyLines[i]!.trim();
          if (t === "" || t === heading || t === anchor) { i += 1; continue; }
          break;
        }
        innerLines = bodyLines.slice(i, bounds.end);
      } else {
        innerLines = stripLeadingBlankLines(bodyLines.slice(bounds.start + 1, bounds.end));
      }
      const existingInner = stripTrailingBlankLines(innerLines.join("\n"));

      const combined = op === "replace" ? newBody
        : op === "append" ? `${existingInner}\n\n${newBody}`
        : `${stripTrailingBlankLines(newBody)}\n\n${existingInner}`;

      let rebuilt: string;
      if (target.kind === "task") {
        if (!params.taskMarkers) return { code: "MISSING_MARKERS", error: "task target 缺 marker。" };
        rebuilt = `${params.taskMarkers.heading}\n${params.taskMarkers.anchor}\n\n${combined}`;
      } else {
        rebuilt = `${headingHashes} ${target.heading}\n\n${combined}`;
      }
      newBodyText = [...before, rebuilt, ...after].join("\n");
    }
  }

  return { proposed: wrapDoc(patchedFm, newBodyText), targetSectionTextBefore };
}
