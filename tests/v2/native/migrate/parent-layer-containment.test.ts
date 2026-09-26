/**
 * 搬遷觸及的父層必須通過 canonical containment。
 *
 * `joinLayerPath` 原本只做字串比對（`isInsideWorktree`），抓不到祖先 symlink：
 * `<專案>/.opencode` 指向專案外的共用目錄時，搬遷會穿過 symlink 動手 ——
 * 第一個專案把外部共用的 `tasks.json` 改名保留、第二個專案全部變成
 * `source-missing` 卻照樣寫下完成標記，之後它的任務／計畫狀態靜默變空，
 * 而且標記存在讓 `workflow_doctor` 的「搬遷未完成」永遠不會出現。
 *
 * 這裡把封頂後的行為釘住：來源與目的的**父層**任何一段是 symlink（指向外部或
 * 內部都一樣）→ 該項記 `unsafe-path`、該層不寫標記、磁碟上完全沒被動。
 * 刻意**不跟隨 symlink 去搬外部資料**：寧可失敗並讓診斷工具回報，也不猜
 * 跨專案共用的語意。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { setupUltrawork } from "../../../../src/index.ts";
import {
  MIGRATION_MARKER_FILE,
  inspectProjectMigration,
  migrateGlobalData,
  migrateProjectData,
} from "../../../../src/migrate/index.ts";
import { createFakeV2Context } from "../../_fake-v2-context.ts";
import { FIXED_NOW, cleanupTempRoots, tempRoot, writeFile, writeJson } from "./_helpers.ts";

afterEach(cleanupTempRoots);

const now = () => FIXED_NOW;
const marker = (root: string) => join(root, ".ultrawork", MIGRATION_MARKER_FILE);
const archived = (name: string) => `${name}.migrated-20260101T000000Z`;

/** 專案外的共用目錄：兩個專案的 `.opencode` 一起指向它。 */
function seedSharedOpencode(external: string): void {
  writeJson(external, "memory/tasks.json", { version: "1", tasks: { "t-1": {} } });
  writeFile(external, "memory/state.md", "state: IN_PROGRESS\n");
  writeFile(external, "plans/plan-1.md", "# 計畫長文\n");
}

/** `<專案>/.opencode` 做成指向外部共用目錄的 symlink。 */
function linkOpencodeTo(projectRoot: string, external: string): string {
  const link = join(projectRoot, ".opencode");
  symlinkSync(external, link, "dir");
  return link;
}

/** 把 `.opencode` symlink 換成真的目錄，內容沿用外部那份。 */
function replaceOpencodeLinkWithRealDir(projectRoot: string, external: string): void {
  const link = join(projectRoot, ".opencode");
  rmSync(link);
  cpSync(external, link, { recursive: true });
}

/** 列出目錄（含隱藏檔）頂層項目；symlink 本身也算一項。 */
function entriesOf(dir: string): string[] {
  return readdirSync(dir).sort();
}

