/**
 * 40 — Workflow 單一交易 commit 管線回歸（Ultra-Coder 統一重構的 Red）。
 *
 * 針對「鎖／交易邊界完整性」障礙：
 *   1. `plan-progress-reconcile` apply 改到與 transaction draft 脫鉤的物件，
 *      回 `applied:true` 但磁碟 `finishedTaskIds` 不變（功能性缺陷）。
 *   2. `transactRegistries` commit 以空 protection set normalize＋直接 prune，
 *      未沿用 `writeRegistry` 的 tombstone／protection 與 `writePlansRegistry`
 *      的 content cleanup 語意；finished 超過保留上限時會丟掉仍被引用的 task。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
import { callTool, setupWorkflow } from "./_helpers.ts";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "uw-workflow-commit-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function testSettings() {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.modules.memory = false;
  settings.modules.commentSignal = false;
  return settings;
}

const TASK_CHAIN: Array<[string, string]> = [
  ["NEW", "PLANNED"],
  ["PLANNED", "IN_PROGRESS"],
  ["IN_PROGRESS", "REVIEWING"],
  ["REVIEWING", "ARCHIVING"],
];

async function completeTask(fake: Awaited<ReturnType<typeof setupWorkflow>>, taskId: string): Promise<void> {
  for (const [from, to] of TASK_CHAIN) {
    const r = await callTool(fake, "task-state-sync", { event: "transition", taskId, from, to, owner: "ultra" });
    expect(r.ok).toBe(true);
  }
  const done = await callTool(fake, "task-state-sync", { event: "complete", taskId, owner: "ultra" });
  expect(done.ok).toBe(true);
}

describe("40 - workflow 單一交易 commit 管線", () => {
  test("plan-progress-reconcile apply 必須真的把 finishedTaskIds 寫到磁碟", async () => {
    const root = await tempRoot();
    const fake = await setupWorkflow(root, testSettings());
    try {
      expect((await callTool(fake, "plan-state-sync", { event: "create", planId: "plan-one", title: "P1" })).ok).toBe(true);
      expect((await callTool(fake, "task-state-sync", {
        event: "create", taskId: "sample-task-01", to: "NEW", title: "T1", owner: "ultra", priority: "normal",
      })).ok).toBe(true);
      expect((await callTool(fake, "plan-task-link", { planId: "plan-one", taskId: "sample-task-01" })).ok).toBe(true);
      await completeTask(fake, "sample-task-01");

      // 製造雙索引漂移：磁碟 finishedTaskIds 清空（tombstone 與 live 終態 task 保留）。
      const plansPath = join(root, ".ultrawork/plans.json");
      const plans = JSON.parse(await readFile(plansPath, "utf8"));
      plans.plans["plan-one"].finishedTaskIds = [];
      await writeFile(plansPath, JSON.stringify(plans, null, 2));

      const result = await callTool(fake, "plan-progress-reconcile", { planId: "plan-one", mode: "apply" });
      expect(result.ok).toBe(true);
      expect(result.data.applied).toBe(true);
      expect(result.data.after).toEqual(["sample-task-01"]);

      // 落盤斷言：回 applied:true 就必須能在磁碟上讀到同樣的 finishedTaskIds。
      const disk = JSON.parse(await readFile(plansPath, "utf8"));
      expect(disk.plans["plan-one"].finishedTaskIds).toEqual(["sample-task-01"]);
    } finally {
      await fake.registration?.dispose();
    }
  });

  test("交易 commit 在 finished 超過保留上限時保留被引用 task 並補 tombstone", async () => {
    const root = await tempRoot();
    const fake = await setupWorkflow(root, testSettings());
    try {
      // plan-one 保持 ACTIVE（DRAFT 即可作為 protection 來源）；plan-zero 最後才收尾。
      expect((await callTool(fake, "plan-state-sync", { event: "create", planId: "plan-one", title: "P1" })).ok).toBe(true);
      expect((await callTool(fake, "plan-state-sync", { event: "create", planId: "plan-zero", title: "P0" })).ok).toBe(true);
      const linked: Record<string, string> = {};
      for (const taskId of ["finish-task-01", "finish-task-02", "finish-task-03", "finish-task-04", "finish-task-05", "finish-task-06", "finish-task-07", "finish-task-08"]) {
        expect((await callTool(fake, "task-state-sync", {
          event: "create", taskId, to: "NEW", title: taskId, owner: "ultra", priority: "normal",
        })).ok).toBe(true);
        const planId = taskId === "finish-task-01" || taskId === "finish-task-02" ? "plan-one" : "plan-zero";
        linked[taskId] = planId;
        expect((await callTool(fake, "plan-task-link", { planId, taskId })).ok).toBe(true);
      }
      expect(linked["finish-task-01"]).toBe("plan-one");
      // 依序完成（updatedAt 遞增：f1 最舊、f8 最新）。
      for (const taskId of ["finish-task-01", "finish-task-02", "finish-task-03", "finish-task-04", "finish-task-05", "finish-task-06", "finish-task-07", "finish-task-08"]) await completeTask(fake, taskId);
      // 收尾 plan-zero：f3..f8 自此成為「unprotected 終態 task」，觸發保留上限修剪。
      for (const [from, to] of [["DRAFT", "CLARIFYING"], ["CLARIFYING", "PLANNED"], ["PLANNED", "IN_PROGRESS"], ["IN_PROGRESS", "REVIEWING"], ["REVIEWING", "ARCHIVING"]]) {
        expect((await callTool(fake, "plan-state-sync", {
          event: "transition", planId: "plan-zero", from, to, owner: "ultra",
        })).ok).toBe(true);
      }
      expect((await callTool(fake, "plan-state-sync", { event: "complete", planId: "plan-zero" })).ok).toBe(true);

      // 模擬缺少 tombstone 的舊資料：刪掉 f4 的終結標記（保留 live 終態 task）。
      const plansPath = join(root, ".ultrawork/plans.json");
      const plans = JSON.parse(await readFile(plansPath, "utf8"));
      delete plans.plans["plan-zero"].completionTombstones["finish-task-04"];
      plans.plans["plan-zero"].finishedTaskIds = plans.plans["plan-zero"].finishedTaskIds.filter((id: string) => id !== "finish-task-04");
      await writeFile(plansPath, JSON.stringify(plans, null, 2));

      // 經真實工具交易觸發 commit（plan-state-sync create 走 transactRegistries）。
      expect((await callTool(fake, "plan-state-sync", { event: "create", planId: "plan-two", title: "P2" })).ok).toBe(true);

      // 保留上限斷言：2 個被 plan-one 引用的 finished＋最新 5 個 unprotected＝7 筆；最舊的 f3 被修剪。
      const tasksPath = join(root, ".ultrawork/tasks.json");
      const diskTasks = JSON.parse(await readFile(tasksPath, "utf8"));
      const kept = Object.keys(diskTasks.tasks).sort();
      expect(kept).toEqual(["finish-task-01", "finish-task-02", "finish-task-04", "finish-task-05", "finish-task-06", "finish-task-07", "finish-task-08"]);
      // tombstone 斷言：被修剪的 f3 與缺標記的 f4 都有終結標記，語意不丟。
      const diskPlans = JSON.parse(await readFile(plansPath, "utf8"));
      expect(diskPlans.plans["plan-zero"].completionTombstones["finish-task-03"].state).toBe("COMPLETED");
      expect(diskPlans.plans["plan-zero"].completionTombstones["finish-task-04"].state).toBe("COMPLETED");
      expect(diskPlans.plans["plan-zero"].finishedTaskIds).toContain("finish-task-04");
    } finally {
      await fake.registration?.dispose();
    }
  });
});
