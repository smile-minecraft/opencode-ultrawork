/**
 * 內容寫入鎖：同一台機器上同時只能有一組寫入在跑臨界區。
 *
 * 用 wx 獨佔建立 lockfile 搶鎖。搶不到時先判斷是否孤兒：
 * 持有者 pid 已死＋年齡超過 CONTENT_LOCK_STALE_SECONDS → 保守回收
 * （先原子取得回收資格，把「重讀→判定→刪除」包在單一寫者區段內，
 * 期間只有資格持有者能刪，刪完留紀錄）然後重搶一次；pid 還活著、
 * 太年輕、或 payload 缺欄位無法驗證 → 絕不動別人的鎖，依 options
 * 有界重試後回 CONTENT_LOCK_BUSY。釋放時比對 token，避免誤刪後來者的鎖。
 *
 * 回收資格拿不到一律 fail closed（不偷、不刪別人的資格）；卡住的資格
 * `unlockStale` 只診斷，須依提示人工處理（工具永遠不刪除資格檔）。
 */

import { existsSync, linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

/** 孤兒門檻（秒）：持有者已死且年齡超過此值才可回收。 */
export const CONTENT_LOCK_STALE_SECONDS = 60;

/** 預設重試次數：短暫交錯可吸收，總等待約 350ms（50＋100＋200）。 */
const DEFAULT_LOCK_RETRIES = 3;

/** 重試硬上限：呼叫端給再大的 retries 也不會無限等待。 */
const MAX_LOCK_RETRIES = 10;

const DEFAULT_RETRY_DELAY_MS = 50;
const MAX_RETRY_DELAY_MS = 500;

export class ContentLockBusyError extends Error {
  readonly code = "CONTENT_LOCK_BUSY";
  readonly heldByPid: number | null;
  readonly since: string | null;
  readonly ageSeconds: number | null;
  readonly lockPath: string | null;

  constructor(info: {
    heldByPid: number | null;
    since: string | null;
    ageSeconds: number | null;
    lockPath?: string | null;
  }) {
    super(formatContentLockBusyMessage(info));
    this.name = "ContentLockBusyError";
    this.heldByPid = info.heldByPid;
    this.since = info.since;
    this.ageSeconds = info.ageSeconds;
    this.lockPath = info.lockPath ?? null;
  }
}

/**
 * 鎖忙碌的使用者指引（唯一措辭）。
 *
 * 持有鎖知識的是這一側（孤兒門檻、復原工具名），所以真相放在這裡；
 * `define-tool.ts` 的外框 `nextAction` 直接引用它，不另寫一份。
 * 門檻數字由 `CONTENT_LOCK_STALE_SECONDS` 內插，改門檻時指引自動跟著走。
 */
export function contentLockBusyGuidance(): string {
  return (
    `持有者仍在執行就等它完成後重試；kill -9 留下的孤兒鎖超過 ${CONTENT_LOCK_STALE_SECONDS}s 會自動回收，` +
    `也可用 plan-content-read 的 unlockStale:true 診斷並回收後重試。`
  );
}

/**
 * 鎖忙碌訊息組裝：時間敘述只用相對（已持有 N 秒）。
 *
 * `since` 保留在錯誤物件欄位上供結構化取用，但訊息正文不混用絕對時間；
 * 年齡不可信（null）時明講「無法判斷」，絕不印出 null。
 */
export function formatContentLockBusyMessage(info: {
  heldByPid: number | null;
  since: string | null;
  ageSeconds: number | null;
  lockPath?: string | null;
}): string {
  const where = info.lockPath ? `（${info.lockPath}）` : "";
  const holder =
    info.heldByPid !== null
      ? info.ageSeconds !== null
        ? `持有者 pid ${info.heldByPid} 已持有約 ${info.ageSeconds} 秒`
        : `持有者 pid ${info.heldByPid}，已持有時間無法判斷`
      : "持有者資訊無法讀取";
  return `content-write lock${where} 被占用：${holder}。${contentLockBusyGuidance()}`;
}

/** 鎖檔 payload：三個欄位缺一不可，缺欄位的一律不當成可回收的孤兒。 */
export interface LockPayload {
  pid: number;
  createdAt: string;
  token: string;
}

export interface ContentWriteLockOptions {
  /**
   * 忙碌時重試次數（預設 3：共用同一個 `.ultrawork/` 的兩個 writer，
   * 短暫交錯時第二個會等一下而不是立刻失敗；總等待約 350ms。
   * 超過硬上限會被箝制；傳 0 回到 fail-fast）。
   */
  retries?: number;
  /** 退避基底間隔 ms（預設 50）；第 n 次重試等基底×2^n。 */
  retryDelayMs?: number;
  /** 退避上限 ms（預設 500）。 */
  maxRetryDelayMs?: number;
  /** 等待函式（預設 setTimeout；測試可注入紀錄型時鐘）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 孤兒回收紀錄回呼（測試用；正式紀錄一律走 console.warn）。 */
  onOrphanReclaim?: (info: { lockPath: string; heldByPid: number; ageSeconds: number }) => void;
  /** 回收流程的測試 hook（正式流程不傳；只在固定點呼叫，不改變判定）。 */
  reclaimHooks?: WriteLockReclaimHooks;
}

/**
 * 回收流程的測試 hook：用來在測試裡製造「兩個回收者交錯」的確定順序，
 * 不靠 sleep 碰運氣。正式流程永遠不傳。
 */
export interface WriteLockReclaimHooks {
  /** 拿到回收資格後、重讀鎖檔前呼叫。 */
  onReclaimClaimed?: (lockPath: string) => void;
  /** 重讀比對成功後、真正刪除前呼叫。 */
  beforeReclaimUnlink?: (lockPath: string, held: LockPayload) => void;
  /** 取得回收資格時遇到已存在的資格檔（不論新舊）時呼叫，之後一律放棄本次回收。 */
  onTicketObserved?: (ticketPath: string) => void;
}

export interface StaleLockRelease {
  released: boolean;
  reason: string;
  heldByPid: number | null;
  since: string | null;
  ageSeconds: number | null;
  pidAlive: boolean | null;
}

function readPayload(lockPath: string): LockPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf-8"));
  } catch {
    return null;
  }
  // 嚴格形狀：缺 pid／token／createdAt 任一欄都不是可回收的孤兒。
  // 寫到一半崩潰的半截 JSON、舊版格式、手動誤建的檔案一律不碰。
  return isCompletePayload(parsed) ? parsed : null;
}

