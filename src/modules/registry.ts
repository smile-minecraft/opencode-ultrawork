/**
 * 模組註冊機制：只呼叫開關開啟的模組，收集回傳的註冊以便卸載。
 *
 * 模組清單可注入，測試用假模組驗證開關行為；
 * 正式路徑傳 BUILTIN_MODULES。
 */

import type { UltraworkSettings } from "../settings/defaults.ts";
import type { ModuleDefinition, ModuleRuntime, Registration } from "./types.ts";

/**
 * 開關判斷的單一來源：只有 boolean false 算關閉，其餘（含 0／null／字串等
 * 非預期值、以及未知 key）一律視為開啟。
 *
 * 非預期值正常走不到這裡（設定載入時已驗證並退回預設），這裡的寬容是為了
 * 讓「開關」永遠 fail-open 成一致的結論：diagnostics 與 workflow 都直接用
 * 這個函式，不再各自用 truthy 判斷。
 */
export function isModuleEnabled(settings: UltraworkSettings | undefined, key: string): boolean {
  const modules = settings?.modules as Record<string, unknown> | undefined;
  return modules?.[key] !== false;
}

/** 依開關呼叫各模組的 register，回傳需要卸載時 dispose 的註冊。
 *
 * 中途有模組失敗時，先把前面已註冊的逐一 dispose（倒序，後註冊先清），
 * 再把原本的錯誤往上丟：外掛載入失敗，但不會留下半套註冊。
 * 回滾時某個 dispose 跟著失敗只記警告，不蓋掉原本的註冊錯誤。
 */
export async function registerModules(
  runtime: ModuleRuntime,
  modules: readonly ModuleDefinition[],
): Promise<Registration[]> {
  const registrations: Registration[] = [];
  try {
    for (const module of modules) {
      if (!isModuleEnabled(runtime.settings, module.key)) continue;
      const registration = await module.register(runtime);
      if (registration) registrations.push(registration);
    }
  } catch (error) {
    for (let index = registrations.length - 1; index >= 0; index -= 1) {
      try {
        await registrations[index]!.dispose();
      } catch (disposeError) {
        console.warn(
          `[ultrawork] 模組註冊失敗後的回滾清理也失敗（第 ${index + 1} 筆）：${disposeError instanceof Error ? disposeError.message : String(disposeError)}`,
        );
      }
    }
    throw error;
  }
  return registrations;
}
