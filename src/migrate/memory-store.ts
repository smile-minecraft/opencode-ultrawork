/**
 * `project.md`／`receipts/` → 分層記憶的自動遷移（企劃書第 10 節）。
 *
 * 觸發點有兩個：外掛啟動時（在 `.opencode/` 搬遷之後）對專案層跑一次，以及記憶工具、
 * context 注入第一次存取某個根目錄時。工作階段位置可以跟外掛實例位置不同，只在啟動時
 * 跑會漏掉。全域層沒有 `project.md`，從空的開始；兩層共用資料夾時就是同一次遷移。
 *
 * 規則：
 * - `project.md` 的 H1 與第一個 H2 之前的內容 → 主題 `overview`；每個 H2 段落 → 一個主題。
 *   code fence 裡的 `##` 不算標題。遷移不受預算限制，超大段落照樣寫入，交給 doctor 回報。
 * - 目前在 ARCHIVING、而且收據通過舊版檢查規則的任務，轉成 `legacy-receipt` 處置，
 *   升級當下正在收尾的任務才不會被卡住。其他收據不轉換。
 * - 舊檔改名成 `<原名>.migrated-<時間戳>` 保留，永不刪除；目標已存在就加
 *   `-2`、`-3`…找下一個未被占用的名稱，絕不覆蓋既有檔案。
 * - 任一步失敗就停止、不寫標記；下次觸發重跑時，已存在的主題跳過不覆寫，可以冪等收斂。
 * - 沿路任何一段是 symlink 就整段失敗（`assertContainedPath`），不讀層外的資料。
 */

import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "../kit/atomic-write.ts";
import { assertContainedPath } from "../kit/path-guard.ts";
import { renderIndex } from "../modules/memory/index-render.ts";
import { memoryLayer, memoryPath, readOptional, withMemoryLock } from "../modules/memory/layers.ts";
import { appendLog, readLog } from "../modules/memory/log.ts";
import { lineFenceState } from "../modules/memory/markdown-fence.ts";
import { listTopics, renderTopic, sha256 } from "../modules/memory/topic.ts";

export const MEMORY_MIGRATION_MARKER = ".migrated-from-project-md.json";

const SLUG_MAX_LENGTH = 48;
const DESCRIPTION_MAX_LENGTH = 120;

/**
 * 封存改名可用的候選上限（含不帶後綴的原本名稱）。時間戳精確到毫秒，
 * 自然碰撞幾乎不可能；這個上限只防預先占位的極端情況，用完就讓遷移
 * 失敗（不寫標記、下次重試），絕不退化成覆蓋。
 */
const MAX_ARCHIVE_CANDIDATES = 100;

/** 找下一個未被占用的封存名稱：先試原本名稱，再試 `-2`、`-3`…。 */
function uniqueArchivePath(root: string, path: string, timestamp: string): string {
  const base = `${path}.migrated-${timestamp}`;
  let archive = assertContainedPath(root, base);
  let suffix = 2;
  while (existsSync(archive)) {
    if (suffix > MAX_ARCHIVE_CANDIDATES) {
      throw new Error(`封存目標 ${archive} 已存在且候選名稱已用完，遷移中止以免覆蓋既有檔案。`);
    }
    archive = assertContainedPath(root, `${base}-${suffix}`);
    suffix++;
  }
  return archive;
}

/** 最近一次遷移失敗的原因（依根目錄）；doctor 用它回報，成功後清掉。 */
const failures = new Map<string, string>();

export function memoryMigrationFailure(root: string): string | undefined {
  return failures.get(root);
}

export interface LegacyMemoryChunk {
  title: string;
  body: string;
  topic: string;
}

/** 標題轉 slug：ASCII 英數字轉小寫，其他換成 `-`；純中文標題取 sha 前 8 碼。 */
function slugFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-$/g, "");
  return slug || `topic-${sha256(title).slice(0, 8)}`;
}

