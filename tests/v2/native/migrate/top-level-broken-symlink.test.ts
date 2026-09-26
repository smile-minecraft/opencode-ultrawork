/**
 * 頂層項目本身就是斷鏈 symlink 的搬遷行為。
 *
 * `migrateLayer` 逐項判斷「舊位置是否存在」時，如果用會跟隨 symlink 的
 * `existsSync()`，斷鏈 symlink 會被誤判成「舊位置不存在」而記成 `source-missing`，
 * 該層卻照樣寫下搬遷標記：資料沒搬走、外掛與診斷工具也都認為搬完了。
 *
 * 這裡把頂層的差別釘住：
 * - 頂層是斷鏈 symlink → 該項 `copy-failed`、該層不寫標記、下次啟動重試；
 * - 頂層真的不存在（`ENOENT`）→ `source-missing`、該層照常完成並寫標記。
 * - 頂層是有效 symlink（目標存在）→ 同樣 `copy-failed`、不跟隨：跟隨它會把
 *   外部檔案的內容讀進 `.ultrawork`，修好方式是把 symlink 換成真檔案／真目錄。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupUltrawork } from "../../../../src/index.ts";
import { MIGRATION_MARKER_FILE, migrateGlobalData } from "../../../../src/migrate/index.ts";
import { createFakeV2Context } from "../../_fake-v2-context.ts";
import { FIXED_NOW, archivedName, cleanupTempRoots, readJson, tempRoot, writeFile, writeJson } from "./_helpers.ts";

afterEach(cleanupTempRoots);

const now = () => FIXED_NOW;
const marker = (root: string) => join(root, ".ultrawork", MIGRATION_MARKER_FILE);

/** symlink 目標放在全域層根目錄外的子資料夾，確保搬遷流程不會碰到它。 */
function externalTarget(root: string): string {
  return join(root, "external-storage", "skills-policy.json");
}

function seedLegacyGlobal(root: string): void {
  writeJson(root, "skills-personal.json", { pins: { alpha: "personal" } });
  writeFile(root, "skill-drafts/alpha/SKILL.md", "# 草稿\n");
  writeFile(root, "skill-quarantine/beta/SKILL.md", "# 隔離\n");
}

/** 把頂層的 `skills-policy.json` 做成指向不存在目標的 symlink。 */
function makeBrokenTopLevelLink(root: string): string {
  const link = join(root, "skills-policy.json");
  symlinkSync(externalTarget(root), link);
  return link;
}

describe("頂層項目是斷鏈 symlink", () => {
  test("該項記 copy-failed、該層不寫標記、舊資料不刪也不改名", () => {
    const root = tempRoot("uw-migrate-global-");
    seedLegacyGlobal(root);
    const link = makeBrokenTopLevelLink(root);

    const result = migrateGlobalData({ root, now });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("copy-failed");
    expect(result.errors[0].from).toBe(link);
    // 不能被誤記成「舊位置不存在」——那會讓該層照樣寫下標記。
    expect(result.skipped).toEqual([]);
    expect(existsSync(marker(root))).toBe(false);
    // 複製到一半的暫存路徑被清掉，目標位置沒有半套。
    expect(readdirSync(root).some((name) => name.includes(".partial-"))).toBe(false);
    expect(existsSync(join(root, ".ultrawork/skills-policy.json"))).toBe(false);
  });

  test("斷鏈 symlink 本身與同層其他舊資料都留在原位", () => {
    const root = tempRoot("uw-migrate-global-");
    seedLegacyGlobal(root);
    const link = makeBrokenTopLevelLink(root);

    migrateGlobalData({ root, now });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, archivedName("skills-policy.json")))).toBe(false);
    // 第一項就停住，後面的項目完全沒被碰到。
    expect(existsSync(join(root, "skills-personal.json"))).toBe(true);
    expect(existsSync(join(root, "skill-drafts/alpha/SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "skill-quarantine/beta/SKILL.md"))).toBe(true);
    expect(existsSync(join(root, archivedName("skills-personal.json")))).toBe(false);
    expect(existsSync(join(root, ".ultrawork/skills-personal.json"))).toBe(false);
  });

  test("重跑還是會再試一次（收斂，不是靜默略過）", () => {
    const root = tempRoot("uw-migrate-global-");
    seedLegacyGlobal(root);
    makeBrokenTopLevelLink(root);
    migrateGlobalData({ root, now });

    const retry = migrateGlobalData({ root, now });

    expect(retry.alreadyMigrated).toBe(false);
    expect(retry.ok).toBe(false);
    expect(retry.errors.map((item) => item.reason)).toEqual(["copy-failed"]);
    expect(existsSync(marker(root))).toBe(false);
  });

  test("symlink 目標補回來也不跟隨；換成真檔案後重跑才補完並寫上標記", () => {
    const root = tempRoot("uw-migrate-global-");
    seedLegacyGlobal(root);
    const link = makeBrokenTopLevelLink(root);
    migrateGlobalData({ root, now });

    // 只把外部目標補回來（symlink 還在）仍然拒絕：跟隨它等於讀外部檔案。
    writeFile(root, "external-storage/skills-policy.json", '{"version":"1.0.0"}\n');
    const stillLink = migrateGlobalData({ root, now });

    expect(stillLink.ok).toBe(false);
    expect(stillLink.errors.map((item) => item.reason)).toContain("copy-failed");
    expect(existsSync(join(root, ".ultrawork/skills-policy.json"))).toBe(false);
    expect(existsSync(marker(root))).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    // 修好方式：symlink 換成真檔案，重跑才補完。
    rmSync(link, { force: true });
    writeFile(root, "skills-policy.json", '{"version":"1.0.0"}\n');
    const retry = migrateGlobalData({ root, now });

    expect(retry.ok).toBe(true);
    expect(retry.errors).toEqual([]);
    expect(readFileSync(join(root, ".ultrawork/skills-policy.json"), "utf-8")).toBe('{"version":"1.0.0"}\n');
    expect(existsSync(marker(root))).toBe(true);
    expect(existsSync(join(root, archivedName("skills-policy.json")))).toBe(true);
    expect(existsSync(join(root, ".ultrawork/skill-quarantine/beta/SKILL.md"))).toBe(true);
  });

  test("外掛照常載入，只是全域層沒搬完", async () => {
    const globalDir = tempRoot("uw-migrate-global-");
    const projectDir = tempRoot("uw-isolated-project-");
    seedLegacyGlobal(globalDir);
    makeBrokenTopLevelLink(globalDir);
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
    expect(lstatSync(join(globalDir, "skills-policy.json")).isSymbolicLink()).toBe(true);
    expect(warnings.some((line) => line.includes("失敗"))).toBe(true);
  });
});

