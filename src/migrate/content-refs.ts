/**
 * 搬遷時改寫註冊檔複本裡的舊 `contentRef`。
 *
 * 背景：舊註冊檔（`.opencode/memory/tasks.json`、`plans.json`）裡的 `contentRef`
 * 指向 `.opencode/plans/….md`。搬遷只複製檔案的話，新位置的註冊檔仍指著舊路徑，
 * 路徑守衛不認 `.opencode/`（只認 `.ultrawork/`），之後任何寫入註冊檔的操作都會
 * 被擋死 —— 必須在搬遷當下把複本裡的 `contentRef` 前綴換成 `.ultrawork/`。
 *
 * 只改新位置的複本，改名保留的舊檔維持原樣。只碰參照欄位（任務與計畫
 * 各自 map 裡的 `contentRef`，外加任務的 `taskContentPath`），其他字串
 *（含內文、標題）不動。來源不是合法 JSON 時不改、不丟錯（舊資料本來就是壞的
 * 就原樣保留，由 doctor 回報損壞）。
 * 重試時的就地修復（`repairMigratedCopy`）只處理能證明是搬遷複本的目標：
 * 使用者原本就有的檔案一個位元組都不改（見該函式的辨認依據）。
 */

import { readFileSync as readRawBytes } from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWriteFileWithOps } from "../kit/atomic-write.ts";
import type { MigrateFsOps } from "./types.ts";

const LEGACY_PREFIX = ".opencode/";
const CURRENT_PREFIX = ".ultrawork/";
const LEGACY_DOT_SLASH_PREFIX = "./.opencode/";
const CURRENT_DOT_SLASH_PREFIX = "./.ultrawork/";

/** 搬遷目標裡需要改寫 `contentRef` 的註冊檔（相對於該層根目錄）。 */
const REGISTRY_COPY_TARGETS = new Set([".ultrawork/tasks.json", ".ultrawork/plans.json"]);

/** 這個搬遷目標是否需要改寫 `contentRef`。 */
export function needsContentRefRewrite(relativeTo: string): boolean {
  return REGISTRY_COPY_TARGETS.has(relativeTo);
}

/**
 * 改寫已搬到新位置的註冊檔複本，回傳改寫的筆數。
 *
 * 不是合法 JSON 時回 `undefined`（呼叫端原樣保留、不視為失敗）。
 * 目標不是普通檔案（例如同名目錄）時回 `0`、不碰它 —— 沿用「目標已存在就跳過」
 * 的舊語意，不為了改寫把整層擋死。
 * 讀寫的 I/O 錯誤直接拋出（呼叫端走整層停止、下次重試：原子寫入保證目標不會留下半套）。
 */
export function rewriteMigratedContentRefs(
  fs: MigrateFsOps,
  filePath: string,
): number | undefined {
  if (!isOrdinaryFile(fs, filePath)) return 0;
  const raw = fs.readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const rewritten = rewriteInPlace(parsed);
  if (rewritten === 0) return 0;
  atomicWriteFileWithOps(filePath, `${JSON.stringify(parsed, null, 2)}\n`, fs);
  return rewritten;
}

