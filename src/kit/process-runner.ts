/**
 * 受限程序執行的唯一機制位置。
 *
 * src 內只有本檔可以匯入 `node:child_process`（邊界測試釘住）：
 * 工具邏輯一律經宿主能力 `host.capabilities.process` 執行外部程序，
 * 能力缺席時由各工具明確拒絕或降級，本檔不做政策判斷。
 *
 * 分工：
 * - 本檔：spawn、程序群組終止（SIGTERM→SIGKILL 升級）、逾時、輸出截斷、
 *   env 傳遞（有給就用、沒給就繼承），以及同步／非同步兩種執行面。
 * - 模組層：授權、命令與參數政策（runner 白名單、參數 containment、
 *   env 過濾規則、git／rg／npx 參數與限制），留在原模組。
 *
 * 用 `node:child_process` 而非 Bun.spawn：Bun.spawn 沒有程序群組支援，
 * subprocess.kill() 只終止直接子程序，測試 runner 起的 dev server／watcher／
 * xdist worker 會變孤兒。detached:true 讓子程序成為新程序群組 leader，
 * 逾時就能用 process.kill(-pid) 打整個群組。僅 POSIX。
 */

import {
  spawn as spawnChildProcess,
  spawnSync as spawnSyncChildProcess,
  type ChildProcess,
} from "node:child_process";

/** 非同步執行的選項：呼叫端（模組政策）決定命令、參數、目錄與限制。 */
export interface HostProcessRunOptions {
  /** 可執行檔：絕對路徑或裸名（裸名由作業系統 PATH 解析）。 */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** 沒給就繼承目前程序的環境；有給就原樣使用（過濾是模組的政策）。 */
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** 單一串流的輸出上限位元組；超過即標 truncated（呼叫端決定是否算失敗）。 */
  readonly maxOutputBytes?: number;
  /** verification 語意：detached 群組啟動＋整組升級終止＋群組退出等待。
   * 結算以 leader 的 exit 為起點（不等 close），結束後有界等輸出收尾
   *（上限 GROUP_DRAIN_WAIT_MS）；正常結束不對背景程序送任何訊號。 */
  readonly processGroup?: boolean;
  /** 與 tailBytes 成對：頭尾截斷的保留位元組（verification 語意）。 */
  readonly headBytes?: number;
  readonly tailBytes?: number;
  /** 串流消費（例如 rg JSON lines）；提前停止由呼叫端 abort 自己的 signal。 */
  readonly onStdoutChunk?: (chunk: Uint8Array) => void;
  readonly onStderrChunk?: (chunk: Uint8Array) => void;
  readonly stderrMode?: "pipe" | "ignore";
  /** 終止寬限：先 SIGTERM，超過才 SIGKILL；預設 KILL_GRACE_MS。 */
  readonly killGraceMs?: number;
  /**
   * 終止後等 close 的上限（孤兒孫程序可能 hold 住 pipe 使 close 永不到）。
   * 預設：群組模式 killGraceMs + 2 秒；單一程序 500ms（舊 change-scope
   * 逾時立刻回傳的語意）。
   * 注意：這只管「逾時／取消後等 close」的上限；群組正常結束的輸出收尾
   * 另由 GROUP_DRAIN_WAIT_MS 管（exit 起點、有界等 close）。
   */
  readonly stopWaitMs?: number;
}

export interface HostProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  /** 任一串流被截斷（超過 maxOutputBytes 或頭尾截斷丟掉中段）。 */
  readonly truncated: boolean;
}

/** 同步執行的最小面（啟動即等待；呼叫端是同步上下文時用）。 */
export interface HostProcessSyncOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
}

export interface HostProcessSyncResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  /** 啟動失敗、逾時或超限以外的原因（例如退出碼非零不算 error）。 */
  readonly error?: string;
}