describe("頂層項目是有效 symlink 或真的不存在", () => {
  test("有效 symlink → 拒絕跟隨：不複製、不寫標記、可重試", () => {
    const root = tempRoot("uw-migrate-global-");
    seedLegacyGlobal(root);
    writeFile(root, "external-storage/skills-policy.json", '{"version":"1.0.0"}\n');
    const link = join(root, "skills-policy.json");
    symlinkSync(externalTarget(root), link);

    const result = migrateGlobalData({ root, now });

    // 目標存在也不跟隨：外部檔案的內容不得被讀進 .ultrawork。
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("copy-failed");
    expect(result.errors[0].from).toBe(link);
    expect(existsSync(join(root, ".ultrawork/skills-policy.json"))).toBe(false);
    expect(existsSync(marker(root))).toBe(false);
    // symlink 本身留在原位，沒被刪也沒被改名。
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, archivedName("skills-policy.json")))).toBe(false);

    const retry = migrateGlobalData({ root, now });
    expect(retry.alreadyMigrated).toBe(false);
    expect(retry.ok).toBe(false);
    expect(retry.errors.map((item) => item.reason)).toEqual(["copy-failed"]);
  });

  test("舊位置真的不存在 → source-missing，該層照常完成並寫標記", () => {
    const root = tempRoot("uw-migrate-global-");
    seedLegacyGlobal(root);

    const result = migrateGlobalData({ root, now });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("source-missing");
    expect(result.skipped[0].from).toBe(join(root, "skills-policy.json"));
    expect(existsSync(marker(root))).toBe(true);
    expect(readJson(join(root, ".ultrawork/skills-personal.json")).pins).toEqual({ alpha: "personal" });
  });

  test("全新專案：舊資料一個都沒有 → 該層完成並寫標記", () => {
    const root = tempRoot("uw-migrate-global-");

    const result = migrateGlobalData({ root, now });

    expect(result.ok).toBe(true);
    expect(result.items.every((item) => item.reason === "source-missing")).toBe(true);
    expect(existsSync(marker(root))).toBe(true);
  });

  test("頂層項目是普通檔案（不是 symlink）→ 照常搬走", () => {
    const root = tempRoot("uw-migrate-global-");
    seedLegacyGlobal(root);
    writeFileSync(join(root, "skills-policy.json"), '{"version":"1.0.0"}\n', "utf-8");

    const result = migrateGlobalData({ root, now });

    expect(result.ok).toBe(true);
    expect(result.migrated.map((item) => item.to)).toContain(join(root, ".ultrawork/skills-policy.json"));
    expect(existsSync(join(root, archivedName("skills-policy.json")))).toBe(true);
  });
});
