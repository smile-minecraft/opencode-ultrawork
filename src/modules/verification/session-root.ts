/**
 * 工作階段位置解析：工具執行時以該次呼叫所在工作階段的位置為準。
 *
 * 順序是「工作階段的位置 → 外掛實例的位置」，不讀環境變數：
 * 每次執行以執行 context 的 sessionID 向 ctx.session.get 拿
 * session.location.directory，拿不到才退回
 * ctx.location.project?.directory ?? ctx.location.directory。
 *
 * isUnsafeRoot 只有 kit 一份（`src/kit/path-guard.ts`：`/`／`""`／`"."`／
 * `".."`／`/Users`／`/Volumes`／家目錄本身，另對 symlink 解析後的真實路徑
 * 套用同一份黑名單）。家目錄入列是使用者裁定：一致性優先於個別工具的好用度，
 * 讀取類工具同樣拒絕；這裡只轉匯出，不再自帶黑名單。
 */

import type { Plugin } from "@opencode/plugin";
import type { ToolExecutionContext } from "../../kit/define-tool.ts";

export { isUnsafeRoot } from "../../kit/path-guard.ts";

/** 本次工具呼叫所屬工作階段的位置；失敗時回傳 undefined，由呼叫端退回外掛實例位置。 */
async function sessionDirectoryOf(ctx: Plugin.Context, toolCtx: ToolExecutionContext): Promise<string | undefined> {
  try {
    const session = await ctx.session.get({ sessionID: toolCtx.sessionID });
    const directory = (session as { location?: { directory?: unknown } } | null | undefined)?.location?.directory;
    if (typeof directory === "string" && directory) return directory;
  } catch {
    // 取不到工作階段就退回外掛實例的位置。
  }
  return undefined;
}

/** 解析本次執行的工作階段位置，拿不到時退回外掛實例的位置。 */
export async function resolveSessionDirectory(ctx: Plugin.Context, toolCtx: ToolExecutionContext): Promise<string> {
  const fromSession = await sessionDirectoryOf(ctx, toolCtx);
  if (fromSession) return fromSession;
  const location = ctx.location as { project?: { directory?: unknown }; directory?: unknown } | undefined;
  const projectDirectory = location?.project?.directory;
  if (typeof projectDirectory === "string" && projectDirectory) return projectDirectory;
  const directory = location?.directory;
  if (typeof directory === "string" && directory) return directory;
  return "";
}
