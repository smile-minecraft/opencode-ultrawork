import { statSync } from "node:fs";
import { DEFAULT_SETTINGS } from "../settings/defaults.ts";
import { loadSettings } from "../settings/load.ts";
import { mergeSettings } from "../settings/merge.ts";
import { SessionStateStore } from "../state/store.ts";
import type { Host, HostRoots } from "../host.ts";
import { BUILTIN_MODULES } from "../modules/index.ts";
import { registerModules } from "../modules/registry.ts";
import type { ModuleDefinition } from "../modules/types.ts";
import { type MigrateFsOps, runMigrations } from "../migrate/index.ts";
import { ensureMemoryStoreMigrated } from "../migrate/memory-store.ts";

export interface SetupOverrides {
  modules?: readonly ModuleDefinition[];
  settings?: unknown;
  globalDir?: string;
  projectDir?: string;
  migrateFs?: MigrateFsOps;
}

export async function setupUltraworkCore(
  host: Host,
  overrides: SetupOverrides = {},
): Promise<() => Promise<void>> {
  const roots: HostRoots = {
    ...host.roots,
    globalConfigDirectory: overrides.globalDir ?? host.roots.globalConfigDirectory,
    ...(overrides.projectDir !== undefined ? { projectDirectory: overrides.projectDir } : {}),
  };
  const runtimeHost: Host = { ...host, roots };
  const globalDir = roots.globalConfigDirectory;
  const projectDir = roots.projectDirectory;

  await runMigration(globalDir, projectDir, overrides.migrateFs);
  if (projectDir && isExistingDirectory(projectDir)) await ensureMemoryStoreMigrated(projectDir);

  const loaded = loadSettings({
    globalDir,
    projectDir,
  });
  for (const warning of loaded.warnings) {
    console.warn(`[ultrawork] ${warning}`);
  }
  const settings = mergeSettings(mergeSettings(DEFAULT_SETTINGS, loaded.settings), overrides.settings);
  const registrations = await registerModules(
    { host: runtimeHost, settings },
    overrides.modules ?? BUILTIN_MODULES,
  );

  const store = new SessionStateStore(runtimeHost.storage);
  const controller = new AbortController();
  void watchSessionEvents(runtimeHost, store, controller.signal);

  return async () => {
    controller.abort();
    for (const registration of registrations) await registration.dispose();
  };
}

async function runMigration(
  globalDir: string,
  projectDir: string | undefined,
  fs: MigrateFsOps | undefined,
): Promise<void> {
  try {
    if (!isExistingDirectory(projectDir)) return;
    const result = runMigrations({
      ...(typeof projectDir === "string" ? { projectDir } : {}),
      globalDir,
      fs,
    });
    const warnings = [...result.warnings];
    if (result.project.gitignore.warning !== undefined) warnings.push(result.project.gitignore.warning);
    for (const warning of warnings) console.warn(`[ultrawork] ${warning}`);
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

async function watchSessionEvents(host: Host, store: SessionStateStore, signal: AbortSignal): Promise<void> {
  try {
    const events = await host.events.subscribe({ signal });
    for await (const event of events) await store.handleEvent(event);
  } catch {
    // 中止或連線中斷時結束迴圈，不影響外掛其他部分。
  }
}
