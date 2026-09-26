/**
 * 來源項目本身是 symlink 時一律不跟隨（頂層與巢狀一致）。
 *
 * 層內目錄項目（例如全域層的 `skill-drafts`）若是 symlink 指向專案外目錄，
 * 跟隨它會把外部資料讀進 `.ultrawork`；`unsafeParentDetail` 只檢查父層，
 * 擋不住「項目本身是 symlink」。這裡釘住：該項 `copy-failed`、不複製任何
 * 內容、不寫標記、下次啟動重試；修好方式是把 symlink 換成真目錄。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATION_MARKER_FILE, migrateGlobalData } from "../../../../src/migrate/index.ts";
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

describe("頂層目錄項目是 symlink（指向專案外目錄）", () => {
  test("不跟隨：外部檔案不被複製、不寫標記、可重試", () => {
    const root = tempRoot("uw-migrate-no-follow-top-");
    const outside = tempRoot("uw-migrate-no-follow-out-");
    seedLegacyGlobal(root);
    // 外部目錄放可辨識的檔案；若被跟隨，它會出現在 .ultrawork 裡。
    writeFileSync(join(outside, "EXTERNAL-MARKER.txt"), "external-content\n", "utf-8");
    writeFileSync(join(outside, "SKILL.md"), "# 外部的\n", "utf-8");
    mkdirSync(join(root, "skill-drafts-stash"), { recursive: true });

    const link = join(root, "skill-drafts");
    // 把真的 skill-drafts 搬開，換成指向外部目錄的 symlink。
    const stash = join(root, "skill-drafts-stash", "alpha");
    mkdirSync(stash, { recursive: true });
    writeFileSync(join(stash, "SKILL.md"), "# 草稿\n", "utf-8");
    rmSync(link, { recursive: true, force: true });
    symlinkSync(outside, link, "dir");

    const result = migrateGlobalData({ root, now });

    expect(result.ok).toBe(false);
    expect(result.errors.map((item) => item.reason)).toContain("copy-failed");
    expect(result.errors.some((item) => /symlink/i.test(item.detail ?? ""))).toBe(true);
    expect(result.alreadyMigrated).toBe(false);
    // 外部內容沒有被搬進 .ultrawork。
    expect(existsSync(join(root, ".ultrawork", "skill-drafts", "EXTERNAL-MARKER.txt"))).toBe(false);
    expect(existsSync(join(root, ".ultrawork", "skill-drafts"))).toBe(false);
    // 不寫標記：下次啟動會重試。
    expect(existsSync(marker(root))).toBe(false);
    // symlink 本身留在原位，沒被刪也沒被改名。
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, archivedName("skill-drafts")))).toBe(false);

    const retry = migrateGlobalData({ root, now });
    expect(retry.alreadyMigrated).toBe(false);
    expect(retry.ok).toBe(false);
    expect(retry.errors.map((item) => item.reason)).toContain("copy-failed");
  });

  test("把 symlink 換成真目錄後重跑會補完並寫上標記", () => {
    const root = tempRoot("uw-migrate-no-follow-fix-");
    const outside = tempRoot("uw-migrate-no-follow-fix-out-");
    seedLegacyGlobal(root);
    writeFileSync(join(outside, "EXTERNAL-MARKER.txt"), "external-content\n", "utf-8");

    const link = join(root, "skill-drafts");
    rmSync(link, { recursive: true, force: true });
    symlinkSync(outside, link, "dir");

    const first = migrateGlobalData({ root, now });
    expect(first.ok).toBe(false);
    expect(existsSync(marker(root))).toBe(false);

    // 修好方式：symlink 換成真目錄（不是把外部目標補回來）。
    rmSync(link, { force: true });
    mkdirSync(join(link, "alpha"), { recursive: true });
    writeFileSync(join(link, "alpha", "SKILL.md"), "# 草稿\n", "utf-8");

    const retry = migrateGlobalData({ root, now });
    expect(retry.ok).toBe(true);
    expect(retry.errors).toEqual([]);
    expect(readFileSync(join(root, ".ultrawork/skill-drafts/alpha/SKILL.md"), "utf-8")).toBe("# 草稿\n");
    expect(existsSync(join(root, ".ultrawork/skill-drafts/EXTERNAL-MARKER.txt"))).toBe(false);
    expect(existsSync(marker(root))).toBe(true);
  });
});

describe("巢狀目錄 symlink（來源樹深處指向專案外）", () => {
  test("不跟隨：該項 copy-failed、不寫標記", () => {
    const root = tempRoot("uw-migrate-no-follow-nested-");
    const outside = tempRoot("uw-migrate-no-follow-nested-out-");
    seedLegacyGlobal(root);
    writeFileSync(join(outside, "NESTED-EXTERNAL.txt"), "external\n", "utf-8");

    symlinkSync(outside, join(root, "skill-drafts", "linked-dir"), "dir");

    const result = migrateGlobalData({ root, now });

    expect(result.ok).toBe(false);
    expect(result.errors.map((item) => item.reason)).toContain("copy-failed");
    expect(existsSync(join(root, ".ultrawork/skill-drafts/linked-dir/NESTED-EXTERNAL.txt"))).toBe(false);
    expect(existsSync(marker(root))).toBe(false);
  });
});
