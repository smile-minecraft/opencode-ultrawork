/**
 * 模組註冊機制：只呼叫開關開啟的模組，收集回傳的註冊以便卸載。
 *
 * 模組清單可注入，測試用假模組驗證開關行為；
 * 正式路徑傳 BUILTIN_MODULES。
 */

import type { UltraworkSettings } from "../settings/defaults.ts";
import type { ModuleDefinition, ModuleRuntime, Registration } from "./types.ts";

/** 開關判斷：明確設 false 才關閉，其餘（包含未知 key）預設開啟。 */
export function isModuleEnabled(settings: UltraworkSettings | undefined, key: string): boolean {
  const modules = settings?.modules as Record<string, unknown> | undefined;
  return modules?.[key] !== false;
}

/** 依開關呼叫各模組的 register，回傳需要卸載時 dispose 的註冊。 */
export async function registerModules(
  runtime: ModuleRuntime,
  modules: readonly ModuleDefinition[],
): Promise<Registration[]> {
  const registrations: Registration[] = [];
  for (const module of modules) {
    if (!isModuleEnabled(runtime.settings, module.key)) continue;
    const registration = await module.register(runtime);
    if (registration) registrations.push(registration);
  }
  return registrations;
}
