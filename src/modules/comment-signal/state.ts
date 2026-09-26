/**
 * commentSignal 模組：ctx.storage 上的工作階段狀態。
 *
 * 舊版放在 module-level Map，重載外掛就消失；這裡改存 storage，
 * 改設定觸發重新載入後狀態還在。API 全部非同步，語意跟舊版一致：
 * modifiedFiles 去重保序、warnings 以內容去重、ancestor 深度上限、
 * late-parent 回填、cycle 防護。
 *
 * key 配置：
 * - `session/<id>/comment-signal`：狀態本體
 *   `{ modifiedFiles, lastReport, fileReports, warnings }`
 *   - `lastReport`：最近一次 check 的 aggregate（展示用；結案 gate 不讀它）。
 *   - `fileReports`：每個修改過檔案的最新 per-file 報告（結案 gate 聚合用）。
 * - `session/<child>/comment-signal-parent`：父子對應 `{ parentID }`
 * - `session/tombstones/comment-signal`：已刪除工作階段 ID 清單（string[]）。
 *   刻意放在 `session/<id>/` 前綴之外：setup 層的 session.deleted 清理會
 *   清掉 `session/<id>/` 下所有 key，tombstone 必須存活才能擋住刪除後的
 *   late parent 事件讓已刪狀態復活。長度設上限並淘汰最舊。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionStateStore, type KeyValueStorage } from "../../state/store.ts";
import { ContentLockBusyError, withContentWriteLock } from "../../kit/write-lock.ts";
import type { CommentSignalReport, CommentSignalSeverity, FileReport } from "./types.ts";
import { migrateLegacyBlockingReports, UNATTRIBUTED_LEGACY_BLOCK_KEY } from "./completion-gate.ts";
import { assertSafeLockPath } from "./containment.ts";

/**
 * 單筆 pre-edit／post-edit warning。
 * createdAt 採 ISO-8601 字串，便於序列化與測試固定。
 */
export interface CommentSignalWarning {
  filePath: string;
  tag: string;
  severity: CommentSignalSeverity;
  message: string;
  createdAt: string;
}

/**
 * 最近一次「工作階段重掃」的實際結果。
 *
 * 存在的原因：`modifiedFiles` 非空**不代表**有可掃描的檔案——清單裡可能
 * 只有 Markdown、隱藏檔或已被刪除的檔案，那種重掃會掃到 0 個檔。結案
 * 訊息要據此告訴操作者「重掃工作階段沒用、請改掃整個專案」，靠的是這份
 * 實際掃描結果，而不是猜。
 */
export interface CommentSignalSweep {
  /** 該次重掃實際掃到的檔案數。 */
  scannedFileCount: number;
  /** ISO-8601 時間字串，便於序列化與觀察。 */
  at: string;
}

/**
 * 單一工作階段的 Comment Signal 狀態容器。
 * 內容結構跟舊版一致，只是改由 storage 讀寫、不再回傳共用 reference。
 */
export interface CommentSignalState {
  /** 對應工作階段 ID；亦作為 storage key 的一部分。 */
  sessionID: string;
  /** 該工作階段修改過的檔案路徑（去重、保留首次記錄順序）。 */
  modifiedFiles: string[];
  /** 最近一次 check 結果；初次為 null（展示用，結案 gate 改讀 fileReports）。 */
  lastReport: CommentSignalReport | null;
  /**
   * 每個修改過檔案的最新 per-file 報告（key 為檔案路徑）。
   * 結案 gate 的聚合對象：任一已修改檔案的最新報告 `shouldBlockCompletion`
   * 為真即阻斷；該檔修好後的乾淨報告會覆蓋舊阻斷，不會永久誤擋。
   */
  fileReports: Record<string, FileReport>;
  /** pre-edit／post-edit warnings 累積清單。 */
  warnings: CommentSignalWarning[];
  /**
   * 最近一次工作階段重掃的實際結果（沒掃過則為 null）。
   *
   * 選填是因為這個欄位不參與任何掃描判定：`checkChangedFiles` 之類的函式
   * 只吃「臨時組出來的狀態物件」，那些物件不需要帶掃描紀錄。從 storage
   * 讀出的狀態一律會正規化成明確的 null。
   */
  sweep?: CommentSignalSweep | null;
}

