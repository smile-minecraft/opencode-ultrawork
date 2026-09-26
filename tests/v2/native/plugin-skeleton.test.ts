/** 新外掛骨架：假 V2 context 可以載入、開關能控制註冊、清理函式會逐一 dispose。 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { setupUltrawork } from "../../../src/index.ts";
import { MIGRATION_MARKER_FILE, nodeMigrateFsOps } from "../../../src/migrate/index.ts";
import { BUILTIN_MODULES } from "../../../src/modules/index.ts";
import type { ModuleDefinition } from "../../../src/modules/types.ts";
import { createFakeV2Context } from "../_fake-v2-context.ts";

describe("外掛骨架載入", () => {
  test("空模組清單載入時零工具零 hook，清理函式可呼叫", async () => {
    const fake = createFakeV2Context();
    const cleanup = await setupUltrawork(fake.ctx, { modules: [] });
    expect(typeof cleanup).toBe("function");
    expect(fake.added.size).toBe(0);
    expect(fake.toolHooks.size).toBe(0);
    expect(fake.sessionHooks.size).toBe(0);
    await cleanup();
  });

  test("預設模組清單可載入、清理函式可呼叫（不斷言具體工具集合）", async () => {
    const fake = createFakeV2Context();
    const cleanup = await plugin.setup(fake.ctx);
    expect(typeof cleanup).toBe("function");
    // 只斷言註冊形狀，不斷言哪些模組已實作：後續模組落地不會再觸發這裡。
    for (const definition of fake.added.values()) {
      expect(typeof definition.name).toBe("string");
      expect(typeof definition.description).toBe("string");
      expect(typeof definition.execute).toBe("function");
    }
    await cleanup!();
  });

  test("清理函式會逐一 dispose 已註冊的項目", async () => {
    const disposed: string[] = [];
    const fakeModule: ModuleDefinition = {
      key: "search",
      register: async () => ({
        dispose: async () => {
          disposed.push("search");
        },
      }),
    };
    const fake = createFakeV2Context();
    const cleanup = await setupUltrawork(fake.ctx, { modules: [fakeModule] });
    await cleanup();
    expect(disposed).toEqual(["search"]);
  });

  test("八個真實槽位都可以載入", () => {
    const keys = BUILTIN_MODULES.map((module) => module.key).sort();
    expect(keys).toEqual(
      ["commentSignal", "diagnostics", "memory", "search", "skiller", "skills", "verification", "workflow"].sort(),
    );
  });
});

/** 第一次 setup 會把 .opencode/ 舊資料搬進 .ultrawork/，第二次不會再搬。 */
describe("舊資料搬遷接線", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  });

  function workspace() {
    const projectDir = mkdtempSync(join(tmpdir(), "uw-skeleton-project-"));
    const globalDir = mkdtempSync(join(tmpdir(), "uw-skeleton-global-"));
    roots.push(projectDir, globalDir);
    mkdirSync(join(projectDir, ".opencode", "memory"), { recursive: true });
    writeFileSync(join(projectDir, ".opencode", "memory", "tasks.json"), '{"version":"1"}', "utf-8");
    writeFileSync(join(globalDir, "skills-policy.json"), '{"version":"1.0.0"}', "utf-8");
    return { projectDir, globalDir };
  }

  function snapshot(dir: string): string[] {
    const out: string[] = [];
    const walk = (current: string, prefix: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(current, entry.name), rel);
        else out.push(`${rel}:${statSync(join(current, entry.name)).size}`);
      }
    };
    walk(dir, "");
    return out.sort();
  }

  test("第一次 setup 會搬兩層，第二次 setup 完全不再動檔案", async () => {
    const { projectDir, globalDir } = workspace();

    const first = await setupUltrawork(createFakeV2Context().ctx, { modules: [], projectDir, globalDir });
    expect(existsSync(join(projectDir, ".ultrawork", "tasks.json"))).toBe(true);
    expect(existsSync(join(projectDir, ".ultrawork", ".gitignore"))).toBe(true);
    expect(existsSync(join(projectDir, ".ultrawork", MIGRATION_MARKER_FILE))).toBe(true);
    expect(existsSync(join(globalDir, ".ultrawork", "skills-policy.json"))).toBe(true);
    // 舊檔改名保留，沒有被刪掉。
    expect(existsSync(join(projectDir, ".opencode", "memory", "tasks.json"))).toBe(false);
    expect(readdirSync(join(projectDir, ".opencode", "memory")).some((n) => n.includes(".migrated-"))).toBe(true);
    await first();

    const projectBefore = snapshot(projectDir);
    const globalBefore = snapshot(globalDir);
    const second = await setupUltrawork(createFakeV2Context().ctx, { modules: [], projectDir, globalDir });
    expect(snapshot(projectDir)).toEqual(projectBefore);
    expect(snapshot(globalDir)).toEqual(globalBefore);
    await second();
  });

  test("搬遷失敗時 setup 仍然成功（外掛照常載入）", async () => {
    const { projectDir, globalDir } = workspace();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    try {
      const cleanup = await setupUltrawork(createFakeV2Context().ctx, {
        modules: [],
        projectDir,
        globalDir,
        migrateFs: {
          ...nodeMigrateFsOps(),
          copyFileSync: (source, destination) => {
            if (source.includes(".opencode")) throw new Error("EACCES: 測試注入的搬移失敗");
            nodeMigrateFsOps().copyFileSync(source, destination);
          },
        },
      });
      expect(typeof cleanup).toBe("function");
      await cleanup();
    } finally {
      console.warn = originalWarn;
    }
    // 沒寫標記（下次啟動會再試），而且把原因講出來了。
    expect(existsSync(join(projectDir, ".ultrawork", MIGRATION_MARKER_FILE))).toBe(false);
    expect(warnings.some((line) => line.includes("測試注入的搬移失敗"))).toBe(true);
  });

  test("專案根目錄不存在時不搬（也不會動到全域層）", async () => {
    const { projectDir, globalDir } = workspace();
    const before = snapshot(globalDir);
    const cleanup = await setupUltrawork(createFakeV2Context().ctx, {
      modules: [],
      projectDir: join(projectDir, "not-created-yet"),
      globalDir,
    });
    expect(existsSync(join(globalDir, ".ultrawork"))).toBe(false);
    expect(snapshot(globalDir)).toEqual(before);
    await cleanup();
  });
});

describe("模組開關", () => {  function trackingModule(key: string, calls: string[]): ModuleDefinition {
    return {
      key,
      register: async () => {
        calls.push(key);
      },
    };
  }

  test("開啟的模組 register 會被呼叫", async () => {
    const calls: string[] = [];
    const fake = createFakeV2Context();
    await setupUltrawork(fake.ctx, {
      modules: [trackingModule("search", calls), trackingModule("memory", calls)],
      settings: { modules: { search: true, memory: false } },
    });
    expect(calls).toEqual(["search"]);
  });

  test("全部關閉時完全不呼叫任何 register", async () => {
    const calls: string[] = [];
    const fake = createFakeV2Context();
    const cleanup = await setupUltrawork(fake.ctx, {
      modules: [trackingModule("search", calls)],
      settings: { modules: { search: false } },
    });
    expect(calls).toEqual([]);
    expect(fake.added.size).toBe(0);
    await cleanup();
  });
});
