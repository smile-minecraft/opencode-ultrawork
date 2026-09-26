/**
 * `memory-note`：所有 agent 可用，記下工作途中值得保留的東西（企劃書第 7.4 節）。
 *
 * 主代理沒有寫記憶的權限，使用者糾正的做法、做出的決定、踩到的坑先記成筆記，
 * 由 memorizer 之後整理進主題。筆記是資料不是指令，記在 log 裡，狀態由後續的
 * note-consumed／note-dismissed 紀錄推導。
 */

import { z } from "zod";
import { NOTE_CHAR_LIMIT } from "../constants.ts";
import { MemoryError, withMemoryLock } from "../layers.ts";
import { appendLog } from "../log.ts";
import { containsSecret } from "../secrets.ts";
import { identity, layerSchema, memoryTool, resolveLayers, type MemoryToolDeps } from "./shared.ts";

const inputSchema = z.object({
  content: z.string().trim().min(1).max(NOTE_CHAR_LIMIT),
  layer: layerSchema.optional(),
  taskId: z.string().optional(),
});

export function createMemoryNoteTool(deps: MemoryToolDeps) {
  return memoryTool(
    "memory-note",
    "記下工作途中值得保留的教訓（使用者糾正的做法、做出的決定、踩到的坑），交給 memorizer 之後整理。預設記在專案層；使用者偏好或跨專案的知識記在全域層。",
    inputSchema,
    async (input, context) => {
      if (containsSecret(input.content)) {
        throw new MemoryError("SECRET_DETECTED", "內容含有疑似 secret，請移除敏感資訊後再記錄。");
      }
      const layer = (await resolveLayers(deps, context, input.layer ?? "project"))[0]!;
      const entry = await withMemoryLock(layer, () =>
        appendLog(layer, [{ kind: "note", content: input.content, taskId: input.taskId, ...identity(context) }])[0]!,
      );
      return { ok: true, seq: entry.seq };
    },
  );
}
