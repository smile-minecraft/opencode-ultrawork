/**
 * opencode-ultrawork — 高風險任務稽核紀錄
 *
 * 角色：
 *   - 把高風險任務的申報、審查結論與收尾寫進一份只增不改的 JSON Lines 檔
 *     （`.ultrawork/audit.jsonl`）。
 *   - 回答的問題是「當時發生過什麼」，跟 tasks.json / plans.json 回答的
 *     「現在怎麼樣」刻意分開。
 *
 * 為什麼需要獨立的檔案：
 *   - `tasks.json` 的完成任務只留 `FINISHED_TASK_LIMIT`（5）筆，每筆任務的
 *     history 只留 `TASK_HISTORY_LIMIT`（3）行。這兩個上限對狀態檔是必要的，
 *     否則每次讀取都要解析一份無限成長的檔案；但它們也讓風險申報與審查結論
 *     在幾筆任務之後就查不到了。
 *   - 計畫的完成註記不受那 5 筆上限影響，可是它只對有關聯計畫的任務有效，
 *     獨立任務沒有地方掛。
 *   - 所以稽核證據需要一個不被裁剪、也不依賴計畫的落點。
 *
 * 對外規則（不可破壞）：
 *   - **只增不改**：一律 append，不覆寫、不裁剪、不輪替。只記高風險相關事件，
 *     所以成長速度很慢；日後真的需要控制大小時，應該按年份切檔，而不是裁掉
 *     最舊的紀錄——裁掉就回到現在這個問題本身了。
 *   - **fail-open**：寫入失敗不能擋住狀態機。但也不能靜默——`appendAuditEntry`
 *     回傳布林值，呼叫端要在失敗時給出提醒。
 *   - 每行是一個獨立的 JSON 物件，讀取端要容忍解析失敗的行（半行、舊格式），
 *     跳過就好，不要讓一行壞資料弄垮整份紀錄。
 *
 * 限制：
 *
 * @see ./context.ts                — AUDIT_LOG 路徑
 * @see ../tools/task-state-sync.ts — 唯一的寫入端
 */

import { appendFileSync } from "node:fs";
import type { ToolExecutionContext } from "../../../kit/define-tool.ts";
import { assertSafeContentRoot, assertSafeProjectFile } from "../content/content-store.ts";

type ToolContext = ToolExecutionContext;

/**
 * 稽核事件。
 *
 * 四種事件涵蓋高風險任務的完整生命週期：
 *   - `risk-declared`：申報為高風險（建立時申報或中途補報）。
 *   - `risk-downgrade-blocked`：有人試圖把已申報的高風險降級。這個動作在
 *     狀態機裡是靜默忽略的，不記下來就完全查不到。
 *   - `review`：每一次審查結論，包含被退回與重審。
 *   - `terminal`：收尾，不論是完成、失敗還是取消。
 */
export interface AuditEntry {
  event: "risk-declared" | "risk-downgrade-blocked" | "review" | "terminal";
  taskId: string;
  projectId: string;
  actor?: string;
  /** risk-declared：申報發生在哪個階段。 */
  phase?: "create" | "transition";
  /** risk-downgrade-blocked：被擋下的那個值。 */
  requestedRisk?: string;
  /** 審查事件：審查結論與說明。 */
  verdict?: string;
  reviewer?: string;
  note?: string;
  /** terminal：收尾狀態與當時的稽核快照。 */
  finalState?: string;
  risk?: string;
  reviewVerdict?: string;
  staleReview?: boolean;
  memoryDisposition?: { outcome: string | undefined; seq: number };
}

/** 提供寫入所需的最小 runtime 介面，避免與完整的 context 型別耦合。 */
export interface AuditLogRuntime {
  getPaths(context?: ToolContext): { MEMORY_DIR: string; AUDIT_LOG: string; PLANS_DIR: string };
  resolveProjectRoot(context?: ToolContext): string;
  ensureDir(path: string, context?: ToolContext): void;
}

/**
 * 追加一筆稽核紀錄。
 *
 * @returns `true` 表示已寫入；`false` 表示寫入失敗，呼叫端應該給出提醒。
 */
export function appendAuditEntry(
  runtime: AuditLogRuntime,
  entry: AuditEntry,
  context?: ToolContext,
): boolean {
  try {
    const root = runtime.resolveProjectRoot(context);
    const { MEMORY_DIR, AUDIT_LOG, PLANS_DIR } = runtime.getPaths(context);
    assertSafeContentRoot(root, PLANS_DIR);
    assertSafeProjectFile(root, PLANS_DIR, AUDIT_LOG);
    runtime.ensureDir(MEMORY_DIR, context);
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    appendFileSync(AUDIT_LOG, `${line}\n`, "utf-8");
    return true;
  } catch {
    // fail-open：稽核寫入失敗不該讓狀態轉換整個失敗，
    // 但呼叫端會依回傳值把這件事講出來，不會靜默。
    return false;
  }
}
