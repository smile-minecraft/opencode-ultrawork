/**
 * `memory-maintain`：memorizer 專用的記憶維護（企劃書第 7.7 節）。
 *
 * - report（唯讀）：列出超過預算、可能過時、太久沒用、引用路徑失效、可能重複、
 *   未整理筆記、hash 鏈斷裂、工具外修改、索引不一致，每項附建議動作。
 * - dismiss-notes：略過不值得整理的筆記，理由進 log。
 * - reseal-log：hash 鏈斷裂或主題被工具外修改後，人為確認「目前的內容是對的」，
 *   記下每個主題現在的 sha 當新基準。理由進 log 供稽核。
 */

import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { z } from "zod";
import { queryTerms } from "../../../kit/text-search.ts";
import { STALE_DAYS, UNUSED_DAYS, budgetForLayer, type MemoryBudgets, type MemoryLayerBudget } from "../constants.ts";
import { mismatchedTopics } from "../disposition.ts";
import { renderIndex } from "../index-render.ts";
import { MemoryError, memoryPath, readOptional, withMemoryLock, type MemoryLayer } from "../layers.ts";
import { appendLog, pendingNotes, readLog, verifyLog } from "../log.ts";
import { listTopics } from "../topic.ts";
import { readUsage, type Usage } from "../usage.ts";
import { allLayersSchema, identity, memoryTool, requireWriter, resolveLayers, type MemoryToolDeps } from "./shared.ts";

const DAY_MS = 86_400_000;
/** title＋description 切詞後的重疊率達到這個值，就列為可能重複。 */
const DUPLICATE_OVERLAP = 0.6;

export interface MaintenanceIssue {
  kind: string;
  topic?: string;
  detail: string;
  action: string;
}

