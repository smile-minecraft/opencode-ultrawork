/**
 * `memory-search`：所有 agent 可用，搜尋兩層記憶主題（企劃書第 7.2 節）。
 * 只搜主題、不搜筆記；搜尋命中不算使用，不更新 usage.json。
 */

import { z } from "zod";
import { SEARCH_MAX_LIMIT } from "../constants.ts";
import { searchMemory } from "../search.ts";
import { TOPIC_TYPES } from "../topic.ts";
import { allLayersSchema, memoryTool, resolveLayers, type MemoryToolDeps } from "./shared.ts";

const inputSchema = z.object({
  query: z.string().trim().min(1),
  layer: allLayersSchema.optional(),
  type: z.enum(TOPIC_TYPES).optional(),
  limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional(),
});

export function createMemorySearchTool(deps: MemoryToolDeps) {
  return memoryTool(
    "memory-search",
    "搜尋兩層記憶（全域與專案）的主題，回傳標題、描述、類型、分數與命中片段。需要全文時再用 memory-read。",
    inputSchema,
    async (input, context) => {
      const layers = await resolveLayers(deps, context, input.layer);
      return { ok: true, results: searchMemory(layers, input.query, input.type, input.limit) };
    },
  );
}