/** 狀態本體的 storage kind（key 後段）。 */
export const COMMENT_SIGNAL_STATE_KIND = "comment-signal";

/** 父子對應的 storage kind（key 後段）。 */
export const COMMENT_SIGNAL_PARENT_KIND = "comment-signal-parent";

/** ancestor 追溯深度上限：損壞的 event 資料不會讓追溯變成無限迴圈。 */
export const MAX_SESSION_ANCESTOR_DEPTH = 64;

/** 已刪除工作階段 tombstone 的 storage key（單一文件，string[]）。 */
const TOMBSTONE_KEY = "session/tombstones/comment-signal";

/** 狀態寫入鎖檔名：放該工作階段所在專案的 `.ultrawork/cache/locks/` 下。 */
export const STATE_LOCK_FILENAME = "comment-signal-state.lock";

/** 搶鎖忙碌時重試間隔（ms）：首輪即時，之後 50→100→200，總計約 0.35 秒。 */
const LOCK_RETRY_DELAYS_MS = [0, 50, 100, 200];

/** tombstone 上限：超過時淘汰最舊（ID 唯一且短，實務上到不了）。 */
const TOMBSTONE_CAP = 1000;

function freshState(sessionID: string): CommentSignalState {
  return { sessionID, modifiedFiles: [], lastReport: null, fileReports: {}, warnings: [], sweep: null };
}

/** 寬容正規化重掃紀錄：形狀不合回 null（等同沒掃過）。 */
function normalizeSweep(stored: unknown): CommentSignalSweep | null {
  if (!stored || typeof stored !== "object") return null;
  const candidate = stored as Partial<CommentSignalSweep>;
  if (typeof candidate.scannedFileCount !== "number" || !Number.isFinite(candidate.scannedFileCount)) {
    return null;
  }
  return {
    scannedFileCount: candidate.scannedFileCount,
    at: typeof candidate.at === "string" ? candidate.at : "",
  };
}

/** 寬容正規化 per-file 報告：形狀不合的 entry 直接丟棄（舊狀態無此欄位時回空）。 */
function normalizeFileReports(stored: unknown): Record<string, FileReport> {
  if (!stored || typeof stored !== "object") return {};
  const out: Record<string, FileReport> = {};
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof key !== "string" || !value || typeof value !== "object") continue;
    const candidate = value as Partial<FileReport>;
    if (typeof candidate.filePath !== "string" || typeof candidate.shouldBlockCompletion !== "boolean") continue;
    out[key] = {
      filePath: candidate.filePath,
      scanned: candidate.scanned ?? true,
      signals: Array.isArray(candidate.signals) ? candidate.signals : [],
      violations: Array.isArray(candidate.violations) ? candidate.violations : [],
      highRisk: Array.isArray(candidate.highRisk) ? candidate.highRisk : [],
      shouldBlockCompletion: candidate.shouldBlockCompletion,
      errorCount: typeof candidate.errorCount === "number" ? candidate.errorCount : 0,
      warningCount: typeof candidate.warningCount === "number" ? candidate.warningCount : 0,
      highRiskCount: typeof candidate.highRiskCount === "number" ? candidate.highRiskCount : 0,
    };
  }
  return out;
}

function normalizeState(sessionID: string, stored: unknown): CommentSignalState {
  const base = freshState(sessionID);
  if (!stored || typeof stored !== "object") return base;
  const raw = stored as Partial<CommentSignalState>;
  return {
    sessionID,
    modifiedFiles: Array.isArray(raw.modifiedFiles)
      ? raw.modifiedFiles.filter((item): item is string => typeof item === "string")
      : [],
    lastReport: (raw.lastReport as CommentSignalReport | null) ?? null,
    // 舊版狀態的阻斷先遷移成 per-file 記錄，再被真的 per-file 報告蓋掉。
    // 順序不能顛倒：這裡是「讀舊狀態」的唯一入口，只要缺了遷移，舊版阻斷
    // 就會被這行補出的空 `fileReports` 蓋掉，之後再也沒有人看得到它。
    fileReports: {
      ...migrateLegacyBlockingReports(stored),
      ...normalizeFileReports(raw.fileReports),
    },
    warnings: Array.isArray(raw.warnings)
      ? (raw.warnings as CommentSignalWarning[]).filter(
          (item) => item && typeof item.filePath === "string",
        )
      : [],
    sweep: normalizeSweep(raw.sweep),
  };
}