describe("兩個專案共用外部的 .opencode", () => {
  test("兩個專案都不寫完成標記，外部共用的檔案一個都沒被改名", () => {
    const external = tempRoot("uw-migrate-shared-");
    const projectA = tempRoot("uw-migrate-project-");
    const projectB = tempRoot("uw-migrate-project-");
    seedSharedOpencode(external);
    linkOpencodeTo(projectA, external);
    linkOpencodeTo(projectB, external);
    const before = entriesOf(external);

    const resultA = migrateProjectData({ root: projectA, now });
    const resultB = migrateProjectData({ root: projectB, now });

    for (const result of [resultA, resultB]) {
      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toBe("unsafe-path");
      expect(result.migrated).toEqual([]);
      expect(result.skipped).toEqual([]);
      // 第一項就停住，該層不寫標記，下次啟動重試。
      expect(existsSync(marker(result.root))).toBe(false);
    }

    // 外部共用的資料完全沒被動：沒有改名保留、沒有被搬走。
    expect(entriesOf(external)).toEqual(before);
    expect(existsSync(join(external, "memory/tasks.json"))).toBe(true);
    expect(existsSync(join(external, "memory", archived("tasks.json")))).toBe(false);
  });

  test("兩個專案都沒有把外部資料搬進自己的 .ultrawork/", () => {
    const external = tempRoot("uw-migrate-shared-");
    const projectA = tempRoot("uw-migrate-project-");
    const projectB = tempRoot("uw-migrate-project-");
    seedSharedOpencode(external);
    linkOpencodeTo(projectA, external);
    linkOpencodeTo(projectB, external);

    migrateProjectData({ root: projectA, now });
    migrateProjectData({ root: projectB, now });

    for (const projectRoot of [projectA, projectB]) {
      expect(existsSync(join(projectRoot, ".ultrawork/tasks.json"))).toBe(false);
      expect(existsSync(join(projectRoot, ".ultrawork/plans/plan-1.md"))).toBe(false);
      expect(existsSync(join(projectRoot, ".ultrawork/receipts"))).toBe(false);
      // 只有外掛自己的 .gitignore，沒有任何搬過來的資料。
      expect(entriesOf(join(projectRoot, ".ultrawork"))).toEqual([".gitignore"]);
    }
  });

  test("診斷端對兩個專案都回報「搬遷未完成」", () => {
    const external = tempRoot("uw-migrate-shared-");
    const projectA = tempRoot("uw-migrate-project-");
    const projectB = tempRoot("uw-migrate-project-");
    seedSharedOpencode(external);
    linkOpencodeTo(projectA, external);
    linkOpencodeTo(projectB, external);

    migrateProjectData({ root: projectA, now });
    migrateProjectData({ root: projectB, now });

    for (const projectRoot of [projectA, projectB]) {
      const report = inspectProjectMigration(projectRoot);
      expect(report.markerExists).toBe(false);
      expect(report.pending).toBe(true);
      expect(report.legacySources).toEqual([".opencode/memory", ".opencode/plans"]);
    }
  });

  test("診斷端帶出 unsafe-path 原因，讓使用者知道是被安全檢查擋下", () => {
    const external = tempRoot("uw-migrate-shared-");
    const projectRoot = tempRoot("uw-migrate-project-");
    seedSharedOpencode(external);
    linkOpencodeTo(projectRoot, external);

    const report = inspectProjectMigration(projectRoot);

    expect(report.pending).toBe(true);
    expect(report.reason).toBe("unsafe-path");
    expect(report.detail).toContain("symlink");
  });

  test("只是還沒搬完（路徑正常）→ 不給原因碼，維持原本的未完成語意", () => {
    const projectRoot = tempRoot("uw-migrate-project-");
    writeJson(projectRoot, ".opencode/memory/tasks.json", { version: "1" });

    const report = inspectProjectMigration(projectRoot);

    expect(report.pending).toBe(true);
    expect(report.reason).toBeUndefined();
    expect(report.detail).toBeUndefined();
  });

  test("重跑還是會再試一次（收斂，不是靜默略過）", () => {
    const external = tempRoot("uw-migrate-shared-");
    const projectRoot = tempRoot("uw-migrate-project-");
    seedSharedOpencode(external);
    linkOpencodeTo(projectRoot, external);
    migrateProjectData({ root: projectRoot, now });

    const retry = migrateProjectData({ root: projectRoot, now });

    expect(retry.alreadyMigrated).toBe(false);
    expect(retry.errors.map((item) => item.reason)).toEqual(["unsafe-path"]);
    expect(existsSync(marker(projectRoot))).toBe(false);
  });

  test(".opencode 換回真目錄後重跑會補完並寫上標記", () => {
    const external = tempRoot("uw-migrate-shared-");
    const projectRoot = tempRoot("uw-migrate-project-");
    seedSharedOpencode(external);
    linkOpencodeTo(projectRoot, external);
    migrateProjectData({ root: projectRoot, now });
    expect(existsSync(marker(projectRoot))).toBe(false);

    replaceOpencodeLinkWithRealDir(projectRoot, external);
    const retry = migrateProjectData({ root: projectRoot, now });

    expect(retry.ok).toBe(true);
    expect(retry.errors).toEqual([]);
    expect(existsSync(join(projectRoot, ".ultrawork/tasks.json"))).toBe(true);
    expect(existsSync(marker(projectRoot))).toBe(true);
  });
});