/** 把 `project.md` 拆成主題；frontmatter 丟掉，重複的 slug 加 `-2`、`-3`。 */
export function splitLegacyMemory(raw: string): LegacyMemoryChunk[] {
  const lines = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").split(/\r?\n/);
  const inFence = lineFenceState(lines);
  const chunks: LegacyMemoryChunk[] = [];
  const used = new Set<string>();
  let title = "專案概觀";
  let body: string[] = [];
  let isOverview = true;

  const flush = () => {
    const text = body.join("\n").trim();
    if (!text) return;
    const base = isOverview ? "overview" : slugFromTitle(title);
    let topic = base;
    for (let suffix = 2; used.has(topic); suffix += 1) topic = `${base}-${suffix}`;
    used.add(topic);
    chunks.push({ title, body: `${text}\n`, topic });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!inFence[index]) {
      const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
      if (h2) {
        flush();
        title = h2[1]!;
        body = [];
        isOverview = false;
        continue;
      }
      // 前言裡的 H1 當成 overview 的標題，不重複放進正文。
      const h1 = isOverview ? /^#\s+(.+?)\s*#*\s*$/.exec(line) : null;
      if (h1) {
        title = h1[1]!;
        continue;
      }
    }
    body.push(line);
  }
  flush();
  return chunks;
}

