/**
 * commentSignal 模組：本次工具呼叫的工作階段位置解析。
 *
 * 順序是「工作階段的位置 → 外掛實例的位置」，不讀環境變數：
 * 每次執行以執行 context 的 sessionID 向 ctx.session.get 拿
 * session.location.directory，拿不到才退回
 * ctx.location.project?.directory ?? ctx.location.directory。
 * 跟 search／verification 同一套規則，行為一致才好追。
 */

import type { Plugin } from "@opencode/plugin";
import type { ToolExecutionContext } from "../../kit/define-tool.ts";

/** 本次工具呼叫所屬工作階段的位置；失敗時回傳 undefined，由呼叫端退回外掛實例位置。 */
async function sessionDirectoryOf(
  ctx: Plugin.Context,
  toolCtx: Pick<ToolExecutionContext, "sessionID">,
): Promise<string | undefined> {
  try {
    const get = (ctx.session as unknown as { get: (args: { sessionID: string }) => Promise<unknown> }).get;
    const session = (await get({ sessionID: toolCtx.sessionID })) as
      | { location?: { directory?: unknown } }
      | undefined;
    const directory = session?.location?.directory;
    if (typeof directory === "string" && directory.length > 0) return directory;
  } catch {
    // 讀不到工作階段就退回外掛位置，不讓工具直接失敗。
  }
  return undefined;
}

/** 解析本次執行的工作階段位置，拿不到時退回外掛實例的位置。 */
export async function resolveSessionDirectory(
  ctx: Plugin.Context,
  toolCtx: Pick<ToolExecutionContext, "sessionID">,
): Promise<string> {
  const candidates = await resolveDirectoryCandidates(ctx, toolCtx);
  return candidates[0] ?? "";
}

/**
 * 依序回傳候選基底目錄（去重保序）：工作階段位置 → 專案位置 → 外掛實例位置。
 * 鎖目錄等需要「第一個可用者」的場景逐一嘗試；跟 resolveSessionDirectory
 * 同一事實來源，行為一致。
 */
export async function resolveDirectoryCandidates(
  ctx: Plugin.Context,
  toolCtx: Pick<ToolExecutionContext, "sessionID">,
): Promise<string[]> {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0 && !out.includes(value)) out.push(value);
  };
  push(await sessionDirectoryOf(ctx, toolCtx));
  const location = ctx.location as { project?: { directory?: unknown }; directory?: unknown } | undefined;
  push(location?.project?.directory);
  push(location?.directory);
  return out;
}