describe(".ultrawork 本身是 symlink", () => {
  test("專案層：外部目錄一個新檔案都沒有，該層失敗、不寫標記", () => {
    const projectRoot = tempRoot("uw-migrate-project-");
    const outside = tempRoot("uw-migrate-outside-");
    writeJson(projectRoot, ".opencode/memory/tasks.json", { version: "1" });
    writeFile(projectRoot, ".opencode/memory/state.md", "state: IDLE\n");
    symlinkSync(outside, join(projectRoot, ".ultrawork"), "dir");

    const result = migrateProjectData({ root: projectRoot, now });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("unsafe-path");
    expect(existsSync(marker(projectRoot))).toBe(false);
    // 外部目錄完全沒被寫：沒有 .gitignore、沒有標記、沒有複製出來的資料。
    expect(entriesOf(outside)).toEqual([]);
  });

  test("專案層：.gitignore 也不建立，並留下警告說明原因", () => {
    const projectRoot = tempRoot("uw-migrate-project-");
    const outside = tempRoot("uw-migrate-outside-");
    symlinkSync(outside, join(projectRoot, ".ultrawork"), "dir");

    const result = migrateProjectData({ root: projectRoot, now });

    expect(result.gitignore.created).toBe(false);
    expect(result.gitignore.warning).toContain("symlink");
    expect(entriesOf(outside)).toEqual([]);
  });

  test("全域層：外部目錄一個新檔案都沒有，該層失敗、不寫標記", () => {
    const globalRoot = tempRoot("uw-migrate-global-");
    const outside = tempRoot("uw-migrate-outside-");
    writeJson(globalRoot, "skills-policy.json", { version: "1.0.0" });
    writeFile(globalRoot, "skill-drafts/alpha/SKILL.md", "# 草稿\n");
    symlinkSync(outside, join(globalRoot, ".ultrawork"), "dir");

    const result = migrateGlobalData({ root: globalRoot, now });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("unsafe-path");
    expect(existsSync(marker(globalRoot))).toBe(false);
    expect(entriesOf(outside)).toEqual([]);
    // 舊資料原地保留、沒有改名。
    expect(existsSync(join(globalRoot, "skills-policy.json"))).toBe(true);
    expect(existsSync(join(globalRoot, archived("skills-policy.json")))).toBe(false);
  });

  test(".ultrawork 換回真目錄後重跑會補完並寫上標記", () => {
    const projectRoot = tempRoot("uw-migrate-project-");
    const outside = tempRoot("uw-migrate-outside-");
    writeJson(projectRoot, ".opencode/memory/tasks.json", { version: "1" });
    const link = join(projectRoot, ".ultrawork");
    symlinkSync(outside, link, "dir");
    migrateProjectData({ root: projectRoot, now });
    expect(existsSync(marker(projectRoot))).toBe(false);

    rmSync(link);
    const retry = migrateProjectData({ root: projectRoot, now });

    expect(retry.ok).toBe(true);
    expect(existsSync(join(projectRoot, ".ultrawork/tasks.json"))).toBe(true);
    expect(existsSync(marker(projectRoot))).toBe(true);
  });

  test("啟動警告會把 .gitignore 沒建立的訊息一起印出來", async () => {
    const projectRoot = tempRoot("uw-migrate-project-");
    const globalRoot = tempRoot("uw-migrate-global-");
    const outside = tempRoot("uw-migrate-outside-");
    writeJson(projectRoot, ".opencode/memory/tasks.json", { version: "1" });
    symlinkSync(outside, join(projectRoot, ".ultrawork"), "dir");
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      const { ctx } = createFakeV2Context({ directory: projectRoot });
      const cleanup = await setupUltrawork(ctx, { modules: [], globalDir: globalRoot });
      await cleanup();
    } finally {
      console.warn = originalWarn;
    }

    const gitignoreLines = warnings.filter((line) => line.includes(".gitignore"));
    expect(gitignoreLines.length).toBeGreaterThan(0);
    expect(gitignoreLines.some((line) => line.startsWith("[ultrawork] ") && line.includes("symlink"))).toBe(true);
    expect(entriesOf(outside)).toEqual([]);
  });

  test("外掛照常載入，只是專案層與全域層都沒搬完", async () => {
    const external = tempRoot("uw-migrate-shared-");
    const projectRoot = tempRoot("uw-migrate-project-");
    const globalRoot = tempRoot("uw-migrate-global-");
    const outside = tempRoot("uw-migrate-outside-");
    seedSharedOpencode(external);
    linkOpencodeTo(projectRoot, external);
    writeJson(globalRoot, "skills-policy.json", { version: "1.0.0" });
    symlinkSync(outside, join(globalRoot, ".ultrawork"), "dir");
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      const { ctx } = createFakeV2Context({ directory: projectRoot });
      const cleanup = await setupUltrawork(ctx, { modules: [], globalDir: globalRoot });
      await cleanup();
    } finally {
      console.warn = originalWarn;
    }

    expect(existsSync(marker(projectRoot))).toBe(false);
    expect(existsSync(marker(globalRoot))).toBe(false);
    expect(entriesOf(outside)).toEqual([]);
    expect(warnings.some((line) => line.includes("失敗"))).toBe(true);
  });
});

