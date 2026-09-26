/**
 * 內容寫入鎖：同一台機器上同時只能有一組寫入在跑臨界區。
 *
 * 用 wx 獨佔建立 lockfile 搶鎖；搶不到直接回 CONTENT_LOCK_BUSY，
 * 不刪別人的鎖。釋放時比對 token，避免誤刪後來者的鎖。
 * 不做自動孤兒回收：診斷只回報，移除由人工執行。
 */

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const STALE_SECONDS = 60;

export class ContentLockBusyError extends Error {
  readonly code = "CONTENT_LOCK_BUSY";
  readonly heldByPid: number | null;
  readonly since: string | null;
  readonly ageSeconds: number | null;

  constructor(info: { heldByPid: number | null; since: string | null; ageSeconds: number | null }) {
    super(
      // 訊息沿用舊版逐字：提到 unlockStale 是因為它是顯式復原動作（diagnoseLock），不是要自動回收。
      `content-write lock 被占用${info.heldByPid !== null ? `（pid ${info.heldByPid}，自 ${info.since}，${info.ageSeconds}s 前）` : ""}。` +
        `若確定沒有其他 content 寫入在進行，用 unlockStale 回收後重試。`,
    );
    this.name = "ContentLockBusyError";
    this.heldByPid = info.heldByPid;
    this.since = info.since;
    this.ageSeconds = info.ageSeconds;
  }
}

interface LockPayload {
  pid: number;
  createdAt: string;
  token: string;
}

function readPayload(lockPath: string): LockPayload | null {
  try {
    return JSON.parse(readFileSync(lockPath, "utf-8")) as LockPayload;
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

/** 搶鎖、跑臨界區、無論成敗放鎖；搶不到丟 ContentLockBusyError。 */
export async function withContentWriteLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const payload: LockPayload = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token: randomBytes(12).toString("hex"),
  };
  try {
    writeFileSync(lockPath, JSON.stringify(payload), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const held = readPayload(lockPath);
    let ageSeconds: number | null = null;
    if (held?.createdAt) {
      ageSeconds = Math.round((Date.now() - Date.parse(held.createdAt)) / 1000);
    }
    throw new ContentLockBusyError({
      heldByPid: held?.pid ?? null,
      since: held?.createdAt ?? null,
      ageSeconds,
    });
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
  const alive = held?.pid ? pidAlive(held.pid) : null;
  const looksStale = ageSeconds >= STALE_SECONDS && alive === false;
  return {
    present: true,
    heldByPid: held?.pid ?? null,
    since: held?.createdAt ?? null,
    ageSeconds: Math.round(ageSeconds),
    pidAlive: alive,
    looksStale,
    hint: looksStale
      // 三態 hint 沿用舊版逐字：孤兒才給手動 rm 指令，其他情況只等或重試。
      ? `lock 看起來是孤兒（持有者 pid ${held?.pid} 已死、${Math.round(ageSeconds)}s）。確認沒有其他 content 寫入後，手動執行：rm '${lockPath}'`
      : alive
        ? `持有者 pid ${held?.pid} 仍在執行，等它完成後重試。`
        : `lock 才 ${Math.round(ageSeconds)}s，可能是正常進行中的寫入，稍後重試。`,
  };
}
