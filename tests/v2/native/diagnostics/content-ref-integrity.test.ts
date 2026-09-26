/**
 * `workflow_doctor` 逐項驗證註冊檔裡的參照（`contentRef` / `taskContentPath`）。
 *
 * 背景：doctor 原本只數「進行中計畫**缺** `contentRef`」，看不到「參照在但指不到
 * 內容庫」。於是註冊檔指著已搬走的 `.opencode/` 路徑時，doctor 全部回通過，
 * 直到有人建立新計畫時才被路徑守衛擋下（見 legacy-ref-resilience.test.ts）。
 *
 * 這裡的判定必須與讀寫工具同一套：doctor 呼叫的就是 `resolvePlansContentRef`
 * （`tryResolvePlansContentRef` 是它的 try/catch 外殼），不另寫一份前綴規則。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATION_MARKER_FILE } from "../../../../src/migrate/index.ts";
import { inspectContentRef } from "../../../../src/modules/workflow/content/content-ref.ts";
import {
  callTool,
  fileSnapshot,
  setupDiagnostics,
  writeMemoryFile,
  writeMinimalWorkspace,
  writePlansRegistry,
  writeTasksRegistry,
} from "./_helpers.ts";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-diag-ref-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function checkByName(r: any, name: string) {
  return r.checks.find((c: any) => c.name === name);
}

/** 搬遷已完成（新版分層標記）——這是實地回報的情境：舊檔已改名保留，參照卻沒被改寫。 */
function markMigrationComplete(root: string): void {
  writeMemoryFile(
    root,
    MIGRATION_MARKER_FILE,
    JSON.stringify(
      {
        version: 2,
        migratedAt: "2026-01-01T00:00:00.000Z",
        items: [],
        skipped: [],
        layers: {
          project: { migratedAt: "2026-01-01T00:00:00.000Z", items: [], skipped: [] },
        },
      },
      null,
      2,
    ),
  );
}

/** 搬遷後改名保留的舊內容檔：檔案真的還在 `.opencode/plans/`。 */
function writeLegacyContent(root: string, name: string): void {
  mkdirSync(join(root, ".opencode", "plans"), { recursive: true });
  writeFileSync(join(root, ".opencode", "plans", name), `# ${name}\n`, "utf-8");
}

/** 現在位置上的內容檔（參照有效、檔案存在）。 */
function writeCurrentContent(root: string, name: string): void {
  mkdirSync(join(root, ".ultrawork", "plans"), { recursive: true });
  writeFileSync(join(root, ".ultrawork", "plans", name), `# ${name}\n`, "utf-8");
}

