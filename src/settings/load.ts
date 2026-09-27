/**
 * 設定載入：讀兩層 ultrawork.jsonc 疊到內建預設上，再做執行期驗證。
 *
 * 讀不到檔案（缺檔、目錄當檔、權限不足）視為沒有設定，不警告。
 * 解析失敗只忽略壞掉的這一層並記一則警告，前面已套用的層保留，
 * 絕不讓外掛載入失敗。檔案讀取函式可注入，方便測試。
 *
 * 合併完一定再過 sanitizeSettings：手寫設定難免有型別錯誤
 * （例如把 skiller 寫成字串），無效的欄位退回預設值並警告，
 * 不讓壞值流進模組導致載入時崩潰。
 */

import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS, type UltraworkSettings } from "./defaults.ts";
import { parseJsonc } from "./jsonc.ts";
import { isPlainObject, mergeSettings } from "./merge.ts";
import { resolveGlobalUltraworkDir, resolveProjectUltraworkDir, settingsFilePath } from "./paths.ts";
import { sanitizeSettings } from "./validate.ts";

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

/**
 * 只允許寫在全域層的 skiller key：它們決定「寫到專案外哪裡」
 *（個人技能目錄、角色檔改寫目錄）。專案層帶著這些 key（例如 clone 來的
 * repo 自帶 .ultrawork/ultrawork.jsonc）不得把寫入導到任意路徑。
 */
const GLOBAL_ONLY_SKILLER_KEYS = ["agentsDir", "personalSkillRoot"] as const;

/**
 * 專案層不得提供寫入位置：有就整段拿掉並警告，呼叫端只會看到全域層的值
 *（或全域缺席時的內建預設）。回傳拿掉的 key 數量供警告使用。
 *
 * 注意：skiller 區段目前只有這兩個合法欄位；專案層的 skiller 若根本不是
 * 物件（例如手誤寫成字串），合併後會蓋掉全域的整個 skiller 物件再被
 * sanitize 退回預設——同樣是專案層改寫了全域層的值，所以整段忽略並警告。
 */
function stripProjectSkillerRoots(layer: unknown, path: string, warnings: string[]): unknown {
  if (!isPlainObject(layer)) return layer;
  if (layer["skiller"] === undefined) return layer;
  const skiller = layer["skiller"];
  if (!isPlainObject(skiller)) {
    warnings.push(
      `設定檔 ${path} 的「skiller」必須是物件且寫入位置只允許寫在全域設定，專案層的整個 skiller 區段已忽略（改用全域層的值）。`,
    );
    const cleaned = { ...layer };
    delete cleaned["skiller"];
    return cleaned;
  }
  let stripped = false;
  const cleanedSkiller = { ...skiller };
  for (const key of GLOBAL_ONLY_SKILLER_KEYS) {
    if (cleanedSkiller[key] !== undefined) {
      warnings.push(
        `設定檔 ${path} 的「skiller.${key}」只允許寫在全域設定，專案層的值已忽略（改用全域層的值）。`,
      );
      delete cleanedSkiller[key];
      stripped = true;
    }
  }
  if (!stripped) return layer;
  return { ...layer, skiller: cleanedSkiller };
}

export function loadSettings(input: LoadSettingsInput = {}): SettingsLoadResult {
  const readFile = input.readFile ?? defaultReader;
  const warnings: string[] = [];
  let settings: UltraworkSettings = DEFAULT_SETTINGS;
  const projectPath =
    input.projectDir === undefined ? undefined : settingsFilePath(resolveProjectUltraworkDir(input.projectDir));
  const layers: Array<{ path: string | undefined; project: boolean }> = [
    {
      path: input.globalDir === undefined ? undefined : settingsFilePath(resolveGlobalUltraworkDir(input.globalDir)),
      project: false,
    },
    { path: projectPath, project: true },
  ];
  for (const layer of layers) {
    if (layer.path === undefined) continue;
    let text: string | undefined;
    try {
      text = readFile(layer.path);
    } catch {
      continue;
    }
    if (text === undefined) continue;
    try {
      const parsed: unknown = parseJsonc(text);
      settings = mergeSettings(settings, layer.project ? stripProjectGlobalBudget(stripProjectMemoryWriters(stripProjectSkillerRoots(parsed, layer.path, warnings), layer.path, warnings), layer.path, warnings) : parsed);
    } catch (error) {
      // 只忽略壞掉的這一層：前面已套用的層保留，不重置。
      warnings.push(`設定檔 ${layer.path} 解析失敗，已忽略該層：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // 執行期驗證：壞掉的欄位退回預設並警告，外掛照常載入。
  const sanitized = sanitizeSettings(settings);
  warnings.push(...sanitized.warnings);
  return { settings: sanitized.settings, warnings };
}

/**
 * `memory.writerAgents` 決定誰能寫全域記憶，只允許寫在全域層（理由同 skiller 的寫入位置）：
 * 專案層有這個 key 就拿掉並警告；`memory` 不是物件時整段忽略。
 */
function stripProjectMemoryWriters(layer: unknown, path: string, warnings: string[]): unknown {
  if (!isPlainObject(layer) || layer.memory === undefined) return layer;
  if (!isPlainObject(layer.memory)) {
    warnings.push(`設定檔 ${path} 的 memory 必須是物件，專案層的整個 memory 區段已忽略。`);
    const { memory: _memory, ...rest } = layer;
    return rest;
  }
  if (layer.memory.writerAgents === undefined) return layer;
  warnings.push(`設定檔 ${path} 的 memory.writerAgents 只允許寫在全域設定，專案層的值已忽略。`);
  const { writerAgents: _writerAgents, ...memory } = layer.memory;
  return { ...layer, memory };
}

/**
 * `memory.budget.global` 決定全域層記憶的額度，只允許寫在全域層
 *（理由同 `memory.writerAgents`）：專案層有這個區塊就整段拿掉並警告，
 * 呼叫端只會看到全域層的值（或全域缺席時的內建預設）。
 *
 * 另外兩種專案層寫壞的情況也在這裡先擋掉，避免合併時蓋掉全域層的合法值、
 * 再被驗證整段退回預設：`budget` 不是物件時整個拿掉；`budget.project`
 * 不是物件時只拿掉那一段（`budget.global` 在專案層本來就不存在，到這裡時
 * 一定已經被拿掉了）。
 */
function stripProjectGlobalBudget(layer: unknown, path: string, warnings: string[]): unknown {
  if (!isPlainObject(layer) || layer.memory === undefined) return layer;
  if (!isPlainObject(layer.memory) || layer.memory.budget === undefined) return layer;
  const budget = layer.memory.budget;
  if (!isPlainObject(budget)) {
    warnings.push(`設定檔 ${path} 的「memory.budget」必須是物件，專案層的值已忽略（改用全域層的值與內建預設）。`);
    const { budget: _budget, ...memory } = layer.memory;
    return { ...layer, memory };
  }
  let cleaned = budget;
  if (cleaned["global"] !== undefined) {
    warnings.push(
      `設定檔 ${path} 的「memory.budget.global」只允許寫在全域設定，專案層的值已忽略（改用全域層的值）。`,
    );
    const { global: _global, ...rest } = cleaned;
    cleaned = rest;
  }
  if (cleaned["project"] !== undefined && !isPlainObject(cleaned["project"])) {
    warnings.push(`設定檔 ${path} 的「memory.budget.project」必須是物件，專案層的值已忽略（改用內建預設）。`);
    const { project: _project, ...rest } = cleaned;
    cleaned = rest;
  }
  if (cleaned === budget) return layer;
  return { ...layer, memory: { ...layer.memory, budget: cleaned } };
}
