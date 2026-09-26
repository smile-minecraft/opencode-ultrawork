import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type UltraworkSettings } from "../../../../src/settings/defaults.ts";
import { memoryLayer, withMemoryLock } from "../../../../src/modules/memory/layers.ts";
import { appendLog } from "../../../../src/modules/memory/log.ts";
import { callTool, setupWorkflow } from "./_helpers.ts";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-workflow-state-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function advanceToArchiving(fake: Awaited<ReturnType<typeof setupWorkflow>>, taskId: string, reviewed = true) {
  await callTool(fake, "task-state-sync", { event: "transition", taskId, from: "NEW", to: "PLANNED" });
  await callTool(fake, "task-state-sync", { event: "transition", taskId, from: "PLANNED", to: "IN_PROGRESS" });
  await callTool(fake, "task-state-sync", { event: "transition", taskId, from: "IN_PROGRESS", to: "REVIEWING" });
  if (reviewed) {
    await callTool(fake, "task-state-sync", { event: "review", taskId, verdict: "approve", reviewer: "momus" });
  }
  return callTool(fake, "task-state-sync", { event: "transition", taskId, from: "REVIEWING", to: "ARCHIVING" });
}

describe("workflow task／plan 狀態機與內容", () => {
  test("高風險任務未審查不能進 ARCHIVING，驗收漏報不能完成", async () => {
    const root = await tempRoot();
    const fake = await setupWorkflow(root);
    await callTool(fake, "plan-state-sync", { event: "create", planId: "p1", title: "高風險計畫" });
    await callTool(fake, "task-state-sync", {
      event: "create", taskId: "t1", to: "NEW", title: "高風險", owner: "ultra", priority: "high", risk: "high",
    });
    await callTool(fake, "plan-task-link", { planId: "p1", taskId: "t1", acceptanceCriteria: ["測試通過"] });
    expect((await advanceToArchiving(fake, "t1", false)).code).toBe("REVIEW_REQUIRED");

    await callTool(fake, "task-state-sync", { event: "review", taskId: "t1", verdict: "approve", reviewer: "momus" });
    expect((await callTool(fake, "task-state-sync", {
      event: "transition", taskId: "t1", from: "REVIEWING", to: "ARCHIVING",
    })).ok).toBe(true);
    const registry = JSON.parse(await readFile(join(root, ".ultrawork/tasks.json"), "utf8"));
    const task = registry.tasks.t1;
    expect(typeof task.archivingAt).toBe("string");
    const layer = memoryLayer(root);
    await withMemoryLock(layer, () =>
      appendLog(layer, [
        { kind: "disposition", taskId: "t1", outcome: "none", reason: "沒有需要保留的新知識", agent: "memorizer", sessionID: "s1" },
      ]),
    );
    const blocked = await callTool(fake, "task-state-sync", {
      event: "complete", taskId: "t1",
    });
    expect(blocked.code).toBe("ACCEPTANCE_REQUIRED");
    expect(blocked.data.blockedBy).toContain("acceptance");
    const completed = await callTool(fake, "task-state-sync", {
      event: "complete", taskId: "t1",
      acceptance: [{ criterion: "測試通過", met: true, evidence: "目標測試已通過" }],
    });
    expect(completed.data.state).toBe("COMPLETED");

    await callTool(fake, "task-state-sync", {
      event: "create", taskId: "t2", to: "NEW", title: "需要同步紀錄", owner: "ultra", priority: "normal",
    });
    await advanceToArchiving(fake, "t2");
    const receiptMissing = await callTool(fake, "task-state-sync", { event: "complete", taskId: "t2" });
    expect(receiptMissing.code).toBe("MEMORY_DISPOSITION_REQUIRED");
    await fake.registration?.dispose();
  });

  test("memory 關閉時不要求 receipt 且回報未啟用；Comment Signal 阻擋與關閉情境可切換", async () => {
    const root = await tempRoot();
    const settings = structuredClone(DEFAULT_SETTINGS) as UltraworkSettings;
    settings.modules.memory = false;
    settings.modules.commentSignal = false;
    const fake = await setupWorkflow(root, settings);
    await callTool(fake, "task-state-sync", { event: "create", taskId: "t1", to: "NEW", title: "不需 receipt", owner: "ultra", priority: "normal" });
    await advanceToArchiving(fake, "t1");
    const result = await callTool(fake, "task-state-sync", { event: "complete", taskId: "t1" });
    expect(result.ok).toBe(true);
    expect(result.data.warnings.join("\n")).toContain("memory 模組或結案政策未啟用");
    expect(result.data.warnings.join("\n")).toContain("Comment Signal 模組未啟用");
    await fake.registration?.dispose();
  });

  test("Comment Signal 開啟時 lastReport.shouldBlockCompletion 會擋結案", async () => {
    const root = await tempRoot();
    const settings = structuredClone(DEFAULT_SETTINGS) as UltraworkSettings;
    settings.modules.memory = false;
    const fake = await setupWorkflow(root, settings);
    await callTool(fake, "task-state-sync", { event: "create", taskId: "t1", to: "NEW", title: "CS", owner: "ultra", priority: "normal" });
    await advanceToArchiving(fake, "t1");
    await fake.ctx.storage.set("session/s1/comment-signal", { lastReport: { shouldBlockCompletion: true } });
    const blocked = await callTool(fake, "task-state-sync", { event: "complete", taskId: "t1" });
    expect(blocked.code).toBe("COMMENT_SIGNAL_BLOCKED");
    await fake.ctx.storage.set("session/s1/comment-signal", { lastReport: { shouldBlockCompletion: false } });
    expect((await callTool(fake, "task-state-sync", { event: "complete", taskId: "t1" })).ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("plan-content-delete 拒絕共用引用，非共用內容可正常刪除", async () => {
    const root = await tempRoot();
    const fake = await setupWorkflow(root);
    await callTool(fake, "plan-state-sync", { event: "create", planId: "p1", title: "P1" });
    await callTool(fake, "plan-state-sync", { event: "create", planId: "p2", title: "P2" });
    await callTool(fake, "plan-content-create", { planId: "p1", content: "# Shared\n" });
    const plansPath = join(root, ".ultrawork/plans.json");
    const plans = JSON.parse(await readFile(plansPath, "utf8"));
    plans.plans.p2.contentRef = plans.plans.p1.contentRef;
    await writeFile(plansPath, JSON.stringify(plans, null, 2));
    const shared = await callTool(fake, "plan-content-delete", { planId: "p1", mode: "apply" });
    expect(shared.code).toBe("CONTENT_IN_USE");
    expect(shared.data.sharedPlanIds).toEqual(["p2"]);

    await callTool(fake, "plan-state-sync", { event: "create", planId: "p3", title: "P3" });
    await callTool(fake, "plan-content-create", { planId: "p3", content: "# Unique\n" });
    const deleted = await callTool(fake, "plan-content-delete", { planId: "p3", mode: "apply" });
    expect(deleted.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("plan 依賴圖拒絕缺參照與循環，plan content 可 roundtrip", async () => {
    const root = await tempRoot();
    const fake = await setupWorkflow(root);
    expect((await callTool(fake, "plan-state-sync", { event: "create", planId: "p1", title: "計畫" })).ok).toBe(true);
    await callTool(fake, "task-state-sync", { event: "create", taskId: "a", to: "NEW", title: "A", owner: "ultra", priority: "normal" });
    await callTool(fake, "task-state-sync", { event: "create", taskId: "b", to: "NEW", title: "B", owner: "ultra", priority: "normal" });
    expect((await callTool(fake, "plan-task-link", { planId: "p1", taskId: "b", dependsOn: ["missing"] })).code).toBe("INVALID_LINK_REFERENCES");
    expect((await callTool(fake, "plan-task-link", { planId: "p1", taskId: "a" })).ok).toBe(true);
    expect((await callTool(fake, "plan-task-link", { planId: "p1", taskId: "b", dependsOn: ["a"] })).ok).toBe(true);
    expect((await callTool(fake, "plan-task-link", { planId: "p1", taskId: "a", dependsOn: ["b"] })).code).toBe("INVALID_LINK_REFERENCES");

    await callTool(fake, "plan-state-sync", { event: "create", planId: "p2", title: "內容計畫" });
    const created = await callTool(fake, "plan-content-create", {
      planId: "p2", content: "# 計畫\n\n## 目標\n\n完成。\n",
    });
    expect(created.ok).toBe(true);
    const read = await callTool(fake, "plan-content-read", { planId: "p2" });
    expect(read.ok).toBe(true);
    expect(read.data.content).toContain("完成。");
    const preview = await callTool(fake, "plan-content-delete", { planId: "p2", mode: "preview" });
    expect(preview.data.wouldDeletePlanContent).toBe(true);
    const deleted = await callTool(fake, "plan-content-delete", { planId: "p2", mode: "apply" });
    expect(deleted.ok).toBe(true);
    await fake.registration?.dispose();
  });
});