/** 宿主程序能力：非同步與同步兩個執行面。 */
export interface HostProcess {
  run(options: HostProcessRunOptions): Promise<HostProcessResult>;
  runSync(options: HostProcessSyncOptions): HostProcessSyncResult;
}

/** 啟動失敗（例如 ENOENT 找不到可執行檔）：呼叫端據此映射自己的錯誤碼。 */
export class ProcessSpawnError extends Error {
  readonly errnoCode?: string;
  constructor(message: string, errnoCode?: string) {
    super(message);
    this.name = "ProcessSpawnError";
    if (errnoCode !== undefined) this.errnoCode = errnoCode;
  }
}

/** 逾時後先 SIGTERM 整個群組，寬限期過了再 SIGKILL。 */
const KILL_GRACE_MS = 4_000;
/**
 * 群組模式正常結束後的輸出收尾上限：leader 的 exit 即結算起點，
 * 背景子程序可能握著 pipe 使 close 遲到或不到，有界等、不多等。
 */
const GROUP_DRAIN_WAIT_MS = 2_000;
/** 同步面的預設輸出上限（與 execFileSync 預設 maxBuffer 同級）。 */
const DEFAULT_SYNC_MAX_BYTES = 1024 * 1024;

function errnoOf(error: unknown): string | undefined {
  return typeof (error as NodeJS.ErrnoException | null)?.code === "string"
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function signalTarget(pid: number, group: boolean, signal: NodeJS.Signals): void {
  try {
    process.kill(group ? -pid : pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 程序已結束。
    }
  }
}

/** 以 signal 0 探測單一程序是否還活著；ESRCH 代表已死，其他錯誤保守當活著。 */
function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoOf(error) !== "ESRCH";
  }
}

/** 以 signal 0 探測程序群組是否還有成員；ESRCH 代表整組已死。 */
function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return errnoOf(error) !== "ESRCH";
  }
}

