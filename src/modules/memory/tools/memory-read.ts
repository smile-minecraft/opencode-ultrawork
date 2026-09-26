/**
 * `memory-read`：所有 agent 可用，讀取一個主題的全文與 sha（企劃書第 7.3 節）。
 * 回傳的 `sha256` 給 memory-write 的 `expectedSha256` 用；成功讀取會累加使用次數。
 */

import { z } from "zod";
import { readTopic } from "../topic.ts";
import { recordRead } from "../usage.ts";
import { layerSchema, memoryTool, resolveLayers, type MemoryToolDeps } from "./shared.ts";

const inputSchema = z.object({ layer: layerSchema, topic: z.string() });

export function createMemoryReadTool(deps: MemoryToolDeps) {
  return memoryTool(
    "memory-read",
    "讀取一個記憶主題的 frontmatter、正文與 sha256（寫入時的 expectedSha256 用這個值）。",
    inputSchema,
    async (input, context) => {
      const layer = (await resolveLayers(deps, context, input.layer))[0]!;
      const { raw: _raw, ...topic } = readTopic(layer, input.topic);
      const warnings = await recordRead(layer, input.topic);
      return { ok: true, layer: layer.layer, ...topic, ...(warnings.length > 0 ? { warnings } : {}) };
    },
  );
}