function appendModifiedFile(state: CommentSignalState, filePath: string): void {
  if (!state.modifiedFiles.includes(filePath)) state.modifiedFiles.push(filePath);
}

function warningKey(warning: CommentSignalWarning): string {
  return [warning.filePath, warning.tag, warning.severity, warning.message, warning.createdAt].join("\u0000");
}

function appendWarning(state: CommentSignalState, warning: CommentSignalWarning): void {
  const key = warningKey(warning);
  if (!state.warnings.some((item) => warningKey(item) === key)) state.warnings.push(warning);
}

/**
 * storage 上的 Comment Signal 狀態。
 * 一個 register 建一個實例，測試直接用假 storage 建。
 *
 * 並行安全：所有 mutation 都走 store-wide 序列化佇列（async mutex），
 * 再疊 kit 檔案鎖跨行程互斥（有鎖配置時）。無鎖配置維持 in-process 行為；
 * 有配置而取不到鎖時放棄本次記錄（安全預設＋警告），絕不無鎖寫入。
 */
export interface CommentSignalStoreOptions {
  /**
   * 跨行程序列化用的鎖目錄解析器：回傳該工作階段所在專案的鎖目錄
   *（如 `<project>/.ultrawork/cache/locks`），檔名見 STATE_LOCK_FILENAME。
   * 兩者都未提供時維持既有行為（in-process mutex；測試／舊路徑用）。
   * 有配置但解析不到／建不起鎖目錄時，本次 mutation 不執行（安全預設＋警告），
   * 絕不退回無鎖寫入（否則跨實例遺失更新且無聲）。
   */
  resolveLockDir?: (sessionID: string) => Promise<string | null>;
  /** 方便測試：固定鎖目錄（等同於常回此目錄的 resolver）。 */
  lockDir?: string;
}

