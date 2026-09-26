/**
 * `.ultrawork/.gitignore` 的新政策：模板只剩 `*` 一行；一致性檢查只看必要行。
 *
 * - 模板是 `*` 一行：目錄內全部忽略，含忽略檔自己；不再豁免 `ultrawork.jsonc`
 *   與 `.gitignore`。
 * - 已存在的檔案不自動改寫：有 `*` 這一行就視為正常（使用者自訂的豁免行不再
 *   每次啟動警告）；缺 `*` 才警告。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ULTRAWORK_GITIGNORE_CONTENT, migrateProjectData } from "../../../../src/migrate/index.ts";
import { FIXED_NOW, cleanupTempRoots, tempRoot, writeFile } from "./_helpers.ts";

afterEach(cleanupTempRoots);

const now = () => FIXED_NOW;

describe(".ultrawork/.gitignore 模板", () => {
  test("模板只剩 `*` 一行", () => {
    expect(ULTRAWORK_GITIGNORE_CONTENT).toBe("*\n");
  });

  test("全新專案建出來的 .gitignore 只有 `*` 一行", () => {
    const root = tempRoot();
    migrateProjectData({ root, now });
    expect(readFileSync(join(root, ".ultrawork", ".gitignore"), "utf-8")).toBe("*\n");
  });
});

describe(".ultrawork/.gitignore 一致性檢查", () => {
  test("自訂內容（多一行豁免）只要有 `*` 就不再警告", () => {
    const root = tempRoot();
    // 使用者 config repo 的現況：`*`＋豁免＋自訂行。
    writeFile(
      root,
      ".ultrawork/.gitignore",
      "*\n!.gitignore\n!ultrawork.jsonc\n!skills-policy.json\n!skills-personal.json\n",
    );
    const result = migrateProjectData({ root, now });
    expect(result.gitignore.created).toBe(false);
    expect(result.gitignore.warning).toBeUndefined();
  });

  test("缺 `*` 時才警告，且不覆寫使用者的檔案", () => {
    const root = tempRoot();
    writeFile(root, ".ultrawork/.gitignore", "cache/\n");
    const result = migrateProjectData({ root, now });
    expect(result.gitignore.created).toBe(false);
    expect(result.gitignore.warning).toBeDefined();
    expect(result.gitignore.warning).toContain("*");
    expect(readFileSync(join(root, ".ultrawork/.gitignore"), "utf-8")).toBe("cache/\n");
  });

  test("既有專案的舊模板內容（有 `*`）不自動改寫也不警告", () => {
    const root = tempRoot();
    writeFile(root, ".ultrawork/.gitignore", "*\n!.gitignore\n!ultrawork.jsonc\n");
    const result = migrateProjectData({ root, now });
    expect(result.gitignore.created).toBe(false);
    expect(result.gitignore.warning).toBeUndefined();
    expect(readFileSync(join(root, ".ultrawork/.gitignore"), "utf-8")).toBe("*\n!.gitignore\n!ultrawork.jsonc\n");
  });
});
