/**
 * `memory-write`：memorizer 專用，建立、更新、封存或核對一個主題（企劃書第 7.6 節）。
 *
 * - preview（預設）：不寫檔、不取鎖，回傳渲染結果、寫入後的索引大小，以及所有會擋下
 *   apply 的問題（一次列出，不要讓 memorizer 一個一個撞）。
 * - apply：在該層的鎖內重做一次同樣的檢查，通過才寫主題、重建索引、附加 log。
 *
 * log 附加失敗時把主題與索引回復成寫入前的位元組：沒有 log 的寫入會被結案檢查
 * 當成工具外修改，寧可整筆失敗。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync } from "node:fs";
import { z } from "zod";
import { atomicWriteFile } from "../../../kit/atomic-write.ts";
import type { MemoryLayerBudget } from "../constants.ts";
import { renderIndex } from "../index-render.ts";
import { MemoryError, memoryPath, readOptional, withMemoryLock, type MemoryLayer } from "../layers.ts";
import { appendLog, pendingNotes, readLog } from "../log.ts";
import { containsSecret } from "../secrets.ts";
import {
  TOPIC_TYPES,
  listTopics,
  parseTopic,
  readTopic,
  renderTopic,
  sha256,
  validateSlug,
  type TopicFrontmatter,
} from "../topic.ts";
import { identity, layerSchema, budgetForDepsLayer, memoryTool, requireWriter, resolveLayers, type MemoryToolDeps } from "./shared.ts";

const inputSchema = z.object({
  layer: layerSchema,
  topic: z.string(),
  op: z.enum(["create", "update", "delete", "verify"]),
  title: z.string().optional(),
  description: z.string().optional(),
  type: z.enum(TOPIC_TYPES).optional(),
  pinned: z.boolean().optional(),
  body: z.string().optional(),
  taskId: z.string().optional(),
  consumesNotes: z.array(z.number().int().positive()).optional(),
  mode: z.enum(["preview", "apply"]).optional(),
  expectedSha256: z.string().optional(),
  reason: z.string().optional(),
});

type WriteInput = z.infer<typeof inputSchema>;

interface Issue {
  code: string;
  error: string;
}

interface PreparedWrite {
  path: string;
  /** 寫入前的檔案內容；主題不存在時為 null。 */
  before: string | null;
  /** 寫入後的檔案內容；delete 或渲染失敗時為 null。 */
  raw: string | null;
  index: string;
  pinned: number;
  issues: Issue[];
}

/** 算出寫入結果並收集所有問題；不寫任何檔案。preview 與 apply 共用。 */
function prepare(layer: MemoryLayer, input: WriteInput, budget: MemoryLayerBudget): PreparedWrite {
  validateSlug(input.topic);
  const path = memoryPath(layer, "topics", `${input.topic}.md`);
  const before = readOptional(path);
  const issues: Issue[] = [];
  const issue = (code: string, error: string) => issues.push({ code, error });

  if (input.op === "create" && before !== null) issue("TOPIC_EXISTS", "主題已經存在，請改用 op:\"update\"。");
  if (input.op !== "create" && before === null) issue("TOPIC_NOT_FOUND", "主題不存在，請先用 memory-search 確認名稱與層。");
  if (input.op !== "create" && before !== null && input.expectedSha256 !== sha256(before)) {
    issue("SHA_MISMATCH", "expectedSha256 與目前內容不符，請先用 memory-read 取得最新的 sha256。");
  }
  if (input.op === "delete" && !input.reason?.trim()) issue("REASON_REQUIRED", "封存主題必須提供 reason。");

  const consumed = input.consumesNotes ?? [];
  const pending = pendingNotes(readLog(layer));
  if (new Set(consumed).size !== consumed.length || consumed.some((seq) => !pending.some((note) => note.seq === seq))) {
    issue("INVALID_NOTE_REFERENCE", "consumesNotes 只能列同一層、尚未整理、不重複的筆記 seq。");
  }

  let frontmatter: TopicFrontmatter | undefined;
  let body = input.body ?? "";
  if (before !== null) {
    const current = readTopic(layer, input.topic);
    frontmatter = { ...current.frontmatter };
    body = input.body ?? current.body;
  }
  const now = new Date().toISOString();
  if (input.op === "create") {
    if (!input.title?.trim() || !input.description?.trim() || !input.type || !input.body?.trim()) {
      issue("INVALID_TOPIC_FORMAT", "create 必須提供 title、description、type 與 body。");
    }
    const source = input.taskId
      ? `task:${input.taskId}`
      : consumed.length > 0
        ? `note:${consumed[0]}`
        : "manual";
    frontmatter = {
      title: input.title ?? "",
      description: input.description ?? "",
      type: input.type ?? "reference",
      pinned: input.pinned ?? false,
      source,
      created: now,
      updated: now,
      verified_at: now,
    };
  } else if (frontmatter && input.op === "update") {
    // 沒給的欄位保留原值。
    if (input.title !== undefined) frontmatter.title = input.title;
    if (input.description !== undefined) frontmatter.description = input.description;
    if (input.type !== undefined) frontmatter.type = input.type;
    if (input.pinned !== undefined) frontmatter.pinned = input.pinned;
    frontmatter.updated = now;
    frontmatter.verified_at = now;
  } else if (frontmatter && input.op === "verify") {
    // 只更新核對時間，內容一字不動。
    frontmatter.verified_at = now;
    body = readTopic(layer, input.topic).body;
  }

  let raw = frontmatter && input.op !== "delete" ? renderTopic(frontmatter, body) : null;
  if (raw !== null) {
    if (raw.length > budget.topicCharLimit) issue("TOPIC_TOO_LARGE", `主題超過 ${budget.topicCharLimit} 字元，請拆成較小的主題。`);
    if (frontmatter!.description.length > budget.descriptionCharLimit) {
      issue("DESCRIPTION_TOO_LONG", `description 不得超過 ${budget.descriptionCharLimit} 字元。`);
    }
    try {
      parseTopic(input.topic, raw);
    } catch {
      issue("INVALID_TOPIC_FORMAT", "frontmatter 的每個欄位都必須是合法的單行值。");
      raw = null;
    }
    // 訊息不回顯命中的內容本身。
    if (raw !== null && containsSecret(raw)) issue("SECRET_DETECTED", "內容含有疑似 secret，請移除敏感資訊。");
  }

  const topics = listTopics(layer).filter((topic) => topic.topic !== input.topic);
  // 主題數上限只擋「新增」：更新、核對、封存不增減數量，既有超標的主題
  // 不刪除也不自動裁減，只擋新的寫入並由診斷提示。
  if (input.op === "create" && before === null && budget.maxTopics > 0 && topics.length >= budget.maxTopics) {
    issue("TOPIC_LIMIT_EXCEEDED", `該層已有 ${topics.length} 個主題，達到上限 ${budget.maxTopics}，請先合併或封存既有主題再新增。`);
  }
  if (raw !== null) topics.push(parseTopic(input.topic, raw));
  const index = renderIndex(topics, layer.layer);
  const pinned = topics.filter((topic) => topic.frontmatter.pinned).length;
  if (pinned > budget.pinnedLimit) issue("PINNED_LIMIT_EXCEEDED", `每層最多 ${budget.pinnedLimit} 個 pinned 主題。`);
  if (index.length > budget.indexCharLimit) {
    issue("INDEX_BUDGET_EXCEEDED", `寫入後索引會超過 ${budget.indexCharLimit} 字元，請先合併或精簡既有主題的 description。`);
  }
  return { path, before, raw, index, pinned, issues };
}

function removeIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function createMemoryWriteTool(deps: MemoryToolDeps) {
  return memoryTool(
    "memory-write",
    "（限 memorizer）建立、更新、封存（delete）或核對（verify）一個記憶主題。預設 preview 只回報結果與問題；apply 時 update／delete／verify 要帶 memory-read 取得的 expectedSha256。為任務寫入時帶 taskId，整理掉的筆記用 consumesNotes。",
    inputSchema,
    async (input, context) => {
      requireWriter(deps, context);
      const layer = (await resolveLayers(deps, context, input.layer))[0]!;
      const budget = budgetForDepsLayer(deps, layer.layer);
      if (input.mode !== "apply") {
        const preview = prepare(layer, input, budget);
        return {
          ok: true,
          mode: "preview",
          content: preview.raw,
          indexChars: preview.index.length,
          pinned: preview.pinned,
          issues: preview.issues,
        };
      }

      return withMemoryLock(layer, () => {
        const prepared = prepare(layer, input, budget);
        if (prepared.issues.length > 0) {
          throw new MemoryError(prepared.issues[0]!.code, prepared.issues[0]!.error, {
            issues: prepared.issues,
            sha256: prepared.before === null ? null : sha256(prepared.before),
          });
        }

        const indexPath = memoryPath(layer, "MEMORY.md");
        const previousIndex = readOptional(indexPath);
        let archivedPath: string | undefined;
        mkdirSync(memoryPath(layer, "topics"), { recursive: true });
        try {
          if (input.op === "delete") {
            // 封存而不刪除：使用者資料永不真的消失。
            mkdirSync(memoryPath(layer, "archive"), { recursive: true });
            archivedPath = memoryPath(layer, "archive", `${input.topic}.${Date.now()}-${randomUUID()}.md`);
            renameSync(prepared.path, archivedPath);
          } else {
            atomicWriteFile(prepared.path, prepared.raw!);
          }
          atomicWriteFile(indexPath, prepared.index);
          const entries = appendLog(layer, [
            {
              kind: "write",
              topic: input.topic,
              op: input.op,
              taskId: input.taskId,
              beforeSha: prepared.before === null ? null : sha256(prepared.before),
              afterSha: prepared.raw === null ? null : sha256(prepared.raw),
              reason: input.reason,
              ...identity(context),
            },
            ...(input.consumesNotes ?? []).map((noteSeq) => ({
              kind: "note-consumed" as const,
              noteSeq,
              taskId: input.taskId,
              ...identity(context),
            })),
          ]);
          return {
            ok: true,
            layer: layer.layer,
            topic: input.topic,
            op: input.op,
            sha256: prepared.raw === null ? null : sha256(prepared.raw),
            seq: entries[0]!.seq,
            indexChars: prepared.index.length,
          };
        } catch (error) {
          // 回復主題與索引，不留下沒有 log 的寫入。
          if (archivedPath) renameSync(archivedPath, prepared.path);
          else if (prepared.before !== null) atomicWriteFile(prepared.path, prepared.before);
          else removeIfExists(prepared.path);
          if (previousIndex !== null) atomicWriteFile(indexPath, previousIndex);
          else removeIfExists(indexPath);
          throw new MemoryError("MEMORY_LOG_WRITE_FAILED", "寫入失敗，主題與索引已回復原狀，請用 memory-maintain report 檢查紀錄與檔案權限。", {
            causeCode: (error as { code?: string }).code,
          });
        }
      });
    },
  );
}
