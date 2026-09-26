/**
 * 新外掛的設定物件形狀與內建預設值。
 *
 * 全域與專案的 ultrawork.jsonc 共用同一種格式，專案層只寫要覆寫的部分。
 */

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
  workflow: {
    completion: {
      /** memory 模組開啟時預設要求同步紀錄；關閉時由完成前檢查自行放行。 */
      requireMemoryReceipt: boolean;
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
  workflow: {
    completion: {
      requireMemoryReceipt: true,
    },
  },
};
