/**
 * 全域層搬遷：skiller 的四項資料搬到 `<全域>/.ultrawork/`。
 *
 * 規則與專案層完全相同（同一套逐項演算法），差別只有項目清單；
 * 全域層不建 `.gitignore`（企劃書 4.3 節的清單沒有它）。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATION_MARKER_FILE, migrateGlobalData } from "../../../../src/migrate/index.ts";
import { FIXED_NOW, archivedName, cleanupTempRoots, readJson, tempRoot, writeFile, writeJson } from "./_helpers.ts";

afterEach(cleanupTempRoots);

const now = () => FIXED_NOW;
const marker = (root: string) => join(root, ".ultrawork", MIGRATION_MARKER_FILE);

function seedLegacyGlobal(root: string): void {
  writeJson(root, "skills-policy.json", { version: "1.0.0", entries: {} });
  writeJson(root, "skills-personal.json", { pins: { alpha: "personal" } });
  writeFile(root, "skill-drafts/alpha/SKILL.md", "# 草稿\n");
  writeFile(root, "skill-quarantine/beta/SKILL.md", "# 隔離\n");
}

describe("全域層搬移", () => {
  test("四項資料全部搬到 <全域>/.ultrawork/，舊檔改名保留", () => {
    const root = tempRoot("uw-migrate-global-");
    seedLegacyGlobal(root);

    const result = migrateGlobalData({ root, now });

    expect(result.ok).toBe(true);
    expect(result.migrated.map((item) => item.to)).toEqual([
      join(root, ".ultrawork/skills-policy.json"),
      join(root, ".ultrawork/skills-personal.json"),
      join(root, ".ultrawork/skill-drafts"),
      join(root, ".ultrawork/skill-quarantine"),
    ]);
    expect(readFileSync(join(root, ".ultrawork/skill-drafts/alpha/SKILL.md"), "utf-8")).toBe("# 草稿\n");
    expect(readFileSync(join(root, ".ultrawork/skill-quarantine/beta/SKILL.md"), "utf-8")).toBe("# 隔離\n");
    expect(existsSync(join(root, "skills-policy.json"))).toBe(false);
    expect(existsSync(join(root, archivedName("skills-policy.json")))).toBe(true);
    expect(existsSync(join(root, archivedName("skill-drafts")))).toBe(true);
  });

  test("全域層不建 .gitignore", () => {
    const root = tempRoot("uw-migrate-global-");
    seedLegacyGlobal(root);
    migrateGlobalData({ root, now });
    expect(existsSync(join(root, ".ultrawork", ".gitignore"))).toBe(false);
  });

  test("新位置已有政策檔 → 不覆寫、舊檔留在原地、標記仍寫入", () => {
    const root = tempRoot("uw-migrate-global-");
    seedLegacyGlobal(root);
    writeJson(root, ".ultrawork/skills-policy.json", { version: "1.0.0", entries: { alpha: { trust: "local" } } });

    const result = migrateGlobalData({ root, now });

    expect(result.ok).toBe(true);
    expect(result.skipped.map((item) => item.reason)).toEqual(["target-exists"]);
    expect(existsSync(join(root, "skills-policy.json"))).toBe(true);
    expect(existsSync(join(root, archivedName("skills-policy.json")))).toBe(false);
    expect(readJson(join(root, ".ultrawork/skills-policy.json")).entries).toEqual({ alpha: { trust: "local" } });
    expect(readJson(marker(root)).skipped).toEqual([
      { from: "skills-policy.json", to: ".ultrawork/skills-policy.json", reason: "target-exists" },
    ]);
  });

  test("標記檔存在 → 第二次呼叫不做事", () => {
    const root = tempRoot("uw-migrate-global-");
    seedLegacyGlobal(root);
    migrateGlobalData({ root, now });
    const second = migrateGlobalData({ root, now });
    expect(second.alreadyMigrated).toBe(true);
    expect(second.items).toEqual([]);
  });
});
