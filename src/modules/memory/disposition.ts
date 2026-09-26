/**
 * 結案處置的查找與驗證（企劃書第 9 節）。
 *
 * workflow 的 `task-state-sync complete` 直接 import 這裡：本檔是葉節點，
 * 不得 import `src/modules/workflow/`，否則會跟 memory 模組形成循環。
 *
 * 證據全部來自工具寫下的 log，外掛不相信 agent 自己寫的任何說明：
 * 處置必須存在、在收尾之後寫下、高風險任務由 writer agent 寫、
 * `recorded` 引用的寫入真的存在、主題檔的現況跟 log 記錄的 sha 串得起來。
 */

import { readFileSync } from "node:fs";
import { memoryLayer, memoryPath, type LayerName, type MemoryLayer } from "./layers.ts";
import { readLog, validReseal, verifyLog, type LogEntry } from "./log.ts";
import { sha256, validateSlug } from "./topic.ts";

/** 任務的最後一筆結案處置（最後一筆為準，允許先宣告 none、之後補記改成 recorded）。 */
export function findTaskDisposition(projectRoot: string, taskId: string): LogEntry | undefined {
  return readLog(memoryLayer(projectRoot))
    .filter((entry) => entry?.kind === "disposition" && entry.taskId === taskId)
    .at(-1) ?? undefined;
}

