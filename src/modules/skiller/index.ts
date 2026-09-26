/**
 * skiller 模組：11 個技能生命週期工具。
 *
 * 工具在 register 之外先建立，transform 回呼只同步加入 editor；關閉模組時
 * 不會建立 factory，也不會碰 ctx。正式 roots 全部由 settings 與 V2 全域
 * 設定資料夾解析，工具輸入沒有 path、root 或 destination 欄位。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "../../kit/define-tool.ts";
import { resolveGlobalConfigDir, resolveGlobalUltraworkDir } from "../../settings/paths.ts";
import type { ModuleDefinition, ModuleRuntime, Registration } from "../types.ts";
import { createSkillerDraftTool } from "./skiller-draft.ts";
import { createSkillerDraftDeleteTool, createSkillerDraftReadTool, createSkillerDraftUpdateTool } from "./skiller-draft-ops.ts";
import { createSkillerImportTool } from "./skiller-import.ts";
import { createSkillerPolicyUpdateTool } from "./skiller-policy-update.ts";
import { createSkillerPromoteTool } from "./skiller-promote.ts";
import { createSkillerRestoreTool } from "./skiller-restore.ts";
import { createSkillerRetireTool } from "./skiller-retire.ts";
import { createSkillerScanTool } from "./skiller-scan.ts";
import { createSkillerValidateTool } from "./skiller-validate.ts";
import type { SkillerDeps, SkillerRootOverrides } from "./skiller-common.ts";

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith(`~${process.platform === "win32" ? "\\" : "/"}`)) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function productionRoots(runtime: ModuleRuntime): SkillerRootOverrides {
  const options = (runtime.ctx.options ?? {}) as Record<string, unknown>;
  const globalDir =
    typeof options.globalDir === "string"
      ? options.globalDir
      : resolveGlobalConfigDir(process.env as Record<string, string | undefined>, homedir());
  const ultraworkDir = resolveGlobalUltraworkDir(globalDir);
  const settings = runtime.settings.skiller;
  const agentsRoot = settings.agentsDir === "auto" ? join(globalDir, "agents") : expandHome(settings.agentsDir);
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
  const projectDirectory = runtime.ctx.location?.project?.directory ?? runtime.ctx.location?.directory;
  if (!projectDirectory) {
    // V2 context 應提供 location；缺少時不能用 process.cwd() 猜測寫入範圍。
    throw new Error("skiller 需要 V2 location 才能解析專案根目錄");
  }
  return {
    roots: productionRoots(runtime),
    resolveProjectRoot: (_context?: ToolExecutionContext) => projectDirectory,
  };
}

export const skillerModule: ModuleDefinition = {
  key: "skiller",
  register: (runtime: ModuleRuntime): Promise<Registration> => {
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
      createSkillerImportTool(deps),
      createSkillerPolicyUpdateTool(deps),
    ];
    return runtime.ctx.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool as never);
    });
  },
};
