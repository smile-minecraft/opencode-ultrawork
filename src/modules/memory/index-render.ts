/**
 * 索引 `MEMORY.md` 的產生（企劃書第 4.4 節）。
 *
 * 索引完全由主題 frontmatter 決定，不手寫：它是衍生資料，缺檔或與主題不一致時，
 * 讀取端一律以重新產生的結果為準，不會有第二份真相。
 */

import type { LayerName } from "./layers.ts";
import type { Topic } from "./topic.ts";

/** 分組順序固定：先 pinned，再依類型；空的組不輸出。 */
const GROUPS = ["Pinned", "decision", "pitfall", "lesson", "reference", "preference"] as const;

/** `updated` 新到舊；同時間依 slug 排，讓輸出穩定（注入內容穩定才不會打壞 prefix cache）。 */
export function newestFirst(a: Topic, b: Topic): number {
  return b.frontmatter.updated.localeCompare(a.frontmatter.updated) || a.topic.localeCompare(b.topic);
}

export function renderIndex(topics: Topic[], layer: LayerName): string {
  const lines = [`# 記憶索引（${layer === "project" ? "專案" : "全域"}層）`];
  for (const group of GROUPS) {
    const members = topics
      .filter((topic) =>
        group === "Pinned"
          ? topic.frontmatter.pinned
          : !topic.frontmatter.pinned && topic.frontmatter.type === group,
      )
      .sort(newestFirst);
    if (members.length === 0) continue;
    lines.push("", `## ${group}`);
    for (const topic of members) {
      // 標題裡的方括號會弄壞 markdown 連結，去掉即可，不影響辨識。
      const title = topic.frontmatter.title.replace(/[[\]]/g, "");
      lines.push(`- [${title}](topics/${topic.topic}.md) — ${topic.frontmatter.description}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
