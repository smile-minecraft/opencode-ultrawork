/**
 * skills 模組：skill_search 與 system prompt 技能清單精簡。
 *
 * 開關開啟時註冊一個工具與 session context hook；關閉時完全不碰宿主。
 * 清單狀態存於宿主 storage，重新載入後仍能查詢。
 */

import type { HostRegistration } from "../../host.ts";
import type { ModuleDefinition, ModuleRuntime } from "../types.ts";
import {
  createSkillCatalogStore,
  createSkillSearchTool,
  resolveSkillsPolicyPath,
  type SkillSystemPart,
} from "./skill-catalog.ts";

export const skillsModule: ModuleDefinition = {
  key: "skills",
  register: async (runtime: ModuleRuntime): Promise<HostRegistration> => {
    const store = createSkillCatalogStore(runtime.host.storage);
    const skillSearch = createSkillSearchTool(store, {
      policyPath: resolveSkillsPolicyPath(runtime.host.roots.globalConfigDirectory),
    });
    const toolRegistration = await runtime.host.tools.install([skillSearch]);
    const contextRegistration = await runtime.host.sessions.hook("context", async (event) => {
      if (runtime.settings.skills.catalog === "full") return;
      try {
        await store.compact(event.system as unknown as SkillSystemPart[], event.sessionID);
      } catch {
        // 技能清單只是最佳化；儲存失敗時保留 OpenCode 原本的完整清單。
      }
    });

    return {
      dispose: async () => {
        await contextRegistration.dispose();
        await toolRegistration.dispose();
      },
    };
  },
};

export {
  COMPACT_THRESHOLD_CHARS,
  createKeywordLoader,
  createSkillCatalogStore,
  createSkillSearchTool,
  parseSkillCatalog,
  queryTerms,
  renderSkillIndex,
  resolveSkillsPolicyPath,
  searchSkills,
  type SkillEntry,
  type SkillKeywordIndex,
  type SkillKeywords,
} from "./skill-catalog.ts";
