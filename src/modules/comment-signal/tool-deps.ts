/**
 * 7 個 tool factory 共用的執行期依賴：注入型別＋storage-backed 狀態。
 *
 * `store` 是本模組在 register 時建好的 CommentSignalStore；
 * 測試可直接用假 storage 建一個注入。
 */

import type { ToolExecutionContext } from "../../kit/define-tool.ts";
import type { CommentSignalStore } from "./state.ts";

export type { CommentSignalStore };

/**
 * 7 個 tool factory 共同的依賴注入。
 *   - `sourceResolver`：給定 (worktree, filePath) 回傳 source 或 null。
 *     `null` 表示該檔案無法讀取（不存在／已刪除／權限不足），此時
 *     `comment_signal_check` 會跳過該檔案（跟 guard.ts checkChangedFiles 一致）。
 *     越界路徑照舊丟錯（fail closed）。
 *   - `directoryResolver`：給定 (worktree, dirPath) 回傳該資料夾內所有檔案的
 *     相對路徑清單（僅檔案，不含資料夾）。未提供時 folder scan 走空清單。
 *   - `directoryInspector`：給定 (worktree, dirPath) 回傳 listing 語意類別，
 *     讓 tool-check 在 `directoryResolver` 回空陣列時區分 Markdown-only 與
 *     真正空／不支援的目錄。未提供時退回既有 `no_supported_files` 行為。
 *   - `today`：YYYY-MM-DD，給 validator／reporter 用；不填時各工具退回
 *     `"1970-01-01"`（跟舊版 production 行為一致）。
 *   - `resolveRoot`：本次工具呼叫的工作階段位置解析（非同步）。
 *   - `store`：storage-backed 工作階段狀態。
 */
export interface CommentSignalToolDeps {
  /** 讀檔函式：給定 worktree 根目錄＋相對檔案路徑，回傳檔案內容或 null。 */
  sourceResolver(worktree: string, filePath: string): string | null;
  /** 列舉資料夾：給定 worktree 根目錄＋相對資料夾路徑，回傳檔案相對路徑清單。 */
  directoryResolver?(worktree: string, dirPath: string): string[] | null;
  /** Inspect directory listing 語意類別；回傳 null 表示目錄不存在／不是資料夾。 */
  directoryInspector?(worktree: string, dirPath: string): string | null;
  /** today 字串（YYYY-MM-DD）。 */
  today?: string;
  /** 本次工具呼叫的工作階段位置；拿不到時退回外掛實例的位置。 */
  resolveRoot(toolCtx: Pick<ToolExecutionContext, "sessionID">): Promise<string>;
  /** storage-backed 工作階段狀態（register 時建好，測試可注入假 storage 版本）。 */
  store: CommentSignalStore;
}
