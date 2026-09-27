/**
 * `memory-extract`：memorizer 專用、唯讀，收集萃取一個任務所需的材料（企劃書第 7.5 節）。
 *
 * 材料由外掛自己讀：任務正式紀錄、任務內容、關聯計畫、待整理筆記、候選既有主題、
 * 兩層預算，以及這個任務已有的寫入與處置。不靠主代理轉述，memorizer 看到的就是
 * 註冊檔裡的原始內容。
 */

import { z } from "zod";
import { EXTRACT_CONTENT_LIMIT } from "../constants.ts";
import { renderIndex } from "../index-render.ts";
import { MemoryError } from "../layers.ts";
import { pendingNotes, readLog } from "../log.ts";
import { searchMemory } from "../search.ts";
import { listTopics } from "../topic.ts";
import { budgetForDepsLayer, memoryTool, requireWriter, resolveLayers, type MemoryToolDeps } from "./shared.ts";

const PENDING_NOTE_LIMIT = 20;
const CANDIDATE_LIMIT = 8;
const CANDIDATE_QUERY_CHARS = 2000;

const inputSchema = z.object({ taskId: z.string() });

export function createMemoryExtractTool(deps: MemoryToolDeps) {
  return memoryTool(
    "memory-extract",
    "（限 memorizer）收集一個任務的正式紀錄、內容、關聯計畫、待整理筆記、候選既有主題與兩層預算，供萃取記憶使用。唯讀。",
    inputSchema,
    async (input, context) => {
      requireWriter(deps, context);
      const layers = await resolveLayers(deps, context);
      const root = layers.find((layer) => layer.layer === "project")!.root;
      const materials = await deps.taskMaterials(input.taskId, root, context);
      if (!materials) throw new MemoryError("TASK_NOT_FOUND", "目前專案找不到這個任務。");

      const content = materials.content ?? "";
      const logs = layers.map((layer) => ({ layer, entries: readLog(layer) }));
      const notes = logs
        .flatMap(({ layer, entries }) => pendingNotes(entries).map((note) => ({ ...note, layer: layer.layer })))
        .sort((a, b) => b.at.localeCompare(a.at));
      const query = `${materials.task.title ?? ""} ${content.slice(0, CANDIDATE_QUERY_CHARS)}`;

      return {
        ok: true,
        ...materials,
        content: content.slice(0, EXTRACT_CONTENT_LIMIT),
        truncated: content.length > EXTRACT_CONTENT_LIMIT,
        taskNotes: notes.filter((note) => note.taskId === input.taskId),
        pendingNotes: notes.slice(0, PENDING_NOTE_LIMIT),
        candidates: layers.flatMap((layer) => searchMemory([layer], query, undefined, CANDIDATE_LIMIT)),
        layers: logs.map(({ layer, entries }) => ({
          layer: layer.layer,
          indexChars: renderIndex(listTopics(layer), layer.layer).length,
          indexLimit: budgetForDepsLayer(deps, layer.layer).indexCharLimit,
          writes: entries.filter((entry) => entry?.taskId === input.taskId && entry.kind === "write"),
          disposition: entries.filter((entry) => entry?.taskId === input.taskId && entry.kind === "disposition").at(-1),
        })),
      };
    },
  );
}
