/**
 * 新外掛入口：Plugin.define 形狀的 { id, setup }。
 *
 * setup 讀兩層設定、依開關註冊模組、訂閱工作階段刪除事件做狀態清理，
 * 回傳清理函式（先停事件迴圈，再逐一 dispose 已註冊的項目）。
 * 設定檔壞掉只警告、不讓載入失敗。
 */

import type { Plugin } from "@opencode/plugin";
import { ensureMemoryStoreMigrated } from "./migrate/memory-store.ts";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { BUILTIN_MODULES } from "./modules/index.ts";
import { registerModules } from "./modules/registry.ts";
import type { ModuleDefinition } from "./modules/types.ts";
import { type MigrateFsOps, runMigrations } from "./migrate/index.ts";
import { DEFAULT_SETTINGS } from "./settings/defaults.ts";
import { loadSettings } from "./settings/load.ts";
import { mergeSettings } from "./settings/merge.ts";
import { resolveGlobalConfigDir } from "./settings/paths.ts";
import { SessionStateStore, type SessionEvent } from "./state/store.ts";

export interface SetupOverrides {
  /** 覆寫模組清單（測試注入假模組用），預設 BUILTIN_MODULES。 */
  modules?: readonly ModuleDefinition[];
  /** 疊在檔案設定之上的設定覆寫。 */
  settings?: unknown;
  globalDir?: string;
  projectDir?: string;
  /** 搬遷用的檔案操作；不給就用真實的 node:fs（測試用來模擬搬到一半失敗）。 */
  migrateFs?: MigrateFsOps;
}

/** 可測試的 setup 本體；default export 的 setup 直接呼叫它。 */
export async function setupUltrawork(ctx: Plugin.Context, overrides: SetupOverrides = {}): Promise<() => Promise<void>> {
  const globalDir =
    overrides.globalDir ?? (ctx.options as Record<string, unknown> | undefined)?.globalDir ?? (
      resolveGlobalConfigDir(process.env as Record<string, string | undefined>, homedir())
    );
  const projectDir =
    overrides.projectDir ?? ctx.location?.project?.directory ?? ctx.location?.directory;
  // 舊資料搬遷：算完兩層路徑就先做一次，失敗只警告，不讓外掛載入失敗。
  await runMigration(globalDir, projectDir, overrides.migrateFs);
  if (isExistingDirectory(projectDir)) await ensureMemoryStoreMigrated(projectDir!);
  const loaded = loadSettings({
    globalDir: typeof globalDir === "string" ? globalDir : undefined,
    projectDir,
  });
  for (const warning of loaded.warnings) {
    console.warn(`[ultrawork] ${warning}`);
  }
  const settings = mergeSettings(mergeSettings(DEFAULT_SETTINGS, loaded.settings), overrides.settings);
  const registrations = await registerModules({ ctx, settings }, overrides.modules ?? BUILTIN_MODULES);

  const store = new SessionStateStore(ctx.storage);
  const controller = new AbortController();
  void watchSessionEvents(ctx, store, controller.signal);

  return async () => {
    controller.abort();
    for (const registration of registrations) {
      await registration.dispose();
    }
  };
}

/**
 * 舊資料搬遷：`.opencode/` 的記憶與計畫資料、全域 skiller 資料 → 對應的 `.ultrawork/`。
 *
 * 整段包在 try/catch：搬遷是盡力而為的相容層，任何失敗都只記警告，
 * 外掛照常用新位置運作（未完成或失敗的狀態由 `workflow_doctor` 回報）。
 *
 * 觸發點是「在某個專案第一次啟動」，所以專案根目錄不存在時整段不跑（含全域層）：
 * 那種 context 沒有可搬的資料，硬跑只會在奇怪的位置建出 `.ultrawork/`。
 */
async function runMigration(
  globalDir: unknown,
  projectDir: unknown,
  fs: MigrateFsOps | undefined,
): Promise<void> {
  try {
    if (!isExistingDirectory(projectDir)) return;
    const result = runMigrations({
      ...(typeof projectDir === "string" ? { projectDir } : {}),
      ...(typeof globalDir === "string" ? { globalDir } : {}),
      fs,
    });
    // `.gitignore` 建不起來（`.ultrawork` 是 symlink 之類）的原因只留在回傳值裡，
    // 使用者看不到；它跟項目層的失敗是同一種「搬遷沒完成」，走同一個輸出管道。
    const warnings = [...result.warnings];
    if (result.project.gitignore.warning !== undefined) {
      warnings.push(result.project.gitignore.warning);
    }
    for (const warning of warnings) {
      console.warn(`[ultrawork] ${warning}`);
    }
    // 成功搬完要讓使用者知道舊資料去哪了；沒有實際搬任何項目時不囉嗦。
    const moved = result.project.migrated.length + result.global.migrated.length;
    if (moved > 0) {
      console.warn(`[ultrawork] 已搬移 ${moved} 項舊資料到 .ultrawork/，舊檔以 .migrated-<時間> 改名保留。`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[ultrawork] 搬移 .opencode/ 舊資料失敗，外掛改用 .ultrawork/ 運作：${detail}`);
  }
}

function isExistingDirectory(path: unknown): boolean {
  if (typeof path !== "string" || path.trim() === "") return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 背景迴圈：工作階段刪除時清掉它的狀態；中止或出錯就結束。 */
async function watchSessionEvents(
  ctx: Pick<Plugin.Context, "event">,
  store: SessionStateStore,
  signal: AbortSignal,
): Promise<void> {
  try {
    for await (const event of ctx.event.subscribe({ signal })) {
      await store.handleEvent(event as SessionEvent);
    }
  } catch {
    // 中止或連線中斷時結束迴圈，不影響外掛其他部分。
  }
}

const plugin: Plugin.Plugin = {
  id: "ultrawork",
  setup: (ctx: Plugin.Context) => setupUltrawork(ctx),
};

export default plugin;
