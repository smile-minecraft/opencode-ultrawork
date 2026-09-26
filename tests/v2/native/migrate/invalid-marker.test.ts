/**
 * 標記檔存在但不可用時，兩端必須給同一個答案：「不算涵蓋」。
 *
 * 三種不可用：讀取失敗、不是合法 JSON、JSON 根不是物件。舊來源仍在時，
 * 診斷端必須回報待搬（搬移端本來就會繼續嘗試）；搬完一輪後標記要自我修復
 * 成合法可解析的分層格式，而不是永遠卡著。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MIGRATION_MARKER_FILE,
  inspectProjectMigration,
  migrateProjectData,
} from "../../../../src/migrate/index.ts";
import { FIXED_NOW, cleanupTempRoots, readJson, tempRoot, withOps, writeFile, writeJson } from "./_helpers.ts";

afterEach(cleanupTempRoots);

const now = () => FIXED_NOW;
const marker = (root: string) => join(root, ".ultrawork", MIGRATION_MARKER_FILE);

function seedLegacy(root: string): void {
  writeJson(root, ".opencode/memory/tasks.json", { version: "1", tasks: {} });
  writeFile(root, ".opencode/memory/state.md", "state: IDLE\n");
}

/** 搬完之後的標記必須是合法 JSON、分層格式且涵蓋專案層。 */
function expectHealedMarker(root: string): void {
  expect(existsSync(marker(root))).toBe(true);
  const payload = readJson(marker(root));
  expect(payload.version).toBe(2);
  expect(Object.keys(payload.layers ?? {})).toContain("project");
}

describe("無效標記＋舊來源仍在：診斷端回報待搬，搬移端照常嘗試並自我修復", () => {
  test("讀取失敗 → 待搬；搬完後標記可解析", () => {
    const root = tempRoot("uw-migrate-invalid-");
    seedLegacy(root);
    writeFile(root, ".ultrawork/.migrated-from-opencode.json", '{"version":1}\n');
    const unreadableFs = withOps({
      readFileSync: ((path: string, encoding: unknown) => {
        if (path === marker(root)) throw new Error("EACCES: 測試注入的讀取失敗");
        return withOps().readFileSync(path, encoding as never);
      }) as never,
    });

    // 修正前：診斷端把讀不到當成已涵蓋，回報已完成。
    expect(inspectProjectMigration(root, unreadableFs).pending).toBe(true);

    const result = migrateProjectData({ root, now, fs: unreadableFs });
    expect(result.alreadyMigrated).toBe(false);
    expect(result.ok).toBe(true);
    expectHealedMarker(root);
  });

  test("不是合法 JSON → 待搬；搬完後標記可解析", () => {
    const root = tempRoot("uw-migrate-invalid-");
    seedLegacy(root);
    writeFile(root, ".ultrawork/.migrated-from-opencode.json", "{ broken json\n");

    // 修正前：解析失敗被當成已涵蓋，回報已完成。
    expect(inspectProjectMigration(root).pending).toBe(true);

    const result = migrateProjectData({ root, now });
    expect(result.alreadyMigrated).toBe(false);
    expect(result.ok).toBe(true);
    expectHealedMarker(root);
  });

  test("JSON 根不是物件 → 待搬；搬完後標記可解析", () => {
    const root = tempRoot("uw-migrate-invalid-");
    seedLegacy(root);
    writeFile(root, ".ultrawork/.migrated-from-opencode.json", "42\n");

    // 修正前：非物件被當成已涵蓋，回報已完成。
    expect(inspectProjectMigration(root).pending).toBe(true);

    const result = migrateProjectData({ root, now });
    expect(result.alreadyMigrated).toBe(false);
    expect(result.ok).toBe(true);
    expectHealedMarker(root);
  });
});

describe("兩端一致：同一份無效標記，「這一層是否已完成」答案相同", () => {
  const cases: Array<{ name: string; content: string }> = [
    { name: "非 JSON", content: "{ broken json\n" },
    { name: "根不是物件", content: '"just a string"\n' },
    { name: "空物件", content: "{}\n" },
  ];
  for (const { name, content } of cases) {
    test(`${name}：診斷 pending ⟺ 搬移不早退`, () => {
      const root = tempRoot("uw-migrate-invalid-");
      seedLegacy(root);
      writeFile(root, ".ultrawork/.migrated-from-opencode.json", content);

      const report = inspectProjectMigration(root);
      const result = migrateProjectData({ root, now });

      // 兩端都說「還沒完成」：診斷待搬，搬移真的去搬（不早退）。
      expect(report.pending).toBe(true);
      expect(result.alreadyMigrated).toBe(false);
      expect(result.ok).toBe(true);
      expectHealedMarker(root);
    });
  }
});

describe("分層記錄無效值不算涵蓋", () => {
  test("layers.project: null → 診斷待搬、搬移不早退", () => {
    const root = tempRoot("uw-migrate-invalid-");
    seedLegacy(root);
    writeFile(
      root,
      ".ultrawork/.migrated-from-opencode.json",
      '{"version":2,"migratedAt":"2026-01-01T00:00:00.000Z","items":[],"skipped":[],"layers":{"project":null}}\n',
    );

    expect(inspectProjectMigration(root).pending).toBe(true);

    const result = migrateProjectData({ root, now });
    expect(result.alreadyMigrated).toBe(false);
    expect(result.ok).toBe(true);
    expectHealedMarker(root);
  });

  test("layers.project 是字串等非記錄值 → 診斷待搬、搬移不早退", () => {
    const root = tempRoot("uw-migrate-invalid-");
    seedLegacy(root);
    writeFile(
      root,
      ".ultrawork/.migrated-from-opencode.json",
      '{"version":2,"migratedAt":"2026-01-01T00:00:00.000Z","items":[],"skipped":[],"layers":{"project":"done"}}\n',
    );

    expect(inspectProjectMigration(root).pending).toBe(true);

    const result = migrateProjectData({ root, now });
    expect(result.alreadyMigrated).toBe(false);
    expect(result.ok).toBe(true);
    expectHealedMarker(root);
  });
});
