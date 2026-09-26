/**
 * 別的計畫／任務帶著壞掉的參照，不該癱瘓與它無關的操作。
 *
 * 實地回報：`plan-state-sync({event:"create"})` 建立一個**新**計畫，卻被
 * 另一個既有計畫殘留的 `.opencode/plans/….md` 參照擋下：
 *
 *   Path traversal attempt detected: …/.opencode/plans/acelib-custom-item-platform-…md
 *   is outside worktree …/.ultrawork/plans
 *
 * 因為 `transactRegistries` 的 commit stage 會替**每一個**存活計畫解析
 * `contentRef`（只為了組「不要誤刪別人內容檔」的名單），一筆解析不到的名單
 * 就讓整個 registry 寫入失敗並回滾 —— 新計畫根本沒被建立（後續
 * `plan-content-create` 因此回 `PLAN_NOT_FOUND`）。
 *
 * 本檔的邊界：解析不到時**跳過該筆名單項目**，不是放寬守衛。真正要刪的檔案在
 * 落盤前仍逐路徑過 `assertSafeContentPath`；`.opencode/` 與專案外的寫入照樣被拒。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTool, setupWorkflow } from "./_helpers.ts";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-ref-resilience-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface PlanSeed {
  planId: string;
  state?: string;
  contentRef?: string;
}

/**
 * 鋪一個帶著舊參照的既有計畫。
 *
 * 舊內容檔真的留在 `.opencode/plans/`（搬遷後改名保留的那批形狀），新位置的
 * 檔案不存在 —— 正是「引用改寫漏掉一筆」會留下的磁碟現況。
 */
