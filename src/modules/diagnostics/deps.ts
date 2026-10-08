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

import type { Host } from "../../host.ts";
import type { AgentRoleFileLookupResult } from "./shared.ts";
import { resolveAgentsRoot } from "../../settings/paths.ts";
import type { UltraworkSettings } from "../../settings/defaults.ts";
import { isModuleEnabled } from "../registry.ts";
import { createWorkflowRuntime, type FullUltraworkRuntimeContext } from "../workflow/index.ts";
import { TOOL_MODULES } from "./inventory.ts";

export interface DiagnosticsDeps {
  readonly host: Host;
  readonly settings: UltraworkSettings;
  readonly runtime: FullUltraworkRuntimeContext;
  /**
   * 全域設定資料夾，由宿主在組裝時明確提供。
   *
   * 專案根目錄就是這個資料夾時，兩層共用同一個 `.ultrawork/`，版控衛生檢查要把
   * 全域層的檔案排除（見 `shared.ts` 的 `isSameAsGlobalConfigDir`）。
   */
  readonly globalConfigDir: string;
  /** OpenCode 提供的唯讀角色檔查詢；其他宿主未提供時，呼叫端必須標 skipped。 */
  readonly agentRoleFiles?: {
    readonly agentsRoot: string;
    readonly lookup: (name: string) => AgentRoleFileLookupResult;
  };
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
 * `listRegisteredToolNames` 的實作把宿主清單收斂到「宣告屬於本外掛」的工具名：
 * 未收斂的話會把平台內建工具也算進來，永遠對不上凍結清單。
 * 回 null 代表平台不提供清單，呼叫端必須標 skipped。
 */
export function createDiagnosticsDeps(
  host: Host,
  settings: UltraworkSettings,
): DiagnosticsDeps {
  const runtime = createWorkflowRuntime(host, settings);
  const globalConfigDir = host.roots.globalConfigDirectory;
  const agentsRoot = resolveAgentsRoot(settings.skiller.agentsDir, globalConfigDir);
  return {
    host,
    settings,
    runtime,
    globalConfigDir,
    ...(host.capabilities.agentRoleFiles
      ? {
          agentRoleFiles: {
            agentsRoot,
            lookup: (name: string) => host.capabilities.agentRoleFiles!.lookup(agentsRoot, name),
          },
        }
      : {}),
    listRegisteredToolNames: async () => {
      try {
        const entries = await host.tools.list();
        if (entries === null) return null;
        // 用 hasOwn 而不是 `in`：`TOOL_MODULES` 是普通物件、繼承 `Object.prototype`，
        // `in` 會把 `constructor`／`toString` 這類平台內建 id 誤判成本外掛工具。
        return entries.map((entry) => entry.id).filter((id) => Object.hasOwn(TOOL_MODULES, id));
      } catch {
        return null;
      }
    },
  };
}
