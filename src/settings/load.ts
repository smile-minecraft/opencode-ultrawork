/**
 * 設定載入：讀兩層 ultrawork.jsonc 疊到內建預設上。
 *
 * 讀不到檔案（缺檔、目錄當檔、權限不足）視為沒有設定，不警告。
 * 解析失敗只忽略壞掉的這一層並記一則警告，前面已套用的層保留，
 * 絕不讓外掛載入失敗。檔案讀取函式可注入，方便測試。
 */

import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS, type UltraworkSettings } from "./defaults.ts";
import { parseJsonc } from "./jsonc.ts";
import { mergeSettings } from "./merge.ts";
import { resolveGlobalUltraworkDir, resolveProjectUltraworkDir, settingsFilePath } from "./paths.ts";

export type SettingsFileReader = (path: string) => string | undefined;

export interface LoadSettingsInput {
  readFile?: SettingsFileReader;
  globalDir?: string;
  projectDir?: string;
}

export interface SettingsLoadResult {
  settings: UltraworkSettings;
  warnings: string[];
}

function defaultReader(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

export function loadSettings(input: LoadSettingsInput = {}): SettingsLoadResult {
  const readFile = input.readFile ?? defaultReader;
  const warnings: string[] = [];
  let settings: UltraworkSettings = DEFAULT_SETTINGS;
  const layers: Array<string | undefined> = [
    input.globalDir === undefined ? undefined : settingsFilePath(resolveGlobalUltraworkDir(input.globalDir)),
    input.projectDir === undefined ? undefined : settingsFilePath(resolveProjectUltraworkDir(input.projectDir)),
  ];
  for (const path of layers) {
    if (path === undefined) continue;
    let text: string | undefined;
    try {
      text = readFile(path);
    } catch {
      continue;
    }
    if (text === undefined) continue;
    try {
      settings = mergeSettings(settings, parseJsonc(text));
    } catch (error) {
      // 只忽略壞掉的這一層：前面已套用的層保留，不重置。
      warnings.push(`設定檔 ${path} 解析失敗，已忽略該層：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { settings, warnings };
}
