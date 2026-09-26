/**
 * skills 模組：skill_search 與 system prompt 技能清單精簡。
 *
 * 開關開啟時註冊一個工具與 session context hook；關閉時完全不碰 ctx。
 * 清單狀態存於 ctx.storage，外掛重新載入後仍能查詢。
 */

import type { ModuleDefinition, ModuleRuntime, Registration } from "../types.ts";
import {
  createSkillCatalogStore,
  createSkillSearchTool,
  resolveSkillsPolicyPath,
  type SkillSystemPart,
} from "./skill-catalog.ts";

function configuredGlobalDir(runtime: ModuleRuntime): string | undefined {
  const value = (runtime.ctx.options as Record<string, unknown> | undefined)?.globalDir;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export const skillsModule: ModuleDefinition = {
  key: "skills",
  register: async (runtime: ModuleRuntime): Promise<Registration> => {
    const store = createSkillCatalogStore(runtime.ctx.storage);
    const skillSearch = createSkillSearchTool(store, {
      policyPath: resolveSkillsPolicyPath(configuredGlobalDir(runtime)),
    });
    const toolRegistration = await runtime.ctx.tool.transform((editor) => {
      editor.add(skillSearch as never);
    });
    const contextRegistration = await runtime.ctx.session.hook("context", async (event) => {
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