function currentSha(layer: MemoryLayer, topic: string): string | null {
  try {
    return sha256(readFileSync(memoryPath(layer, "topics", `${topic}.md`)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 找出現況跟 log 對不上的主題（被工具外修改過）。
 *
 * 每個主題的預期 sha 取 log 中最後一筆 write／migrate 的 `afterSha`；遇到有效的
 * reseal，改以它記錄的 sha 為新基準（reseal 沒列到的主題預期為不存在）。
 * 不傳 `topics` 時檢查 log 裡出現過的所有主題。
 */
export function mismatchedTopics(layer: MemoryLayer, entries: (LogEntry | null)[], topics?: string[]): string[] {
  const expected = new Map<string, string | null>();
  for (const entry of entries) {
    if (!entry) continue;
    if (validReseal(entry)) {
      for (const key of expected.keys()) expected.set(key, null);
      for (const [key, value] of Object.entries(entry.shas!)) expected.set(key, value);
    } else if ((entry.kind === "write" || entry.kind === "migrate") && entry.topic && entry.afterSha !== undefined) {
      expected.set(entry.topic, entry.afterSha);
    }
  }
  return (topics ?? [...expected.keys()]).filter((topic) => {
    validateSlug(topic);
    return !expected.has(topic) || currentSha(layer, topic) !== expected.get(topic);
  });
}

export type DispositionResult = { ok: true; disposition: LogEntry } | { ok: false; code: string; error: string };

export interface VerifyTaskDispositionInput {
  projectRoot: string;
  /** 全域設定資料夾；跟專案根目錄相同時兩層視為一層。 */
  globalMemoryRoot: string;
  task: { taskId: string; risk?: string; archivingAt?: string };
  writerAgents: readonly string[];
}

/**
 * 依企劃書第 9.4 節的順序驗證，第一個失敗就回傳。任何讀檔或路徑守衛的例外都
 * fail closed 成 `MEMORY_LOG_TAMPERED`：證據讀不到就不能結案。
 */
export function verifyTaskDisposition(input: VerifyTaskDispositionInput): DispositionResult {
  const fail = (code: string, error: string): DispositionResult => ({ ok: false, code, error });
  try {
    const project = memoryLayer(input.projectRoot);
    const shared = project.directory === memoryLayer(input.globalMemoryRoot, "global").directory;
    const global = shared ? project : memoryLayer(input.globalMemoryRoot, "global");
    const layers: Record<LayerName, MemoryLayer> = { project, global };
    const projectLog = readLog(project);
    const logs: Record<LayerName, (LogEntry | null)[]> = { project: projectLog, global: shared ? projectLog : readLog(global) };

    // 1. 處置存在
    const disposition = logs.project
      .filter((entry) => entry?.kind === "disposition" && entry.taskId === input.task.taskId)
      .at(-1);
    if (!disposition) {
      return fail("MEMORY_DISPOSITION_REQUIRED", "這個任務還沒有記憶結案處置，請先呼叫 memory-task-close。");
    }
    const refs = disposition.outcome === "recorded" && Array.isArray(disposition.refs) ? disposition.refs : [];

    // 2. hash 鏈：從處置（recorded 則往前延伸到最早被引用的寫入）驗到尾端，兩層各自驗
    for (const name of (shared ? ["project"] : ["project", "global"]) as LayerName[]) {
      const seqs = refs.filter((ref) => (shared ? true : ref.layer === name)).map((ref) => ref.seq);
      if (name === "project") seqs.push(disposition.seq);
      if (seqs.length > 0 && !verifyLog(logs[name], Math.min(...seqs))) {
        return fail("MEMORY_LOG_TAMPERED", "記憶紀錄的 hash 鏈斷裂，請派 memorizer 用 memory-maintain report 檢查，確認內容後用 reseal-log 復原。");
      }
    }

    // 3. 處置不得早於本次收尾
    const at = Date.parse(disposition.at);
    if (!Number.isFinite(at) || (input.task.archivingAt && at < Date.parse(input.task.archivingAt))) {
      return fail("MEMORY_DISPOSITION_STALE", "記憶處置早於任務進入 ARCHIVING 的時間，請重新呼叫 memory-task-close。");
    }

    // 4. 遷移轉換的舊收據：升級前就已經在收尾的任務，直接放行
    if (disposition.outcome === "legacy-receipt" && disposition.agent === "migration") {
      return { ok: true, disposition };
    }

    // 5. 高風險任務只接受 writer agent 的處置
    if (input.task.risk === "high" && (!disposition.agent || !input.writerAgents.includes(disposition.agent))) {
      return fail("MEMORY_WRITER_REQUIRED", "高風險任務的記憶處置必須由 memorizer 宣告，請派 memorizer 處理。");
    }

    // 6. none 必須有理由
    if (disposition.outcome === "none") {
      return disposition.reason?.trim()
        ? { ok: true, disposition }
        : fail("MEMORY_REFERENCE_MISSING", "none 處置缺少理由，請重新呼叫 memory-task-close。");
    }

    // 7. recorded：引用存在且屬於同一任務，主題現況與 log 一致
    if (disposition.outcome !== "recorded" || refs.length === 0) {
      return fail("MEMORY_REFERENCE_MISSING", "記憶處置缺少有效的寫入引用，請重新呼叫 memory-task-close。");
    }
    const referenced = new Map<LayerName, Set<string>>();
    for (const ref of refs) {
      const layerName: LayerName = shared ? "project" : ref.layer;
      const entry = logs[layerName]?.find((item) => item?.seq === ref.seq);
      if (!entry || entry.kind !== "write" || entry.taskId !== input.task.taskId || !entry.topic) {
        return fail("MEMORY_REFERENCE_MISSING", "處置引用的寫入紀錄不存在或不屬於這個任務，請檢查紀錄後重新宣告。");
      }
      if (!referenced.has(layerName)) referenced.set(layerName, new Set());
      referenced.get(layerName)!.add(entry.topic);
    }
    const mismatches = [...referenced].flatMap(([name, topics]) =>
      mismatchedTopics(layers[name], logs[name], [...topics]).map((topic) => `${name}/${topic}`),
    );
    if (mismatches.length > 0) {
      return fail(
        "MEMORY_OUT_OF_BAND_EDIT",
        `主題在工具外被修改過：${mismatches.join("、")}。請派 memorizer 用 memory-maintain report 檢查，確認內容無誤後用 reseal-log。`,
      );
    }
    return { ok: true, disposition };
  } catch {
    return fail("MEMORY_LOG_TAMPERED", "無法安全讀取記憶紀錄，請檢查檔案格式、權限與符號連結。");
  }
}
