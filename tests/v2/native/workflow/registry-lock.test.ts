import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../../../../src/kit/atomic-write.ts";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
import { createPlanContentCreateTool } from "../../../../src/modules/workflow/tools/plan-content.ts";
import { createPlanStateSyncTool } from "../../../../src/modules/workflow/tools/plan-state-sync.ts";
import { appendAuditEntry } from "../../../../src/modules/workflow/runtime/audit-log.ts";
import { readRawRegistry } from "../../../../src/modules/workflow/tools/plan-progress-reconcile.ts";
import { createWorkflowRuntime } from "../../../../src/modules/workflow/runtime/v2-runtime.ts";
import { deletePlanContentStrict } from "../../../../src/modules/workflow/content/content-ref.ts";
import { guardedContentWrite, restoreStore, snapshotStore } from "../../../../src/modules/workflow/content/content-store.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../../_fake-v2-context.ts";
import { callTool, setupWorkflow } from "./_helpers.ts";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-workflow-lock-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type WorkflowFake = Awaited<ReturnType<typeof setupWorkflow>>;

/**
 * 並行寫入 helper：CONTENT_LOCK_BUSY 是可預期的瞬時併發結果（不是失敗），
 * 只重試回 BUSY 的那一路，有上界。BUSY 保證沒進臨界區，所以重試不會重複
 * 寫入；最終的狀態斷言一個沒少（沒有放寬測試）。這樣並行測試不再假設
 * 「競爭一定在預設約 350ms 重試視窗內解決」，高負載下也不會誤判。
 */
async function callToolRetryBusy(
  fake: WorkflowFake,
  name: string,
  input: Record<string, unknown>,
  maxAttempts = 15,
): Promise<any> {
  let last: any = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    last = await callTool(fake, name, input);
    if (last.ok !== false || last.code !== "CONTENT_LOCK_BUSY") return last;
  }
  return last;
}

/** transact 版：BUSY 才重試，其他錯誤原樣拋出，同樣有上界。 */
async function transactRetryBusy<T>(fn: () => Promise<T>, maxAttempts = 15): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if ((error as { code?: string })?.code !== "CONTENT_LOCK_BUSY") throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function occupy(root: string, name: string): Promise<void> {
  const dir = join(root, ".ultrawork/cache/locks");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: "external" }));
}

