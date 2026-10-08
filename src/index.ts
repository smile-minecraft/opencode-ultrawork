/** OpenCode 插件入口：只把平台 context 適配成宿主能力，再交給共用核心。 */

import type { Plugin } from "@opencode/plugin";
import { createOpenCodeHost } from "./opencode/adapter.ts";
import { setupUltraworkCore, type SetupOverrides } from "./core/setup.ts";

export type { SetupOverrides };

export function setupUltrawork(
  ctx: Plugin.Context,
  overrides: SetupOverrides = {},
): Promise<() => Promise<void>> {
  return setupUltraworkCore(createOpenCodeHost(ctx, {
    ...(overrides.globalDir !== undefined ? { globalDirectory: overrides.globalDir } : {}),
    ...(overrides.projectDir !== undefined ? { projectDirectory: overrides.projectDir } : {}),
  }), overrides);
}

const plugin: Plugin.Plugin = {
  id: "ultrawork",
  setup: (ctx: Plugin.Context) => setupUltrawork(ctx),
};

export default plugin;
