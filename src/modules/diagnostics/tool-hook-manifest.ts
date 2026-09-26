/**
 * `tool_hook_manifest`：凍結介面的資料自檢與文件化輸出。
 *
 * 凍結介面（與舊版一致）：
 *   - 名稱 `tool_hook_manifest`；參數 `{ category?: string }`（可選過濾）。
 *   - 回傳外框走 `jsonResult`，`data` 內含 `ok / toolCount / hookCount /
 *     sourceCount / tools[] / hooks[] / sources[] / categories[] / humanSummary`。
 *   - `tools[]` 元素形狀 `{ name, category, source }`、`hooks[]` 形狀
 *     `{ name, wired }`、`sources[]` 形狀 `{ path, toolCount }`。
 *
 * 與舊版的落差：資料來源從 `plugins/.../tool-hook-manifest.ts` 的常數換成
 * `inventory.ts`（V2 的單一正式資料）。`category` 過濾、排序、來源聚合規則
 * 逐字沿用。舊版一律把 `wired` 當 true；V2 改由 settings 的模組開關推導，
 * 因為 V2 可以逐一關閉模組，一律 true 會是假訊號。
 *
 * 唯讀：只讀 inventory（純常數）與 settings。
 */

import { z } from "zod";
import { defineTool } from "../../kit/define-tool.ts";
import { jsonResult } from "../../kit/json.ts";
import { moduleEnabled, type DiagnosticsDeps } from "./deps.ts";
import { HOOK_NAMES, TOOL_CATEGORIES, TOOL_MODULES, TOOL_SOURCES, type HookName } from "./inventory.ts";

export interface ToolManifestEntry {
  name: string;
  category: string;
  source: string;
}

export interface HookManifestEntry {
  name: HookName;
  wired: boolean;
}

export interface SourceManifestEntry {
  path: string;
  toolCount: number;
}

export function createToolHookManifestTool(deps: DiagnosticsDeps) {
  return defineTool({
    name: "tool_hook_manifest",
    description:
      "自動產生 tool / hook / source manifest：列舉所有 active tool（含 category）+ event hook wiring 狀態 + 對應 source 檔路徑。可用於文件化、code review、版本對照。",
    inputSchema: z.object({
      category: z.string().optional(),
    }),
    execute: async (input) => {
      const categoryFilter = input.category?.trim() || undefined;

      // 只列啟用中模組的工具：關閉的模組不會註冊工具，列出來會是假的。
      const allNames = Object.keys(TOOL_SOURCES)
        .filter((name) => moduleEnabled(deps.settings, TOOL_MODULES[name]))
        .sort();

      const filtered = categoryFilter
        ? allNames.filter((name) => TOOL_CATEGORIES[name] === categoryFilter)
        : allNames;

      const tools: ToolManifestEntry[] = filtered.map((name) => ({
        name,
        category: TOOL_CATEGORIES[name] ?? "unknown",
        source: TOOL_SOURCES[name],
      }));

      const hooks: HookManifestEntry[] = HOOK_NAMES.map((name) => ({
        name,
        wired: hookWired(deps, name),
      }));

      // 來源聚合：多個工具共用同一個來源檔時合併計數。
      const sourceMap = new Map<string, number>();
      for (const tool of tools) {
        if (!tool.source) continue;
        sourceMap.set(tool.source, (sourceMap.get(tool.source) ?? 0) + 1);
      }
      const sources: SourceManifestEntry[] = Array.from(sourceMap.entries())
        .map(([path, toolCount]) => ({ path, toolCount }))
        .sort((a, b) => a.path.localeCompare(b.path));

      const categories = Array.from(new Set(tools.map((tool) => tool.category)));
      const humanSummary = [
        "Tool/Hook Manifest",
        `- tools: ${tools.length}`,
        `- hooks: ${hooks.length} (${hooks.filter((hook) => hook.wired).length} wired)`,
        `- sources: ${sources.length}`,
        `- categories: ${categories.join(", ")}`,
      ].join("\n");

      return jsonResult({
        ok: true,
        toolCount: tools.length,
        hookCount: hooks.length,
        sourceCount: sources.length,
        tools,
        hooks,
        sources,
        categories,
        humanSummary,
      });
    },
  });
}

/**
 * 單一 hook 的 wiring：對應模組開著就算有接線。
 *
 * 這是**依 `settings.modules` 推導的預估值，不是實際註冊的觀測值**：平台沒有
 * 提供「查詢某個 hook 有沒有真的被註冊」的 API。只註冊 diagnostics、卻把
 * commentSignal 開著的組合會推導出 `wired: true`，但實際上沒有該 hook。
 * 回傳欄位與輸出文字維持凍結介面不變，語意落差記在
 * `tests/v2/native/diagnostics/TEST-MAPPING.md`。
 */
function hookWired(deps: DiagnosticsDeps, name: HookName): boolean {
  const search = moduleEnabled(deps.settings, "search");
  const verification = moduleEnabled(deps.settings, "verification");
  const skills = moduleEnabled(deps.settings, "skills");
  const skiller = moduleEnabled(deps.settings, "skiller");
  const workflow = moduleEnabled(deps.settings, "workflow");
  const commentSignal = moduleEnabled(deps.settings, "commentSignal");
  const diagnostics = moduleEnabled(deps.settings, "diagnostics");
  switch (name) {
    case "event":
      return search || workflow || commentSignal || skiller;
    case "tool.execute.before":
      return workflow || commentSignal;
    case "tool.execute.after":
      return commentSignal;
    case "experimental.chat.system.transform":
      return skills || workflow;
    case "experimental.session.compacting":
      return workflow;
    case "tool.definition":
      return search || verification || skills || skiller || workflow || commentSignal || diagnostics;
    default:
      return false;
  }
}