describe("workflow registry 寫入鎖", () => {
  test("工具層並行建立 task 保留 t1／t2", async () => {
    const root = await tempRoot();
    const fake = await setupWorkflow(root);
    await Promise.all(["t1", "t2"].map((taskId) => callToolRetryBusy(fake, "task-state-sync", {
      event: "create", taskId, to: "NEW", title: taskId, owner: "ultra", priority: "normal",
    })));
    const registry = JSON.parse(await readFile(join(root, ".ultrawork/tasks.json"), "utf8"));
    expect(Object.keys(registry.tasks).sort()).toEqual(["t1", "t2"]);
    await fake.registration?.dispose();
  });

  test("工具層並行建立 plan 保留 p1／p2", async () => {
    const root = await tempRoot();
    const fake = await setupWorkflow(root);
    await Promise.all(["p1", "p2"].map((planId) => callToolRetryBusy(fake, "plan-state-sync", {
      event: "create", planId, title: planId,
    })));
    const registry = JSON.parse(await readFile(join(root, ".ultrawork/plans.json"), "utf8"));
    expect(Object.keys(registry.plans).sort()).toEqual(["p1", "p2"]);
    await fake.registration?.dispose();
  });

  test("plan-progress-reconcile 與其他 registry 寫入並行時保留兩邊結果", async () => {
    const root = await tempRoot();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.modules.memory = false;
    settings.modules.commentSignal = false;
    const fake = await setupWorkflow(root, settings);
    await callTool(fake, "plan-state-sync", { event: "create", planId: "p1", title: "P1" });
    await callTool(fake, "task-state-sync", { event: "create", taskId: "t1", to: "NEW", title: "T1", owner: "ultra", priority: "normal" });
    await callTool(fake, "plan-task-link", { planId: "p1", taskId: "t1" });
    for (const [from, to] of [["NEW", "PLANNED"], ["PLANNED", "IN_PROGRESS"], ["IN_PROGRESS", "REVIEWING"], ["REVIEWING", "ARCHIVING"]]) {
      await callTool(fake, "task-state-sync", { event: "transition", taskId: "t1", from, to });
    }
    await callTool(fake, "task-state-sync", { event: "complete", taskId: "t1" });
    const [reconcile, created] = await Promise.all([
      callToolRetryBusy(fake, "plan-progress-reconcile", { planId: "p1", mode: "apply" }),
      callToolRetryBusy(fake, "task-state-sync", { event: "create", taskId: "t2", to: "NEW", title: "T2", owner: "ultra", priority: "normal" }),
    ]);
    expect(reconcile.ok).toBe(true);
    expect(created.ok).toBe(true);
    const tasks = JSON.parse(await readFile(join(root, ".ultrawork/tasks.json"), "utf8"));
    const plans = JSON.parse(await readFile(join(root, ".ultrawork/plans.json"), "utf8"));
    expect(Object.keys(tasks.tasks).sort()).toEqual(["t1", "t2"]);
    expect(Object.keys(plans.plans)).toEqual(["p1"]);
    await fake.registration?.dispose();
  });

  test("plans.json／tasks.json 共用 registry.lock，忙碌時回 CONTENT_LOCK_BUSY 外框且停止寫入", async () => {
    const root = await tempRoot();
    await occupy(root, "registry.lock");
    const fake = await setupWorkflow(root);
    const result = await callTool(fake, "plan-state-sync", { event: "create", planId: "p1", title: "測試" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONTENT_LOCK_BUSY");
    expect(JSON.stringify(result)).toContain("unlockStale");
    // 忙碌時什麼都沒寫：plans.json 沒被建出來，別人的鎖沒被動。
    expect(existsSync(join(root, ".ultrawork/plans.json"))).toBe(false);
    expect(readFileSync(join(root, ".ultrawork/cache/locks/registry.lock"), "utf-8")).toContain("external");
    await fake.registration?.dispose();
  });

  test("雙檔交易第二檔失敗時回滾 tasks.json 與 plans.json", async () => {
    const root = await tempRoot();
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    let failPlans = false;
    const runtime = createWorkflowRuntime(fake.ctx, DEFAULT_SETTINGS, {
      writeFile(path, content) {
        if (failPlans && path.endsWith("plans.json")) throw new Error("注入第二檔失敗");
        atomicWriteFile(path, content);
      },
    });
    const toolContext = fakeV2ToolContext();
    await runtime.transactRegistries(toolContext, (_draft, control) => control.commit());
    const tasksPath = join(root, ".ultrawork/tasks.json");
    const plansPath = join(root, ".ultrawork/plans.json");
    const tasksBefore = await readFile(tasksPath, "utf8");
    const plansBefore = await readFile(plansPath, "utf8");
    failPlans = true;

    await expect(runtime.transactRegistries(toolContext, (draft, control) => {
      draft.tasks.tasks.added = { taskId: "added" } as never;
      draft.plans.projectPath = "changed";
      control.commit();
    })).rejects.toThrow("注入第二檔失敗");

    expect(await readFile(tasksPath, "utf8")).toBe(tasksBefore);
    expect(await readFile(plansPath, "utf8")).toBe(plansBefore);
  });

  test("sanitized 檔名碰撞時不刪存活計畫內容", async () => {
    const root = await tempRoot();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.modules.memory = false;
    settings.modules.commentSignal = false;
    const fake = await setupWorkflow(root, settings);
    for (const planId of ["foo/bar", "foo-bar", "Foo", "foo", "p2", "p3", "p4", "p5", "p0"]) {
      await callTool(fake, "plan-state-sync", { event: "create", planId, title: planId });
    }
    const plansPath = join(root, ".ultrawork/plans.json");
    const plans = JSON.parse(await readFile(plansPath, "utf8"));
    for (const plan of Object.values(plans.plans) as Array<{ state: string; planId: string }>) plan.state = "COMPLETED";
    plans.plans["foo-bar"].updatedAt = new Date(Date.now() + 200_000).toISOString();
    plans.plans.foo.updatedAt = new Date(Date.now() + 150_000).toISOString();
    plans.plans.Foo.updatedAt = new Date(Date.now() + 175_000).toISOString();
    plans.plans.p0.updatedAt = new Date(Date.now() + 100_000).toISOString();
    plans.plans["foo/bar"].contentRef = ".ultrawork/plans/foo-bar.md";
    plans.plans["foo-bar"].contentRef = ".ultrawork/plans/foo-bar.md";
    plans.plans.p2.contentRef = ".ultrawork/plans/p3.md";
    plans.plans.p3.contentRef = ".ultrawork/plans/p2.md";
    atomicWriteFile(plansPath, JSON.stringify(plans, null, 2));
    const contentPath = join(root, ".ultrawork/plans/foo-bar.md");
    const caseContentPath = join(root, ".ultrawork/plans/foo.md");
    await mkdir(join(root, ".ultrawork/plans"), { recursive: true });
    atomicWriteFile(contentPath, "surviving foo-bar content");
    atomicWriteFile(caseContentPath, "surviving foo content");
    const p2ContentPath = join(root, ".ultrawork/plans/p3.md");
    const p3ContentPath = join(root, ".ultrawork/plans/p2.md");
    atomicWriteFile(p2ContentPath, "p3 content");
    atomicWriteFile(p3ContentPath, "p2 content");

    const result = await callTool(fake, "plan-content-create", { planId: "p0", content: "# P0\n" });
    expect(result.ok).toBe(true);
    expect(await readFile(contentPath, "utf8")).toBe("surviving foo-bar content");
    expect(await readFile(caseContentPath, "utf8")).toBe("surviving foo content");
    expect(existsSync(p2ContentPath)).toBe(false);
    expect(existsSync(p3ContentPath)).toBe(false);
    await fake.registration?.dispose();
  });

  test("writePlansRegistry prune 會補完成 tombstone，plan-status 不報 missing", async () => {
    const root = await tempRoot();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.modules.memory = false;
    settings.modules.commentSignal = false;
    const fake = await setupWorkflow(root, settings);
    for (const planId of ["p0", "p1", "p2", "p3", "p4", "p5"]) {
      await callTool(fake, "plan-state-sync", { event: "create", planId, title: planId });
    }
    for (let index = 0; index < 6; index++) {
      const taskId = `finished-${index}`;
      await callTool(fake, "task-state-sync", {
        event: "create", taskId, to: "NEW", title: taskId, owner: "ultra", priority: "normal",
      });
      await callTool(fake, "plan-task-link", { planId: "p0", taskId });
    }
    const plansPath = join(root, ".ultrawork/plans.json");
    const tasksPath = join(root, ".ultrawork/tasks.json");
    const plans = JSON.parse(await readFile(plansPath, "utf8"));
    for (const plan of Object.values(plans.plans) as Array<{ state: string }>) plan.state = "COMPLETED";
    plans.plans.p0.updatedAt = new Date(Date.now() + 100_000).toISOString();
    atomicWriteFile(plansPath, JSON.stringify(plans, null, 2));
    const tasks = JSON.parse(await readFile(tasksPath, "utf8"));
    for (const task of Object.values(tasks.tasks) as Array<{ state: string }>) task.state = "COMPLETED";
    atomicWriteFile(tasksPath, JSON.stringify(tasks, null, 2));

    const created = await callTool(fake, "plan-content-create", { planId: "p0", content: "# P0\n" });
    expect(created.ok).toBe(true);
    const status = await callTool(fake, "plan-status", { planId: "p0" });
    expect(status.ok).toBe(true);
    expect(status.data.missingIds).toEqual([]);
    expect(status.data.inconsistencies).toEqual([]);
    expect(status.data.tombstonedIds).toEqual(["finished-0"]);
    expect(status.data.finishedCount).toBe(6);
    const persistedPlans = JSON.parse(await readFile(plansPath, "utf8"));
    const tombstone = persistedPlans.plans.p0.completionTombstones["finished-0"];
    expect(tombstone.state).toBe("COMPLETED");
    expect(typeof tombstone.finishedAt).toBe("string");
    const persistedTasks = JSON.parse(await readFile(tasksPath, "utf8"));
    expect(persistedTasks.tasks["finished-0"]).toBeUndefined();
    await fake.registration?.dispose();
  });

  test("tasks.json symlink 不會被 readRegistry 讀取外部檔", async () => {
    const root = await tempRoot();
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    const runtime = createWorkflowRuntime(fake.ctx, DEFAULT_SETTINGS);
    const context = fakeV2ToolContext();
    runtime.lazyEnsure(context);
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    const victim = join(outside, "tasks.json");
    const original = Buffer.from([0xff, 0x00, 0x41]);
    writeFileSync(victim, original);
    await rm(join(root, ".ultrawork/tasks.json"));
    symlinkSync(victim, join(root, ".ultrawork/tasks.json"));

    expect(() => runtime.readRegistry(context)).toThrow();
    expect(readFileSync(victim)).toEqual(original);
  });

  test("plans.json symlink 不會被 readPlansRegistry 讀取外部檔", async () => {
    const root = await tempRoot();
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    const runtime = createWorkflowRuntime(fake.ctx, DEFAULT_SETTINGS);
    const context = fakeV2ToolContext();
    runtime.lazyEnsure(context);
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    const victim = join(outside, "plans.json");
    const original = Buffer.from([0xfe, 0x80, 0x42]);
    writeFileSync(victim, original);
    await rm(join(root, ".ultrawork/plans.json"), { force: true });
    symlinkSync(victim, join(root, ".ultrawork/plans.json"));

    expect(() => runtime.readPlansRegistry(context)).toThrow();
    expect(readFileSync(victim)).toEqual(original);
  });

  test("audit.jsonl symlink 不會被 appendAuditEntry 寫入外部", async () => {
    const root = await tempRoot();
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    const runtime = createWorkflowRuntime(fake.ctx, DEFAULT_SETTINGS);
    const context = fakeV2ToolContext();
    runtime.lazyEnsure(context);
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    const victim = join(outside, "audit.jsonl");
    const original = Buffer.from([0xff, 0x00, 0x41]);
    writeFileSync(victim, original);
    await rm(join(root, ".ultrawork/audit.jsonl"), { force: true });
    symlinkSync(victim, join(root, ".ultrawork/audit.jsonl"));

    const written = appendAuditEntry(runtime, { event: "risk-declared", taskId: "t1", projectId: "p1" }, context);
    expect(written).toBe(false);
    expect(readFileSync(victim)).toEqual(original);
  });

  test("readRawRegistry 會自行拒絕 plans.json 與 tasks.json symlink", async () => {
    const root = await tempRoot();
    const plansDir = join(root, ".ultrawork/plans");
    await mkdir(plansDir, { recursive: true });
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    const plansVictim = join(outside, "plans.json");
    const tasksVictim = join(outside, "tasks.json");
    writeFileSync(plansVictim, "{}");
    writeFileSync(tasksVictim, "{}");
    const plansPath = join(root, ".ultrawork/plans.json");
    const tasksPath = join(root, ".ultrawork/tasks.json");
    symlinkSync(plansVictim, plansPath);
    symlinkSync(tasksVictim, tasksPath);

    expect(() => readRawRegistry(root, plansDir, plansPath)).toThrow();
    expect(() => readRawRegistry(root, plansDir, tasksPath)).toThrow();
    expect(readFileSync(plansVictim, "utf8")).toBe("{}");
    expect(readFileSync(tasksVictim, "utf8")).toBe("{}");
  });

  test("cache symlink 不會讓 registry 或 state lock 在外部建立", async () => {
    const root = await tempRoot();
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    const runtime = createWorkflowRuntime(fake.ctx, DEFAULT_SETTINGS);
    const context = fakeV2ToolContext();
    runtime.lazyEnsure(context);
    const registry = runtime.readRegistry(context);
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await rm(join(root, ".ultrawork/cache"), { recursive: true, force: true });
    symlinkSync(outside, join(root, ".ultrawork/cache"));

    await expect(runtime.writeRegistry(registry, context)).rejects.toThrow();
    await expect(runtime.updateStateMd(registry, context)).rejects.toThrow();
    expect(existsSync(join(outside, "locks"))).toBe(false);
    expect(existsSync(join(outside, "locks/registry.lock"))).toBe(false);
    expect(existsSync(join(outside, "locks/state.lock"))).toBe(false);
  });

  test(".ultrawork ancestor symlink 不會讓 lazyEnsure 或 updateStateMd 寫入外部", async () => {
    const root = await tempRoot();
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    const runtime = createWorkflowRuntime(fake.ctx, DEFAULT_SETTINGS);
    const context = fakeV2ToolContext();
    runtime.lazyEnsure(context);
    const registry = runtime.readRegistry(context);
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    const victim = join(outside, "victim.txt");
    const original = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    writeFileSync(victim, original);
    await rm(join(root, ".ultrawork"), { recursive: true });
    symlinkSync(outside, join(root, ".ultrawork"));

    expect(() => runtime.lazyEnsure(context)).toThrow();
    expect(() => runtime.updateStateMd(registry, context)).toThrow();
    expect(readFileSync(victim)).toEqual(original);
    expect(existsSync(join(outside, "state.md"))).toBe(false);
    expect(existsSync(join(outside, "project.md"))).toBe(false);
    expect(existsSync(join(outside, "tasks.json"))).toBe(false);
  });

  test("plans root symlink 會讓 snapshot、restore、delete 全部 fail closed", async () => {
    const root = await tempRoot();
    const outside = join(root, "outside");
    const ultraworkDir = join(root, ".ultrawork");
    const plansDir = join(ultraworkDir, "plans");
    await mkdir(plansDir, { recursive: true });
    await mkdir(outside, { recursive: true });
    const victim = join(outside, "victim.txt");
    const original = Buffer.from([0xff, 0x00, 0x41]);
    writeFileSync(victim, original);
    writeFileSync(join(plansDir, "safe.md"), "safe");
    const snapshot = snapshotStore(root, plansDir, []);
    await rm(plansDir, { recursive: true, force: true });
    symlinkSync(outside, plansDir);

    expect(() => snapshotStore(root, plansDir, [])).toThrow();
    expect(restoreStore(snapshot).ok).toBe(false);
    expect(readFileSync(victim)).toEqual(original);
    expect(() => deletePlanContentStrict(root, join(plansDir, "victim.txt"), plansDir)).toThrow();
    expect(readFileSync(victim)).toEqual(original);
  });

  test(".ultrawork ancestor symlink 會讓 snapshot、restore、delete 全部 fail closed", async () => {
    const root = await tempRoot();
    const ultraworkDir = join(root, ".ultrawork");
    const plansDir = join(ultraworkDir, "plans");
    const outside = join(root, "outside");
    const outsidePlans = join(outside, "plans");
    await mkdir(plansDir, { recursive: true });
    await mkdir(outsidePlans, { recursive: true });
    const snapshot = snapshotStore(root, plansDir, []);
    const victim = join(outsidePlans, "victim.txt");
    const original = Buffer.from([0xfe, 0x80, 0x42]);
    writeFileSync(victim, original);
    await rm(ultraworkDir, { recursive: true, force: true });
    symlinkSync(outside, ultraworkDir);

    expect(() => snapshotStore(root, plansDir, [])).toThrow();
    expect(restoreStore(snapshot).ok).toBe(false);
    expect(readFileSync(victim)).toEqual(original);
    expect(() => deletePlanContentStrict(root, join(plansDir, "victim.txt"), plansDir)).toThrow();
    expect(readFileSync(victim)).toEqual(original);
  });

  test("plans symlink 逃逸在還原與刪除前 fail closed", async () => {
    const root = await tempRoot();
    const outside = join(root, "outside");
    const plansDir = join(root, ".ultrawork/plans");
    await mkdir(outside, { recursive: true });
    await mkdir(plansDir, { recursive: true });
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "outside-original");
    writeFileSync(join(plansDir, "safe.md"), "safe");
    const snapshot = snapshotStore(root, plansDir, []);
    const link = join(plansDir, "link");
    symlinkSync(victim, link);
    const restored = restoreStore(snapshot);
    expect(restored.ok).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("outside-original");
    expect(() => deletePlanContentStrict(root, link, plansDir)).toThrow();
    expect(readFileSync(victim, "utf8")).toBe("outside-original");
  });

  test("content-store 真實還原路徑以 Buffer 保留非 UTF-8 位元組", async () => {
    const root = await tempRoot();
    const plansDir = join(root, ".ultrawork/plans");
    await mkdir(plansDir, { recursive: true });
    const contentPath = join(plansDir, "bytes.md");
    const original = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41]);
    writeFileSync(contentPath, original);
    const result = await guardedContentWrite({
      projectRoot: root,
      plansDir,
      contentPath,
      proposedFile: "temporary replacement",
      extraSnapshotPaths: [],
      op: "test-byte-restore",
      shaBefore: { file: "", contentVersion: 1 },
      shaAfter: { file: "", contentVersion: 2 },
      writeRegistry() {
        throw new Error("注入寫入失敗");
      },
    });
    expect(result.kind).toBe("rolled_back");
    expect(readFileSync(contentPath)).toEqual(original);
  });

  test("unlink 失敗時 fail closed，JSON 與內容檔維持一致", async () => {
    const root = await tempRoot();
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    const runtime = createWorkflowRuntime(fake.ctx, DEFAULT_SETTINGS, {
      deleteContent() {
        throw new Error("注入 unlink 失敗");
      },
    });
    const context = fakeV2ToolContext();
    const planTool = createPlanStateSyncTool(runtime);
    const contentTool = createPlanContentCreateTool(runtime);
    const run = async (tool: any, input: Record<string, unknown>) => JSON.parse((await tool.execute(input, context)).content);
    for (const planId of ["p0", "p1", "p2", "p3", "p4", "p5"]) {
      await run(planTool, { event: "create", planId, title: planId });
    }
    const plansPath = join(root, ".ultrawork/plans.json");
    const tasksPath = join(root, ".ultrawork/tasks.json");
    const plans = JSON.parse(await readFile(plansPath, "utf8"));
    for (const plan of Object.values(plans.plans) as Array<{ state: string; planId: string }>) plan.state = "COMPLETED";
    plans.plans.p0.updatedAt = new Date(Date.now() + 100_000).toISOString();
    plans.plans.p5.contentRef = ".ultrawork/plans/p5.md";
    atomicWriteFile(plansPath, JSON.stringify(plans, null, 2));
    const tasks = JSON.parse(await readFile(tasksPath, "utf8"));
    for (const task of Object.values(tasks.tasks) as Array<{ state: string }>) task.state = "COMPLETED";
    atomicWriteFile(tasksPath, JSON.stringify(tasks, null, 2));
    const contentPath = join(root, ".ultrawork/plans/p5.md");
    await mkdir(join(root, ".ultrawork/plans"), { recursive: true });
    atomicWriteFile(contentPath, "p5 content");
    const plansBefore = await readFile(plansPath, "utf8");
    const tasksBefore = await readFile(tasksPath, "utf8");
    const result = await run(contentTool, { planId: "p0", content: "# P0\n" });
    expect(result.code).toBe("REGISTRY_WRITE_FAILED_ROLLED_BACK");
    expect(await readFile(plansPath, "utf8")).toBe(plansBefore);
    expect(await readFile(tasksPath, "utf8")).toBe(tasksBefore);
    expect(await readFile(contentPath, "utf8")).toBe("p5 content");
  });

  test("writePlansRegistry 第二檔失敗時回滾 plans.json／tasks.json", async () => {
    const root = await tempRoot();
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    let failTasks = false;
    const runtime = createWorkflowRuntime(fake.ctx, DEFAULT_SETTINGS, {
      writeFile(path, content) {
        if (failTasks && path.endsWith("tasks.json")) throw new Error("注入 plans 第二檔失敗");
        atomicWriteFile(path, content);
      },
    });
    const context = fakeV2ToolContext();
    const planTool = createPlanStateSyncTool(runtime);
    const contentTool = createPlanContentCreateTool(runtime);
    const run = async (tool: any, input: Record<string, unknown>) => {
      const result = await tool.execute(input, context);
      return JSON.parse(result.content);
    };
    for (const planId of ["p0", "p1", "p2", "p3", "p4", "p5"]) {
      await run(planTool, { event: "create", planId, title: planId });
    }
    const plansPath = join(root, ".ultrawork/plans.json");
    const tasksPath = join(root, ".ultrawork/tasks.json");
    const seeded = JSON.parse(await readFile(plansPath, "utf8"));
    for (const plan of Object.values(seeded.plans) as Array<{ state: string }>) plan.state = "COMPLETED";
    seeded.plans.p0.updatedAt = new Date(Date.now() + 100_000).toISOString();
    atomicWriteFile(plansPath, JSON.stringify(seeded, null, 2));
    const contentPath = join(root, ".ultrawork/plans/p5.md");
    await mkdir(join(root, ".ultrawork/plans"), { recursive: true });
    const contentBytes = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41]);
    writeFileSync(contentPath, contentBytes);
    const plansBefore = await readFile(plansPath, "utf8");
    const tasksBefore = await readFile(tasksPath, "utf8");
    failTasks = true;

    const result = await run(contentTool, { planId: "p0", content: "# P0\n" });
    expect(result.code).toBe("REGISTRY_WRITE_FAILED_ROLLED_BACK");
    expect(await readFile(plansPath, "utf8")).toBe(plansBefore);
    expect(await readFile(tasksPath, "utf8")).toBe(tasksBefore);
    expect(existsSync(join(root, ".ultrawork/plans/p0.md"))).toBe(false);
    expect(readFileSync(contentPath)).toEqual(contentBytes);
  });

  test("並行交易在鎖內重新讀取並保留兩個操作", async () => {
    const root = await tempRoot();
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    const runtime = createWorkflowRuntime(fake.ctx, DEFAULT_SETTINGS);
    const toolContext = fakeV2ToolContext();
    await Promise.all(["t1", "t2"].map((taskId) => transactRetryBusy(() => runtime.transactRegistries(toolContext, (draft, control) => {
      draft.tasks.tasks[taskId] = { taskId } as never;
      control.commit();
    }))));
    const tasks = JSON.parse(await readFile(join(root, ".ultrawork/tasks.json"), "utf8"));
    expect(Object.keys(tasks.tasks).sort()).toEqual(["t1", "t2"]);
  });

  test("state.md 使用 state.lock，忙碌時回 CONTENT_LOCK_BUSY 外框且不覆寫狀態投影", async () => {
    const root = await tempRoot();
    const fake = await setupWorkflow(root);
    await callTool(fake, "task-state-sync", { event: "create", taskId: "seed", to: "NEW", title: "初始化", owner: "ultra", priority: "normal" });
    await occupy(root, "state.lock");
    const result = await callTool(fake, "task-state-sync", {
      event: "create", taskId: "t1", to: "NEW", title: "測試", owner: "ultra", priority: "normal",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONTENT_LOCK_BUSY");
    expect(readFileSync(join(root, ".ultrawork/cache/locks/state.lock"), "utf-8")).toContain("external");
    await fake.registration?.dispose();
  });
});