export class CommentSignalStore {
  private readonly sessions: SessionStateStore;
  private readonly options: CommentSignalStoreOptions;
  private storeLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: KeyValueStorage,
    options: CommentSignalStoreOptions = {},
  ) {
    this.sessions = new SessionStateStore(storage);
    this.options = options;
  }

  /**
   * store-wide 序列化：fn 的本體（含 ancestors 寫入）一次只跑一個。
   * tail 鏈永不 reject（只閘門 gate），等待者不會被前一個失敗卡住。
   */
  private async withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.storeLock;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.storeLock = prev.then(() => gate);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 跨行程臨界區（kit 寫入鎖）：同機多行程同時只有一組 mutation 在跑。
   * 呼叫端一律先經外層 withStoreLock（同實例快徑），再進這裡跨實例互斥。
   * - 無鎖配置 → 直接執行（維持既有 in-process 行為；測試／舊路徑用）。
   * - 有配置但解析不到／建不起鎖目錄 → 不執行，回 null＋警告（絕不退回
   *   無鎖寫入，否則跨實例遺失更新且無聲）。
   * - 搶鎖忙碌 → 有界重試（總計約 0.2–0.5 秒）→ 仍失敗則放棄本次記錄
   *   （回 null；呼叫端轉為安全預設，絕不 throw，工具執行不受影響）。
   * - 本體 fn 的錯誤原樣拋出（跟既有語意一致，不吞錯）。
   * - 退化警告 per-store 只發一次，避免刷屏。
   */
  private lockWarned = false;

  /** 退化警告：per-store 只發一次，避免刷屏。 */
  private warnLockDegraded(message: string): void {
    if (this.lockWarned) return;
    this.lockWarned = true;
    console.warn(`[ultrawork] comment-signal ${message}`);
  }

  private async withFileLock<T>(sessionID: string, fn: () => Promise<T>): Promise<T | null> {
    const hasLockConfig = this.options.lockDir !== undefined || this.options.resolveLockDir !== undefined;
    if (!hasLockConfig) return fn();
    let lockDir: string | null = null;
    try {
      if (this.options.lockDir !== undefined) lockDir = this.options.lockDir;
      else if (this.options.resolveLockDir !== undefined) lockDir = await this.options.resolveLockDir(sessionID);
    } catch {
      lockDir = null;
    }
    if (!lockDir) {
      this.warnLockDegraded("寫入鎖目錄解析失敗，本次記錄放棄（degraded，不影響工具執行）。");
      return null;
    }
    const lockPath = join(lockDir, STATE_LOCK_FILENAME);
    try {
      assertSafeLockPath(lockDir, lockPath);
    } catch {
      this.warnLockDegraded("寫入鎖路徑拒絕 symlink 或越界路徑，本次記錄放棄（degraded，不影響工具執行）。");
      return null;
    }
    try {
      mkdirSync(lockDir, { recursive: true });
    } catch {
      this.warnLockDegraded("寫入鎖目錄建立失敗，本次記錄放棄（degraded，不影響工具執行）。");
      return null;
    }
    for (const delay of LOCK_RETRY_DELAYS_MS) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        return await withContentWriteLock(lockPath, fn);
      } catch (error) {
        if (!(error instanceof ContentLockBusyError)) throw error;
        // 忙碌 → 下一輪重試；配額用完就放棄。
      }
    }
    this.warnLockDegraded("寫入鎖忙碌，有界重試後放棄本次記錄（degraded，不影響工具執行）。");
    return null;
  }

  private async readState(sessionID: string): Promise<CommentSignalState> {
    const stored = await this.sessions.getSession(sessionID, COMMENT_SIGNAL_STATE_KIND);
    return normalizeState(sessionID, stored);
  }

  private async writeState(state: CommentSignalState): Promise<void> {
    await this.sessions.setSession(state.sessionID, COMMENT_SIGNAL_STATE_KIND, {
      modifiedFiles: state.modifiedFiles,
      lastReport: state.lastReport,
      fileReports: state.fileReports,
      warnings: state.warnings,
      sweep: state.sweep,
    });
  }

  private async readParent(sessionID: string): Promise<string | undefined> {
    const stored = await this.sessions.getSession(sessionID, COMMENT_SIGNAL_PARENT_KIND);
    const parentID = (stored as { parentID?: unknown } | null)?.parentID;
    return typeof parentID === "string" && parentID.length > 0 ? parentID : undefined;
  }

  private async readTombstones(): Promise<string[]> {
    const stored = await this.storage.get(TOMBSTONE_KEY);
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  }

  /** 已刪除的工作階段是否在 tombstone 內（呼叫端須在 withStoreLock 內使用）。 */
  private async isTombstoned(sessionID: string): Promise<boolean> {
    return (await this.readTombstones()).includes(sessionID);
  }

  /** 記下已刪除的工作階段 ID（呼叫端須在 withStoreLock 內使用）。 */
  private async addTombstone(sessionID: string): Promise<void> {
    const next = [...(await this.readTombstones()).filter((id) => id !== sessionID), sessionID];
    while (next.length > TOMBSTONE_CAP) next.shift();
    await this.storage.set(TOMBSTONE_KEY, next);
  }

  /**
   * 斷開所有 child→sessionID 的 parent 對應（呼叫端須在 withStoreLock 內使用）。
   * 只斷 direct children：聚合一律走現存 mapping，斷開後更深層也到不了已刪節點。
   */
  private async detachChildren(sessionID: string): Promise<void> {
    const suffix = `/${COMMENT_SIGNAL_PARENT_KIND}`;
    let after: string | undefined;
    for (;;) {
      const result = await this.storage.scan({ prefix: "session/", after });
      for (const entry of result.entries) {
        if (!entry.key.endsWith(suffix)) continue;
        const childID = entry.key.slice("session/".length, -suffix.length);
        if (!childID || childID === sessionID) continue;
        if ((await this.readParent(childID)) === sessionID) {
          await this.sessions.removeSession(childID, COMMENT_SIGNAL_PARENT_KIND);
        }
      }
      if (result.next === undefined) break;
      after = result.next;
    }
  }

  /**
   * 回傳 direct parent 到 root 的 ancestor ID。
   * 遇到 cycle 或異常深度時停止，避免損壞的 event 資料造成無限迴圈。
   */
  async getSessionAncestors(sessionID: string): Promise<string[]> {
    const ancestors: string[] = [];
    const seen = new Set<string>([sessionID]);
    let current = await this.readParent(sessionID);
    while (current && ancestors.length < MAX_SESSION_ANCESTOR_DEPTH && !seen.has(current)) {
      ancestors.push(current);
      seen.add(current);
      current = await this.readParent(current);
    }
    return ancestors;
  }

  /**
   * 註冊父子工作階段關係。若 child 在 event 抵達前已修改檔案，
   * 會立即把既有 modifiedFiles／fileReports／warnings 回填到所有 ancestor。
   * parent 已刪除（tombstone）時拒絕，避免 late event 讓已刪狀態復活。
   */
  async registerSessionParent(sessionID: string, parentID: string): Promise<boolean> {
    return this.withStoreLock(async () =>
      (await this.withFileLock(sessionID, async () => {
        const child = sessionID.trim();
        const parent = parentID.trim();
        if (!child || !parent || child === parent) return false;
        // parent 或 child 任一已刪除都拒絕：late created/updated 不得讓已刪節點復活或重掛。
        if (await this.isTombstoned(parent)) return false;
        if (await this.isTombstoned(child)) return false;
        if ((await this.getSessionAncestors(parent)).includes(child)) return false;

        await this.sessions.setSession(child, COMMENT_SIGNAL_PARENT_KIND, { parentID: parent });
        const childState = await this.readState(child);
        if (
          childState.modifiedFiles.length === 0 &&
          childState.warnings.length === 0 &&
          Object.keys(childState.fileReports).length === 0
        ) {
          return true;
        }

        for (const ancestorID of await this.getSessionAncestors(child)) {
          const ancestor = await this.readState(ancestorID);
          for (const filePath of childState.modifiedFiles) appendModifiedFile(ancestor, filePath);
          for (const [filePath, fileReport] of Object.entries(childState.fileReports)) {
            ancestor.fileReports[filePath] = fileReport;
          }
          for (const warning of childState.warnings) appendWarning(ancestor, warning);
          await this.writeState(ancestor);
        }
        return true;
      })) ?? false,
    );
  }

  /** 移除工作階段的 parent 對應；不清除已向 ancestor 聚合的稽核資料。 */
  async unregisterSessionParent(sessionID: string): Promise<void> {
    return this.withStoreLock(async () => {
      await this.withFileLock(sessionID, async () => {
        await this.sessions.removeSession(sessionID, COMMENT_SIGNAL_PARENT_KIND);
      });
    });
  }

  /**
   * 記錄工作階段修改過的檔案路徑。同檔案重複記錄會去重（保留首次順序），
   * 並同步聚合到所有 ancestor。
   */
  async recordModifiedFile(sessionID: string, filePath: string): Promise<CommentSignalState> {
    return this.withStoreLock(async () =>
      (await this.withFileLock(sessionID, async () => {
        // 已刪除的工作階段不再接受記錄（late edit 不得重建狀態、不得污染 parent）。
        if (await this.isTombstoned(sessionID)) return freshState(sessionID);
        const state = await this.readState(sessionID);
        appendModifiedFile(state, filePath);
        await this.writeState(state);
        for (const ancestorID of await this.getSessionAncestors(sessionID)) {
          const ancestor = await this.readState(ancestorID);
          appendModifiedFile(ancestor, filePath);
          await this.writeState(ancestor);
        }
        return state;
      })) ?? freshState(sessionID),
    );
  }

  /** 取得工作階段修改過的檔案路徑清單（defensive copy）。 */
  async getModifiedFiles(sessionID: string): Promise<string[]> {
    return (await this.readState(sessionID)).modifiedFiles;
  }

  /** 清空工作階段的 modifiedFiles。對不存在的工作階段不拋錯。 */
  async clearModifiedFiles(sessionID: string): Promise<void> {
    return this.withStoreLock(async () => {
      await this.withFileLock(sessionID, async () => {
        const state = await this.readState(sessionID);
        state.modifiedFiles = [];
        await this.writeState(state);
      });
    });
  }

  /** 寫入最近一次的檢查結果；後續呼叫會覆蓋。 */
  async recordLastReport(sessionID: string, report: CommentSignalReport): Promise<CommentSignalState> {
    return this.withStoreLock(async () =>
      (await this.withFileLock(sessionID, async () => {
        const state = await this.readState(sessionID);
        state.lastReport = report;
        await this.writeState(state);
        return state;
      })) ?? freshState(sessionID),
    );
  }

  /** 取得最近一次檢查結果；無則回傳 null。 */
  async getLastReport(sessionID: string): Promise<CommentSignalReport | null> {
    return (await this.readState(sessionID)).lastReport;
  }

  /** 清空工作階段的 lastReport。 */
  async clearLastReport(sessionID: string): Promise<void> {
    return this.withStoreLock(async () => {
      await this.withFileLock(sessionID, async () => {
        const state = await this.readState(sessionID);
        state.lastReport = null;
        await this.writeState(state);
      });
    });
  }

  /**
   * 寫入單一檔案的最新 per-file 報告；後續同檔寫入會覆蓋（含乾淨報告覆蓋
   * 舊阻斷：問題修好後 gate 不再誤擋），並同步聚合到所有 ancestor
   *（子工作階段的阻斷／清除都會即時反映到父工作階段）。
   */
  async recordFileReport(
    sessionID: string,
    filePath: string,
    report: FileReport,
  ): Promise<CommentSignalState> {
    return this.withStoreLock(async () =>
      (await this.withFileLock(sessionID, async () => {
        // 已刪除的工作階段不再接受記錄（late edit 不得重建狀態、不得污染 parent）。
        if (await this.isTombstoned(sessionID)) return freshState(sessionID);
        const state = await this.readState(sessionID);
        state.fileReports[filePath] = report;
        await this.writeState(state);
        for (const ancestorID of await this.getSessionAncestors(sessionID)) {
          const ancestor = await this.readState(ancestorID);
          ancestor.fileReports[filePath] = report;
          await this.writeState(ancestor);
        }
        return state;
      })) ?? freshState(sessionID),
    );
  }

  /**
   * 記下最近一次「工作階段重掃」的實際掃描結果。
   *
   * 供結案訊息判斷用：`modifiedFiles` 非空不代表有可掃描檔（可能全是
   * Markdown、隱藏檔或已刪除檔），只有實際掃描結果能說明「重掃工作階段
   * 會不會掃到東西」。純記錄，不影響任何阻斷判定。
   */
  async recordSessionSweep(sessionID: string, scannedFileCount: number): Promise<void> {
    return this.withStoreLock(async () => {
      await this.withFileLock(sessionID, async () => {
        if (await this.isTombstoned(sessionID)) return;
        const state = await this.readState(sessionID);
        state.sweep = { scannedFileCount, at: new Date().toISOString() };
        await this.writeState(state);
      });
    });
  }

  /**
   * 解除**本工作階段自己**的「無法歸檔的舊版阻斷」標記。
   *
   * 解除權限刻意只給標記的擁有者：掃描範圍是某個工作階段時，它證明的也只
   * 是那個工作階段的檔案乾淨。連帶清掉 ancestor 的標記等於讓別人的掃描為
   * 自己的阻斷背書——子工作階段的掃描根本不涵蓋父工作階段的檔案，這是漏放。
   * 父層的標記只能由父工作階段自己的完整乾淨重掃解除。
   *
   * 呼叫條件由 `comment_signal_check` 把關：只有在一次**涵蓋整個工作階段
   * 修改檔**（或整個專案）的重掃回報乾淨時才呼叫。局部掃描不足以代表真相
   * 已重新確立，所以不能解除。
   *
   * 可歸檔的舊版阻斷不走這裡：它已經是普通 per-file 記錄，該檔被重新檢查
   * 並寫入乾淨報告時就自然覆蓋掉了。
   */
  async dischargeUnattributedLegacyBlock(sessionID: string): Promise<void> {
    return this.withStoreLock(async () => {
      await this.withFileLock(sessionID, async () => {
        const state = await this.readState(sessionID);
        if (state.fileReports[UNATTRIBUTED_LEGACY_BLOCK_KEY] === undefined) return;
        delete state.fileReports[UNATTRIBUTED_LEGACY_BLOCK_KEY];
        await this.writeState(state);
      });
    });
  }

  /** 取得每檔最新 per-file 報告（defensive copy）。 */
  async getFileReports(sessionID: string): Promise<Record<string, FileReport>> {
    const stored = (await this.readState(sessionID)).fileReports;
    const out: Record<string, FileReport> = {};
    for (const [filePath, report] of Object.entries(stored)) {
      out[filePath] = {
        ...report,
        signals: [...report.signals],
        violations: [...report.violations],
        highRisk: [...report.highRisk],
      };
    }
    return out;
  }

  /** 推入一筆 warning（累積模式，不覆蓋；同內容去重）。 */
  async recordWarning(sessionID: string, warning: CommentSignalWarning): Promise<CommentSignalState> {
    return this.withStoreLock(async () =>
      (await this.withFileLock(sessionID, async () => {
        if (await this.isTombstoned(sessionID)) return freshState(sessionID);
        const state = await this.readState(sessionID);
        appendWarning(state, warning);
        await this.writeState(state);
        for (const ancestorID of await this.getSessionAncestors(sessionID)) {
          const ancestor = await this.readState(ancestorID);
          appendWarning(ancestor, warning);
          await this.writeState(ancestor);
        }
        return state;
      })) ?? freshState(sessionID),
    );
  }

  /** 取得工作階段的 warnings 累積清單（defensive copy）。 */
  async getWarnings(sessionID: string): Promise<CommentSignalWarning[]> {
    return (await this.readState(sessionID)).warnings;
  }

  /** 清空工作階段的 warnings。 */
  async clearWarnings(sessionID: string): Promise<void> {
    return this.withStoreLock(async () => {
      await this.withFileLock(sessionID, async () => {
        const state = await this.readState(sessionID);
        state.warnings = [];
        await this.writeState(state);
      });
    });
  }

  /**
   * 完整清除指定工作階段的狀態（modifiedFiles／lastReport／fileReports／
   * warnings／parent 對應），
   * 並斷開所有 child→本工作階段的 mapping（否則 child 之後 edit 會把已刪狀態重建），
   * 最後記 tombstone：之後的 late parent 事件不得再以本工作階段為 parent 註冊。
   * 對不存在的工作階段不拋錯；之後讀取會拿到全新空狀態。
   */
  async clearSession(sessionID: string): Promise<void> {
    return this.withStoreLock(async () => {
      await this.withFileLock(sessionID, async () => {
        await this.sessions.removeSession(sessionID, COMMENT_SIGNAL_STATE_KIND);
        await this.sessions.removeSession(sessionID, COMMENT_SIGNAL_PARENT_KIND);
        await this.detachChildren(sessionID);
        await this.addTombstone(sessionID);
      });
    });
  }

  /** 等效 clearSession；alias 方便 hook 注入時的語意清晰（重置整個狀態）。 */
  async resetCommentSignalState(sessionID: string): Promise<void> {
    await this.clearSession(sessionID);
  }

  /**
   * 測試 helper：清除所有 Comment Signal 狀態與 parent 對應。
   * 生產程式碼不應呼叫（會清掉其他工作階段的狀態）。
   */
  async clearAllSessions(): Promise<void> {
    return this.withStoreLock(async () => {
      let after: string | undefined;
      for (;;) {
        const result = await this.storage.scan({ prefix: "session/", after });
        for (const entry of result.entries) {
          if (
            entry.key.endsWith(`/${COMMENT_SIGNAL_STATE_KIND}`) ||
            entry.key.endsWith(`/${COMMENT_SIGNAL_PARENT_KIND}`) ||
            entry.key === TOMBSTONE_KEY
          ) {
            await this.storage.remove(entry.key);
          }
        }
        if (result.next === undefined) break;
        after = result.next;
      }
    });
  }
}
