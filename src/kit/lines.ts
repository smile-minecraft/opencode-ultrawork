/**
 * 行號輸出：逐行資料排成「行號＋標記＋原文」，一行一列。
 *
 * 比每行包物件省 token；標記沿用 ripgrep 慣例，命中行用 :，前後文用 -。
 */

export interface NumberedLine {
  line: number;
  text: string;
}

export function formatNumberedLines(lines: ReadonlyArray<NumberedLine>, marker = ":"): string {
  return lines.map(({ line, text }) => `${line}${marker} ${text}`).join("\n");
}

/** 超長行截斷，避免單行灌爆輸出。 */
export function truncateLine(value: string, maximum = 1000): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum - 1)}…`;
}