async function waitForProcessGroupExit(pid: number | undefined, maxWaitMs: number): Promise<boolean> {
  if (pid === undefined) return true;
  const startedAt = Date.now();
  for (;;) {
    if (!isProcessGroupAlive(pid)) return true;
    if (Date.now() - startedAt >= maxWaitMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * 串流輸出的有界擷取器。保留前 `headMax` 位元組（填滿後不再變動）與後
 * `tailMax` 位元組（丟掉最舊的），中段只累加位元組數。記憶體上界為
 * headMax + tailMax + 單一最大 chunk，與總輸出量、逾時長度都無關。
 */
class BoundedCapture {
  private head: Uint8Array;
  private headLen = 0;
  private tailChunks: Uint8Array[] = [];
  private tailBytes = 0;
  total = 0;

  constructor(private headMax: number, private tailMax: number) {
    this.head = new Uint8Array(headMax);
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.total += chunk.length;
    if (this.headLen < this.headMax) {
      const take = Math.min(this.headMax - this.headLen, chunk.length);
      this.head.set(chunk.subarray(0, take), this.headLen);
      this.headLen += take;
    }
    this.tailChunks.push(chunk);
    this.tailBytes += chunk.length;
    // 丟掉最舊的 chunk，只要丟掉之後剩餘位元組仍 >= tailMax。
    while (this.tailChunks.length > 1 && this.tailChunks[0]!.length <= this.tailBytes - this.tailMax) {
      this.tailBytes -= this.tailChunks.shift()!.length;
    }
  }

  private tailBuffer(): Uint8Array {
    if (this.tailChunks.length === 1) return this.tailChunks[0]!;
    const merged = new Uint8Array(this.tailBytes);
    let offset = 0;
    for (const chunk of this.tailChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }

  /** 重建輸出文字：未超長時逐位元組還原，超長時「頭 + 省略標記 + 尾」。 */
  finalize(): { text: string; truncated: boolean; bytes: number } {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    if (this.total <= this.headMax) {
      return { text: decoder.decode(this.head.subarray(0, this.headLen)), truncated: false, bytes: this.total };
    }
    const tailAll = this.tailBuffer();
    const tail = tailAll.length > this.tailMax ? tailAll.subarray(tailAll.length - this.tailMax) : tailAll;
    const gap = this.total - this.headMax - tail.length;
    if (gap <= 0) {
      // 頭尾涵蓋全部（可能重疊）：把 head 與尾端超出 headMax 的位元組接成
      // 一個陣列再一次解碼，確保跨邊界的多位元組字元逐位元組還原。
      const tailRemainder = tail.subarray(Math.max(0, tail.length - (this.total - this.headMax)));
      const merged = new Uint8Array(this.headLen + tailRemainder.length);
      merged.set(this.head.subarray(0, this.headLen), 0);
      merged.set(tailRemainder, this.headLen);
      return { text: decoder.decode(merged), truncated: false, bytes: this.total };
    }
    return {
      text: `${decoder.decode(this.head.subarray(0, this.headLen))}\n...[略過中段 ${gap} 位元組]...\n${decodeTail(tail, decoder)}`,
      truncated: true,
      bytes: this.total,
    };
  }
}

/** 解碼尾端位元組前，先跳過開頭可能被切一半的 UTF-8 continuation byte。 */
function decodeTail(bytes: Uint8Array, decoder: TextDecoder): string {
  let start = 0;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return decoder.decode(bytes.subarray(start));
}

interface StreamCapture {
  push(chunk: Uint8Array): void;
  finalize(): { text: string; truncated: boolean; bytes: number };
}

/** 全文擷取：上限內逐塊保留，超限後繼續讀掉（免得子程序寫滿 pipe 卡住）但不再累積。 */
function createFullCapture(maxBytes: number): StreamCapture {
  const chunks: Uint8Array[] = [];
  let stored = 0;
  let total = 0;
  return {
    push(chunk: Uint8Array): void {
      if (chunk.length === 0) return;
      total += chunk.length;
      if (stored < maxBytes) {
        const room = maxBytes - stored;
        const take = chunk.length <= room ? chunk : chunk.subarray(0, room);
        chunks.push(take);
        stored += take.length;
      }
    },
    finalize(): { text: string; truncated: boolean; bytes: number } {
      const merged = new Uint8Array(stored);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      return {
        text: new TextDecoder("utf-8", { fatal: false }).decode(merged),
        truncated: total > maxBytes,
        bytes: total,
      };
    },
  };
}

function emptyAsyncResult(cancelled: boolean): HostProcessResult {
  return {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    timedOut: false,
    cancelled,
    truncated: false,
  };
}

export async function runHostProcess(options: HostProcessRunOptions): Promise<HostProcessResult> {
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  const killGraceMs = Math.max(0, options.killGraceMs ?? KILL_GRACE_MS);
  const group = options.processGroup === true;
  const stopWaitMs = Math.max(0, options.stopWaitMs ?? (group ? killGraceMs + 2_000 : 500));
  const stderrMode = options.stderrMode ?? "pipe";
  const useHeadTail = options.headBytes !== undefined && options.tailBytes !== undefined;
  const maxBytes = options.maxOutputBytes ?? Number.POSITIVE_INFINITY;

  // 呼叫前就已中止：不要啟動子程序。
  if (options.signal?.aborted) return emptyAsyncResult(true);

  let child: ChildProcess;
  try {
    child = spawnChildProcess(options.command, [...options.args], {
      cwd: options.cwd,
      ...(options.env !== undefined ? { env: options.env } : {}),
      stdio: ["ignore", "pipe", stderrMode === "ignore" ? "ignore" : "pipe"],
      detached: group,
      windowsHide: true,
      shell: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProcessSpawnError(`啟動程序失敗：${message}`, errnoOf(error));
  }

  const stdoutCapture: StreamCapture = useHeadTail
    ? new BoundedCapture(options.headBytes!, options.tailBytes!)
    : createFullCapture(maxBytes);
  const stderrCapture: StreamCapture = useHeadTail
    ? new BoundedCapture(options.headBytes!, options.tailBytes!)
    : createFullCapture(maxBytes);

  // Buffer 的底層 ArrayBuffer 可能被 pool 重用，必須複製一份再分發。
  const copy = (chunk: Buffer): Uint8Array => new Uint8Array(chunk);
  if (child.stdout) {
    child.stdout.on("data", (chunk: Buffer) => {
      const owned = copy(chunk);
      stdoutCapture.push(owned);
      options.onStdoutChunk?.(owned);
    });
  }
  if (stderrMode === "pipe" && child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      const owned = copy(chunk);
      stderrCapture.push(owned);
      options.onStderrChunk?.(owned);
    });
  } else {
    child.stderr?.resume();
  }

  const childPid = child.pid;
  let timedOut = false;
  let abortFired = false;
  let settled = false;
  let killIssuedAt: number | undefined;
  let spawnError: ProcessSpawnError | undefined;
  let forceExit: (() => void) | undefined;
  let notifyClosed: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolve) => {
    notifyClosed = resolve;
  });
  const onClosed = (): void => {
    notifyClosed?.();
  };
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    forceExit = () => {
      resolve({ code: null, signal: null });
      notifyClosed?.();
    };
    if (group) {
      // 群組模式：leader 的 exit 就是結算起點，不等 close。
      // 背景子程序（dev server、watcher 這類）可能握著 pipe 使 close
      // 很久才到或不到，輸出收尾另外有界等待，不得誤判逾時。
      child.once("exit", (code, signal) => resolve({ code, signal }));
    } else {
      // 非群組：close 代表程序退出且 stdio 已關：已分發的 chunk 全部送達。
      child.once("close", (code, signal) => resolve({ code, signal }));
    }
    child.once("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      spawnError = new ProcessSpawnError(`啟動程序失敗：${message}`, errnoOf(error));
      notifyClosed?.();
      resolve({ code: null, signal: null });
    });
  });
  child.once("close", onClosed);

  // 逾時與取消都打整個群組（或單一程序）：先 SIGTERM，寬限期後 SIGKILL，
  // 再一個寬限期還沒結束就不再等，直接回傳（不留孤兒，也不卡住呼叫端）。
  // 升級計時器一律 unref：提前回傳也不會被取消，SIGKILL 照樣送達；
  // 只是不再用它們 hold 住事件迴圈。
  const killTimers: ReturnType<typeof setTimeout>[] = [];
  const clearKillTimers = () => {
    for (const timer of killTimers.splice(0)) clearTimeout(timer);
  };
  const trackKillTimer = (timer: ReturnType<typeof setTimeout>) => {
    if (typeof timer.unref === "function") timer.unref();
    killTimers.push(timer);
    return timer;
  };
  const killTree = (pid: number | undefined) => {
    if (pid === undefined) return;
    killIssuedAt = Date.now();
    signalTarget(pid, group, "SIGTERM");
    trackKillTimer(setTimeout(() => {
      signalTarget(pid, group, "SIGKILL");
    }, killGraceMs));
    // close 可能永不到（孤兒孫程序 hold 住 pipe）：有界等待後直接回傳，
    // 未送達的升級 SIGKILL 由 unref 計時器照樣送達。
    trackKillTimer(setTimeout(() => forceExit?.(), stopWaitMs));
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(childPid);
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  const abortSignal = options.signal;
  const handleAbort = () => {
    if (settled || timedOut) return;
    abortFired = true;
    clearTimeout(timer);
    killTree(childPid);
  };
  if (abortSignal) {
    abortSignal.addEventListener("abort", handleAbort, { once: true });
  }

  const exit = await exitPromise;
  settled = true;
  clearTimeout(timer);
  abortSignal?.removeEventListener("abort", handleAbort);
  if (timedOut || abortFired) {
    if (group) {
      // leader 退出不代表整組全死：確認群組終止才清升級計時器，否則留著
      // unref 計時器讓 SIGKILL 照樣送達。等待有上界，呼叫端不會被卡住。
      if (await waitForProcessGroupExit(childPid, killGraceMs + 2_000)) clearKillTimers();
    } else if (childPid === undefined || !isProcessAlive(childPid)) {
      // 程序已死：升級計時器無事可做，清掉。
      clearKillTimers();
    } else {
      // 有界回傳不得取消仍必要的升級終止：保留 unref 計時器，讓 SIGKILL
      // 在寬限後照樣送出（程序已死時送訊號走 ESRCH 容忍，不拋錯）；
      // 寬限已過而升級尚未送出時（stopWaitMs < killGraceMs 的組合），直接補送。
      if (killIssuedAt !== undefined && Date.now() - killIssuedAt >= killGraceMs) {
        signalTarget(childPid, group, "SIGKILL");
      }
    }
  }

  if (group) {
    // 群組輸出收尾：exit 之後有界等 close，close 先到就提前結束。
    // 背景子程序握著 pipe 時等到上限為止：不砍背景程序、不誤判逾時。
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closedPromise,
        new Promise<void>((resolve) => {
          drainTimer = setTimeout(resolve, GROUP_DRAIN_WAIT_MS);
        }),
      ]);
    } finally {
      if (drainTimer !== undefined) clearTimeout(drainTimer);
    }
  }

  // 結算後不拆監聽：沿用舊版持續消耗語意，背景輸出繼續被讀掉，
  // 寫端不會背壓阻塞；背景程序不受影響。
  // 生命週期限制（與舊版相同）：背景程序握著 pipe 時，宿主會保留該 pipe
  // 直到背景程序結束——函式本身有界回傳、不卡住呼叫端，但宿主程序要自然
  // 退出仍需等背景結束。這是既有限制，不是本次修復能消除的。
  if (spawnError) throw spawnError;

  const stdout = stdoutCapture.finalize();
  const stderr = stderrCapture.finalize();
  return {
    exitCode: timedOut ? null : exit.code,
    signal: exit.signal ?? null,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    timedOut,
    cancelled: abortFired && !timedOut,
    truncated: stdout.truncated || stderr.truncated,
  };
}