/**
 * 連「標記已經在了」這條路徑也要過封頂。
 *
 * `migrateLayer` 讀到既存標記就直接回 `alreadyMigrated`，那時還沒做過任何
 * containment 檢查 —— 於是 `.ultrawork` 是指向外部的 symlink、而外部目標裡
 * 剛好有別人的標記檔時（例如手動複製過去，或該目錄曾是別專案真正的
 * `.ultrawork/`），搬移端回 `ok=true`／`alreadyMigrated=true`／`migrated=0`，
 * 專案自己的 `tasks.json` 還留在 `.opencode/memory/` 沒被搬，診斷端也因為
 * 「標記存在」而回 `passed`。封頂的主張在這條路徑上是假的。
 *
 * 正常路徑（`.ultrawork` 是普通目錄、標記已存在）必須逐字不變：那是最常見的
 * 「已經搬過」狀態，仍然要回 `alreadyMigrated`／`passed`。
 */
/**
 * 診斷端要能講出**任何一項**的封頂原因，不是只有第一項。
 *
 * `firstUnsafeItemDetail()` 逐項重演搬移端的順序、在第一個不通過的項目就停。
 * 這個案例的關鍵父層（`.opencode`）只出現在清單**最後一項**（`.opencode/plans`）
 * 的來源父層，而且該專案沒有 `.opencode/memory` —— 也就是說第一項的來源父層
 * `<專案>/.opencode/memory` 這個錨點根本不存在，只靠第一項是講不出原因的。
 *
 * 兩端都必須報 `unsafe-path`：搬移端真的會在那一項停下來，診斷端不能因為
 * 「第一項看起來沒問題」就退回泛用提示。
 */
describe("不只第一項的父層，診斷端都講得出原因", () => {
  test(".opencode 是 symlink、專案只有 .opencode/plans → 搬移端與診斷端都記 unsafe-path", () => {
    const external = tempRoot("uw-migrate-shared-");
    const projectRoot = tempRoot("uw-migrate-project-");
    // 故意不放 `.opencode/memory`：讓第一項的來源父層這個錨點不存在。
    writeFile(external, "plans/plan-1.md", "# 計畫長文\n");
    linkOpencodeTo(projectRoot, external);

    const result = migrateProjectData({ root: projectRoot, now });
    const report = inspectProjectMigration(projectRoot);

    expect(result.ok).toBe(false);
    expect(result.errors.map((item) => item.reason)).toEqual(["unsafe-path"]);
    expect(report.pending).toBe(true);
    expect(report.legacySources).toEqual([".opencode/plans"]);
    expect(report.reason).toBe("unsafe-path");
    expect(report.detail).toContain("symlink");
  });
});

