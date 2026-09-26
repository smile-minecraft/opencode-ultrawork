/**
 * diagnostics 模組：六個唯讀診斷工具。
 *
 * - `workflow_bootstrap`、`workflow_l1_check`、`workflow_doctor`、
 *   `workflow_health_check`、`tool_hook_manifest`、`ultrawork_selftest`。
 * - 開關開啟時註冊 6 個工具；關閉時完全不碰 ctx（`registerModules` 不會呼叫本檔）。
 * - 工具定義在 transform 外先建好，transform 回呼只做 `editor.add`，
 *   保持同步、可重播、無副作用；回傳的註冊由外掛卸載時 dispose。
 * - 唯讀不變條件：六個工具都不寫入任何檔案；`ultrawork_selftest` 也只呼叫
 *   這六個唯讀工具。
 *
 * 凍結介面的資料來源是同資料夾的 `inventory.ts`（48 工具／6 hook／11 分類／
 * 36 來源），由 `tests/v2/native/diagnostics/tool-parity.test.ts` 內嵌的凍結
 * 清單逐項比對鎖住。
 */

import type { DefinedTool } from "../../kit/define-tool.ts";
import type { ModuleDefinition, ModuleRuntime, Registration } from "../types.ts";
import { createDiagnosticsDeps } from "./deps.ts";
import { createToolHookManifestTool } from "./tool-hook-manifest.ts";
import { createUltraworkSelftestTool } from "./ultrawork-selftest.ts";
import { createWorkflowBootstrapTool } from "./workflow-bootstrap.ts";
import { createWorkflowDoctorTool } from "./workflow-doctor.ts";
import { createWorkflowHealthCheckTool } from "./workflow-health-check.ts";
import { createWorkflowL1CheckTool } from "./workflow-l1-check.ts";

export const diagnosticsModule: ModuleDefinition = {
  key: "diagnostics",
  register: (runtime: ModuleRuntime): Promise<Registration> => {
    const deps = createDiagnosticsDeps(runtime.ctx, runtime.settings);
    // selftest 需要能實際呼叫的工具定義；先建好前五個，再把 selftest 一起放進
    // toolMap，確保 `results[]` 反映的是同一批工具。
    const bootstrap = createWorkflowBootstrapTool(deps);
    const l1Check = createWorkflowL1CheckTool(deps);
    const doctor = createWorkflowDoctorTool(deps);
    const healthCheck = createWorkflowHealthCheckTool(deps);
    const manifest = createToolHookManifestTool(deps);
    const selftestToolMap: Record<string, DefinedTool> = {
      [bootstrap.name]: bootstrap,
      [l1Check.name]: l1Check,
      [doctor.name]: doctor,
      [healthCheck.name]: healthCheck,
      [manifest.name]: manifest,
    };
    const selftest = createUltraworkSelftestTool(deps, selftestToolMap);

    const tools: DefinedTool[] = [bootstrap, l1Check, doctor, healthCheck, manifest, selftest];
    return runtime.ctx.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool as never);
    });
  },
};

export { createDiagnosticsDeps, moduleEnabled, type DiagnosticsDeps } from "./deps.ts";
export { compareToolNameSets, type ToolCountComparison } from "./workflow-health-check.ts";
export { isSelfDiagnostic, __ultraworkSelftestInternals } from "./ultrawork-selftest.ts";
export {
  DIAGNOSTICS_TOOL_NAMES,
  EXPECTED_CATEGORIES,
  EXPECTED_SOURCE_PATHS,
  EXPECTED_TOOL_NAMES,
  HOOK_NAMES,
  TOOL_CATEGORIES,
  TOOL_MODULES,
  TOOL_SOURCES,
  type HookName,
  type ToolCategory,
} from "./inventory.ts";
