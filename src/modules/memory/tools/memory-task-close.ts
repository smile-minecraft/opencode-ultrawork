/**
 * `memory-task-close`：記錄任務的記憶結案處置（企劃書第 7.8 節）。
 *
 * - `none`：所有 agent 可用，但高風險任務限 writer agent；理由至少 8 個非空白字元；
 *   任務已有寫入紀錄時拒絕（應改用 recorded）。
 * - `recorded`：限 writer agent；工具自己從兩層 log 收集這個任務的寫入，一筆都沒有就拒絕。
 *
 * 任務必須在 ARCHIVING：處置一定寫在收尾之後，結案檢查會再驗一次時間。
 * 處置記在專案層 log；同一任務可重複呼叫，最後一筆為準。
 */

import { z } from "zod";
import { MemoryError, withMemoryLock } from "../layers.ts";
import { appendLog, readLog } from "../log.ts";
import { identity, memoryTool, requireWriter, resolveLayers, type MemoryToolDeps } from "./shared.ts";

const MIN_REASON_CHARS = 8;

const inputSchema = z.object({
  taskId: z.string(),
  outcome: z.enum(["recorded", "none"]),
  reason: z.string().optional(),
});

export function createMemoryTaskCloseTool(deps: MemoryToolDeps) {
  return memoryTool(
    "memory-task-close",
    "任務在 ARCHIVING 時記錄記憶結案處置，task-state-sync complete 前必須先做。沒有值得記的內容用 outcome:\"none\" 並附具體理由（高風險任務限 memorizer）；recorded 限 memorizer，會自動收集這個任務的寫入紀錄。",
    inputSchema,
    async (input, context) => {
      const layers = await resolveLayers(deps, context);
      const project = layers.find((layer) => layer.layer === "project")!;
      return withMemoryLock(project, async () => {
        const materials = await deps.taskMaterials(input.taskId, project.root, context);
        if (!materials) throw new MemoryError("TASK_NOT_FOUND", "目前專案找不到這個任務。");
        if (materials.task.state !== "ARCHIVING") {
          throw new MemoryError("TASK_NOT_ARCHIVING", "任務要先轉成 ARCHIVING 才能記錄記憶處置。");
        }
        if (input.outcome === "recorded" || materials.task.risk === "high") requireWriter(deps, context);

        const refs = layers.flatMap((layer) =>
          readLog(layer)
            .filter((entry) => entry?.kind === "write" && entry.taskId === input.taskId)
            .map((entry) => ({ layer: layer.layer, seq: entry!.seq })),
        );
        if (input.outcome === "recorded" && refs.length === 0) {
          throw new MemoryError("NO_WRITES_FOR_TASK", "這個任務還沒有記憶寫入，請先用 memory-write 寫入並帶上 taskId。");
        }
        if (input.outcome === "none") {
          if ((input.reason?.replace(/\s/g, "").length ?? 0) < MIN_REASON_CHARS) {
            throw new MemoryError("REASON_REQUIRED", `outcome 為 none 時，reason 至少要 ${MIN_REASON_CHARS} 個非空白字元，說清楚為什麼沒有值得記的內容。`);
          }
          if (refs.length > 0) {
            throw new MemoryError("DISPOSITION_CONFLICT", "這個任務已有記憶寫入紀錄，請改用 outcome:\"recorded\"。");
          }
        }

        const entry = appendLog(project, [
          {
            kind: "disposition",
            taskId: input.taskId,
            outcome: input.outcome,
            reason: input.reason,
            refs: input.outcome === "recorded" ? refs : undefined,
            ...identity(context),
          },
        ])[0]!;
        return { ok: true, taskId: input.taskId, outcome: input.outcome, seq: entry.seq, refs: entry.refs ?? [] };
      });
    },
  );
}
