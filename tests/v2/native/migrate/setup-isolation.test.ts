/**
 * 外掛入口的測試隔離：假的 V2 context 必須自帶一個暫存的全域設定目錄。
 *
 * `setupUltrawork` 的全域目錄解析順序是 overrides → ctx.options.globalDir →
 * OPENCODE_CONFIG_DIR → XDG_CONFIG_HOME → ~/.config/opencode。測試沒給前兩者時會
 * 落到最後一項，於是 `bun test` 會把開發者機器上的真實 skiller 資料搬走（改名保留）。
 * 這裡用暫存目錄當「假的使用者 home」重現同一個情境，不碰真實 home。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setupUltrawork } from "../../../../src/index.ts";
import { MIGRATION_MARKER_FILE } from "../../../../src/migrate/index.ts";
import { resolveGlobalConfigDir } from "../../../../src/settings/paths.ts";
import { createFakeV2Context, fakeGlobalDir } from "../../_fake-v2-context.ts";
import { cleanupTempRoots, tempRoot, writeFile, writeJson } from "./_helpers.ts";

afterEach(cleanupTempRoots);

const marker = (root: string) => join(root, ".ultrawork", MIGRATION_MARKER_FILE);
const globalDirOf = (ctx: { options: unknown }): string => String((ctx.options as Record<string, unknown>).globalDir);

describe("假 context 的全域目錄", () => {
  test("沒給 globalDir 時注入行程共用的暫存目錄，不落在真實 home", () => {
    const { ctx } = createFakeV2Context();

    const globalDir = globalDirOf(ctx);
    expect(globalDir.startsWith(tmpdir())).toBe(true);
    expect(globalDir.startsWith(join(homedir(), ".config"))).toBe(false);
  });

  test("同一個行程內共用同一個目錄（只建一次）", () => {
    const first = createFakeV2Context();
    const second = createFakeV2Context();

    expect(globalDirOf(first.ctx)).toBe(globalDirOf(second.ctx));
  });

  test("呼叫端有給 globalDir 時不覆蓋", () => {
    const { ctx } = createFakeV2Context({ options: { globalDir: "/tmp/測試自備的全域目錄" } });

    expect(globalDirOf(ctx)).toBe("/tmp/測試自備的全域目錄");
  });

  test("globalDir 是一般可見屬性：展開與相等比較都看得到隔離", () => {
    const { ctx } = createFakeV2Context({ options: { strict: true } });

    // 安全預設不能是看不見的屬性：一旦有人做展開或序列化就會靜默失去隔離。
    expect(Object.keys(ctx.options as object)).toEqual(["strict", "globalDir"]);
    expect({ ...(ctx.options as object) }).toEqual({ strict: true, globalDir: fakeGlobalDir() });
  });
});

/** 真實 home 的全域設定目錄頂層項目；搬遷只會在這一層動手，掃整棵太慢。 */
function realGlobalTopLevel(): string[] {
  const realHome = join(homedir(), ".config", "opencode");
  if (!existsSync(realHome)) return [];
  return readdirSync(realHome).sort();
}

describe("把展開後的 ctx.options 當成新 context", () => {
  /**
   * 展開是最容易靜默失去隔離的一條路。跑之前先把解析順序的落點設成暫存的假 home：
   * 就算隔離真的破了，也不會寫到開發者機器的真實設定。
   *
   * 判斷隔離有沒有生效要看**正向**證據 —— 解析出的全域目錄就是注入的那個暫存路徑，
   * 搬遷標記會落在那裡。只驗「真實 home 沒被動」是無牙齒的：fallback 已經被環境
   * 變數指到假 home，那句斷言無論隔離有沒有破都成立。
   */
  async function runWithSpreadOptions(
    projectDir: string,
    fakeHome: string,
    dropInjectedGlobalDir = false,
  ): Promise<void> {
    const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
    const originalXdg = process.env.XDG_CONFIG_HOME;
    const originalWarn = console.warn;
    console.warn = () => {};
    process.env.OPENCODE_CONFIG_DIR = fakeHome;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const { ctx: base } = createFakeV2Context({ directory: projectDir });
      const spreadCtx = { ...base, options: { ...(base.options as Record<string, unknown>) } };
      if (dropInjectedGlobalDir) delete spreadCtx.options.globalDir;
      const cleanup = await setupUltrawork(spreadCtx as any, { modules: [] });
      await cleanup();
    } finally {
      console.warn = originalWarn;
      if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdg;
    }
  }

  test("globalDir 展開後仍在，不會掉回後面的解析順序", () => {
    const { ctx } = createFakeV2Context();

    expect((ctx.options as Record<string, unknown>).globalDir).toBe(fakeGlobalDir());
    expect({ ...(ctx.options as Record<string, unknown>) }.globalDir).toBe(fakeGlobalDir());
  });

  test("用展開結果當 options 跑 setup，解析出的全域目錄就是注入的暫存路徑", async () => {
    const projectDir = tempRoot("uw-isolated-project-");
    const fakeHome = tempRoot("uw-fake-home-");
    // 先清掉共用暫存目錄裡既有的搬遷結果，讓「標記出現」是這次執行造成的。
    rmSync(join(fakeGlobalDir(), ".ultrawork"), { recursive: true, force: true });

    await runWithSpreadOptions(projectDir, fakeHome);

    // 正向證據：解析出的全域目錄就是注入的暫存路徑（搬遷標記落在那裡）。
    // 注入若在展開時被弄丟，這條會紅 —— 因為標記會改落在 fakeHome。
    expect(existsSync(marker(fakeGlobalDir()))).toBe(true);
    // 假 home（fallback 位置）完全沒被動。
    expect(existsSync(join(fakeHome, ".ultrawork"))).toBe(false);
  });

  test("拿掉注入後解析確實落到 fallback（假 home），證明上一條觀察得到失效", async () => {
    const projectDir = tempRoot("uw-isolated-project-");
    const fakeHome = tempRoot("uw-fake-home-");

    // 這次執行刻意丟掉注入的 globalDir，模擬屬性在展開／複製時被弄丟。
    await runWithSpreadOptions(projectDir, fakeHome, true);

    // 隔離一旦失效，寫入就會落在這裡 —— 所以上一條斷言是真的觀察得到失效。
    expect(existsSync(marker(fakeHome))).toBe(true);
    // 沒有任何環境變數時，同一條 fallback 解析出來的就是真實 home：
    // 這才是隔離要擋的落點，假 home 只是它的無害替身。
    expect(resolveGlobalConfigDir({}, homedir())).toBe(join(homedir(), ".config", "opencode"));
  });

  test("真實 home 逐項相同：這次執行沒有留下 .ultrawork、也沒有 .migrated-*", async () => {
    const projectDir = tempRoot("uw-isolated-project-");
    const fakeHome = tempRoot("uw-fake-home-");
    const realHomeBefore = realGlobalTopLevel();

    await runWithSpreadOptions(projectDir, fakeHome);

    // 這是防止整套測試寫到開發者機器的最後一道保險，不是隔離的判斷依據。
    expect(realGlobalTopLevel()).toEqual(realHomeBefore);
  });
});

