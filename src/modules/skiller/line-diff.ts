/**
 * opencode-ultrawork — 行級最小差異（LCS）＋ 多 hunk unified 輸出
 *
 * content 工具的 `preview` 用它產生給人看的 diff。共同前綴／後綴快速路徑把 LCS
 * 規模壓到真正變動的中段；輸出切成多個 `@@` hunk（frontmatter 的一行變更與正文
 * 的變更會落在各自的 hunk，行號正確），輸出行數有硬上限。
 */

export interface LineDiffOptions {
  /** 每個 hunk 前後保留的 context 行數（預設 3）。 */
  context?: number;
  /** 輸出行數硬上限（超過就截斷，預設 400）。 */
  maxLines?: number;
}

type Edit = { tag: " " | "-" | "+"; line: string; a: number; b: number };

/** 對 a[lo..ahi) / b[lo..bhi) 做 LCS 回溯，產生帶「原始行號」的編輯序列。 */
function diffRange(a: string[], b: string[], aLo: number, aHi: number, bLo: number, bHi: number): Edit[] {
  const m = aHi - aLo;
  const n = bHi - bLo;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[aLo + i] === b[bLo + j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[aLo + i] === b[bLo + j]) {
      edits.push({ tag: " ", line: a[aLo + i]!, a: aLo + i, b: bLo + j });
      i++; j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      edits.push({ tag: "-", line: a[aLo + i]!, a: aLo + i, b: bLo + j });
      i++;
    } else {
      edits.push({ tag: "+", line: b[bLo + j]!, a: aLo + i, b: bLo + j });
      j++;
    }
  }
  while (i < m) { edits.push({ tag: "-", line: a[aLo + i]!, a: aLo + i, b: bLo + j }); i++; }
  while (j < n) { edits.push({ tag: "+", line: b[bLo + j]!, a: aLo + i, b: bLo + j }); j++; }
  return edits;
}

/**
 * 產生 `before` → `after` 的多 hunk unified-style 行 diff（給人看，非嚴格 patch）。
 * 無變更回 `"(no change)"`。
 */
export function unifiedLineDiff(before: string, after: string, opts: LineDiffOptions = {}): string {
  if (before === after) return "(no change)";
  const context = Math.max(0, opts.context ?? 3);
  const maxLines = Math.max(20, opts.maxLines ?? 400);

  const a = before.split("\n");
  const b = after.split("\n");

  // 共同前綴／後綴：只對中段跑 LCS
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) suf++;

  // 完整編輯序列：前綴 context + 中段 LCS + 後綴 context（都帶原始行號）
  const edits: Edit[] = [];
  for (let k = 0; k < pre; k++) edits.push({ tag: " ", line: a[k]!, a: k, b: k });
  edits.push(...diffRange(a, b, pre, a.length - suf, pre, b.length - suf));
  for (let k = 0; k < suf; k++) {
    const ai = a.length - suf + k;
    edits.push({ tag: " ", line: a[ai]!, a: ai, b: b.length - suf + k });
  }

  // 找出「變更區塊」的索引區間，向外擴 context，重疊 / 間距 ≤ 2*context 的合併
  const changeIdx = edits.map((e, i) => (e.tag === " " ? -1 : i)).filter((i) => i >= 0);
  if (changeIdx.length === 0) return "(no change)";

  const groups: Array<[number, number]> = [];
  let gs = changeIdx[0]!;
  let ge = changeIdx[0]!;
  for (const idx of changeIdx.slice(1)) {
    if (idx - ge <= context * 2) {
      ge = idx;
    } else {
      groups.push([gs, ge]);
      gs = idx;
      ge = idx;
    }
  }
  groups.push([gs, ge]);

  const out: string[] = [];
  for (const [start, end] of groups) {
    const lo = Math.max(0, start - context);
    const hi = Math.min(edits.length - 1, end + context);
    const slice = edits.slice(lo, hi + 1);
    const firstA = slice.find((e) => e.tag !== "+")?.a ?? slice[0]!.a;
    const firstB = slice.find((e) => e.tag !== "-")?.b ?? slice[0]!.b;
    const aCount = slice.filter((e) => e.tag !== "+").length;
    const bCount = slice.filter((e) => e.tag !== "-").length;
    out.push(`@@ -${firstA + 1},${aCount} +${firstB + 1},${bCount} @@`);
    for (const e of slice) out.push(`${e.tag} ${e.line}`);
    if (out.length > maxLines) {
      return out.slice(0, maxLines).join("\n") + `\n… (diff 截斷，共 ${groups.length} 個變更區塊)`;
    }
  }
  return out.join("\n");
}
