/**
 * 診斷模組的執行環境組裝。
 *
 * 六個工具都是唯讀，共用同一組依賴：workflow runtime（只取唯讀讀取與路徑解析）、
 * 合併後的設定（模組開關決定哪些檢查要標 skipped），以及平台實際註冊的工具
 * 清單讀取器。
 *
 * 為什麼用 workflow runtime 解析路徑：
 *   `.ultrawork/` 同時被 workflow 寫入端與 memory／comment-signal 使用。診斷端
 *   若自己發明一套根目錄解析，就會診斷到 workflow 沒在寫的目錄。用同一個
 *   `createWorkflowRuntime` 產物，讀到的位置與寫入端逐字一致。
 */

import type { Plugin } from "@opencode/plugin";
import type { UltraworkSettings } from "../../settings/defaults.ts";
import { isModuleEnabled } from "../registry.ts";
import { createWorkflowRuntime, type FullUltraworkRuntimeContext } from "../workflow/index.ts";
import { TOOL_MODULES } from "./inventory.ts";

export interface DiagnosticsDeps {
  readonly ctx: Plugin.Context;
  readonly settings: UltraworkSettings;
  readonly runtime: FullUltraworkRuntimeContext;
  /**
   * 平台實際註冊的工具清單。
   *
   * 來自 `ctx.tool.list()`（回「每次 transform 之後」的全部工具，含平台內建）。
   * 平台沒提供這個方法時回 null，呼叫端把 tool-set 比對標成 skipped 並寫明原因，
   * 不得靜默假裝比對過。
   */
  readonly listRegisteredToolNames: () => Promise<readonly string[] | null>;
}

/** 依模組開關判斷模組是否啟用；轉交 registry 的單一判斷，語意詳見該處。 */
export function moduleEnabled(settings: UltraworkSettings, key: string): boolean {
  return isModuleEnabled(settings, key);
}

/**
 * 組出診斷依賴。
 *
 * `listRegisteredToolNames` 的實作把平台清單收斂到「宣告屬於本外掛」的工具名：
 * 未收斂的話 `ctx.tool.list()` 會把平台內建工具也算進來，永遠對不上凍結清單。
 * 回 null 代表平台不提供清單，呼叫端必須標 skipped。
 */
export function createDiagnosticsDeps(
  ctx: Plugin.Context,
  settings: UltraworkSettings,
): DiagnosticsDeps {
  const runtime = createWorkflowRuntime(ctx, settings);
  const toolDomain = ctx.tool as unknown as { list?: () => Promise<readonly { id: string }[]> };
  return {
    ctx,
    settings,
    runtime,
    listRegisteredToolNames: async () => {
      if (typeof toolDomain?.list !== "function") return null;
      try {
        const entries = await toolDomain.list();
        // 用 hasOwn 而不是 `in`：`TOOL_MODULES` 是普通物件、繼承 `Object.prototype`，
        // `in` 會把 `constructor`／`toString` 這類平台內建 id 誤判成本外掛工具。
        return entries.map((entry) => entry.id).filter((id) => Object.hasOwn(TOOL_MODULES, id));
      } catch {
        return null;
      }
    },
  };
}
