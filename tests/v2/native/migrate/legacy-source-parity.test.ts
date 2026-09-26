/**
 * 專案層「舊資料位置是 symlink」時，搬移端與診斷端要給同一個答案。
 *
 * 搬移端逐項判斷「舊位置是否存在」用不跟隨 symlink 的 `lstatSync()`；診斷端的
 * `inspectProjectMigration()`（`workflow_doctor` 唯一的搬移狀態來源）以前用
 * 會跟隨 symlink 的 `existsSync()`，於是「頂層舊位置是斷鏈 symlink」時會回
 * 「沒有待搬遷」。這裡把兩端釘在同一個 helper 的語意上：
 *
 * - 斷鏈 symlink → 視為舊資料還在（doctor warn），搬移端不寫標記、每次重試；
 * - 完全沒有舊資料 → 兩端都說沒事（doctor passed）；
 * - 有效 symlink 指向存在的目錄 → 兩端都說還有得搬（doctor warn）。
 *
 * 標記檔存在時以標記檔為準（`pending = 沒有標記 && 還有舊資料`），這是兩端共用的
 * 同一個判斷式，所以「已搬完但舊 symlink 還在」一律回 passed。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MIGRATION_MARKER_FILE,
  inspectProjectMigration,
  migrateProjectData,
} from "../../../../src/migrate/index.ts";
import { FIXED_NOW, cleanupTempRoots, tempRoot, writeFile } from "./_helpers.ts";

afterEach(cleanupTempRoots);

const now = () => FIXED_NOW;
const marker = (root: string) => join(root, ".ultrawork", MIGRATION_MARKER_FILE);

function makeLink(root: string, relativePath: string, target: string): string {
  const link = join(root, relativePath);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link);
  return link;
}

describe("舊資料位置是斷鏈 symlink", () => {
  test(".opencode/plans 斷鏈 → 視為還有舊資料，搬移端不寫標記並每次重試", () => {
    const root = tempRoot("uw-migrate-project-");
    const link = makeLink(root, ".opencode/plans", join(root, "external-storage", "plans"));

    // 診斷端：不能說「沒有待搬遷」——搬移端明明每次都在重試。
    expect(inspectProjectMigration(root).pending).toBe(true);
    expect(inspectProjectMigration(root).legacySources).toEqual([".opencode/plans"]);

    migrateProjectData({ root, now });
    expect(existsSync(marker(root))).toBe(false);

    const retry = migrateProjectData({ root, now });
    expect(retry.alreadyMigrated).toBe(false);
    expect(retry.errors.map((item) => item.reason)).toEqual(["copy-failed"]);
    expect(existsSync(marker(root))).toBe(false);
    // 斷鏈 symlink 本身沒被刪也沒被改名。
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test(".opencode/memory 斷鏈 → 視為還有舊資料（doctor 不會靜默說沒事）", () => {
    const root = tempRoot("uw-migrate-project-");
    makeLink(root, ".opencode/memory", join(root, "external-storage", "memory"));

    const report = inspectProjectMigration(root);
    expect(report.pending).toBe(true);
    expect(report.legacySources).toEqual([".opencode/memory"]);
  });

  test("斷鏈 symlink 修好成真目錄後重跑 → 補完並寫上標記", () => {
    const root = tempRoot("uw-migrate-project-");
    makeLink(root, ".opencode/plans", join(root, "external-storage", "plans"));
    migrateProjectData({ root, now });
    expect(existsSync(marker(root))).toBe(false);

    writeFile(root, "external-storage/plans/tasks.json", '{"version":"1"}\n');
    const retry = migrateProjectData({ root, now });

    expect(retry.ok).toBe(true);
    expect(existsSync(marker(root))).toBe(true);
    expect(inspectProjectMigration(root).pending).toBe(false);
  });
});

describe("舊資料位置是有效 symlink 或真的沒有", () => {
  /**
   * 舊資料的**父層**是 symlink → 搬移端不跟著搬、也不寫標記。
   *
   * 這裡的 `.opencode/memory` 就是搬遷項目的父層，所以搬移端記 `unsafe-path`。
   * 兩端因此永遠一致：診斷端說「還有得搬」，搬移端就真的每次都重試而且從不
   * 標記完成 —— 不再有「搬移端改口說搬完了、doctor 卻找不到警告」的落差。
   */
  test("有效 symlink 指向存在的目錄 → 兩端都認為還有得搬，搬移端不寫標記", () => {
    const root = tempRoot("uw-migrate-project-");
    const external = tempRoot("uw-migrate-external-");
    writeFile(external, "tasks.json", '{"version":"1"}');
    makeLink(root, ".opencode/memory", external);

    expect(inspectProjectMigration(root).pending).toBe(true);

    const result = migrateProjectData({ root, now });
    expect(result.ok).toBe(false);
    expect(result.errors.map((item) => item.reason)).toEqual(["unsafe-path"]);
    // 外部共用的資料一個都沒被動。
    expect(readdirSync(external)).toEqual(["tasks.json"]);
    expect(existsSync(join(external, "tasks.json.migrated-20260101T000000Z"))).toBe(false);
    // 標記永遠不寫，診斷端也永遠說還有得搬。
    expect(existsSync(marker(root))).toBe(false);
    expect(inspectProjectMigration(root).pending).toBe(true);
  });

  test("完全沒有舊資料 → 兩端都說沒事", () => {
    const root = tempRoot("uw-migrate-project-");

    const report = inspectProjectMigration(root);
    expect(report.pending).toBe(false);
    expect(report.legacySources).toEqual([]);

    const result = migrateProjectData({ root, now });
    expect(result.ok).toBe(true);
    expect(existsSync(marker(root))).toBe(true);
  });
});