/** 正文第一個非空行去掉 markdown 符號，當作 description。 */
function describe(chunk: LegacyMemoryChunk): string {
  const firstLine = chunk.body.split("\n").find((line) => line.trim()) ?? chunk.title;
  const cleaned = firstLine.replace(/[#*`>[\]]/g, "").replace(/^\s*[-+]\s+/, "").trim();
  return (cleaned || chunk.title).slice(0, DESCRIPTION_MAX_LENGTH);
}

interface LegacyTaskRegistry {
  projectId?: string;
  projectPath?: string;
  tasks?: Record<string, { taskId: string; state: string }>;
}

/**
 * 舊版 `validateReceiptForCompletion` 的規則（舊檔已移除，只留遷移需要的部分）：
 * taskId 與專案綁定一致、status 是 ok／completed／success、createdAt 可解析、
 * 有 extraction 證據或 zeroExtractionReason。
 */
function isValidLegacyReceipt(raw: unknown, taskId: string, registry: LegacyTaskRegistry): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const receipt = raw as Record<string, unknown>;
  const hasEvidence =
    [receipt.extractionResults, receipt.extractions, receipt.createdCards, receipt.updatedCards].some(
      (value) => Array.isArray(value) && value.length > 0,
    ) ||
    (typeof receipt.zeroExtractionReason === "string" && receipt.zeroExtractionReason.trim() !== "");
  return (
    receipt.taskId === taskId &&
    typeof receipt.projectId === "string" &&
    receipt.projectId === registry.projectId &&
    typeof receipt.projectPath === "string" &&
    typeof registry.projectPath === "string" &&
    resolve(receipt.projectPath) === resolve(registry.projectPath) &&
    ["ok", "completed", "success"].includes(String(receipt.status).toLowerCase()) &&
    typeof receipt.createdAt === "string" &&
    Number.isFinite(Date.parse(receipt.createdAt)) &&
    hasEvidence
  );
}

/**
 * 確保這個根目錄的專案層已經遷移；回傳 true 代表可以使用新格式（已遷移或本來就沒有舊資料）。
 * 失敗時記下原因、輸出警告並回 false，不拋錯：記憶遷移不能讓外掛或工作階段失敗。
 */
export async function ensureMemoryStoreMigrated(root: string): Promise<boolean> {
  try {
    const layer = memoryLayer(root);
    const marker = memoryPath(layer, MEMORY_MIGRATION_MARKER);
    if (existsSync(marker)) return true;
    return await withMemoryLock(layer, () => {
      // 拿到鎖之後再看一次：另一個伺服器可能剛做完。
      if (existsSync(marker)) return true;
      const projectMd = assertContainedPath(root, join(root, ".ultrawork", "project.md"));
      const receiptsDir = assertContainedPath(root, join(root, ".ultrawork", "receipts"));
      const raw = readOptional(projectMd);
      const at = new Date().toISOString();
      const timestamp = at.replace(/[:.]/g, "-");
      const topics: string[] = [];
      const converted: string[] = [];
      const archives: string[] = [];

      if (raw !== null) {
        mkdirSync(memoryPath(layer, "topics"), { recursive: true });
        for (const chunk of splitLegacyMemory(raw)) {
          const target = memoryPath(layer, "topics", `${chunk.topic}.md`);
          if (existsSync(target)) {
            console.warn(`[ultrawork] 記憶遷移略過既有主題 ${chunk.topic}，不覆寫。`);
            continue;
          }
          const content = renderTopic(
            {
              title: chunk.title,
              description: describe(chunk),
              type: "reference",
              pinned: false,
              source: "migration",
              created: at,
              updated: at,
              verified_at: "",
            },
            chunk.body,
          );
          writeFileSync(target, content, { flag: "wx" });
          appendLog(layer, [{ kind: "migrate", topic: chunk.topic, afterSha: sha256(content), agent: "migration", sessionID: null }]);
          topics.push(chunk.topic);
        }
        atomicWriteFile(memoryPath(layer, "MEMORY.md"), renderIndex(listTopics(layer), layer.layer));
      }

      if (existsSync(receiptsDir)) {
        const registryPath = assertContainedPath(root, join(root, ".ultrawork", "tasks.json"));
        const registry = JSON.parse(readOptional(registryPath) ?? '{"tasks":{}}') as LegacyTaskRegistry;
        const existingLog = readLog(layer);
        for (const name of readdirSync(receiptsDir)) {
          if (!name.endsWith(".json")) continue;
          const path = assertContainedPath(root, join(receiptsDir, name));
          let receipt: Record<string, unknown> | null;
          try {
            receipt = JSON.parse(readOptional(path) ?? "null");
          } catch {
            continue;
          }
          if (!receipt || typeof receipt.taskId !== "string") continue;
          const task = registry.tasks?.[receipt.taskId];
          if (!task || task.state !== "ARCHIVING" || !isValidLegacyReceipt(receipt, task.taskId, registry)) continue;
          const receiptId = name.slice(0, -".json".length);
          // 重跑時不重複轉換同一份收據。
          const alreadyConverted = existingLog.some(
            (entry) => entry?.kind === "disposition" && entry.legacyReceiptId === receiptId,
          );
          if (!alreadyConverted) {
            appendLog(layer, [
              {
                kind: "disposition",
                outcome: "legacy-receipt",
                taskId: task.taskId,
                legacyReceiptId: receiptId,
                agent: "migration",
                sessionID: null,
              },
            ]);
          }
          converted.push(receiptId);
        }
      }

      for (const path of [projectMd, receiptsDir]) {
        if (!existsSync(path)) continue;
        const archive = uniqueArchivePath(root, path, timestamp);
        renameSync(path, archive);
        archives.push(archive.slice(root.length + 1));
      }
      atomicWriteFile(
        marker,
        JSON.stringify({ at, topics, converted, archives, noLegacyData: raw === null && archives.length === 0 }),
      );
      failures.delete(root);
      return true;
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failures.set(root, detail);
    console.warn(`[ultrawork] 記憶遷移失敗，下次存取時重試：${detail}`);
    return false;
  }
}

/** doctor 用：舊 `project.md` 還在但沒有遷移標記就是待遷移；附最近一次失敗原因。 */
export function inspectMemoryMigration(root: string): { pending: boolean; error?: string } {
  const pending =
    existsSync(join(root, ".ultrawork", "project.md")) &&
    !existsSync(join(root, ".ultrawork", "memory", MEMORY_MIGRATION_MARKER));
  return { pending, error: failures.get(root) };
}
