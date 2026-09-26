/**
 * `memory-search` 的評分（企劃書第 7.2 節）。
 *
 * 切詞沿用 skills 模組的 `queryTerms`（中文補兩字片段），每個 term 各自累加：
 * slug 完全相同 +20、title 命中 +8、description 命中 +4、正文命中 +1（每個主題
 * 正文分數上限 10，避免長文靠字數贏過標題命中）。同分時 pinned 排前面。
 */

import { containsTerm, queryTerms } from "../../kit/text-search.ts";
import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from "./constants.ts";
import type { LayerName, MemoryLayer } from "./layers.ts";
import { listTopics, type TopicFrontmatter, type TopicType } from "./topic.ts";

const SNIPPET_RADIUS = 80;
const BODY_SCORE_CAP = 10;

export interface MemorySearchResult extends TopicFrontmatter {
  layer: LayerName;
  topic: string;
  score: number;
  /** 正文第一個命中處前後各 80 字元；沒命中正文時取開頭。 */
  snippet: string;
}

export function searchMemory(
  layers: MemoryLayer[],
  query: string,
  type?: TopicType,
  limit = SEARCH_DEFAULT_LIMIT,
): MemorySearchResult[] {
  const terms = queryTerms(query);
  const results = layers.flatMap((layer) =>
    listTopics(layer)
      .filter((topic) => !type || topic.frontmatter.type === type)
      .map((topic) => {
        const body = topic.body.toLowerCase();
        let score = 0;
        let bodyHits = 0;
        let firstHit = -1;
        for (const term of terms) {
          if (topic.topic === term) score += 20;
          if (containsTerm(topic.frontmatter.title.toLowerCase(), term)) score += 8;
          if (containsTerm(topic.frontmatter.description.toLowerCase(), term)) score += 4;
          if (containsTerm(body, term)) {
            bodyHits += 1;
            const position = body.indexOf(term);
            if (position >= 0 && (firstHit < 0 || position < firstHit)) firstHit = position;
          }
        }
        const snippet =
          firstHit < 0
            ? topic.body.slice(0, SNIPPET_RADIUS * 2)
            : topic.body.slice(Math.max(0, firstHit - SNIPPET_RADIUS), firstHit + SNIPPET_RADIUS);
        return {
          layer: layer.layer,
          topic: topic.topic,
          ...topic.frontmatter,
          score: score + Math.min(BODY_SCORE_CAP, bodyHits),
          snippet,
        };
      }),
  );
  return results
    .filter((result) => result.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.pinned) - Number(a.pinned) ||
        b.updated.localeCompare(a.updated) ||
        a.topic.localeCompare(b.topic),
    )
    .slice(0, Math.min(SEARCH_MAX_LIMIT, limit));
}