describe("沒給 globalDir 時的搬遷隔離", () => {
  /** 在暫存的假 home 上跑 setupUltrawork；回傳該次呼叫記到的警告。 */
  async function setupAgainstFakeHome(fakeHome: string, projectDir: string): Promise<string[]> {
    const original = process.env.OPENCODE_CONFIG_DIR;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    process.env.OPENCODE_CONFIG_DIR = fakeHome;
    try {
      const { ctx } = createFakeV2Context({ directory: projectDir });
      const cleanup = await setupUltrawork(ctx, { modules: [] });
      await cleanup();
    } finally {
      console.warn = originalWarn;
      if (original === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = original;
    }
    return warnings;
  }

  test("OPENCODE_CONFIG_DIR 底下的舊資料不會被搬走或改名", async () => {
    const fakeHome = tempRoot("uw-fake-home-");
    const projectDir = tempRoot("uw-isolated-project-");
    writeJson(fakeHome, "skills-policy.json", { version: "1.0.0" });
    writeFile(fakeHome, "skill-drafts/alpha/SKILL.md", "# 草稿\n");

    await setupAgainstFakeHome(fakeHome, projectDir);

    expect(existsSync(join(fakeHome, "skills-policy.json"))).toBe(true);
    expect(existsSync(join(fakeHome, "skill-drafts/alpha/SKILL.md"))).toBe(true);
    expect(existsSync(join(fakeHome, ".ultrawork"))).toBe(false);
  });

  test("搬遷改在假 context 的暫存全域目錄上發生", async () => {
    const fakeHome = tempRoot("uw-fake-home-");
    const projectDir = tempRoot("uw-isolated-project-");

    await setupAgainstFakeHome(fakeHome, projectDir);

    expect(existsSync(marker(globalDirOf(createFakeV2Context().ctx)))).toBe(true);
  });

});

describe("搬移成功提示", () => {
  /** 擷取一次 setupUltrawork 記到 console.warn 的訊息。 */
  async function captureWarnings(projectDir: string, globalDir: string): Promise<string[]> {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      const { ctx } = createFakeV2Context({ directory: projectDir });
      const cleanup = await setupUltrawork(ctx, { modules: [], globalDir });
      await cleanup();
    } finally {
      console.warn = originalWarn;
    }
    return warnings;
  }

  test("有實際搬遷項目時輸出一行，說明舊檔以 .migrated-<時間> 保留", async () => {
    const projectDir = tempRoot("uw-isolated-project-");
    const globalDir = tempRoot("uw-migrate-global-");
    writeJson(globalDir, "skills-policy.json", { version: "1.0.0" });

    const warnings = await captureWarnings(projectDir, globalDir);

    const notice = warnings.filter((line) => line.startsWith("[ultrawork] ") && line.includes("已搬移"));
    expect(notice).toHaveLength(1);
    expect(notice[0]).toContain(".migrated-");
    expect(readdirSync(globalDir).some((name) => name.startsWith("skills-policy.json.migrated-"))).toBe(true);
    expect(existsSync(join(globalDir, ".ultrawork/skills-policy.json"))).toBe(true);
  });

  test("沒有搬遷項目時不輸出那一行", async () => {
    const projectDir = tempRoot("uw-isolated-project-");
    const globalDir = tempRoot("uw-migrate-global-");

    const warnings = await captureWarnings(projectDir, globalDir);

    expect(warnings.filter((line) => line.includes("已搬移"))).toEqual([]);
  });
});
