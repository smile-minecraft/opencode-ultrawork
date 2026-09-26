/**
 * opencode-ultrawork — content 檔的行級 grep（內容工具設計）
 *
 * literal 預設、`regex` opt-in、結果有上限、每筆帶 section selector + 行號 + 前後文。
 * 非語意搜尋。在 canonical body（去 frontmatter、LF）上執行，行號為 body 內 1-based。
 */

import { lineFenceState } from "../core/markdown-fence.ts";

export interface GrepMatch {
  /** 所屬 section 的 selector（H2/H3 標題文字、或 `task:<id>`）；檔首在任何標題前 → null。 */
  selector: string | null;
  /** body 內 1-based 行號。 */
  line: number;
  text: string;
  before: string[];
  after: string[];
}

export interface GrepResult {
  matches: GrepMatch[];
  matchCount: number;
  truncated: boolean;
}

export interface GrepOptions {
  pattern: string;
  regex?: boolean;
  context?: number;
  maxMatches?: number;
  /**
   * 只在 body 的這個行區間內搜（`[start, end)`，0-based，對應 `findSectionBounds`
   * 的 bounds）。行號、selector、前後文仍以**完整 body** 為準——縮範圍不改座標。
   */
  within?: [number, number];
}

const MAX_CONTEXT = 10;
const HARD_MAX_MATCHES = 200;

/** 逐行掃出「這一行屬於哪個 section」。fence 內的標題不算。 */
function sectionAtLine(lines: string[], fence: boolean[]): (string | null)[] {
  const out: (string | null)[] = new Array(lines.length).fill(null);
  let current: string | null = null;
  const headingCounts = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    if (!fence[i]) {
      const task = /^###\s+task:\s+(\S+)\s*$/.exec(lines[i]!.trim());
      const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(lines[i]!);
      if (task) {
        current = `task:${task[1]}`;
      } else if (heading) {
        const level = heading[1]!.length;
        const title = heading[2]!.trim();
        if (level === 1) {
          current = null; // H1 = 檔標題，重置
        } else if (!title.startsWith("task:")) {
          const occ = headingCounts.get(title) ?? 0;
          headingCounts.set(title, occ + 1);
          current = occ === 0 ? title : `${title}[${occ}]`;
        }
      }
    }
    out[i] = current;
  }
  return out;
}

export function grepContent(body: string, opts: GrepOptions): GrepResult | { error: string; code: string } {
  const context = Math.max(0, Math.min(opts.context ?? 2, MAX_CONTEXT));
  const maxMatches = Math.max(1, Math.min(opts.maxMatches ?? 20, HARD_MAX_MATCHES));

  let test: (line: string) => boolean;
  if (opts.regex) {
    let re: RegExp;
    try {
      re = new RegExp(opts.pattern);
    } catch (err) {
      return { code: "GREP_BAD_REGEX", error: `regex 無法編譯：${err instanceof Error ? err.message : String(err)}` };
    }
    test = (line) => re.test(line);
  } else {
    const needle = opts.pattern;
    test = (line) => line.includes(needle);
  }

  const lines = body.split("\n");
  const fence = lineFenceState(lines);
  const sections = sectionAtLine(lines, fence);

  const lo = opts.within ? Math.max(0, opts.within[0]) : 0;
  const hi = opts.within ? Math.min(lines.length, opts.within[1]) : lines.length;

  const matches: GrepMatch[] = [];
  let matchCount = 0;
  for (let i = lo; i < hi; i++) {
    if (!test(lines[i]!)) continue;
    matchCount++;
    if (matches.length >= maxMatches) continue;
    matches.push({
      selector: sections[i]!,
      line: i + 1,
      text: lines[i]!,
      before: lines.slice(Math.max(0, i - context), i),
      after: lines.slice(i + 1, Math.min(lines.length, i + 1 + context)),
    });
  }

  return { matches, matchCount, truncated: matchCount > matches.length };
}
