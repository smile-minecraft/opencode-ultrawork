/**
 * skiller 模組：11 個技能生命週期工具。
 *
 * 工具在 register 之外先建立，transform 回呼只同步加入 editor；關閉模組時
 * 不會建立 factory，也不會碰宿主。正式 roots 全部由 settings 與 V2 全域
 * 設定資料夾解析，工具輸入沒有 path、root 或 destination 欄位。
 */

import { join } from "node:path";
import type { ToolExecutionContext } from "../../kit/define-tool.ts";
import { expandHome, resolveAgentsRoot, resolveGlobalUltraworkDir } from "../../settings/paths.ts";
import type { HostRegistration } from "../../host.ts";
import type { ModuleDefinition, ModuleRuntime } from "../types.ts";
import { createSkillerDraftTool } from "./skiller-draft.ts";
import { createSkillerDraftDeleteTool, createSkillerDraftReadTool, createSkillerDraftUpdateTool } from "./skiller-draft-ops.ts";
import { createSkillerImportTool, type SkillerImportDeps } from "./skiller-import.ts";
import { createSkillerPolicyUpdateTool } from "./skiller-policy-update.ts";
import { createSkillerPromoteTool } from "./skiller-promote.ts";
import { createSkillerRestoreTool } from "./skiller-restore.ts";
import { createSkillerRetireTool } from "./skiller-retire.ts";
import { createSkillerScanTool } from "./skiller-scan.ts";
import { createSkillerValidateTool } from "./skiller-validate.ts";
import type { SkillerDeps, SkillerRootOverrides } from "./skiller-common.ts";

function productionRoots(runtime: ModuleRuntime): SkillerRootOverrides {
  const globalDir = runtime.host.roots.globalConfigDirectory;
  const ultraworkDir = resolveGlobalUltraworkDir(globalDir);
  const settings = runtime.settings.skiller;
  const agentsRoot = resolveAgentsRoot(settings.agentsDir, globalDir);
  return {
    personalSkillRoot: expandHome(settings.personalSkillRoot),
    personalDraftRoot: join(ultraworkDir, "skill-drafts"),
    personalQuarantineRoot: join(ultraworkDir, "skill-quarantine"),
    policyPath: join(ultraworkDir, "skills-policy.json"),
    personalPinsPath: join(ultraworkDir, "skills-personal.json"),
    agentsRoot,
  };
}

function createDeps(runtime: ModuleRuntime): SkillerDeps {
  const projectDirectory = runtime.host.roots.projectDirectory ?? runtime.host.roots.instanceDirectory;
  if (!projectDirectory) {
    // V2 context 應提供 location；缺少時不能用 process.cwd() 猜測寫入範圍。
    throw new Error("skiller 需要 V2 location 才能解析專案根目錄");
  }
  return {
    roots: productionRoots(runtime),
    agentRoleEditor: runtime.host.capabilities.agentRoleEditor ?? null,
    resolveProjectRoot: (_context?: ToolExecutionContext) => projectDirectory,
  };
}

function createImportDeps(runtime: ModuleRuntime): SkillerImportDeps {
  return {
    ...createDeps(runtime),
    process: runtime.host.capabilities.process ?? null,
  };
}

export const skillerModule: ModuleDefinition = {
  key: "skiller",
  register: (runtime: ModuleRuntime): Promise<HostRegistration> => {
    const deps = createDeps(runtime);
    const tools = [
      createSkillerScanTool(deps),
      createSkillerValidateTool(deps),
      createSkillerDraftTool(deps),
      createSkillerDraftReadTool(deps),
      createSkillerDraftUpdateTool(deps),
      createSkillerDraftDeleteTool(deps),
      createSkillerPromoteTool(deps),
      createSkillerRetireTool(deps),
      createSkillerRestoreTool(deps),
      createSkillerImportTool(createImportDeps(runtime)),
      createSkillerPolicyUpdateTool(deps),
    ];
    return runtime.host.tools.install(tools);
  },
};