export function runHostProcessSync(options: HostProcessSyncOptions): HostProcessSyncResult {
  const maxBuffer = options.maxOutputBytes ?? DEFAULT_SYNC_MAX_BYTES;
  let result: ReturnType<typeof spawnSyncChildProcess>;
  try {
    result = spawnSyncChildProcess(options.command, [...options.args], {
      cwd: options.cwd,
      ...(options.env !== undefined ? { env: options.env } : {}),
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
      timeout: Math.max(1, Math.floor(options.timeoutMs)),
      encoding: "utf-8",
      maxBuffer,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: null, stdout: "", timedOut: false, truncated: false, error: `啟動程序失敗：${message}` };
  }
  const spawnError = result.error as NodeJS.ErrnoException | undefined;
  if (spawnError) {
    if (spawnError.code === "ETIMEDOUT") {
      return { exitCode: null, stdout: "", timedOut: true, truncated: false, error: `程序執行逾時（${options.timeoutMs}ms）` };
    }
    if (spawnError.code === "ENOBUFS") {
      return { exitCode: null, stdout: "", timedOut: false, truncated: true, error: "程序輸出超過上限，已中斷。" };
    }
    return { exitCode: null, stdout: "", timedOut: false, truncated: false, error: spawnError.message };
  }
  return {
    exitCode: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    timedOut: false,
    truncated: false,
  };
}

/** 宿主程序能力的真實作：OpenCode 適配器與合成宿主共用同一份機制。 */
export function createHostProcess(): HostProcess {
  return {
    run: (options) => runHostProcess(options),
    runSync: (options) => runHostProcessSync(options),
  };
}