/** 合法 pid：正整數。0／負值／非整數／非數字一律不是持有者。 */
function asPid(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * POSIX shell 路徑引用：整段包單引號，內部的單引號斷開跳脫（' → '\''）。
 * 單引號內雙引號、空白、$、反引號、反斜線、換行全部是字面量，
 * 因此任何合法路徑（可含單引號、$、反引號、空白、換行）複製貼上執行
 * 都只會作用在那個檔案，不會跳出引號執行別的命令。
 */
function quoteShellPath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** 完整 payload 檢查：pid 正整數＋token 非空字串＋createdAt 可解析。 */
function isCompletePayload(held: unknown): held is LockPayload {
  if (typeof held !== "object" || held === null) return false;
  const payload = held as Record<string, unknown>;
  return (
    asPid(payload.pid) !== null &&
    typeof payload.token === "string" &&
    payload.token.length > 0 &&
    typeof payload.createdAt === "string" &&
    !Number.isNaN(Date.parse(payload.createdAt))
  );
}

/** 原始 payload（只解析 JSON，不驗形狀）：給「缺欄位」分支做診斷訊息用。 */
function readRawPayload(lockPath: string): unknown {
  try {
    return JSON.parse(readFileSync(lockPath, "utf-8"));
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH 是已死；EPERM 是活著但沒權限，保守視為活著。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 鎖年齡（秒）：createdAt 壞掉時退回 mtime，都拿不到就回 null（不猜）。 */
function lockAgeSeconds(lockPath: string, held: LockPayload | null): number | null {
  if (held?.createdAt) {
    const parsed = Date.parse(held.createdAt);
    if (!Number.isNaN(parsed)) return (Date.now() - parsed) / 1000;
  }
  try {
    return (Date.now() - statSync(lockPath).mtimeMs) / 1000;
  } catch {
    return null;
  }
}

/** 孤兒判定（保守）：完整 payload＋已死＋年齡超過門檻，三者缺一就不回收。 */
function isOrphanPayload(held: LockPayload | null, ageSeconds: number | null): boolean {
  return (
    isCompletePayload(held) &&
    ageSeconds !== null &&
    ageSeconds >= CONTENT_LOCK_STALE_SECONDS &&
    !pidAlive(held.pid)
  );
}

/**
 * 回收資格檔：跟鎖同目錄的 `<lock>.reclaim`。
 * 「重讀→判定→刪除」只有資格持有者能執行，同一時間只有一個回收者
 * 在區段內，後到的拿不到資格就放棄走重試路徑，絕不在區段外刪除。
 * 持資格的時間只有幾次同步檔案操作（微秒級），不會成為等待來源。
 *
 * 互斥保證：資格檔只用原子操作建立（見 acquireReclaimTicket），自動路徑
 * 永不刪除別人的資格檔（只刪自己 token 相符的）。因此同一時間最多只有
 * 一個持有者，不存在「刪掉重建」的窗口。資格被佔用一律 fail closed。
 */
export function reclaimTicketPathFor(lockPath: string): string {
  return `${lockPath}.reclaim`;
}

interface ReclaimTicket {
  pid: number;
  createdAt: string;
  token: string;
}

function readTicket(ticketPath: string): ReclaimTicket | null {
  try {
    return JSON.parse(readFileSync(ticketPath, "utf-8")) as ReclaimTicket;
  } catch {
    return null;
  }
}

/**
 * 取得回收資格（fail closed）：有資格檔就放棄，絕不偷取、絕不刪除別人的檔。
 *
 * 原子建立：先把完整內容寫進唯一暫存檔，再用 link 原子指到目標名。
 * link 成功 ⟺ 目標名之前不存在 ⟺ 這份資格是自己建立的；link 遇到 EEXIST
 * 表示別人先拿到（或上次崩潰留下），直接放棄。因為內容在 link 之前已完整
 * 寫入，可讀到的資格檔一定是完整的，不會有「半截資格檔」。
 * 暫存檔用唯一名且只有自己會清；崩潰殘留的暫存檔不影響任何判定。
 */
function acquireReclaimTicket(lockPath: string, hooks?: WriteLockReclaimHooks): ReclaimTicket | null {
  const ticketPath = reclaimTicketPathFor(lockPath);
  const ticket: ReclaimTicket = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token: randomBytes(12).toString("hex"),
  };
  const tmpPath = `${ticketPath}.${process.pid}.${ticket.token}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(ticket), { flag: "wx" });
  } catch {
    return null;
  }
  try {
    linkSync(tmpPath, ticketPath);
    return ticket;
  } catch (error) {
    // EEXIST：別人先拿到或上次崩潰留下。fail closed：不讀、不刪、不偷，
    // 放棄本次回收、照常走有界重試。卡住的資格只由使用者按診斷指示手動清除。
    if ((error as NodeJS.ErrnoException).code === "EEXIST") hooks?.onTicketObserved?.(ticketPath);
    return null;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // 暫存檔清不掉（極少見）：唯一名、不影響判定，原地放行。
    }
  }
}

function releaseReclaimTicket(lockPath: string, ticket: ReclaimTicket): void {
  const ticketPath = reclaimTicketPathFor(lockPath);
  try {
    // 比對 token：只刪自己的資格。自動路徑沒有偷取，活著持有者的資格
    // 不可能被換掉，這裡是雙保險。注意：持有者自己的 finally 是全程式
    // 唯一會刪除資格檔的地方；診斷與 unlockStale 只讀不刪。
    const current = readTicket(ticketPath);
    if (current?.token === ticket.token) unlinkSync(ticketPath);
  } catch {
    // 資格檔已經不在，原地放行。
  }
}

/** 回收資格的診斷結果：給 unlockStale 看「卡在哪」，自動路徑不用它做決定。 */
export interface ReclaimTicketStatus {
  path: string;
  present: boolean;
  /** 解析得出完整票據形狀（pid 正整數＋createdAt 可解析＋token 非空）。 */
  readable: boolean;
  /** 需要人工按 hint 手動處理：內容無效，或持有者已死＋夠舊。活持有者的資格永遠 false。 */
  stale: boolean;
  heldByPid: number | null;
  ageSeconds: number | null;
  hint: string;
}

/** 診斷用的讀檔縫：測試注入讀取失敗用；正式流程永遠走真實檔案。 */
export interface ReclaimTicketReadOps {
  readFile?: (ticketPath: string) => string;
}

/**
 * 只診斷不刪除：回報回收資格檔是否存在、能不能讀、能不能解析、是不是卡住。
 *
 * 讀不到（權限、I/O）與「讀到了但內容無效」嚴格分開：前者無法確認持有者
 * 是否還活著，一律 readable:false、stale:false（fail closed）；後者與
 * 「持有者已死＋超過孤兒門檻」才是 stale（卡住、需要人工按 hint 處理）。
 * 活持有者的資格一律不是 stale。這個函式與 unlockStale 都只診斷，絕不刪除。
 */
export function diagnoseReclaimTicket(lockPath: string, ops: ReclaimTicketReadOps = {}): ReclaimTicketStatus {
  const path = reclaimTicketPathFor(lockPath);
  const quoted = quoteShellPath(path);
  const readFile = ops.readFile ?? ((ticketPath: string) => readFileSync(ticketPath, "utf-8"));
  const base = { path, present: false, readable: false, stale: false, heldByPid: null, ageSeconds: null };
  // 存在性用 statSync 並區分錯誤碼：ENOENT 是「確認不存在」；
  // EACCES 等其他錯誤是「無法確認」，保守視為可能有東西，絕不謊報「沒有卡住」。
  // （限制：目錄無權限時只能做到「無法確認」，給不出更細的資訊。）
  try {
    statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...base, hint: "沒有卡住的回收資格。" };
    }
    return {
      ...base,
      present: true,
      hint:
        `無法確認回收資格檔是否存在（可能是目錄權限不足）：${path}。` +
        `保守起見視為可能卡住；自動回收會持續放棄，也不會自動清除。` +
        `請先排除權限問題，確認沒有其他寫入在進行後，若檔案存在且已損毀再手動執行：rm ${quoted}`,
    };
  }
  let content: string;
  try {
    content = readFile(path);
  } catch (error) {
    // stat 之後檔案消失 ⟺ 確認不存在；其他讀取錯誤 ⟺ 無法確認持有者，fail closed。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...base, hint: "沒有卡住的回收資格。" };
    }
    return {
      ...base,
      present: true,
      hint:
        `回收資格檔無法讀取（可能是權限不足或暫時性 I/O 錯誤）：${path}。` +
        `無法確認持有者是否還活著，自動回收會持續放棄，也不會自動清除。` +
        `請先排除讀取問題（權限、磁碟），確認沒有其他寫入在進行後，` +
        `若檔案已損毀再手動執行：rm ${quoted}`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return {
      ...base,
      present: true,
      stale: true,
      hint:
        `回收資格檔內容無效（無法解析）：${path}。無法確認持有者，` +
        `自動回收會持續放棄。確認沒有其他寫入在進行後，手動執行：rm ${quoted}`,
    };
  }
  const ticket = raw as Partial<ReclaimTicket>;
  const heldByPid = asPid(ticket.pid);
  const parsedAge =
    typeof ticket.createdAt === "string" && !Number.isNaN(Date.parse(ticket.createdAt))
      ? (Date.now() - Date.parse(ticket.createdAt)) / 1000
      : null;
  const readable =
    heldByPid !== null &&
    parsedAge !== null &&
    typeof ticket.token === "string" &&
    ticket.token.length > 0;
  const ageSeconds = parsedAge === null ? null : Math.round(parsedAge);
  if (!readable) {
    return {
      ...base,
      present: true,
      stale: true,
      heldByPid,
      ageSeconds,
      hint:
        `回收資格檔缺必要欄位（需要正整數 pid＋token＋createdAt）：${path}。` +
        `無法確認持有者，自動回收會持續放棄。確認沒有其他寫入在進行後，` +
        `手動執行：rm ${quoted}`,
    };
  }
  if (pidAlive(heldByPid as number)) {
    return {
      ...base,
      present: true,
      readable: true,
      heldByPid,
      ageSeconds,
      hint: `另一個回收者（pid ${heldByPid}）正在處理，稍後重試即可，不用處理，也不要刪除資格檔。`,
    };
  }
  if (parsedAge !== null && parsedAge >= CONTENT_LOCK_STALE_SECONDS) {
    return {
      ...base,
      present: true,
      readable: true,
      stale: true,
      heldByPid,
      ageSeconds,
      hint:
        `回收資格的持有者 pid ${heldByPid} 已死、${ageSeconds}s（超過 ${CONTENT_LOCK_STALE_SECONDS}s 門檻）：${path}。` +
        `可能是上次回收崩潰留下，自動回收會持續放棄。確認沒有其他寫入在進行後，` +
        `手動執行：rm ${quoted}`,
    };
  }
  return {
    ...base,
    present: true,
    readable: true,
    heldByPid,
    ageSeconds,
    hint: `回收資格的持有者 pid ${heldByPid} 已死，但資格才 ${ageSeconds ?? "未知"}s，稍後重試；若持續超過 ${CONTENT_LOCK_STALE_SECONDS}s 仍卡住，診斷會標成需人工處理。`,
  };
}

function recordOrphanReclaim(
  lockPath: string,
  held: LockPayload,
  ageSeconds: number,
  onOrphanReclaim?: ContentWriteLockOptions["onOrphanReclaim"],
): void {
  const age = Math.round(ageSeconds);
  console.warn(
    `[ultrawork] content-write lock 孤兒回收：${lockPath}（持有者 pid ${held.pid} 已死、${age}s，` +
      `超過 ${CONTENT_LOCK_STALE_SECONDS}s 門檻，已刪除並重搶）。`,
  );
  onOrphanReclaim?.({ lockPath, heldByPid: held.pid, ageSeconds: age });
}

/**
 * 顯式復原：只有孤兒鎖才刪，其他情況一律住手並說明原因。
 * 自動回收（withContentWriteLock 內）與 plan-content-read 的 unlockStale 共用此函式，
 * 判定規則只有一份。刪除成功會留紀錄（console.warn；呼叫端回傳的結果本身也是紀錄）。
 */
export function releaseStaleContentWriteLock(
  lockPath: string,
  onOrphanReclaim?: ContentWriteLockOptions["onOrphanReclaim"],
  hooks?: WriteLockReclaimHooks,
): StaleLockRelease {
  const held = readPayload(lockPath);
  if (!existsSync(lockPath) || !held) {
    const quotedLock = quoteShellPath(lockPath);
    const raw = existsSync(lockPath) ? readRawPayload(lockPath) : null;
    if (raw !== null && !isCompletePayload(raw)) {
      // 看得懂 JSON 但缺欄位：無法確認持有者，絕不自動刪除。
      const partial = raw as Partial<LockPayload>;
      return {
        released: false,
        reason:
          `鎖檔缺必要欄位（需要正整數 pid＋token＋createdAt），無法確認持有者，不自動刪除。` +
          `確認沒有其他寫入在進行後，手動執行：rm ${quotedLock}`,
        heldByPid: asPid(partial.pid),
        since: typeof partial.createdAt === "string" ? partial.createdAt : null,
        ageSeconds: null,
        pidAlive: null,
      };
    }
    return {
      released: false,
      reason: existsSync(lockPath)
        ? `鎖檔無法解析（可能寫到一半就崩潰），無法確認持有者，不自動刪除。確認沒有其他寫入在進行後，手動執行：rm ${quotedLock}`
        : "沒有鎖，不用回收。",
      heldByPid: null,
      since: null,
      ageSeconds: null,
      pidAlive: null,
    };
  }
  const ageSeconds = lockAgeSeconds(lockPath, held);
  const alive = pidAlive(held.pid);
  if (!isOrphanPayload(held, ageSeconds)) {
    const ageText = ageSeconds === null ? "未知" : `${Math.round(ageSeconds)}s`;
    return {
      released: false,
      reason: alive
        ? `持有者 pid ${held.pid} 仍在執行，不回收。等它完成後重試。`
        : `持有者 pid ${held.pid} 已死，但 lock 才 ${ageText}（未達 ${CONTENT_LOCK_STALE_SECONDS}s 門檻），不回收。稍後重試，達到門檻後會自動回收。`,
      heldByPid: held.pid,
      since: held.createdAt,
      ageSeconds: ageSeconds === null ? null : Math.round(ageSeconds),
      pidAlive: alive,
    };
  }
  // 單一寫者區段：先拿回收資格。拿不到（另一個回收者正在處理，
  // 或上次回收崩潰留下資格檔）就放棄回收、照常走重試路徑，
  // 絕不在區段外刪除別人的新鎖。
  const ticket = acquireReclaimTicket(lockPath, hooks);
  if (!ticket) {
    return {
      released: false,
      reason:
        "回收資格被占用（另一個回收者正在處理，或上次回收崩潰留下資格檔），不重複刪除。" +
        "稍後重試；若持續卡住，用 plan-content-read 的 unlockStale:true 診斷，按指示手動清除後重試。",
      heldByPid: held.pid,
      since: held.createdAt,
      ageSeconds: Math.round(ageSeconds as number),
      pidAlive: false,
    };
  }
  try {
    hooks?.onReclaimClaimed?.(lockPath);
    // 在資格保護下重讀：只有「仍是當初看到的那個孤兒」才刪。
    // 期間被換新、消失、變形一律住手。
    const stillSameOrphan = (): boolean => {
      const current = readPayload(lockPath);
      const currentAge = current ? lockAgeSeconds(lockPath, current) : null;
      return (
        !!current &&
        isOrphanPayload(current, currentAge) &&
        current.token === held.token &&
        current.pid === held.pid &&
        current.createdAt === held.createdAt
      );
    };
    if (!stillSameOrphan()) {
      return {
        released: false,
        reason: "鎖在等待回收資格期間被別人動過（已換新、已消失或變形），不刪除。重讀診斷後再決定。",
        heldByPid: held.pid,
        since: held.createdAt,
        ageSeconds: Math.round(ageSeconds as number),
        pidAlive: false,
      };
    }
    hooks?.beforeReclaimUnlink?.(lockPath, held);
    // hook 之後最終再驗一次：保證「判定→刪除」之間沒有空隙。
    // 正式流程不傳 hook，這一讀必定通過，只多一次讀檔。
    if (!stillSameOrphan()) {
      return {
        released: false,
        reason: "鎖在刪除前一刻被別人動過（已換新），不刪除。重讀診斷後再決定。",
        heldByPid: held.pid,
        since: held.createdAt,
        ageSeconds: Math.round(ageSeconds as number),
        pidAlive: false,
      };
    }
    try {
      unlinkSync(lockPath);
    } catch {
      return {
        released: false,
        reason: "刪除時鎖已被別人拿走，不重複刪除。重讀診斷後再決定。",
        heldByPid: held.pid,
        since: held.createdAt,
        ageSeconds: Math.round(ageSeconds as number),
        pidAlive: false,
      };
    }
    recordOrphanReclaim(lockPath, held, ageSeconds as number, onOrphanReclaim);
    return {
      released: true,
      reason: `已回收孤兒鎖（持有者 pid ${held.pid} 已死、${Math.round(ageSeconds as number)}s）。`,
      heldByPid: held.pid,
      since: held.createdAt,
      ageSeconds: Math.round(ageSeconds as number),
      pidAlive: false,
    };
  } finally {
    releaseReclaimTicket(lockPath, ticket);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 搶鎖、跑臨界區、無論成敗放鎖。
 * 搶到孤兒鎖會自動回收重搶；搶到活鎖則有界重試（預設 3 次、總等待約 350ms），
 * 配額用完丟 ContentLockBusyError。
 */
export async function withContentWriteLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: ContentWriteLockOptions = {},
): Promise<T> {
  const retries = Math.max(0, Math.min(options.retries ?? DEFAULT_LOCK_RETRIES, MAX_LOCK_RETRIES));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const maxRetryDelayMs = Math.max(0, options.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS);
  const sleep = options.sleep ?? defaultSleep;
  let reclaimed = false;
  // 上界：首次＋回收後重搶＋retries 次重試，不會無限繞。
  for (let attempt = 0; ; attempt++) {
    const payload: LockPayload = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      token: randomBytes(12).toString("hex"),
    };
    try {
      writeFileSync(lockPath, JSON.stringify(payload), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!reclaimed) {
        reclaimed = true;
        if (releaseStaleContentWriteLock(lockPath, options.onOrphanReclaim, options.reclaimHooks).released) continue;
      }
      const held = readPayload(lockPath);
      const ageSeconds = lockAgeSeconds(lockPath, held);
      if (attempt >= retries) {
        throw new ContentLockBusyError({
          heldByPid: held?.pid ?? null,
          since: held?.createdAt ?? null,
          ageSeconds: ageSeconds === null ? null : Math.round(ageSeconds),
          lockPath,
        });
      }
      await sleep(Math.min(retryDelayMs * 2 ** attempt, maxRetryDelayMs));
      continue;
    }
    try {
      return await fn();
    } finally {
      const current = readPayload(lockPath);
      if (current?.token === payload.token) {
        try {
          unlinkSync(lockPath);
        } catch {
          // 鎖檔已經不在，原地放行。
        }
      }
    }
  }
}

/** 只診斷不刪除：回報鎖是否存在、持有者是否還活著、看起來像不像孤兒。 */
export function diagnoseContentWriteLock(lockPath: string): {
  present: boolean;
  heldByPid: number | null;
  since: string | null;
  ageSeconds: number | null;
  pidAlive: boolean | null;
  looksStale: boolean;
  hint: string;
} {
  if (!existsSync(lockPath)) {
    return {
      present: false,
      heldByPid: null,
      since: null,
      ageSeconds: null,
      pidAlive: null,
      looksStale: false,
      hint: "沒有鎖。",
    };
  }
  const held = readPayload(lockPath);
  let ageSeconds: number;
  if (held?.createdAt && !Number.isNaN(Date.parse(held.createdAt))) {
    ageSeconds = (Date.now() - Date.parse(held.createdAt)) / 1000;
  } else {
    try {
      ageSeconds = (Date.now() - statSync(lockPath).mtimeMs) / 1000;
    } catch {
      ageSeconds = Infinity;
    }
  }
  // 嚴格形狀下 held 一定有正整數 pid；不用 truthy 判斷，避免 pid 0 這類
  // 非法值在將來繞過形狀檢查時被誤判。
  const alive = held ? pidAlive(held.pid) : null;
  const looksStale = ageSeconds >= CONTENT_LOCK_STALE_SECONDS && alive === false;
  const roundedAge = Math.round(ageSeconds);
  const quotedLock = quoteShellPath(lockPath);
  return {
    present: true,
    heldByPid: held?.pid ?? null,
    since: held?.createdAt ?? null,
    ageSeconds: roundedAge,
    pidAlive: alive,
    looksStale,
    hint: looksStale
      ? `lock 看起來是孤兒（持有者 pid ${held?.pid} 已死、${roundedAge}s）。確認沒有其他 content 寫入後，手動執行：rm ${quotedLock}`
      : alive
        ? `持有者 pid ${held?.pid} 仍在執行，等它完成後重試。`
        : alive === false
          ? `持有者 pid ${held?.pid} 已死，但 lock 才 ${roundedAge}s（未達 ${CONTENT_LOCK_STALE_SECONDS}s 門檻），稍後重試；達到門檻後會自動回收，也可用 plan-content-read 的 unlockStale:true 診斷。`
          : roundedAge >= CONTENT_LOCK_STALE_SECONDS
            ? `lock 已 ${roundedAge}s 且無法確認持有者，確認沒有其他寫入在進行後，手動執行：rm ${quotedLock}`
            : `lock 才 ${roundedAge}s，可能是正常進行中的寫入，稍後重試。`,
  };
}
