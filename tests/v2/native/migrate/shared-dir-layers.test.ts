/**
 * 同一目錄同時是 projectDir 與 globalDir（例如在全域設定資料夾本身開工作階段）：
 * 兩層共用同一個標記檔路徑，標記必須分層記錄 —— 專案層寫完標記，不能讓全域層靜默早退。
 *
 * 目前的行為：`runMigrations` 先跑專案層、寫下標記，全域層看到標記檔存在就回
 * `alreadyMigrated`，四個全域項目（skills-policy.json、skills-personal.json、
 * skill-drafts/、skill-quarantine/）完全不搬。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATION_MARKER_FILE, migrateProjectData, runMigrations } from "../../../../src/migrate/index.ts";
import { FIXED_NOW, cleanupTempRoots, readJson, tempRoot, withOps, writeFile, writeJson } from "./_helpers.ts";

afterEach(cleanupTempRoots);

const now = () => FIXED_NOW;
const marker = (root: string) => join(root, ".ultrawork", MIGRATION_MARKER_FILE);

function seedProjectLegacy(root: string): void {
  writeJson(root, ".opencode/memory/tasks.json", { version: "1", tasks: {} });
  writeFile(root, ".opencode/memory/state.md", "state: IDLE\n");
}

function seedGlobalLegacy(root: string): void {
  writeJson(root, "skills-policy.json", { version: "1.0.0", entries: {} });
  writeJson(root, "skills-personal.json", { pins: {} });
  writeFile(root, "skill-drafts/alpha/SKILL.md", "# 草稿\n");
  writeFile(root, "skill-quarantine/beta/SKILL.md", "# 隔離\n");
}

describe("projectDir == globalDir：兩層都要搬", () => {
  test("同一個目錄跑 runMigrations，全域四項實際被搬遷", () => {
    const root = tempRoot("uw-migrate-shared-");
    seedProjectLegacy(root);
    seedGlobalLegacy(root);

    const result = runMigrations({ projectDir: root, globalDir: root, now });

    expect(result.project.migrated.length).toBeGreaterThan(0);
    // 全域層不再因專案層寫下的標記而早退。
    expect(result.global.alreadyMigrated).toBe(false);
    expect(result.global.migrated.map((item) => item.to).sort()).toEqual(
      [
        join(root, ".ultrawork/skills-personal.json"),
        join(root, ".ultrawork/skills-policy.json"),
        join(root, ".ultrawork/skill-drafts"),
        join(root, ".ultrawork/skill-quarantine"),
      ].sort(),
    );
    expect(existsSync(join(root, ".ultrawork/skills-policy.json"))).toBe(true);
    expect(existsSync(join(root, ".ultrawork/skill-drafts/alpha/SKILL.md"))).toBe(true);
  });

  test("兩層都搬完後再跑一次，兩層都回 alreadyMigrated 且磁碟不再變動", () => {
    const root = tempRoot("uw-migrate-shared-");
    seedProjectLegacy(root);
    seedGlobalLegacy(root);
    runMigrations({ projectDir: root, globalDir: root, now });

    const second = runMigrations({ projectDir: root, globalDir: root, now });
    expect(second.project.alreadyMigrated).toBe(true);
    expect(second.global.alreadyMigrated).toBe(true);
    expect(second.project.items).toEqual([]);
    expect(second.global.items).toEqual([]);
  });
});

describe("已受影響的實例：只有一份舊標記，下次啟動續搬", () => {
  test("舊標記只記了專案層 → 全域層照樣搬，不需手動刪標記", () => {
    const root = tempRoot("uw-migrate-shared-");
    // 重現已受影響的現場：舊版先跑完專案層（寫下單層標記），全域舊資料還在原地。
    seedProjectLegacy(root);
    migrateProjectData({ root, now });
    seedGlobalLegacy(root);
    expect(existsSync(marker(root))).toBe(true);
    expect(existsSync(join(root, "skills-policy.json"))).toBe(true);

    const result = runMigrations({ projectDir: root, globalDir: root, now });

    // 專案層維持已完成，全域層續搬，同一份標記檔升級成兩層都記。
    expect(result.project.alreadyMigrated).toBe(true);
    expect(result.global.alreadyMigrated).toBe(false);
    expect(result.global.migrated).toHaveLength(4);
    expect(existsSync(join(root, ".ultrawork/skills-policy.json"))).toBe(true);

    const payload = readJson(marker(root));
    const recorded = JSON.stringify(payload);
    expect(recorded).toContain(".ultrawork/skills-policy.json");
    expect(recorded).toContain(".ultrawork/tasks.json");

    // 續搬完之後兩層都靜默。
    const third = runMigrations({ projectDir: root, globalDir: root, now });
    expect(third.project.alreadyMigrated).toBe(true);
    expect(third.global.alreadyMigrated).toBe(true);
  });
});

describe("空 v1 標記：舊版在沒有舊資料時也會寫下，不能擋住另一層", () => {
  test("同一目錄已有空 v1 標記＋全域來源仍在 → 全域四項續搬", () => {
    const root = tempRoot("uw-migrate-shared-");
    // 重現舊版順序：專案層先跑、沒有舊資料就寫下空標記，全域來源還在原地。
    writeJson(root, ".ultrawork/.migrated-from-opencode.json", {
      version: 1,
      migratedAt: FIXED_NOW.toISOString(),
      items: [],
      skipped: [],
    });
    seedGlobalLegacy(root);

    const result = runMigrations({ projectDir: root, globalDir: root, now });

    // 空標記沒有攜帶任何層的資訊，不得早退：目標已存在才跳過、不覆寫，所以重跑安全。
    expect(result.global.alreadyMigrated).toBe(false);
    expect(result.global.migrated).toHaveLength(4);
    expect(existsSync(join(root, ".ultrawork/skills-policy.json"))).toBe(true);

    // 續搬完之後兩層都靜默（標記已升級成分層格式）。
    const second = runMigrations({ projectDir: root, globalDir: root, now });
    expect(second.project.alreadyMigrated).toBe(true);
    expect(second.global.alreadyMigrated).toBe(true);
  });
});

describe("改寫失敗的重試：複本已存在但舊參照還沒修好", () => {
  function seedRegistryLegacy(root: string): void {
    writeJson(root, ".opencode/memory/tasks.json", {
      version: "1",
      projectId: "p",
      projectPath: root,
      activeTaskIds: [],
      taskCursor: null,
      tasks: {},
    });
    writeJson(root, ".opencode/memory/plans.json", {
      version: "1",
      projectId: "p",
      projectPath: root,
      activePlanIds: ["p-1"],
      planCursor: "p-1",
      plans: {
        "p-1": {
          planId: "p-1",
          projectId: "p",
          projectPath: root,
          title: "t",
          state: "IN_PROGRESS",
          owner: "ultra",
          priority: "P0",
          createdAt: FIXED_NOW.toISOString(),
          updatedAt: FIXED_NOW.toISOString(),
          taskIds: [],
          finishedTaskIds: [],
          dependencyGraph: { nodes: [], edges: [] },
          history: [],
          contentRef: ".opencode/plans/p-1.md",
        },
      },
    });
    writeFile(root, ".opencode/plans/p-1.md", "# 計畫長文\n");
  }

  test("首次改寫的原子寫入失敗 → 該層停止、不寫標記；重跑修好複本", () => {
    const root = tempRoot("uw-migrate-retry-");
    seedRegistryLegacy(root);
    // 只讓 plans.json 複本的改寫失敗：原子寫入的 temp 檔名是 `.<原檔名>.<pid>…`。
    const failingFs = withOps({
      writeFileSync: ((path: string, content: string, options?: unknown) => {
        if (path.split("/").pop()?.startsWith(".plans.json.")) {
          throw new Error("ENOSPC: 測試注入的改寫失敗");
        }
        return withOps().writeFileSync(path, content, options as never);
      }) as never,
    });

    const first = migrateProjectData({ root, now, fs: failingFs });

    expect(first.ok).toBe(false);
    expect(first.errors.map((item) => item.reason)).toEqual(["copy-failed"]);
    // 未改寫成功前不寫下涵蓋該層的完成標記。
    expect(existsSync(marker(root))).toBe(false);
    // 來源已按正常流程封存（資料沒丟），複本留著舊參照等修。
    expect(existsSync(join(root, ".opencode/memory/plans.json"))).toBe(false);
    expect(readJson(join(root, ".ultrawork/plans.json")).plans["p-1"].contentRef).toBe(
      ".opencode/plans/p-1.md",
    );

    // 重跑：不得因目標已存在就跳過改寫。
    const retry = migrateProjectData({ root, now });

    expect(retry.ok).toBe(true);
    expect(readJson(join(root, ".ultrawork/plans.json")).plans["p-1"].contentRef).toBe(
      ".ultrawork/plans/p-1.md",
    );
    expect(existsSync(marker(root))).toBe(true);
    const payload = readJson(marker(root));
    expect(JSON.stringify(payload.layers?.project ?? payload)).toContain(".ultrawork/plans.json");
  });
});

describe("搬遷改寫註冊檔內的舊 contentRef", () => {
  test("本次真實撞到的形狀：plans.json 的 contentRef 由 .opencode/ 改寫成 .ultrawork/", () => {
    const root = tempRoot("uw-migrate-shared-");
    writeJson(root, ".opencode/memory/plans.json", {
      version: "1",
      projectId: "p",
      projectPath: root,
      activePlanIds: ["uw-v2-native-rewrite-20260925"],
      planCursor: "uw-v2-native-rewrite-20260925",
      plans: {
        "uw-v2-native-rewrite-20260925": {
          planId: "uw-v2-native-rewrite-20260925",
          projectId: "p",
          projectPath: root,
          title: "t",
          state: "IN_PROGRESS",
          owner: "ultra",
          priority: "P0",
          createdAt: FIXED_NOW.toISOString(),
          updatedAt: FIXED_NOW.toISOString(),
          taskIds: [],
          finishedTaskIds: [],
          dependencyGraph: { nodes: [], edges: [] },
          history: [],
          contentRef: ".opencode/plans/uw-v2-native-rewrite-20260925.md",
        },
      },
    });
    writeJson(root, ".opencode/memory/tasks.json", {
      version: "1",
      projectId: "p",
      projectPath: root,
      activeTaskIds: ["t-1"],
      taskCursor: "t-1",
      tasks: {
        "t-1": {
          taskId: "t-1",
          projectId: "p",
          projectPath: root,
          title: "t",
          state: "IN_PROGRESS",
          owner: "ultra",
          priority: "P0",
          updatedAt: FIXED_NOW.toISOString(),
          history: [],
          planId: "uw-v2-native-rewrite-20260925",
          contentRef: ".opencode/plans/uw-v2-native-rewrite-20260925.md#task-t-1",
        },
      },
    });
    writeFile(root, ".opencode/plans/uw-v2-native-rewrite-20260925.md", "# 計畫長文\n");

    const result = runMigrations({ projectDir: root, globalDir: tempRoot("uw-migrate-global-"), now });
    expect(result.project.ok).toBe(true);

    const plans = readJson(join(root, ".ultrawork/plans.json"));
    expect(plans.plans["uw-v2-native-rewrite-20260925"].contentRef).toBe(
      ".ultrawork/plans/uw-v2-native-rewrite-20260925.md",
    );
    const tasks = readJson(join(root, ".ultrawork/tasks.json"));
    expect(tasks.tasks["t-1"].contentRef).toBe(".ultrawork/plans/uw-v2-native-rewrite-20260925.md#task-t-1");
    // 舊檔改名保留的內容維持原樣（只改新位置的複本）。
    expect(readFileSync(join(root, ".opencode/memory", "plans.json.migrated-20260101T000000Z"), "utf-8")).toContain(
      ".opencode/plans/uw-v2-native-rewrite-20260925.md",
    );
  });
});

describe("搬遷改寫任務的舊 taskContentPath", () => {
  test("同守衛同規則：.opencode/ 前綴的 taskContentPath 一併換掉，其他欄位不動", () => {
    const root = tempRoot("uw-migrate-shared-");
    writeJson(root, ".opencode/memory/tasks.json", {
      version: "1",
      projectId: "p",
      projectPath: root,
      activeTaskIds: ["t-1"],
      taskCursor: "t-1",
      tasks: {
        "t-1": {
          taskId: "t-1",
          projectId: "p",
          projectPath: root,
          title: "提到 .opencode/plans 的標題不動",
          state: "IN_PROGRESS",
          owner: "ultra",
          priority: "P0",
          updatedAt: FIXED_NOW.toISOString(),
          history: [],
          taskContentMode: "file",
          taskContentPath: ".opencode/plans/tasks/t-1.md",
          contentRef: ".opencode/plans/tasks/t-1.md",
        },
      },
    });

    const result = migrateProjectData({ root, now });
    expect(result.ok).toBe(true);

    const task = readJson(join(root, ".ultrawork/tasks.json")).tasks["t-1"];
    expect(task.taskContentPath).toBe(".ultrawork/plans/tasks/t-1.md");
    expect(task.contentRef).toBe(".ultrawork/plans/tasks/t-1.md");
    expect(task.title).toBe("提到 .opencode/plans 的標題不動");
  });
});

describe("修復只碰我們自己的複本：使用者原本就有的目標一個位元組都不改", () => {
  test("無效標記＋使用者目標（含舊參照）＋舊來源仍在 → 重跑後該檔逐字不變", () => {
    const root = tempRoot("uw-migrate-shared-");
    const globalDir = tempRoot("uw-migrate-global-");
    const userTarget = JSON.stringify(
      {
        version: "1",
        projectId: "p",
        projectPath: root,
        activePlanIds: ["p-1"],
        planCursor: "p-1",
        plans: {
          "p-1": {
            planId: "p-1",
            projectId: "p",
            projectPath: root,
            title: "使用者自己的計畫",
            state: "IN_PROGRESS",
            owner: "ultra",
            priority: "P0",
            createdAt: FIXED_NOW.toISOString(),
            updatedAt: FIXED_NOW.toISOString(),
            taskIds: [],
            finishedTaskIds: [],
            dependencyGraph: { nodes: [], edges: [] },
            history: [],
            contentRef: ".opencode/plans/p-1.md",
          },
        },
      },
      null,
      2,
    );
    // 使用者原本就有的目標：我們沒複製過它（舊來源還在、沒有任何封存檔）。
    writeFile(root, ".ultrawork/plans.json", `${userTarget}\n`);
    writeJson(root, ".opencode/memory/plans.json", JSON.parse(userTarget));
    writeFile(root, ".ultrawork/.migrated-from-opencode.json", "{ broken json\n");
    const before = readFileSync(join(root, ".ultrawork/plans.json"), "utf-8");

    const result = runMigrations({ projectDir: root, globalDir, now });

    expect(result.project.ok).toBe(true);
    // 不動手、只回報：警告要講清楚有舊參照且需要自行處理。
    expect(result.warnings.some((w) => w.includes("自行把參照換成"))).toBe(true);
    // 逐字不變：內容相同，且舊來源沒有被改名（目標已存在就跳過、不覆寫）。
    expect(readFileSync(join(root, ".ultrawork/plans.json"), "utf-8")).toBe(before);
    expect(existsSync(join(root, ".opencode/memory/plans.json"))).toBe(true);
  });
});

describe("位元組辨認：解碼後字串相同不算相同", () => {
  // 標題裡各放一個無效 UTF-8 位元組（0xFF vs 0xFE）：解碼後都是同一個替代字元，
  // JSON 照樣解析成功、contentRef 也都有舊參照；但原始位元組不同。
  function registryBytes(markerByte: number): Buffer {
    const head = Buffer.from(
      '{"version":"1","projectId":"p","projectPath":"/r","activePlanIds":["p-1"],' +
        '"planCursor":"p-1","plans":{"p-1":{"planId":"p-1","projectId":"p","projectPath":"/r",' +
        '"title":"t',
      "utf-8",
    );
    const tail = Buffer.from(
      'itle","state":"IN_PROGRESS","owner":"ultra","priority":"P0",' +
        '"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z",' +
        '"taskIds":[],"finishedTaskIds":[],"dependencyGraph":{"nodes":[],"edges":[]},"history":[],' +
        '"contentRef":".opencode/plans/p-1.md"}}}\n',
      "utf-8",
    );
    return Buffer.concat([head, Buffer.from([markerByte]), tail]);
  }

  test("位元組不同但解碼相同 → foreign，目標逐字不變", () => {
    const root = tempRoot("uw-migrate-bytes-");
    const targetBytes = registryBytes(0xff);
    const archiveBytes = registryBytes(0xfe);
    // 先鎖定前提：這組輸入解碼後真的相同（否則測的只是普通不同的檔案）。
    expect(targetBytes.toString("utf-8")).toBe(archiveBytes.toString("utf-8"));
    expect(Buffer.isBuffer(targetBytes) && !targetBytes.equals(archiveBytes)).toBe(true);

    // 上輪搬移留下的現場：來源已封存、複本在新位置；封存檔與複本差一個無效位元組。
    mkdirSync(join(root, ".ultrawork"), { recursive: true });
    mkdirSync(join(root, ".opencode", "memory"), { recursive: true });
    writeFileSync(join(root, ".ultrawork/plans.json"), targetBytes);
    writeFileSync(join(root, ".opencode/memory/plans.json.migrated-20260101T000000Z"), archiveBytes);
    const before = readFileSync(join(root, ".ultrawork/plans.json"));

    const result = migrateProjectData({ root, now });

    expect(result.ok).toBe(true);
    // 修正前：解碼字串相等被當成複本，目標被改寫，這裡逐字比對失敗。
    expect(readFileSync(join(root, ".ultrawork/plans.json")).equals(before)).toBe(true);
  });
});
