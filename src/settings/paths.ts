/**
 * 路徑解析：全域設定資料夾與兩層 .ultrawork 位置。
 *
 * 全域設定資料夾的規則跟 V2 一致（跟 `opencode debug paths config` 相同結果）：
 * OPENCODE_CONFIG_DIR → $XDG_CONFIG_HOME/opencode → ~/.config/opencode。
 * env 與家目錄都由參數注入，方便測試。
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

/** 展開設定路徑開頭的 `~`；家目錄可注入，供呼叫端與測試共用同一規則。 */
export function expandHome(path: string, homeDir: string = homedir()): string {
  if (path === "~") return homeDir;
  if (path.startsWith(`~${process.platform === "win32" ? "\\" : "/"}`)) {
    return join(homeDir, path.slice(2));
  }
  return path;
}

/** 解析 skiller 與診斷共用的 agents 目錄位置。 */
export function resolveAgentsRoot(agentsDir: string, globalConfigDir: string): string {
  return agentsDir === "auto" ? join(globalConfigDir, "agents") : expandHome(agentsDir);
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

/**
 * 專案根目錄與全域設定資料夾是不是同一個資料夾。
 *
 * 用 realpath 比對，`/var` 與 `/private/var` 這類別名、結尾斜線都不影響判定；
 * 任一邊解析不到（不存在）就退回字面上的 `resolve()` 比對。
 */
export function isSameAsGlobalConfigDir(projectRoot: string, globalConfigDir: string | undefined): boolean {
  if (globalConfigDir === undefined || globalConfigDir.trim() === "") return false;
  const canonical = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return canonical(projectRoot) === canonical(globalConfigDir);
}
