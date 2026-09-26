/** 設定模組的公開介面：後續模組任務只從這裡拿設定。 */

export { DEFAULT_SETTINGS, MODULE_KEYS, type ModuleKey, type UltraworkSettings } from "./defaults.ts";
export { parseJsonc, stripJsoncComments } from "./jsonc.ts";
export { loadSettings, type LoadSettingsInput, type SettingsFileReader, type SettingsLoadResult } from "./load.ts";
export { mergeSettings } from "./merge.ts";
export { asStringList, sanitizeSettings, type SanitizeResult } from "./validate.ts";
export {
  resolveGlobalConfigDir,
  resolveGlobalUltraworkDir,
  resolveProjectUltraworkDir,
  settingsFilePath,
} from "./paths.ts";