/** 一層的維護報告（唯讀）；doctor 不直接用它，memorizer 透過 report 模式取得。 */
export function maintenanceReport(layer: MemoryLayer, budgets?: MemoryBudgets) {
  const budget: MemoryLayerBudget = budgetForLayer(budgets, layer.layer);
  const topics = listTopics(layer);
  const entries = readLog(layer);
  const index = renderIndex(topics, layer.layer);
  const warnings: string[] = [];
  let usage: Record<string, Usage> = {};
  try {
    usage = readUsage(layer);
  } catch {
    warnings.push("usage.json 無法讀取，「太久沒用」的判斷改以建立時間計算，請檢查檔案格式。");
  }

  const issues: MaintenanceIssue[] = [];
  const add = (kind: string, detail: string, action: string, topic?: string) =>
    issues.push({ kind, detail, action, ...(topic ? { topic } : {}) });

  if (index.length > budget.indexCharLimit) add("index-budget", `索引 ${index.length} 字元，超過 ${budget.indexCharLimit}`, "合併主題或精簡 description");
  if (budget.maxTopics > 0 && topics.length > budget.maxTopics) {
    add("topic-count", `主題 ${topics.length} 個，超過上限 ${budget.maxTopics}`, "合併或封存主題；既有主題不會自動刪除");
  }
  if (topics.length > 0 && readOptional(memoryPath(layer, "MEMORY.md")) !== index) {
    add("index-mismatch", "MEMORY.md 與主題內容不一致", "下一次 memory-write 會重建索引");
  }
  if (!verifyLog(entries)) add("log-integrity", "記憶紀錄的 hash 鏈斷裂", "確認主題內容無誤後用 reseal-log");
  for (const topic of mismatchedTopics(layer, entries, topics.map((item) => item.topic))) {
    add("out-of-band-edit", "主題檔的 sha 對不上最後一筆寫入紀錄", "核對內容，確認無誤後用 reseal-log", topic);
  }

  const now = Date.now();
  for (const topic of topics) {
    if (topic.size > budget.topicCharLimit) add("topic-budget", `主題 ${topic.size} 字元，超過 ${budget.topicCharLimit}`, "拆成較小的主題", topic.topic);
    const verifiedAt = Date.parse(topic.frontmatter.verified_at || topic.frontmatter.updated);
    if (now - verifiedAt > STALE_DAYS * DAY_MS) add("stale", `超過 ${STALE_DAYS} 天沒有核對`, "查證現況後用 memory-write 的 verify 或 update", topic.topic);
    const lastRead = Date.parse(usage[topic.topic]?.lastReadAt ?? topic.frontmatter.created);
    if (now - lastRead > UNUSED_DAYS * DAY_MS) add("unused", `超過 ${UNUSED_DAYS} 天沒有被讀`, "評估是否封存", topic.topic);
    // 引用路徑只對專案層檢查：反引號包住、含 `/` 且有副檔名的字串，相對專案根目錄找不到。
    if (layer.layer === "project") {
      for (const match of topic.body.matchAll(/`([^`\n]+)`/g)) {
        const path = match[1]!;
        if (path.includes("/") && extname(path) && !existsSync(resolve(layer.root, path))) {
          add("missing-path", path, "核對並更新引用路徑", topic.topic);
        }
      }
    }
  }

  const termSets = topics.map((topic) => new Set(queryTerms(`${topic.frontmatter.title} ${topic.frontmatter.description}`)));
  for (let i = 0; i < topics.length; i += 1) {
    for (let j = i + 1; j < topics.length; j += 1) {
      const shared = [...termSets[i]!].filter((term) => termSets[j]!.has(term)).length;
      const union = new Set([...termSets[i]!, ...termSets[j]!]).size;
      if (shared / Math.max(1, union) >= DUPLICATE_OVERLAP) {
        add("duplicate", `${topics[i]!.topic} / ${topics[j]!.topic}`, "評估是否合併");
      }
    }
  }

  const notes = pendingNotes(entries);
  if (notes.length > 0) add("pending-notes", `${notes.length} 筆未整理的筆記`, "整理進主題（consumesNotes）或用 dismiss-notes 略過");

  return {
    layer: layer.layer,
    indexChars: index.length,
    indexLimit: budget.indexCharLimit,
    topics: topics.length,
    pinned: topics.filter((topic) => topic.frontmatter.pinned).length,
    issues,
    notes,
    warnings,
  };
}

const inputSchema = z.object({
  mode: z.enum(["report", "dismiss-notes", "reseal-log"]),
  layer: allLayersSchema.optional(),
  noteSeqs: z.array(z.number().int().positive()).optional(),
  reason: z.string().optional(),
});

export function createMemoryMaintainTool(deps: MemoryToolDeps) {
  return memoryTool(
    "memory-maintain",
    "（限 memorizer）report：檢查預算、時效、使用情況、重複、未整理筆記與紀錄完整性；dismiss-notes：附理由略過筆記；reseal-log：確認目前內容無誤後，以現況為新基準修復斷裂的紀錄。",
    inputSchema,
    async (input, context) => {
      requireWriter(deps, context);
      const layers = await resolveLayers(deps, context, input.layer);
      if (input.mode === "report") {
        return {
          ok: true,
          layers: layers.map((layer) => maintenanceReport(layer, deps.budgets)),
        };
      }

      if (!input.reason?.trim()) throw new MemoryError("REASON_REQUIRED", "dismiss-notes 與 reseal-log 都必須提供 reason。");
      if (input.mode === "dismiss-notes" && !input.noteSeqs?.length) {
        throw new MemoryError("INVALID_NOTE_REFERENCE", "請用 noteSeqs 指定要略過的筆記。");
      }

      const results = [];
      for (const layer of layers) {
        results.push(
          await withMemoryLock(layer, () => {
            if (input.mode === "dismiss-notes") {
              const pending = pendingNotes(readLog(layer));
              if (input.noteSeqs!.some((seq) => !pending.some((note) => note.seq === seq))) {
                throw new MemoryError("INVALID_NOTE_REFERENCE", "筆記必須存在且尚未整理；筆記在哪一層就指定哪一層。");
              }
              const entries = appendLog(
                layer,
                input.noteSeqs!.map((noteSeq) => ({ kind: "note-dismissed" as const, noteSeq, reason: input.reason, ...identity(context) })),
              );
              return { layer: layer.layer, entries };
            }
            const shas = Object.fromEntries(listTopics(layer).map((topic) => [topic.topic, topic.sha256]));
            const entries = appendLog(layer, [{ kind: "reseal", reason: input.reason, shas, ...identity(context) }]);
            return { layer: layer.layer, entries };
          }),
        );
      }
      return { ok: true, layers: results };
    },
  );
}
