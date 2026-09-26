/**
 * 斷鏈 symlink 的搬遷行為。
 *
 * `copyTree` 對每一層用 `statSync()` 判斷是不是目錄，而 `statSync` 會跟著 symlink 走：
 * 目標不存在的 symlink 會拋 `ENOENT`，整層複製中斷。這裡把實際行為釘住 ——
 * 該層記 `copy-failed`、不寫標記、舊資料（含那個 symlink 本身）不刪也不改名、
 * 外掛照常載入，而且重跑還會再試一次（收斂，不是靜默略過）。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { setupUltrawork } from "../../../../src/index.ts";
import { MIGRATION_MARKER_FILE, migrateGlobalData } from "../../../../src/migrate/index.ts";
import { createFakeV2Context } from "../../_fake-v2-context.ts";
import { FIXED_NOW, archivedName, cleanupTempRoots, tempRoot, writeFile, writeJson } from "./_helpers.ts";

afterEach(cleanupTempRoots);

const now = () => FIXED_NOW;
const marker = (root: string) => join(root, ".ultrawork", MIGRATION_MARKER_FILE);

function seedLegacyGlobal(root: string): void {
  writeJson(root, "skills-policy.json", { version: "1.0.0", entries: {} });
  writeJson(root, "skills-personal.json", { pins: { alpha: "personal" } });
  writeFile(root, "skill-drafts/alpha/SKILL.md", "# 草稿\n");
  writeFile(root, "skill-quarantine/beta/SKILL.md", "# 隔離\n");
}

/** 在 `skill-drafts/beta` 放一個指向不存在目標的 symlink（`beta` 排在 `alpha` 之後）。 */
function addBrokenSymlink(root: string): string {
  const link = join(root, "skill-drafts", "beta");
  symlinkSync(join(root, "skill-drafts", "不存在的目標.md"), link);
  return link;
}

describe("目錄裡有斷鏈 symlink", () => {
  test("該層記 copy-failed、不寫標記、磁碟沒有半套暫存", () => {
    const root = tempRoot("uw-migrate-global-");
    seedLegacyGlobal(root);
    addBrokenSymlink(root);

    const result = migrateGlobalData({ root, now });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("copy-failed");
    expect(result.errors[0].from).toBe(join(root, "skill-drafts"));
    expect(existsSync(marker(root))).toBe(false);
    // 複製到一半的暫存路徑被清掉，目標位置沒有半套。
    expect(readdirSync(root).some((name) => name.includes(".partial-"))).toBe(false);
    expect(existsSync(join(root, ".ultrawork/skill-drafts"))).toBe(false);
  });

  test("斷鏈 symlink 本身與同層其他資料都沒被刪除或改名", () => {
    const root = tempRoot("uw-migrate-global-");
    seedLegacyGlobal(root);
    const link = addBrokenSymlink(root);

    migrateGlobalData({ root, now });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, "skill-drafts/alpha/SKILL.md"), "utf-8")).toBe("# 草稿\n");
    // 失敗的項目與還沒輪到的項目都留在原位，沒有被改名成 .migrated-*。
    expect(existsSync(join(root, "skill-drafts"))).toBe(true);
    expect(existsSync(join(root, "skill-quarantine"))).toBe(true);
    expect(existsSync(join(root, archivedName("skill-drafts")))).toBe(false);
    expect(existsSync(join(root, archivedName("skill-quarantine")))).toBe(false);
  });

  test("重跑還是會再試一次（收斂，不是靜默略過）", () => {
    const root = tempRoot("uw-migrate-global-");
    seedLegacyGlobal(root);
    const link = addBrokenSymlink(root);
    migrateGlobalData({ root, now });

    const retry = migrateGlobalData({ root, now });

    expect(retry.alreadyMigrated).toBe(false);
    expect(retry.ok).toBe(false);
    expect(retry.errors.map((item) => item.reason)).toEqual(["copy-failed"]);
    expect(existsSync(marker(root))).toBe(false);
  });

  test("symlink 修好之後重跑會補完並寫上標記", () => {
    const root = tempRoot("uw-migrate-global-");
    seedLegacyGlobal(root);
    const link = addBrokenSymlink(root);
    migrateGlobalData({ root, now });

    rmSync(link);
    writeFile(root, "skill-drafts/beta/SKILL.md", "# 補回來的\n");
    const retry = migrateGlobalData({ root, now });

    expect(retry.ok).toBe(true);
    expect(retry.errors).toEqual([]);
    expect(readFileSync(join(root, ".ultrawork/skill-drafts/beta/SKILL.md"), "utf-8")).toBe("# 補回來的\n");
    expect(existsSync(marker(root))).toBe(true);
    expect(existsSync(join(root, archivedName("skill-drafts")))).toBe(true);
  });

  test("外掛照常載入，只是全域層沒搬完", async () => {
    const globalDir = tempRoot("uw-migrate-global-");
    const projectDir = tempRoot("uw-isolated-project-");
    seedLegacyGlobal(globalDir);
    addBrokenSymlink(globalDir);
    const originalWarn = console.warn;
    const warnings: string[] = [];
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

    expect(existsSync(marker(globalDir))).toBe(false);
    expect(existsSync(join(globalDir, "skill-drafts/alpha/SKILL.md"))).toBe(true);
    expect(warnings.some((line) => line.includes("失敗"))).toBe(true);
  });
});
