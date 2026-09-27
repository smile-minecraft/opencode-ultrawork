/**
 * `memory-note`：所有 agent 可用，記下工作途中值得保留的東西（企劃書第 7.4 節）。
 *
 * 主代理沒有寫記憶的權限，使用者糾正的做法、做出的決定、踩到的坑先記成筆記，
 * 由 memorizer 之後整理進主題。筆記是資料不是指令，記在 log 裡，狀態由後續的
 * note-consumed／note-dismissed 紀錄推導。
 */

import { z } from "zod";
import { MemoryError, withMemoryLock } from "../layers.ts";
import { appendLog } from "../log.ts";
import { containsSecret } from "../secrets.ts";
import { budgetForDepsLayer, identity, layerSchema, memoryTool, resolveLayers, type MemoryToolDeps } from "./shared.ts";

export function createMemoryNoteTool(deps: MemoryToolDeps) {
  // 兩層的上限可能不同，zod 只能用一個靜態值：取兩層較大者當輸入形狀，
  // 真正的把關在解析出層之後用該層的上限檢查（NOTE_TOO_LONG）。
  // 預設兩層都是內建值，輸入形狀與過去完全一致。
  const projectLimit = budgetForDepsLayer(deps, "project").noteCharLimit;
  const globalLimit = budgetForDepsLayer(deps, "global").noteCharLimit;
  const inputSchema = z.object({
    content: z.string().trim().min(1).max(Math.max(projectLimit, globalLimit)),
    layer: layerSchema.optional(),
    taskId: z.string().optional(),
  });
  return memoryTool(
    "memory-note",
    "記下工作途中值得保留的教訓（使用者糾正的做法、做出的決定、踩到的坑），交給 memorizer 之後整理。預設記在專案層；使用者偏好或跨專案的知識記在全域層。",
    inputSchema,
    async (input, context) => {
      if (containsSecret(input.content)) {
        throw new MemoryError("SECRET_DETECTED", "內容含有疑似 secret，請移除敏感資訊後再記錄。");
      }
      const layer = (await resolveLayers(deps, context, input.layer ?? "project"))[0]!;
      const limit = budgetForDepsLayer(deps, layer.layer).noteCharLimit;
      if (input.content.length > limit) {
        throw new MemoryError("NOTE_TOO_LONG", `筆記超過 ${limit} 字元，請精簡後再記錄。`);
      }
      const entry = await withMemoryLock(layer, () =>
        appendLog(layer, [{ kind: "note", content: input.content, taskId: input.taskId, ...identity(context) }])[0]!,
      );
      return { ok: true, seq: entry.seq };
    },
  );
}
