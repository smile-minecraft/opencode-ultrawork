/**
 * 寫入紀錄 `log.jsonl`（企劃書第 8 節）。
 *
 * 一行一筆 JSON，只增不改。每筆帶前一筆的 hash（`prevHash`），自己的 `hash` 是
 * 除 `hash` 以外所有欄位 key 排序後的 sha256，串成一條鏈。筆記、筆記整理、
 * 結案處置、遷移、reseal 都記在這裡，所以它是結案檢查的唯一證據來源。
 *
 * 能力邊界：hash 鏈能發現手改與走捷徑，不能阻止有檔案寫入權的 agent 重算整條鏈；
 * 威脅模型與 `tasks.json` 相同。
 */

import { appendFileSync } from "node:fs";
import { MemoryError, memoryPath, readOptional, type LayerName, type MemoryLayer } from "./layers.ts";
import { sha256 } from "./topic.ts";

export interface LogEntry {
  /** 該層從 1 開始連號。 */
  seq: number;
  at: string;
  kind: "write" | "note" | "note-consumed" | "note-dismissed" | "disposition" | "migrate" | "reseal";
  /** 呼叫者 agent；遷移寫的是 "migration"。 */
  agent: string | null;
  sessionID: string | null;
  /** 前一筆的 hash；第一筆是 "genesis"。 */
  prevHash: string;
  hash: string;
  taskId?: string;
  topic?: string;
  op?: "create" | "update" | "delete" | "verify";
  /** 寫入前檔案的 sha；create 為 null。 */
  beforeSha?: string | null;
  /** 寫入後檔案的 sha；delete 為 null。 */
  afterSha?: string | null;
  content?: string;
  noteSeq?: number;
  outcome?: "recorded" | "none" | "legacy-receipt";
  refs?: { layer: LayerName; seq: number }[];
  reason?: string;
  legacyReceiptId?: string;
  /** reseal：當下每個主題檔的 sha，是之後 sha 連續性檢查的新基準。 */
  shas?: Record<string, string>;
}

export type LogInput = Omit<LogEntry, "seq" | "at" | "prevHash" | "hash">;

const SHA_PATTERN = /^[a-f0-9]{64}$/;

/** key 排序、去掉 undefined，讓同一筆紀錄不論欄位順序都得到同一個 hash。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function entryHash(entry: Omit<LogEntry, "hash"> | LogEntry): string {
  const { hash: _hash, ...rest } = entry as LogEntry;
  return sha256(JSON.stringify(canonical(rest)));
}

/**
 * 逐行讀取；解析失敗或缺必要欄位的行回 null（保留位置，驗證時才看得出斷在哪裡）。
 * 檔案不存在回空陣列。
 */
export function readLog(layer: MemoryLayer): (LogEntry | null)[] {
  const raw = readOptional(memoryPath(layer, "log.jsonl"));
  if (!raw) return [];
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => {
    try {
      const entry = JSON.parse(line) as LogEntry;
      const wellFormed =
        !!entry &&
        Number.isInteger(entry.seq) &&
        entry.seq > 0 &&
        typeof entry.at === "string" &&
        typeof entry.kind === "string" &&
        typeof entry.hash === "string" &&
        typeof entry.prevHash === "string";
      return wellFormed ? entry : null;
    } catch {
      return null;
    }
  });
}

/** 有效的 reseal：自身 hash 正確、有理由、`shas` 是 slug → sha 的物件。 */
export function validReseal(entry: LogEntry | null): boolean {
  return (
    !!entry &&
    entry.kind === "reseal" &&
    !!entry.reason?.trim() &&
    !!entry.shas &&
    typeof entry.shas === "object" &&
    !Array.isArray(entry.shas) &&
    Object.values(entry.shas).every((sha) => typeof sha === "string" && SHA_PATTERN.test(sha)) &&
    entry.hash === entryHash(entry)
  );
}

/**
 * 驗證從 `startSeq` 到尾端的 hash 鏈（企劃書第 9.4 節第 2 條）。
 *
 * - `startSeq` 為 1（預設）時驗整條鏈，第一筆必須接在 "genesis" 後面。
 * - `startSeq` 大於 1 時，只驗那一筆到尾端；那一筆之前的內容（包括壞行）不在範圍內，
 *   它跟前一筆的連結也不驗。找不到那一筆就算失敗。
 * - 範圍內若有較新的有效 reseal，從最後一筆 reseal 重新起算：reseal 是人為確認
 *   「目前的內容是對的」，之前的斷裂不再追究。被引用的舊紀錄是否存在、是否屬於
 *   同一任務，由呼叫端另外檢查。
 */
export function verifyLog(entries: (LogEntry | null)[], startSeq = 1): boolean {
  if (entries.length === 0) return true;
  let start = startSeq <= 1 ? 0 : entries.findIndex((entry) => entry !== null && entry.seq >= startSeq);
  if (start < 0) return false;
  for (let index = start; index < entries.length; index += 1) {
    if (validReseal(entries[index] ?? null)) start = index;
  }
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.hash !== entryHash(entry)) return false;
    if (index === start && (index > 0 || validReseal(entry))) continue;
    const previous = index > 0 ? entries[index - 1] : undefined;
    if (entry.prevHash !== (previous?.hash ?? "genesis")) return false;
    if (entry.seq !== (previous?.seq ?? 0) + 1) return false;
  }
  return true;
}

/**
 * 附加一批紀錄（呼叫端必須持有該層的鎖）。整批只做一次 append，
 * 寫入與它整理掉的筆記不會一半成功一半失敗。
 *
 * 尾端壞掉時拒絕附加，只有單獨一筆 reseal 例外：它接在最後一個可解析的紀錄後面，
 * 是修復斷鏈的唯一入口。
 */
export function appendLog(layer: MemoryLayer, inputs: LogInput[]): LogEntry[] {
  const entries = readLog(layer);
  const isReseal = inputs.length === 1 && inputs[0]?.kind === "reseal";
  let previous = entries.at(-1);
  if (entries.length > 0 && (!previous || previous.hash !== entryHash(previous))) {
    if (!isReseal) {
      throw new MemoryError("MEMORY_LOG_TAMPERED", "記憶紀錄尾端損壞，請派 memorizer 確認內容後用 memory-maintain 的 reseal-log 復原。");
    }
    previous = entries.filter((entry): entry is LogEntry => entry !== null).at(-1);
  }

  const added: LogEntry[] = [];
  for (const input of inputs) {
    const entry: LogEntry = {
      ...input,
      seq: (previous?.seq ?? 0) + 1,
      at: new Date().toISOString(),
      prevHash: previous?.hash ?? "genesis",
      hash: "",
    };
    entry.hash = entryHash(entry);
    added.push(entry);
    previous = entry;
  }

  const path = memoryPath(layer, "log.jsonl");
  const raw = readOptional(path);
  // 既有檔案最後一行沒有換行時先補一個，避免新紀錄黏在壞行後面。
  const separator = raw && !raw.endsWith("\n") ? "\n" : "";
  appendFileSync(path, `${separator}${added.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return added;
}

/** 尚未整理的筆記：沒有對應的 note-consumed／note-dismissed 紀錄。 */
export function pendingNotes(entries: (LogEntry | null)[]): LogEntry[] {
  const closed = new Set(
    entries
      .filter((entry) => entry?.kind === "note-consumed" || entry?.kind === "note-dismissed")
      .map((entry) => entry!.noteSeq),
  );
  return entries.filter((entry): entry is LogEntry => !!entry && entry.kind === "note" && !closed.has(entry.seq));
}