/** 只有普通檔案才值得讀寫；目錄或讀不到狀態時回 false（呼叫端沿用跳過語意）。 */
function isOrdinaryFile(fs: MigrateFsOps, filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** 把解析後的註冊檔裡的舊參照就地換掉，回傳筆數。 */
function rewriteInPlace(parsed: unknown): number {
  let count = 0;
  // `contentRef`（計畫正文、任務錨點）與 `taskContentPath`（file mode 的任務內容檔）
  // 走同一個路徑守衛（`resolvePlansContentRef`），舊前綴一併換掉。
  // 舊資料實測只有 section mode（`contentRef`＋無 `taskContentPath`），這裡是順手 cover
  // 手工或外來舊檔可能帶的值；其他欄位（標題、內文）一律不動。
  eachRegistryRefValue(parsed, (current, assign) => {
    const next = rewriteRef(current);
    if (next !== current) {
      assign(next);
      count += 1;
    }
  });
  return count;
}

/** 數一數還有幾處舊參照（唯讀掃描，不寫入；給「無法證明是我們的就不碰」回報用）。 */
function countLegacyRefs(parsed: unknown): number {
  let count = 0;
  eachRegistryRefValue(parsed, (current) => {
    if (rewriteRef(current) !== current) count += 1;
  });
  return count;
}

/** 走訪 tasks／plans 兩張 map 裡參照欄位的字串值；其他欄位一律不碰。 */
function eachRegistryRefValue(
  parsed: unknown,
  visit: (value: string, assign: (next: string) => void) => void,
): void {
  if (typeof parsed !== "object" || parsed === null) return;
  const root = parsed as Record<string, unknown>;
  for (const key of ["tasks", "plans"]) {
    const table = root[key];
    if (typeof table !== "object" || table === null) continue;
    for (const entry of Object.values(table as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      for (const field of ["contentRef", "taskContentPath"]) {
        if (typeof record[field] === "string") {
          visit(record[field] as string, (next: string) => {
            record[field] = next;
          });
        }
      }
    }
  }
}

/** 舊前綴換新前綴（含 `#task-…` 錨點原樣保留）；不是舊前綴就原樣回傳。 */
function rewriteRef(contentRef: string): string {
  if (contentRef.startsWith(LEGACY_PREFIX)) return CURRENT_PREFIX + contentRef.slice(LEGACY_PREFIX.length);
  if (contentRef.startsWith(LEGACY_DOT_SLASH_PREFIX)) {
    return CURRENT_DOT_SLASH_PREFIX + contentRef.slice(LEGACY_DOT_SLASH_PREFIX.length);
  }
  return contentRef;
}

/**
 * 這個參照是不是指向已搬走的舊前綴（也就是改寫之後會變的值）。
 *
 * 給診斷端分辨「搬遷改寫漏了一筆」與「參照本來就指到別處」：兩者的修法不同，
 * 但判斷必須與搬移端同一份，所以直接問 `rewriteRef` 會不會改變它，不另寫
 * 前綴比對。`legacyContentRefTarget` 同理是給訊息用的具體修法值。
 */
export function isLegacyContentRef(contentRef: string): boolean {
  return rewriteRef(contentRef) !== contentRef;
}

/** 舊前綴換成新前綴後的值；不是舊前綴就原樣回傳（診斷訊息用來指出該改成什麼）。 */
export function legacyContentRefTarget(contentRef: string): string {
  return rewriteRef(contentRef);
}

/**
 * 重試時就地修復已存在的複本（一定要在來源檢查之前呼叫，見 `migrateLayer`）。
 *
 * 辨認依據 —— 「這份目標是搬遷複本」當且僅當「它的位元組等於某份來源封存檔」：
 *
 * - 逐项流程只有兩種寫入目標的方式：來源不存在時不動；來源存在且目標不存在時
 *   `copyThenRename` 逐位元組複製，成功後立刻把來源改名成 `<原檔名>.migrated-<時間戳>`
 *   （撞名加序號）。封存檔只由搬遷自己產生。
 * - 目標已存在就跳過且**不改名來源**：所以「來源還在」表示當時跳過了它，
 *   不可能是我們的複本 —— 此時封存檔不存在（除非使用者手工造了一個同名檔，
 *   但位元組比對仍會擋下），結論一樣是不碰。
 * - 複製是逐位元組的，改寫是唯一的變換：目標與封存檔逐位元組相同 ⟺
 *   它就是我們還沒改寫的那份複本（或是與之完全相同的檔案 —— 前綴改寫的語意
 *   完全相同，都是把已死的舊路徑換成新位置）。改寫過的複本（位元組已不同）
 *   會落到 `clean`，照舊跳過。
 *
 * 前提被破壞時（例如使用者手工建了 `<原檔名>.migrated-xxx` 且位元組恰好相同）：
 * 最壞情況是把一份與封存檔完全相同的檔案做了前綴改寫 —— 沒有刪除、沒有覆寫
 * 使用者獨有內容，原子寫入失敗也不留半套。辨認是保守方向：證據不足就一律不碰。
 */
export type RepairVerdict =
  /** 證明不了是我們的複本 → 一個位元組都不改；`legacyRefs` 是唯讀掃到的舊參照數（回報用）。 */
  | { kind: "foreign"; legacyRefs: number }
  /** 是我們的複本且已乾淨 → 照舊跳過。 */
  | { kind: "clean" }
  /** 是我們的複本且修好了 `count` 處。 */
  | { kind: "repaired"; count: number }
  /** 是我們的複本但不是合法 JSON → 原樣保留（由 doctor 回報損壞）。 */
  | { kind: "unparseable" };

export function repairMigratedCopy(fs: MigrateFsOps, fromPath: string, toPath: string): RepairVerdict {
  if (!isOrdinaryFile(fs, toPath)) return { kind: "foreign", legacyRefs: 0 };
  // 辨認用的是原始位元組，不是解碼後字串：無效 UTF-8 在不同檔案可能解碼成同一個
  // 替代字元（U+FFFD），字串相等證明不了位元組相同。`MigrateFsOps.readFileSync`
  // 是 utf-8 字串形狀（JSON 解析用），這裡走 raw 通道直接讀位元組；測試皆用真實
  // 暫存檔，兩通道讀到的是同一份檔案，沒有分叉。
  // stat 通過後才讀：競態下讀失敗會拋出，呼叫端走整層停止（與舊行為一致）。
  const targetBytes = readRawBytes(toPath);
  const raw = targetBytes.toString("utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return isOurVerbatimCopy(fs, fromPath, targetBytes) ? { kind: "unparseable" } : { kind: "foreign", legacyRefs: 0 };
  }
  if (!isOurVerbatimCopy(fs, fromPath, targetBytes)) {
    return { kind: "foreign", legacyRefs: countLegacyRefs(parsed) };
  }
  const rewritten = rewriteInPlace(parsed);
  if (rewritten === 0) return { kind: "clean" };
  atomicWriteFileWithOps(toPath, `${JSON.stringify(parsed, null, 2)}\n`, fs);
  return { kind: "repaired", count: rewritten };
}

/**
 * 目標位元組是否等於某份來源封存檔（`<原檔名>.migrated-<時間戳>[-序號]`）。
 *
 * 比的是原始位元組（`Buffer.equals`），不是解碼後字串，見 `repairMigratedCopy`。
 * 來源父層讀不到、封存檔讀不到、一份都對不上 → 全部回 `false`（證據不足就不碰）。
 */
function isOurVerbatimCopy(fs: MigrateFsOps, fromPath: string, targetBytes: Buffer): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dirname(fromPath));
  } catch {
    return false;
  }
  const prefix = `${basename(fromPath)}.migrated-`;
  const parent = dirname(fromPath);
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    let archived: Buffer;
    try {
      archived = readRawBytes(join(parent, entry));
    } catch {
      continue;
    }
    if (archived.equals(targetBytes)) return true;
  }
  return false;
}