describe("workflow_doctor 註冊檔參照完整性", () => {
  test("plans.json 留著 .opencode/ 舊前綴 → 回報肇事計畫與修法（搬遷已完成也一樣）", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    markMigrationComplete(root);
    writeLegacyContent(root, "legacy-plan.md");
    writePlansRegistry(root, {
      planId: "legacy-plan",
      contentRef: ".opencode/plans/legacy-plan.md",
    });

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");

    const item = checkByName(r, "Content Ref Path Integrity");
    expect(item).toBeDefined();
    expect(item.status).toBe("failed");
    expect(r.ok).toBe(false);

    // 指出是哪一個計畫、哪個欄位、什麼值
    const issue = r.content_ref_issues.find((i: any) => i.owner === "plan" && i.id === "legacy-plan");
    expect(issue).toBeDefined();
    expect(issue.field).toBe("contentRef");
    expect(issue.ref).toBe(".opencode/plans/legacy-plan.md");
    expect(issue.kind).toBe("legacy-prefix");
    expect(issue.repair).toContain(".ultrawork/plans/");

    // 訊息要能直接照做：點名計畫 + 指出舊前綴 + 給修法
    const warning = r.warnings.find((w: string) => w.startsWith("[content-ref]") && w.includes("legacy-plan"));
    expect(warning).toBeDefined();
    expect(warning).toContain("計畫 legacy-plan");
    expect(warning).toContain(".opencode/plans/legacy-plan.md");
    expect(warning).toContain("workflow_doctor");

    // 既有檢查名稱與狀態不受影響
    expect(checkByName(r, "Legacy .opencode Data Migration").status).toBe("passed");
    expect(checkByName(r, "Content Store Consistency").status).toBe("passed");
    expect(checkByName(r, "Plan Registry Health").status).toBe("passed");
    await fake.registration?.dispose();
  });

  test("tasks.json 的 contentRef / taskContentPath 留舊前綴 → 逐項點名任務", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    markMigrationComplete(root);
    writeLegacyContent(root, "legacy-plan.md");
    writePlansRegistry(root, { planId: "legacy-plan", contentRef: ".ultrawork/plans/legacy-plan.md" });
    writeCurrentContent(root, "legacy-plan.md");
    writeTasksRegistry(root, {
      taskId: "t-legacy-1",
      planId: "legacy-plan",
      contentRef: ".opencode/plans/legacy-plan.md#task-t-legacy-1",
    });

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");

    const item = checkByName(r, "Content Ref Path Integrity");
    expect(item.status).toBe("failed");
    const issue = r.content_ref_issues.find((i: any) => i.owner === "task" && i.id === "t-legacy-1");
    expect(issue.field).toBe("contentRef");
    expect(issue.ref).toBe(".opencode/plans/legacy-plan.md#task-t-legacy-1");
    expect(issue.kind).toBe("legacy-prefix");
    // 錨點片段不該出現在「要改成什麼」的建議裡被吃掉
    expect(issue.repair).toContain("#task-t-legacy-1");
    expect(r.warnings.some((w: string) => w.includes("任務 t-legacy-1"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("taskContentPath 指在內容庫外（不是舊前綴）→ 報 outside-store，訊息不假裝是搬遷問題", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeTasksRegistry(root, {
      taskId: "t-outside",
      taskContentPath: ".ultrawork/plans/../../elsewhere/t.md",
      taskContentMode: "file",
    });

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");

    const issue = r.content_ref_issues.find((i: any) => i.owner === "task" && i.id === "t-outside");
    expect(issue.kind).toBe("outside-store");
    expect(issue.field).toBe("taskContentPath");
    expect(checkByName(r, "Content Ref Path Integrity").status).toBe("failed");
    await fake.registration?.dispose();
  });

  test("已完成的計畫正文不存在 → 報 missing-file，只 warn 不讓 ok=false", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writePlansRegistry(root, {
      planId: "ghost",
      state: "COMPLETED",
      contentRef: ".ultrawork/plans/ghost.md",
      active: false,
    });

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");

    const issue = r.content_ref_issues.find((i: any) => i.owner === "plan" && i.id === "ghost");
    expect(issue.kind).toBe("missing-file");
    expect(checkByName(r, "Content Ref Path Integrity").status).toBe("warn");
    // 已封存／已完成的項目正文被清掉是常見狀態，不該擋人。
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w: string) => w.includes("ghost"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("引用修正後 doctor 恢復正常（不再回報）", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    markMigrationComplete(root);
    writeCurrentContent(root, "fixed-plan.md");
    writePlansRegistry(root, { planId: "fixed-plan", contentRef: ".ultrawork/plans/fixed-plan.md" });
    writeTasksRegistry(root, {
      taskId: "t-fixed-1",
      planId: "fixed-plan",
      contentRef: ".ultrawork/plans/fixed-plan.md#task-t-fixed-1",
    });

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");

    expect(r.content_ref_issues).toEqual([]);
    expect(checkByName(r, "Content Ref Path Integrity").status).toBe("passed");
    expect(r.warnings.some((w: string) => w.startsWith("[content-ref]"))).toBe(false);
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("既有語意不動：進行中計畫缺 contentRef 仍要被數到", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writePlansRegistry(root, { planId: "no-ref-plan" });

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");

    expect(r.memory_budget.missing_content_ref_plan_count).toBe(1);
    expect(r.memory_budget.missing_content_ref_status).toBe("warn");
    // 缺參照是「沒有東西可驗證」，不是「參照壞掉」。
    expect(r.content_ref_issues).toEqual([]);
    await fake.registration?.dispose();
  });

  test("plans.json 讀不到時這項檢查標 skipped，不假裝通過", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeFileSync(join(root, ".ultrawork", "plans.json"), "{ not json", "utf-8");

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");

    expect(checkByName(r, "Content Ref Path Integrity").status).toBe("skipped");
    expect(r.content_ref_issues).toEqual([]);
    await fake.registration?.dispose();
  });

  test("回報壞引用時 doctor 仍然唯讀（不順手把引用改掉）", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    markMigrationComplete(root);
    writeLegacyContent(root, "legacy-plan.md");
    writePlansRegistry(root, { planId: "legacy-plan", contentRef: ".opencode/plans/legacy-plan.md" });
    const before = fileSnapshot(root);

    const fake = await setupDiagnostics(root);
    await callTool(fake, "workflow_doctor");
    await fake.registration?.dispose();

    expect(fileSnapshot(root)).toEqual(before);
    const raw = JSON.parse(
      // 診斷不碰檔案：引用仍是原樣，使用者照 doctor 的訊息自己修（或重跑搬遷）。
      readFileSync(join(root, ".ultrawork", "plans.json"), "utf-8"),
    );
    expect(raw.plans["legacy-plan"].contentRef).toBe(".opencode/plans/legacy-plan.md");
    expect(existsSync(join(root, ".opencode", "plans", "legacy-plan.md"))).toBe(true);
  });
});

/**
 * 審查補強：兩個「診斷說正常、其實壞了」的缺口。
 *
 * ①引用指向內容庫內的**目錄** —— `existsSync` 對目錄也回 true，於是 doctor 判有效，
 *   但讀正文一定失敗（`readFileSync` 對目錄丟 EISDIR，工具端轉 CONTENT_FILE_NOT_FOUND）。
 * ②`missing-file` 一律只 warn —— 進行中計畫的正文不見和已封存計畫的正文不見
 *   後果不同，卻同級，doctor 仍能回 `ok: true`。
 */
describe("workflow_doctor 引用健全性：目錄目標與活躍項目正文缺失", () => {
  test("① contentRef 指向內容庫內的一個目錄 → 不能判為有效", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    // 內容庫裡本來就有目錄（tasks/），所以「指到目錄」是可能的現況。
    mkdirSync(join(root, ".ultrawork", "plans", "not-a-file"), { recursive: true });
    writePlansRegistry(root, { planId: "dir-plan", contentRef: ".ultrawork/plans/not-a-file" });

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");

    const issue = r.content_ref_issues.find((i: any) => i.owner === "plan" && i.id === "dir-plan");
    expect(issue).toBeDefined();
    expect(issue.kind).toBe("not-a-file");
    expect(issue.repair).toContain("目錄");
    expect(issue.repair).toContain("dir-plan");
    expect(checkByName(r, "Content Ref Path Integrity").status).toBe("failed");
    expect(r.ok).toBe(false);
    await fake.registration?.dispose();
  });

  test("① 對應的直接判定：inspectContentRef 不把目錄當成有效引用", async () => {
    const root = await tempRoot();
    mkdirSync(join(root, ".ultrawork", "plans"), { recursive: true });
    mkdirSync(join(root, ".ultrawork", "plans", "subdir"), { recursive: true });

    const inspection = inspectContentRef(".ultrawork/plans/subdir", root, join(root, ".ultrawork", "plans"), {
      owner: "plan",
      id: "p1",
      field: "contentRef",
    });

    expect(inspection.defect).toBe("not-a-file");
    expect(inspection.resolvedPath).toBe(join(root, ".ultrawork", "plans", "subdir"));
    expect(inspection.message).toContain("目錄");
  });

  test("① 完成狀態的計畫指到目錄仍然是 failed（結構性錯誤不看狀態）", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    mkdirSync(join(root, ".ultrawork", "plans", "not-a-file"), { recursive: true });
    writePlansRegistry(root, {
      planId: "dir-plan",
      state: "COMPLETED",
      contentRef: ".ultrawork/plans/not-a-file",
      active: false,
    });

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");

    expect(checkByName(r, "Content Ref Path Integrity").status).toBe("failed");
    expect(r.ok).toBe(false);
    await fake.registration?.dispose();
  });

  test("② 進行中計畫的正文不存在 → failed 且 ok=false（與缺欄位同一級）", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writePlansRegistry(root, { planId: "ghost", contentRef: ".ultrawork/plans/ghost.md" });

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");

    const issue = r.content_ref_issues.find((i: any) => i.owner === "plan" && i.id === "ghost");
    expect(issue.kind).toBe("missing-file");
    expect(checkByName(r, "Content Ref Path Integrity").status).toBe("failed");
    // 讀正文會拿不到東西，工作中的計畫不該被 doctor 說成健康。
    expect(r.ok).toBe(false);
    await fake.registration?.dispose();
  });

  test("② 進行中的任務正文不存在 → failed", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writePlansRegistry(root, { planId: "p1", contentRef: ".ultrawork/plans/p1.md" });
    writeCurrentContent(root, "p1.md");
    writeTasksRegistry(root, {
      taskId: "t-ghost",
      planId: "p1",
      taskContentPath: ".ultrawork/plans/tasks/t-ghost.md",
      taskContentMode: "file",
    });

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");

    const issue = r.content_ref_issues.find(
      (i: any) => i.owner === "task" && i.id === "t-ghost" && i.field === "taskContentPath",
    );
    expect(issue.kind).toBe("missing-file");
    expect(checkByName(r, "Content Ref Path Integrity").status).toBe("failed");
    expect(r.ok).toBe(false);
    await fake.registration?.dispose();
  });

  test("② 不是一律升級：已完成的計畫正文不存在仍只 warn", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writePlansRegistry(root, {
      planId: "ghost",
      state: "COMPLETED",
      contentRef: ".ultrawork/plans/ghost.md",
      active: false,
    });

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");

    expect(checkByName(r, "Content Ref Path Integrity").status).toBe("warn");
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("② 不是一律升級：已取消的任務正文不存在仍只 warn", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writePlansRegistry(root, { planId: "p1", contentRef: ".ultrawork/plans/p1.md" });
    writeCurrentContent(root, "p1.md");
    writeTasksRegistry(root, {
      taskId: "t-cancelled",
      state: "CANCELLED",
      planId: "p1",
      taskContentPath: ".ultrawork/plans/tasks/t-cancelled.md",
      taskContentMode: "file",
      cursor: null,
    });

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");

    expect(checkByName(r, "Content Ref Path Integrity").status).toBe("warn");
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("分級的兩種失敗在 details 裡分開講，不混成一句", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    mkdirSync(join(root, ".ultrawork", "plans", "not-a-file"), { recursive: true });
    writeLegacyContent(root, "legacy-plan.md");
    writePlansRegistry(root, { planId: "dir-plan", contentRef: ".ultrawork/plans/not-a-file" });
    // 第二個計畫：進行中、正文不存在。
    const raw = JSON.parse(readFileSync(join(root, ".ultrawork", "plans.json"), "utf-8"));
    const now = new Date().toISOString();
    raw.plans["active-ghost"] = {
      ...raw.plans["dir-plan"],
      planId: "active-ghost",
      title: "進行中但正文不見",
      contentRef: ".ultrawork/plans/active-ghost.md",
    };
    raw.plans["legacy-plan"] = {
      ...raw.plans["dir-plan"],
      planId: "legacy-plan",
      contentRef: ".opencode/plans/legacy-plan.md",
    };
    raw.activePlanIds.push("active-ghost", "legacy-plan");
    writeFileSync(join(root, ".ultrawork", "plans.json"), JSON.stringify(raw, null, 2), "utf-8");

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");

    const details = checkByName(r, "Content Ref Path Integrity").details;
    expect(details).toContain("dir-plan");
    expect(details).toContain("active-ghost");
    expect(details).toContain("legacy-plan");
    // 三種問題各自的說法都在，不會被併成一句無法分辨的話。
    expect(details).toContain("不是普通檔");
    expect(details).toContain("正文檔不存在");
    expect(details).toContain("內容庫之外");
    expect(r.ok).toBe(false);
    await fake.registration?.dispose();
  });

  test("既有回傳欄位形狀不變：每筆 issue 仍只有那六個欄位", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writePlansRegistry(root, { planId: "ghost", contentRef: ".ultrawork/plans/ghost.md" });

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");

    expect(Object.keys(r.content_ref_issues[0]).sort()).toEqual([
      "field",
      "id",
      "kind",
      "owner",
      "ref",
      "repair",
    ]);
    await fake.registration?.dispose();
  });
});
