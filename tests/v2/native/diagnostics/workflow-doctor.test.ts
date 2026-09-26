import { afterEach, describe, expect, test } from "bun:test";
import { statSync, symlinkSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
import { MIGRATION_MARKER_FILE } from "../../../../src/migrate/index.ts";
import { writeInconsistentMarker } from "../../../../src/modules/workflow/content/content-store.ts";
import {
  callTool,
  fileSnapshot,
  makePlansDir,
  setupDiagnostics,
  writeMemoryFile,
  writeMinimalWorkspace,
  writePlansRegistry,
  writeStateMd,
  writeTasksRegistry,
} from "./_helpers.ts";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-diag-doctor-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function checkByName(r: any, name: string) {
  return r.checks.find((c: any) => c.name === name);
}

/** 舊版 `14-doctor-memory-budget.test.ts` 的 doctor 區塊。 */
describe("workflow_doctor 記憶體預算", () => {
  test("健康 workspace 仍回完整 memory_budget 區塊", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(r.memory_budget.project_md_status).toBe("ok");
    expect(r.memory_budget.state_md_status).toBe("ok");
    expect(r.memory_budget.bootstrap_full_status).toBe("ok");
    expect(r.memory_budget.registry_projection_divergence).toBe(false);
    expect(r.memory_budget.project_md_hard_limit).toBe(7000);
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("project.md 超過有效上限 → warn 且 ok=false", async () => {
    const root = await tempRoot();
    writeMemoryFile(root, "project.md", "---\nlimit: 1000\n---\n# P\n\n" + "a".repeat(1_500) + "\n");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(r.ok).toBe(false);
    expect(r.memory_budget.project_md_status).toBe("warn");
    expect(r.memory_budget.project_md_over_by).toBeGreaterThan(0);
    expect(r.warnings.some((w: string) => w.includes("project.md 超過大小上限"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("state.md 超過 3000 → warn 提示", async () => {
    const root = await tempRoot();
    writeMemoryFile(root, "state.md", "---\nlimit: 3000\n---\n# S\n\n" + "b".repeat(3_200) + "\n");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(r.memory_budget.state_md_status).toBe("warn");
    expect(r.warnings.some((w: string) => w.includes("state.md 超過大小上限"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("bootstrap full 預估超過 soft budget → warn", async () => {
    const root = await tempRoot();
    writeMemoryFile(root, "project.md", "---\nlimit: 7000\n---\n# P\n\n" + "a".repeat(6_000) + "\n");
    writeMemoryFile(root, "state.md", "---\nlimit: 3000\n---\n# S\n\n" + "b".repeat(2_900) + "\n");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(r.memory_budget.bootstrap_full_status).toBe("warn");
    expect(r.memory_budget.bootstrap_full_estimated_chars).toBeGreaterThan(10_000);
    await fake.registration?.dispose();
  });

  test("project.md frontmatter limit 無效 → CONFIGURATION_ERROR", async () => {
    const root = await tempRoot();
    writeMemoryFile(root, "project.md", "---\nlimit: abc\n---\n# P\n");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIGURATION_ERROR");
    expect(r.memory_budget.project_md_status).toBe("warn");
    await fake.registration?.dispose();
  });

  test("進行中計畫缺 contentRef → warn；已完成的計畫不報", async () => {
    const root = await tempRoot();
    makePlansDir(root);
    writePlansRegistry(root, { planId: "p-active", state: "IN_PROGRESS" });
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(r.memory_budget.missing_content_ref_plan_count).toBe(1);
    expect(r.memory_budget.missing_content_ref_status).toBe("warn");
    expect(r.warnings.some((w: string) => w.includes("沒有 contentRef"))).toBe(true);
    await fake.registration?.dispose();

    const doneRoot = await tempRoot();
    makePlansDir(doneRoot);
    writePlansRegistry(doneRoot, { planId: "p-done", state: "COMPLETED", active: false });
    const fake2 = await setupDiagnostics(doneRoot);
    const r2 = await callTool(fake2, "workflow_doctor");
    expect(r2.memory_budget.missing_content_ref_plan_count).toBe(0);
    expect(r2.memory_budget.missing_content_ref_status).toBe("ok");
    await fake2.registration?.dispose();
  });
});

/** 舊版 doctor 的一致性檢查：state.md ↔ tasks.json 對不上。 */
describe("workflow_doctor 一致性檢查", () => {
  test("state.md 的 task_id 與 tasks.json 游標不一致 → 標記 divergence", async () => {
    const root = await tempRoot();
    writeTasksRegistry(root, { taskId: "t-1", state: "IN_PROGRESS" });
    writeStateMd(root, "IN_PROGRESS", "t-other");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(r.memory_budget.registry_projection_divergence).toBe(true);
    expect(r.memory_budget.registry_projection_status).toBe("warn");
    expect(r.warnings.some((w: string) => w.includes("state.md 的 task_id"))).toBe(true);
    expect(r.warnings.some((w: string) => w.includes("task-state-sync"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("state.md 的 state 與 tasks.json 不一致 → 標記 divergence", async () => {
    const root = await tempRoot();
    writeTasksRegistry(root, { taskId: "t-1", state: "IN_PROGRESS" });
    writeStateMd(root, "READY", "t-1");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(r.memory_budget.registry_projection_divergence).toBe(true);
    expect(r.warnings.some((w: string) => w.includes("state.md 的 state"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("state.md 與 tasks.json 一致 → 不標 divergence", async () => {
    const root = await tempRoot();
    writeTasksRegistry(root, { taskId: "t-1", state: "IN_PROGRESS" });
    writeStateMd(root, "IN_PROGRESS", "t-1");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(r.memory_budget.registry_projection_divergence).toBe(false);
    await fake.registration?.dispose();
  });

  test("state.md 不存在 → 該項標 skipped 並附原因，不判失敗", async () => {
    const root = await tempRoot();
    writeTasksRegistry(root, { taskId: "t-1", state: "IN_PROGRESS" });
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const skipped = checkByName(r, "State Projection Consistency");
    expect(skipped.status).toBe("skipped");
    expect(skipped.details).toContain("state.md 不存在");
    expect(r.memory_budget.registry_projection_divergence).toBe(false);
    await fake.registration?.dispose();
  });

  test("游標指向不存在的任務：讀取層已正規化掉，doctor 如實回報閒置", async () => {
    const root = await tempRoot();
    writeTasksRegistry(root, { taskId: "t-1", cursor: "t-ghost" });
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    // t-1 仍是進行中任務，游標 t-ghost 不在 activeTaskIds → 退回第一個進行中任務。
    expect(checkByName(r, "Active Task Validity").status).toBe("passed");
    expect(checkByName(r, "Active Task Existence")).toBeUndefined();
    await fake.registration?.dispose();
  });

  // 讀取層的正規化讓「Active Task Validity 失敗」這條分支不可達：
  // `normalizeTaskLeaf` 只讓 taskId／projectId／projectPath 三者都非空的 task
  // 進 registry，owner／priority 缺漏時一律補成 "—"。所以 doctor 拿到的 task
  // 這五個欄位必然都truthy。這裡釘住實際行為，而不是硬造一個到不了的分支。
  test("owner／priority 缺漏 → 讀取層補成「—」，Active Task Validity 仍通過", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const { readFileSync, writeFileSync } = await import("node:fs");
    writeTasksRegistry(root, { taskId: "t-1", state: "IN_PROGRESS" });
    const path = join(root, ".ultrawork", "tasks.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.tasks["t-1"].owner = "";
    raw.tasks["t-1"].priority = "";
    writeFileSync(path, JSON.stringify(raw, null, 2), "utf-8");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const validity = checkByName(r, "Active Task Validity");
    expect(validity.status).toBe("passed");
    // 五個欄位都被視為齊全，doctor 如實回報 5/5
    expect(validity.details).toContain("true/true/true/true/true");
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("taskId 缺漏的任務 → 讀取層直接丟棄，doctor 如實回報閒置", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const { readFileSync, writeFileSync } = await import("node:fs");
    writeTasksRegistry(root, { taskId: "t-1", state: "IN_PROGRESS" });
    const path = join(root, ".ultrawork", "tasks.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.tasks["t-1"].taskId = "";
    writeFileSync(path, JSON.stringify(raw, null, 2), "utf-8");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    // 連 taskId 都沒有 → 該筆被正規化階段丟掉，剩下游標指向空清單
    expect(checkByName(r, "Active Task").status).toBe("passed");
    expect(checkByName(r, "Active Task").details).toContain("沒有進行中的任務");
    expect(checkByName(r, "Active Task Validity")).toBeUndefined();
    await fake.registration?.dispose();
  });

  test("沒有進行中任務 → Active Task 通過（閒置）", async () => {
    const root = await tempRoot();
    writeMemoryFile(root, "tasks.json", JSON.stringify({
      version: "1",
      projectId: root.split("/").pop()!.toLowerCase(),
      projectPath: root,
      activeTaskIds: [],
      taskCursor: null,
      tasks: {},
    }));
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(checkByName(r, "Active Task").status).toBe("passed");
    await fake.registration?.dispose();
  });
});

/** 舊版 `23-plan-completion-tombstones.test.ts` 的 doctor 區塊。 */
describe("workflow_doctor 計畫註冊檔健康", () => {
  test("計畫註冊檔有 error → ok=false 並帶 [plan-registry] 警告", async () => {
    const root = await tempRoot();
    makePlansDir(root);
    // tombstone 有、finishedTaskIds 沒有 → tombstone-missing-from-finishedTaskIds error
    writePlansRegistry(root, {
      planId: "p-err",
      state: "IN_PROGRESS",
      taskIds: ["t-1"],
      finishedTaskIds: [],
      completionTombstones: { "t-1": { state: "COMPLETED", finishedAt: new Date().toISOString() } },
    });
    writeTasksRegistry(root, { taskId: "t-1", state: "IN_PROGRESS", planId: "p-err" });
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(r.plan_registry_health.error_count).toBeGreaterThanOrEqual(1);
    expect(checkByName(r, "Plan Registry Health").status).toBe("failed");
    expect(r.ok).toBe(false);
    expect(r.warnings.some((w: string) => w.startsWith("[plan-registry]"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("計畫註冊檔乾淨 → passed", async () => {
    const root = await tempRoot();
    makePlansDir(root);
    writePlansRegistry(root, { planId: "p-ok", state: "IN_PROGRESS", contentRef: ".ultrawork/plans/p-ok.md" });
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(r.plan_registry_health.error_count).toBe(0);
    expect(checkByName(r, "Plan Registry Health").status).toBe("passed");
    await fake.registration?.dispose();
  });
});

/** 舊版 `38-content-grep-and-recovery.test.ts` 的 doctor marker 診斷。 */
describe("workflow_doctor 內容庫不一致標記", () => {
  test("存在 marker → 診斷失敗並附 op/at，且不清除 marker", async () => {
    const root = await tempRoot();
    const plansDir = makePlansDir(root);
    writeInconsistentMarker(root, plansDir, {
      at: "2026-01-01T00:00:00.000Z",
      op: "writePlanContent",
      filesWritten: [".ultrawork/plans/p-1.md"],
      filesPending: [".ultrawork/plans/p-2.md"],
      detail: { reason: "disk full" },
    });
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(r.content_store_inconsistent.op).toBe("writePlanContent");
    expect(checkByName(r, "Content Store Consistency").status).toBe("failed");
    expect(r.ok).toBe(false);
    expect(r.warnings.some((w: string) => w.startsWith("[content-store]"))).toBe(true);
    // doctor 只診斷：marker 必須還在
    const after = await callTool(fake, "workflow_doctor");
    expect(after.content_store_inconsistent).toBeDefined();
    await fake.registration?.dispose();
  });

  test("沒有 marker → passed", async () => {
    const root = await tempRoot();
    makePlansDir(root);
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(checkByName(r, "Content Store Consistency").status).toBe("passed");
    expect(r.content_store_inconsistent).toBeUndefined();
    await fake.registration?.dispose();
  });

  test("plans 目錄不存在 → skipped 並附原因", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "workflow_doctor");
    const skipped = checkByName(r, "Content Store Consistency");
    expect(skipped.status).toBe("skipped");
    expect(skipped.details).toContain("內容庫目錄不存在");
    await fake.registration?.dispose();
  });
});

/** 模組關閉與資料損壞時的 skipped 行為。 */
describe("workflow_doctor 依賴不可得時的 skipped 行為", () => {
  test("workflow 模組關閉 → 仍產出診斷並附說明，不丟例外", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeTasksRegistry(root, { taskId: "t-1", state: "IN_PROGRESS" });
    writeStateMd(root, "IN_PROGRESS", "t-1");
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.modules.workflow = false;
    const fake = await setupDiagnostics(root, settings);
    const r = await callTool(fake, "workflow_doctor");
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w: string) => w.includes("workflow 模組已關閉"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("memory 模組關閉 → Memory Module Switch 反映關閉狀態", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.modules.memory = false;
    const fake = await setupDiagnostics(await tempRoot(), settings);
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Memory Module Switch");
    expect(item.status).toBe("passed");
    expect(item.details).toContain("memory 模組已關閉");
    expect(r.warnings.some((w: string) => w.includes("memory 模組已關閉"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("tasks.json 損壞 → 註冊檔相關檢查標 skipped，不假裝健康", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeMemoryFile(root, "tasks.json", "{ not json");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const binding = checkByName(r, "Tasks Registry Project Binding");
    expect(binding.status).toBe("skipped");
    expect(binding.details).toContain("tasks.json 讀取失敗");
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("plans.json 損壞 → 計畫註冊檔與 contentRef 檢查標 skipped", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeMemoryFile(root, "plans.json", "[[[ broken");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(checkByName(r, "Plan Registry Health").status).toBe("skipped");
    expect(checkByName(r, "Plan Content Ref Coverage").status).toBe("skipped");
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("六個診斷工具都不寫入任何檔案", async () => {
    const root = await tempRoot();
    makePlansDir(root);
    writeMemoryFile(root, "project.md", "---\nlimit: 7000\n---\n# P\n");
    writeMemoryFile(root, "state.md", "---\nlimit: 3000\n---\n# S\n");
    writeTasksRegistry(root, { taskId: "t-1", state: "IN_PROGRESS" });
    writeStateMd(root, "IN_PROGRESS", "t-1");
    const before = fileSnapshot(root);
    const fake = await setupDiagnostics(root);
    for (const name of [
      "workflow_bootstrap",
      "workflow_l1_check",
      "workflow_doctor",
      "workflow_health_check",
      "tool_hook_manifest",
      "ultrawork_selftest",
    ]) {
      await callTool(fake, name, name === "workflow_health_check" ? { includeBaselineCheck: false } : {});
    }
    expect(fileSnapshot(root)).toEqual(before);
    expect(statSync(join(root, ".ultrawork")).isDirectory()).toBe(true);
    await fake.registration?.dispose();
  });
});

/** 舊資料搬遷狀態：搬移未完成要講清楚，但不改變 ok。 */
describe("workflow_doctor 舊資料搬遷狀態", () => {
  test(".opencode/memory 還在且沒有標記檔 → warn 並附下一步，ok 不變", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeMemoryFile(root, "state.md", "---\nlimit: 3000\n---\n# S\n");
    await mkdir(join(root, ".opencode", "memory"), { recursive: true });
    await writeFile(join(root, ".opencode", "memory", "tasks.json"), '{"version":"1"}', "utf-8");

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Legacy .opencode Data Migration");
    expect(item.status).toBe("warn");
    expect(item.details).toContain(".opencode/memory");
    // 沒有標記檔時維持原本的措辭（這是搬移端最常見的未完成）。
    expect(item.details).toContain(`${MIGRATION_MARKER_FILE} 不存在`);
    expect(item.details).toContain("搬遷未完成或失敗");
    expect(r.warnings.some((w: string) => w.startsWith("[migrate]"))).toBe(true);
    // 搬移沒完成不是診斷失敗：外掛照新位置運作。
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("有標記檔 → passed，說明舊資料以改名形式保留", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeMemoryFile(root, MIGRATION_MARKER_FILE, '{"version":1,"migratedAt":"2026-01-01T00:00:00.000Z","items":[],"skipped":[]}\n');

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Legacy .opencode Data Migration");
    expect(item.status).toBe("passed");
    expect(item.details).toContain(".migrated-");
    expect(r.warnings.some((w: string) => w.startsWith("[migrate]"))).toBe(false);
    await fake.registration?.dispose();
  });

  test("沒有舊資料也沒有標記 → passed（不擾動乾淨的新專案）", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(checkByName(r, "Legacy .opencode Data Migration").status).toBe("passed");
    expect(checkByName(r, "Legacy .opencode Data Migration").details).toContain("沒有待搬遷");
    await fake.registration?.dispose();
  });
});

/**
 * 舊資料位置本身是 symlink 時，doctor 要跟搬移端講同一件事。
 *
 * 搬移端判斷「舊位置是否存在」用不跟隨 symlink 的 `lstatSync()`：頂層項目是
 * 斷鏈 symlink 就記 `copy-failed`、該層不寫標記、每次啟動重試。診斷端如果改用
 * 會跟隨 symlink 的 `existsSync()`，斷鏈 symlink 會被回成「不存在」而報成
 * 「沒有待搬遷」—— 搬移端明明每次都在重試，使用者卻拿不到任何訊號。
 */
describe("workflow_doctor 舊資料位置是 symlink", () => {
  test(".opencode/memory 是斷鏈 symlink → warn「搬遷未完成」並附下一步", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    await mkdir(join(root, ".opencode"), { recursive: true });
    symlinkSync(join(root, "external-storage", "memory"), join(root, ".opencode", "memory"));

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Legacy .opencode Data Migration");
    expect(item.status).toBe("warn");
    expect(item.details).toContain(".opencode/memory");
    expect(item.details).toContain("搬遷未完成或失敗");
    expect(r.warnings.some((w: string) => w.startsWith("[migrate]"))).toBe(true);
    // 搬移沒完成不是診斷失敗：外掛照新位置運作。
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test(".opencode/plans 是斷鏈 symlink → 與搬移端一致地報「有待搬遷」", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    await mkdir(join(root, ".opencode"), { recursive: true });
    symlinkSync(join(root, "external-storage", "plans"), join(root, ".opencode", "plans"));

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Legacy .opencode Data Migration");
    expect(item.status).toBe("warn");
    expect(item.details).toContain(".opencode/plans");
    await fake.registration?.dispose();
  });

  test("有效 symlink 指向存在的目錄 → warn「有待搬遷」（與搬移端一致）", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const external = await tempRoot();
    await writeFile(join(external, "state.md"), "---\nlimit: 3000\n---\n# S\n", "utf-8");
    await mkdir(join(root, ".opencode"), { recursive: true });
    symlinkSync(external, join(root, ".opencode", "memory"));

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Legacy .opencode Data Migration");
    expect(item.status).toBe("warn");
    expect(item.details).toContain(".opencode/memory");
    await fake.registration?.dispose();
  });

  test("有效 symlink 但已有標記檔 → passed（舊資料已改名保留）", async () => {
    const root = await tempRoot();
    const external = await tempRoot();
    await writeFile(join(external, "state.md"), "---\nlimit: 3000\n---\n# S\n", "utf-8");
    writeMinimalWorkspace(root);
    writeMemoryFile(root, MIGRATION_MARKER_FILE, '{"version":1,"migratedAt":"2026-01-01T00:00:00.000Z","items":[],"skipped":[]}\n');
    await mkdir(join(root, ".opencode"), { recursive: true });
    symlinkSync(external, join(root, ".opencode", "memory"));

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(checkByName(r, "Legacy .opencode Data Migration").status).toBe("passed");
    expect(checkByName(r, "Legacy .opencode Data Migration").details).toContain(".migrated-");
    await fake.registration?.dispose();
  });
});

/**
 * 搬遷卡住時要講得出「為什麼」，使用者才知道怎麼自行排除。
 *
 * 搬移端遇到 symlink 逃逸會記 `unsafe-path`、該層不寫標記、每次啟動重試，
 * 而且永遠不會自己好。doctor 若只說「搬遷未完成或失敗、確認檔案權限」，
 * 使用者會被指向錯誤方向 —— 權限沒問題，問題是路徑本身。
 */
describe("workflow_doctor 搬遷未完成要說出原因", () => {
  test(".opencode 是 symlink → details 點名安全檢查與 symlink，並給可執行下一步", async () => {
    const root = await tempRoot();
    const external = await tempRoot();
    writeMinimalWorkspace(root);
    await writeFile(join(external, "tasks.json"), '{"version":"1"}', "utf-8");
    await mkdir(join(external, "memory"), { recursive: true });
    symlinkSync(external, join(root, ".opencode"), "dir");

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Legacy .opencode Data Migration");
    expect(item.status).toBe("warn");
    expect(item.details).toContain("安全檢查");
    expect(item.details).toContain("symlink");
    // 可自行排除的下一步：確認不是 symlink，或手動把舊資料複製過去。
    expect(item.details).toContain(".ultrawork/");
    // 仍然只是 warn，不影響診斷結果。
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("普通目錄的正常未完成 → 維持原本語意，不提 symlink 也不提安全檢查", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    await mkdir(join(root, ".opencode", "memory"), { recursive: true });
    await writeFile(join(root, ".opencode", "memory", "tasks.json"), '{"version":"1"}', "utf-8");

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Legacy .opencode Data Migration");
    expect(item.status).toBe("warn");
    expect(item.details).toContain("搬遷未完成或失敗");
    expect(item.details).toContain("檔案權限");
    expect(item.details).not.toContain("symlink");
    expect(item.details).not.toContain("安全檢查");
    await fake.registration?.dispose();
  });
});

/**
 * 標記已經在了，但 `.ultrawork` 指向專案外 —— 不得回 `passed`。
 *
 * 搬移端讀到既存標記就結束，沒有對 `.ultrawork` 的父層做過 containment；於是
 * `.ultrawork` 是 symlink、外部目標裡有別人搬完的標記時，搬移端回 `ok=true`／
 * `alreadyMigrated=true`，本專案自己的 `.opencode/memory/` 卻還沒搬。doctor 若
 * 只看「標記存在」就回 `passed`，使用者完全拿不到訊號。
 */
describe("workflow_doctor 標記存在但 .ultrawork 不安全", () => {
  /**
   * 外部目錄假裝是**別專案**留下的完整 `.ultrawork/`（骨架 + 搬遷標記）。
   *
   * 回傳那個 `.ultrawork/` 的絕對路徑：專案層的 `.ultrawork` symlink 要指向它，
   * 這正是審查者重現的情境（該目標曾是別專案真正的 `.ultrawork/`）。
   */
  async function seedOutsideAsMigratedUltrawork(): Promise<string> {
    const outside = await tempRoot();
    writeMinimalWorkspace(outside);
    await writeFile(
      join(outside, ".ultrawork", MIGRATION_MARKER_FILE),
      '{"version":1,"migratedAt":"2025-12-01T00:00:00.000Z","items":[],"skipped":[]}\n',
      "utf-8",
    );
    return join(outside, ".ultrawork");
  }

  test(".ultrawork 是 symlink → warn「搬遷未完成」並點名安全檢查，外部目錄沒被寫", async () => {
    const root = await tempRoot();
    const outside = await seedOutsideAsMigratedUltrawork();
    // 舊資料還在（照審查者的重現情境），內容與 `.ultrawork/` 那份一致，
    // 這樣 doctor 除了搬遷這一項以外都維持健康，`r.ok` 才量得到「搬遷問題不影響診斷」。
    await mkdir(join(root, ".opencode", "memory"), { recursive: true });
    await cp(join(outside, "tasks.json"), join(root, ".opencode", "memory", "tasks.json"));
    symlinkSync(outside, join(root, ".ultrawork"), "dir");
    const before = fileSnapshot(outside);

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Legacy .opencode Data Migration");
    expect(item.status).toBe("warn");
    // 標記檔其實就在磁碟上，所以這半句不能說「不存在」——否則 details 會自相矛盾。
    expect(item.details).not.toContain("不存在");
    expect(item.details).toContain("安全檢查");
    expect(item.details).toContain("symlink");
    // 可自行排除的下一步要留著。
    expect(item.details).toContain(".ultrawork/");
    // 只是 warn，不影響診斷結果：外掛照新位置運作。
    expect(r.ok).toBe(true);
    expect(fileSnapshot(outside)).toEqual(before);
    await fake.registration?.dispose();
  });

  /**
   * 沒有舊資料時，訊息不得還在主張「舊資料仍存在」。
   *
   * 這個專案連 `.opencode/memory`／`.opencode/plans` 都沒有，所以
   * `legacySources` 是空的。此時若沿用「`.opencode 舊資料仍存在（…）」的句型，
   * 使用者會看到一個**空括號**加一句自己站不住的敘述，warning 也會變成沒有主詞的
   * 「[migrate]  尚未搬遷到 …」（雙空白）。狀態是對的（warn、沒有誤報成功），
   * 但講的是不存在的東西 —— 跟上一輪修掉的自相矛盾是同一個目標。
   */
  test("專案沒有舊資料 → 訊息不主張有舊資料，仍講得出原因與下一步", async () => {
    const root = await tempRoot();
    const outside = await seedOutsideAsMigratedUltrawork();
    symlinkSync(outside, join(root, ".ultrawork"), "dir");

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Legacy .opencode Data Migration");
    expect(item.status).toBe("warn");
    expect(item.details).not.toContain("舊資料仍存在");
    // 空括號（無論全形或半形）與「沒有東西」的主詞都不該出現。
    expect(item.details).not.toMatch(/[（(]\s*[）)]/);
    expect(item.details).not.toContain("，但 ");
    // 原因與可執行下一步仍在。
    expect(item.details).toContain("安全檢查");
    expect(item.details).toContain("symlink");
    expect(item.details).toContain(".ultrawork/");
    // `[migrate]` 那筆也要有主詞、不得出現雙空白。
    const migrateWarning = r.warnings.find((w: string) => w.startsWith("[migrate]"));
    expect(migrateWarning).toBeDefined();
    expect(migrateWarning).not.toMatch(/\[migrate\]\s{2,}/);
    expect(migrateWarning).not.toMatch(/[（(]\s*[）)]/);
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("反向：.ultrawork 是普通目錄且標記已存在 → passed（最常見的已搬過狀態）", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    await writeFile(
      join(root, ".ultrawork", MIGRATION_MARKER_FILE),
      '{"version":1,"migratedAt":"2025-12-01T00:00:00.000Z","items":[],"skipped":[]}\n',
      "utf-8",
    );
    await mkdir(join(root, ".opencode", "memory"), { recursive: true });
    await writeFile(join(root, ".opencode", "memory", "tasks.json"), '{"version":"1"}', "utf-8");

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Legacy .opencode Data Migration");
    expect(item.status).toBe("passed");
    expect(item.details).toContain(".migrated-");
    expect(r.warnings.some((w: string) => w.startsWith("[migrate]"))).toBe(false);
    await fake.registration?.dispose();
  });
});