describe("既存標記路徑也要通過封頂", () => {
  /** `.ultrawork` 指向的外部目錄裡預先放一份別人搬完的標記。 */
  function seedOutsideWithMarker(outside: string): void {
    writeJson(outside, MIGRATION_MARKER_FILE, {
      version: 1,
      migratedAt: "2025-12-01T00:00:00.000Z",
      items: [],
      skipped: [],
    });
  }

  test(".ultrawork 是 symlink 且外部目標預先有標記 → 不得回報 alreadyMigrated，記 unsafe-path", () => {
    const projectRoot = tempRoot("uw-migrate-project-");
    const outside = tempRoot("uw-migrate-outside-");
    // 專案自己還有沒搬的舊資料。
    writeJson(projectRoot, ".opencode/memory/tasks.json", { version: "1", tasks: { "t-1": {} } });
    writeFile(projectRoot, ".opencode/memory/state.md", "state: IN_PROGRESS\n");
    seedOutsideWithMarker(outside);
    symlinkSync(outside, join(projectRoot, ".ultrawork"), "dir");
    const before = entriesOf(outside);

    const result = migrateProjectData({ root: projectRoot, now });

    expect(result.alreadyMigrated).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("unsafe-path");
    expect(result.errors[0].detail).toContain("symlink");
    expect(result.migrated).toEqual([]);
    // 外部目錄一個新檔案都沒有：預先存在的標記也沒被改寫。
    expect(entriesOf(outside)).toEqual(before);
    // 舊資料原地保留、沒有改名。
    expect(existsSync(join(projectRoot, ".opencode/memory/tasks.json"))).toBe(true);
    expect(existsSync(join(projectRoot, ".opencode/memory", archived("tasks.json")))).toBe(false);
  });

  test("同一情境下診斷端也不得回「已完成」", () => {
    const projectRoot = tempRoot("uw-migrate-project-");
    const outside = tempRoot("uw-migrate-outside-");
    writeJson(projectRoot, ".opencode/memory/tasks.json", { version: "1" });
    seedOutsideWithMarker(outside);
    symlinkSync(outside, join(projectRoot, ".ultrawork"), "dir");

    const report = inspectProjectMigration(projectRoot);

    // 外部那份是別專案的空標記：沒有本層的完成記錄，所以 markerExists 為 false；
    // 但檔案確實在磁碟上（markerFilePresent），pending 照樣為 true，訊號不斷。
    expect(report.markerExists).toBe(false);
    expect(report.markerFilePresent).toBe(true);
    expect(report.pending).toBe(true);
    expect(report.reason).toBe("unsafe-path");
    expect(report.detail).toContain("symlink");
  });

  test("重跑仍然會再試一次並持續回報，不會靜默當成已完成", () => {
    const projectRoot = tempRoot("uw-migrate-project-");
    const outside = tempRoot("uw-migrate-outside-");
    writeJson(projectRoot, ".opencode/memory/tasks.json", { version: "1" });
    seedOutsideWithMarker(outside);
    symlinkSync(outside, join(projectRoot, ".ultrawork"), "dir");
    migrateProjectData({ root: projectRoot, now });

    const retry = migrateProjectData({ root: projectRoot, now });

    expect(retry.alreadyMigrated).toBe(false);
    expect(retry.ok).toBe(false);
    expect(retry.errors.map((item) => item.reason)).toEqual(["unsafe-path"]);
    expect(inspectProjectMigration(projectRoot).pending).toBe(true);
  });

  test(".ultrawork 換回真目錄後重跑會補完並寫上自己的標記", () => {
    const projectRoot = tempRoot("uw-migrate-project-");
    const outside = tempRoot("uw-migrate-outside-");
    writeJson(projectRoot, ".opencode/memory/tasks.json", { version: "1", tasks: { "t-1": {} } });
    seedOutsideWithMarker(outside);
    const link = join(projectRoot, ".ultrawork");
    symlinkSync(outside, link, "dir");
    migrateProjectData({ root: projectRoot, now });

    rmSync(link);
    const retry = migrateProjectData({ root: projectRoot, now });

    expect(retry.ok).toBe(true);
    expect(retry.alreadyMigrated).toBe(false);
    expect(existsSync(join(projectRoot, ".ultrawork/tasks.json"))).toBe(true);
    expect(existsSync(join(projectRoot, archived("tasks.json")))).toBe(false);
    expect(inspectProjectMigration(projectRoot).pending).toBe(false);
  });

  test("反向：.ultrawork 是普通目錄且標記已存在 → 維持 alreadyMigrated／passed", () => {
    const projectRoot = tempRoot("uw-migrate-project-");
    writeJson(projectRoot, ".opencode/memory/tasks.json", { version: "1", tasks: { "t-1": {} } });
    writeFile(projectRoot, ".opencode/memory/tasks.json.migrated-20251201T000000Z", '{"version":"1"}\n');

    const first = migrateProjectData({ root: projectRoot, now });
    expect(first.ok).toBe(true);
    expect(first.alreadyMigrated).toBe(false);
    expect(first.migrated).toHaveLength(1);

    const second = migrateProjectData({ root: projectRoot, now });
    expect(second.ok).toBe(true);
    expect(second.alreadyMigrated).toBe(true);
    expect(second.items).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(second.migrated).toEqual([]);
    expect(inspectProjectMigration(projectRoot).pending).toBe(false);
    expect(inspectProjectMigration(projectRoot).markerExists).toBe(true);
  });
});

/** 封頂管「父層」；項目本身是 symlink 時由 `copyTree` 一律拒絕（不跟隨）。 */
describe("封頂不改變項目本身的語意", () => {
  test("頂層項目自己是有效 symlink（父層是普通目錄）→ 拒絕、不複製、不寫標記", () => {
    const root = tempRoot("uw-migrate-global-");
    writeFile(root, "external-storage/skills-policy.json", '{"version":"1.0.0"}\n');
    const link = join(root, "skills-policy.json");
    symlinkSync(join(root, "external-storage/skills-policy.json"), link);

    const result = migrateGlobalData({ root, now });

    // 即使目標存在也不跟隨：外部檔案的內容不得被讀進 .ultrawork。
    expect(result.ok).toBe(false);
    expect(result.errors.map((item) => item.reason)).toContain("copy-failed");
    expect(existsSync(join(root, ".ultrawork/skills-policy.json"))).toBe(false);
    expect(existsSync(marker(root))).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
