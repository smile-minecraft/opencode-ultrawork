/**
 * 工作階段位置解析：工具執行時以該次呼叫所在工作階段的位置為準。
 *
 * 順序是「工作階段的位置 → 外掛實例的位置」，不讀環境變數：
 * 每次執行以執行 context 的 sessionID 向 ctx.session.get 拿
 * session.location.directory，拿不到才退回
 * ctx.location.project?.directory ?? ctx.location.directory。
 *
 * isUnsafeRoot 沿用舊版黑名單（`/` / `""` / `"."` / `".."` / `/Users` /
 * `/Volumes`，另對 symlink 解析後的真實路徑套用同一份黑名單），禁止
 * 新增／移除項目，避免既有防呆失效。
 */

import type { Plugin } from "@opencode/plugin";
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { ToolExecutionContext } from "../../kit/define-tool.ts";

/** 判斷路徑是否屬於 unsafe root 黑名單；無法確認時一律 fail closed。 */
export function isUnsafeRoot(path: string): boolean {
  if (!path) return true;
  const resolved = resolve(path);
  // 嚴禁在根目錄或系統關鍵目錄建立狀態或啟動驗證工具。
  if (resolved === "/" || resolved === "" || resolved === "." || resolved === ".." || resolved === "/Users" || resolved === "/Volumes") {
    return true;
  }
  const real = resolveExistingRealpath(resolved);
  // 無法解析出任何存在祖先 → 無法確認 containment → fail closed。
  if (!real) return true;
  return real === "/" || real === "/Users" || real === "/Volumes";
}

/**
 * 回傳 target 的真實路徑；target 不存在時逐層向上找最近的存在祖先解析。
 * 連檔案系統根都無法解析時回傳 undefined（呼叫端 fail closed）。
 */
function resolveExistingRealpath(target: string): string | undefined {
  let current = target;
  for (;;) {
    try {
      return realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

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
