/**
 * 路徑解析：全域設定資料夾與兩層 .ultrawork 位置。
 *
 * 全域設定資料夾的規則跟 V2 一致（跟 `opencode debug paths config` 相同結果）：
 * OPENCODE_CONFIG_DIR → $XDG_CONFIG_HOME/opencode → ~/.config/opencode。
 * env 與家目錄都由參數注入，方便測試。
 */

import { join } from "node:path";

export function resolveGlobalConfigDir(
  env: Record<string, string | undefined>,
  homeDir: string,
): string {
  const override = env.OPENCODE_CONFIG_DIR?.trim();
  if (override) return override;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, "opencode");
  return join(homeDir, ".config", "opencode");
}

/** 全域層：<全域設定資料夾>/.ultrawork/ */
export function resolveGlobalUltraworkDir(globalConfigDir: string): string {
  return join(globalConfigDir, ".ultrawork");
}

/** 專案層：<專案根目錄>/.ultrawork/ */
export function resolveProjectUltraworkDir(projectDir: string): string {
  return join(projectDir, ".ultrawork");
}

/** 兩層的 ultrawork.jsonc 完整路徑。 */
export function settingsFilePath(ultraworkDir: string): string {
  return join(ultraworkDir, "ultrawork.jsonc");
}
