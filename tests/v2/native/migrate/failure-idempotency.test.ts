/**
 * 搬到一半失敗與重跑冪等。
 *
 * 用注入的檔案操作讓其中一項拋錯，證明：該層停止、不寫標記、已搬的項目沒有回滾，
 * 而且重跑時已搬的會被自然跳過、剩下的補完。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MIGRATION_MARKER_FILE, migrateProjectData, runMigrations } from "../../../../src/migrate/index.ts";
import { FIXED_NOW, archivedName, cleanupTempRoots, tempRoot, withOps, writeFile, writeJson } from "./_helpers.ts";

afterEach(cleanupTempRoots);

const now = () => FIXED_NOW;
const marker = (root: string) => join(root, ".ultrawork", MIGRATION_MARKER_FILE);

function seedLegacy(root: string): void {
  writeJson(root, ".opencode/memory/tasks.json", { version: "1" });
  writeFile(root, ".opencode/memory/state.md", "state: IDLE\n");
  writeFile(root, ".opencode/memory/receipts/r-1.json", '{"receiptId":"r-1"}\n');
}

function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else out.push(`${rel}:${statSync(join(dir, entry.name)).size}`);
    }
  };
  walk(root, "");
  return out.sort();
}

describe("搬到一半失敗", () => {
  test("該層停止、不寫標記、錯誤被記下來，磁碟沒有半套暫存", () => {
    const root = tempRoot();
    seedLegacy(root);
    // 第 3 項（receipts）複製時失敗。
    const fs = withOps({
      copyFileSync: (source, destination) => {
        if (source.includes("receipts")) throw new Error("EACCES: 測試注入的複製失敗");
        const real = withOps();
        real.copyFileSync(source, destination);
      },
    });

    const result = migrateProjectData({ root, now, fs });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("copy-failed");
    expect(result.errors[0].detail).toContain("測試注入的複製失敗");
    // 失敗後不再往下搬（後面的舊資料還在原位）。
    expect(result.items.filter((item) => item.status === "migrated")).toHaveLength(2);
    expect(existsSync(marker(root))).toBe(false);
    // 暫存路徑被清掉，目標位置沒有半套 receipts。
    expect(snapshot(root).filter((entry) => entry.includes(".partial-"))).toEqual([]);
    expect(existsSync(join(root, ".ultrawork/receipts"))).toBe(false);
    expect(existsSync(join(root, ".opencode/memory/receipts/r-1.json"))).toBe(true);
  });

  test("重跑：已搬的跳過、剩下的補完、標記補上（冪等收斂）", () => {
    const root = tempRoot();
    seedLegacy(root);
    const fs = withOps({
      copyFileSync: (source, destination) => {
        if (source.includes("receipts")) throw new Error("EACCES: 測試注入的複製失敗");
        withOps().copyFileSync(source, destination);
      },
    });
    migrateProjectData({ root, now, fs });

    const retry = migrateProjectData({ root, now });

    expect(retry.ok).toBe(true);
    expect(retry.migrated.map((item) => item.to)).toEqual([join(root, ".ultrawork/receipts")]);
    // 已搬的兩項舊檔上一輪就改名保留過了，所以這次是「舊位置不存在」而跳過。
    expect(retry.skipped).toHaveLength(7);
    expect(retry.skipped.map((item) => item.from)).toContain(join(root, ".opencode/memory/tasks.json"));
    expect(retry.skipped.map((item) => item.from)).toContain(join(root, ".opencode/memory/state.md"));
    expect(retry.migrated.map((item) => item.to)).not.toContain(join(root, ".ultrawork/tasks.json"));
    expect(existsSync(join(root, ".ultrawork/receipts/r-1.json"))).toBe(true);
    expect(readFileSync(join(root, ".ultrawork/tasks.json"), "utf-8")).toBe(
      readFileSync(join(root, ".opencode/memory", archivedName("tasks.json")), "utf-8"),
    );

    const payload = JSON.parse(readFileSync(marker(root), "utf-8"));
    expect(payload.items.map((item: { to: string }) => item.to)).toEqual([".ultrawork/receipts"]);
    expect(payload.skipped).toEqual([]);
  });

  test("搬完之後的第三次呼叫完全不做任何事", () => {
    const root = tempRoot();
    seedLegacy(root);
    migrateProjectData({ root, now, fs: withOps({ copyFileSync: () => { throw new Error("不該被呼叫"); } }) });
    migrateProjectData({ root, now });
    const before = snapshot(root);
    const third = migrateProjectData({ root, now });
    expect(third.alreadyMigrated).toBe(true);
    expect(third.items).toEqual([]);
    expect(snapshot(root)).toEqual(before);
  });
});

describe("兩層一起跑", () => {
  test("專案層失敗不影響全域層，警告同時收齊", () => {
    const projectDir = tempRoot("uw-migrate-project-");
    const globalDir = tempRoot("uw-migrate-global-");
    seedLegacy(projectDir);
    writeJson(globalDir, "skills-policy.json", { version: "1.0.0" });
    writeFile(projectDir, ".ultrawork/state.md", "使用者既有資料\n");

    const result = runMigrations({
      projectDir,
      globalDir,
      now,
      fs: withOps({
        copyFileSync: (source, destination) => {
          if (source.includes("receipts")) throw new Error("測試注入的複製失敗");
          withOps().copyFileSync(source, destination);
        },
      }),
    });

    expect(result.project.ok).toBe(false);
    expect(result.global.ok).toBe(true);
    expect(existsSync(join(globalDir, ".ultrawork/skills-policy.json"))).toBe(true);
    expect(existsSync(join(projectDir, ".opencode/memory", archivedName("tasks.json")))).toBe(true);
    expect(result.warnings.some((w) => w.includes("state.md") && w.includes("搬遷略過"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("搬移失敗") || w.includes("失敗"))).toBe(true);
  });

  test("沒有傳入根目錄時回空結果，不丟錯", () => {
    const result = runMigrations({ now });
    expect(result.project.items).toEqual([]);
    expect(result.global.items).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
