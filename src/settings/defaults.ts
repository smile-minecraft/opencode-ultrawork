/**
 * 新外掛的設定物件形狀與內建預設值。
 *
 * 全域與專案的 ultrawork.jsonc 共用同一種格式，專案層只寫要覆寫的部分。
 */

import { defaultMemoryBudgets, type MemoryBudgets } from "../modules/memory/constants.ts";

export const MODULE_KEYS = [
  "search",
  "verification",
  "commentSignal",
  "skills",
  "skiller",
  "workflow",
  "diagnostics",
  "memory",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export interface UltraworkSettings {
  modules: Record<ModuleKey, boolean>;
  skiller: {
    /** 個人技能目錄，預設 ~/.agents/skills。 */
    personalSkillRoot: string;
    /** 改寫角色檔的目錄，auto = 全域設定資料夾下的 agents。 */
    agentsDir: string;
  };
  skills: {
    /** 技能清單在 system prompt 的呈現：index 只列名稱，full 走原本完整清單。 */
    catalog: "index" | "full";
  };
  verification: {
    /** 能呼叫 verification_run 的 agent；預設只有 momus（第二層 runtime 防護）。 */
    runAllowedAgents: string[];
    /** 能呼叫 change-scope-check 的 agent；預設 build 與 ultra。 */
    scopeCheckAllowedAgents: string[];
  };
  memory: { writerAgents: string[]; inject: boolean; budget: MemoryBudgets };
  workflow: {
    completion: {
      /** memory 模組開啟時預設要求記憶處置；關閉時由完成前檢查自行放行。 */
      requireMemoryDisposition: boolean;
    };
    evidencePack: {
      /** 派發時強制檢查實作說明七節格式的 subagent；預設 implementer／debugger／ultra-coder。 */
      gatedSubagents: string[];
    };
  };
}

export const DEFAULT_SETTINGS: UltraworkSettings = {
  modules: {
    search: true,
    verification: true,
    commentSignal: true,
    skills: true,
    skiller: true,
    workflow: true,
    diagnostics: true,
    memory: true,
  },
  skiller: {
    personalSkillRoot: "~/.agents/skills",
    agentsDir: "auto",
  },
  skills: {
    catalog: "index",
  },
  verification: {
    runAllowedAgents: ["momus"],
    scopeCheckAllowedAgents: ["build", "ultra"],
  },
  memory: { writerAgents: ["memorizer"], inject: true, budget: defaultMemoryBudgets() },
  workflow: {
    completion: {
      requireMemoryDisposition: true,
    },
    evidencePack: {
      gatedSubagents: ["implementer", "debugger", "ultra-coder"],
    },
  },
};