async function seedLegacyPlan(root: string, seed: PlanSeed): Promise<void> {
  mkdirSync(join(root, ".ultrawork", "plans"), { recursive: true });
  mkdirSync(join(root, ".opencode", "plans"), { recursive: true });
  writeFileSync(join(root, ".opencode", "plans", `${seed.planId}.md`), `# ${seed.planId}\n`, "utf-8");
  const projectId = root.split("/").pop()!.toLowerCase();
  const now = new Date().toISOString();
  writeFileSync(
    join(root, ".ultrawork", "plans.json"),
    JSON.stringify(
      {
        version: "1",
        projectId,
        projectPath: root,
        activePlanIds: [seed.planId],
        planCursor: seed.planId,
        plans: {
          [seed.planId]: {
            planId: seed.planId,
            projectId,
            projectPath: root,
            title: "舊計畫",
            state: seed.state ?? "IN_PROGRESS",
            owner: "ultra",
            priority: "P0",
            createdAt: now,
            updatedAt: now,
            taskIds: [],
            finishedTaskIds: [],
            dependencyGraph: { nodes: [], edges: [] },
            history: [],
            ...(seed.contentRef !== undefined ? { contentRef: seed.contentRef } : {}),
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function readPlans(root: string): any {
  return JSON.parse(readFileSync(join(root, ".ultrawork", "plans.json"), "utf-8"));
}

/** 工具 payload（非外框欄位）都在 `data` 裡。 */
function payload(r: any): any {
  return r.data;
}

interface TaskSeed {
  taskId: string;
  planId?: string;
  contentRef?: string;
  taskContentPath?: string;
  taskContentMode?: string;
}

/** 寫一份 tasks.json（欄位原樣帶入，可以刻意放壞掉的參照）。 */
function writeTasks(root: string, seeds: TaskSeed[]): void {
  const projectId = root.split("/").pop()!.toLowerCase();
  const now = new Date().toISOString();
  const tasks: Record<string, unknown> = {};
  for (const seed of seeds) {
    tasks[seed.taskId] = {
      taskId: seed.taskId,
      projectId,
      projectPath: root,
      title: seed.taskId,
      state: "IN_PROGRESS",
      owner: "ultra",
      priority: "P0",
      createdAt: now,
      updatedAt: now,
      history: [],
      ...(seed.planId ? { planId: seed.planId } : {}),
      ...(seed.contentRef ? { contentRef: seed.contentRef } : {}),
      ...(seed.taskContentPath ? { taskContentPath: seed.taskContentPath } : {}),
      ...(seed.taskContentMode ? { taskContentMode: seed.taskContentMode } : {}),
    };
  }
  writeFileSync(
    join(root, ".ultrawork", "tasks.json"),
    JSON.stringify(
      {
        version: "1",
        projectId,
        projectPath: root,
        activeTaskIds: seeds.map((s) => s.taskId),
        taskCursor: seeds[0]?.taskId ?? null,
        tasks,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

describe("別的計畫的壞參照不再癱瘓無關的 registry 寫入", () => {
  test("既有計畫帶 .opencode/ 舊參照時，建立新計畫成功", async () => {
    const root = await tempRoot();
    await seedLegacyPlan(root, {
      planId: "legacy-plan",
      contentRef: ".opencode/plans/legacy-plan.md",
    });
    const fake = await setupWorkflow(root);

    const r = await callTool(fake, "plan-state-sync", {
      event: "create",
      planId: "brand-new-plan",
      title: "新計畫",
      owner: "ultra",
      priority: "high",
    });

    expect(r.ok).toBe(true);
    expect(payload(r).state).toBe("DRAFT");
    const plans = readPlans(root);
    expect(Object.keys(plans.plans).sort()).toEqual(["brand-new-plan", "legacy-plan"]);
    expect(plans.plans["brand-new-plan"].state).toBe("DRAFT");
    // 建立新計畫不得順手改寫別人的資料：舊計畫的引用原樣保留，交给 doctor 回報。
    expect(plans.plans["legacy-plan"].contentRef).toBe(".opencode/plans/legacy-plan.md");
    // 舊位置的使用者資料一個位元組都不能少。
    expect(existsSync(join(root, ".opencode", "plans", "legacy-plan.md"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("既有計畫帶舊參照時，建立新計畫的內容檔也寫得起來", async () => {
    const root = await tempRoot();
    await seedLegacyPlan(root, {
      planId: "legacy-plan",
      contentRef: ".opencode/plans/legacy-plan.md",
    });
    const fake = await setupWorkflow(root);
    await callTool(fake, "plan-state-sync", {
      event: "create",
      planId: "brand-new-plan",
      title: "新計畫",
    });

    const r = await callTool(fake, "plan-content-create", { planId: "brand-new-plan" });

    expect(r.ok).toBe(true);
    expect(existsSync(join(root, ".ultrawork", "plans", "brand-new-plan.md"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("引用逃出內容庫（`..`）時同樣不癱瘓建立新計畫", async () => {
    const root = await tempRoot();
    await seedLegacyPlan(root, {
      planId: "escape-plan",
      contentRef: ".ultrawork/plans/../../../outside.md",
    });
    const fake = await setupWorkflow(root);

    const r = await callTool(fake, "plan-state-sync", {
      event: "create",
      planId: "brand-new-plan",
      title: "新計畫",
    });

    expect(r.ok).toBe(true);
    expect(readPlans(root).plans["brand-new-plan"]).toBeDefined();
    await fake.registration?.dispose();
  });

  test("被擋的是壞引用自己的操作：訊息要點名肇事計畫與修法", async () => {
    const root = await tempRoot();
    await seedLegacyPlan(root, {
      planId: "legacy-plan",
      contentRef: ".opencode/plans/legacy-plan.md",
    });
    const fake = await setupWorkflow(root);

    // 對**肇事計畫本身**寫內容仍然必須被擋（守衛不放寬），但錯誤要能照做。
    let message = "";
    try {
      await callTool(fake, "plan-content-update", {
        planId: "legacy-plan",
        content: "# 更新\n",
        mode: "preview",
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("legacy-plan");
    expect(message).toContain(".opencode/plans/legacy-plan.md");
    expect(message).toContain(".ultrawork/plans/");
    expect(message).toContain("workflow_doctor");
    await fake.registration?.dispose();
  });

  test("對肇事任務讀內容同樣點名；對參照正常的任務讀不受影響", async () => {
    const root = await tempRoot();
    await seedLegacyPlan(root, {
      planId: "legacy-plan",
      contentRef: ".opencode/plans/legacy-plan.md",
    });
    writeTasks(root, [
      {
        taskId: "t-legacy-1",
        planId: "legacy-plan",
        contentRef: ".opencode/plans/legacy-plan.md#task-t-legacy-1",
        taskContentPath: ".opencode/plans/legacy-plan.md",
        taskContentMode: "file",
      },
      { taskId: "t-healthy-1", planId: "legacy-plan" },
    ]);
    const fake = await setupWorkflow(root);

    // 肇事的是**參照的持有者**，不是被操作的對象：t-healthy-1 自己沒問題，
    // 但它要經過壞掉的 plan 引用，所以訊息要點名 legacy-plan（真正要修的那筆）。
    let planSideMessage = "";
    try {
      await callTool(fake, "task-content-read", { taskId: "t-healthy-1" });
    } catch (error) {
      planSideMessage = (error as Error).message;
    }
    expect(planSideMessage).toContain("計畫 legacy-plan");
    expect(planSideMessage).toContain("workflow_doctor");

    let message = "";
    try {
      await callTool(fake, "task-content-read", { taskId: "t-legacy-1" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("任務 t-legacy-1");
    expect(message).toContain(".opencode/plans/legacy-plan.md");
    expect(message).toContain("workflow_doctor");
    await fake.registration?.dispose();
  });

  test("plan-content-delete 掃其他計畫的引用時不會被無關的壞引用炸掉", async () => {
    const root = await tempRoot();
    await seedLegacyPlan(root, {
      planId: "legacy-plan",
      contentRef: ".opencode/plans/legacy-plan.md",
    });
    writeFileSync(join(root, ".ultrawork", "plans", "doomed-plan.md"), "# doomed\n", "utf-8");
    const plans = readPlans(root);
    const now = new Date().toISOString();
    plans.plans["doomed-plan"] = {
      planId: "doomed-plan",
      projectId: plans.projectId,
      projectPath: root,
      title: "待刪計畫",
      state: "IN_PROGRESS",
      owner: "ultra",
      priority: "P0",
      createdAt: now,
      updatedAt: now,
      taskIds: [],
      finishedTaskIds: [],
      dependencyGraph: { nodes: [], edges: [] },
      history: [],
      contentRef: ".ultrawork/plans/doomed-plan.md",
    };
    writeFileSync(join(root, ".ultrawork", "plans.json"), JSON.stringify(plans, null, 2), "utf-8");
    const fake = await setupWorkflow(root);

    const r = await callTool(fake, "plan-content-delete", {
      planId: "doomed-plan",
      mode: "apply",
      force: true,
    });

    expect(r.ok).toBe(true);
    expect(existsSync(join(root, ".ultrawork", "plans", "doomed-plan.md"))).toBe(false);
    // 舊位置的檔案不在內容庫裡，本來就不該被這次刪除碰到。
    expect(existsSync(join(root, ".opencode", "plans", "legacy-plan.md"))).toBe(true);
    await fake.registration?.dispose();
  });
});

describe("路徑保護沒有被放寬", () => {
  test("讀取 .opencode/ 參照仍然被拒", async () => {
    const root = await tempRoot();
    await seedLegacyPlan(root, { planId: "legacy-plan" });
    const fake = await setupWorkflow(root);

    await expect(
      callTool(fake, "plan-content-read", { contentRef: ".opencode/plans/legacy-plan.md" }),
    ).rejects.toThrow(/outside worktree|escapes guarded root/);
    await fake.registration?.dispose();
  });

  test("讀取專案外的絕對路徑仍然被拒", async () => {
    const root = await tempRoot();
    await seedLegacyPlan(root, { planId: "legacy-plan" });
    const fake = await setupWorkflow(root);

    await expect(
      callTool(fake, "plan-content-read", { contentRef: "/etc/hosts" }),
    ).rejects.toThrow(/outside worktree|escapes guarded root/);
    await fake.registration?.dispose();
  });

  test("`..` 逃出內容庫仍然被拒", async () => {
    const root = await tempRoot();
    await seedLegacyPlan(root, { planId: "legacy-plan" });
    const fake = await setupWorkflow(root);

    await expect(
      callTool(fake, "plan-content-read", { contentRef: ".ultrawork/plans/../../escape.md" }),
    ).rejects.toThrow(/outside worktree|escapes guarded root/);
    await fake.registration?.dispose();
  });
});
