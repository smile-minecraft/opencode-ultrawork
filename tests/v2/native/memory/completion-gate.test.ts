/**
 * 記憶結案檢查的整合測試：透過真正的 task-state-sync 與記憶工具走完整流程
 * （企劃書 `docs/memory-redesign.md` 第 9 節與第 15 節階段 6 的驗收條件）。
 *
 * 單元層級的處置驗證在 store-tools.test.ts；這裡確認 workflow 與 memory 兩個模組
 * 接在一起時，每條規則都真的擋在 complete 上，而且擋下時回結構化錯誤、不拋例外。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryModule } from "../../../../src/modules/memory/index.ts";
import { memoryLayer, withMemoryLock } from "../../../../src/modules/memory/layers.ts";
import { appendLog } from "../../../../src/modules/memory/log.ts";
import { workflowModule } from "../../../../src/modules/workflow/index.ts";
import type { ModuleRuntime } from "../../../../src/modules/types.ts";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
import { createFakeV2Context } from "../../_fake-v2-context.ts";

const roots: string[] = [];
function tempRoot(prefix = "memory-gate-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** workflow 與 memory 兩個模組註冊在同一個假 context 上。 */
async function setup(options: { globalDir?: string } = {}) {
  const root = tempRoot();
  const globalDir = options.globalDir === "same" ? root : (options.globalDir ?? tempRoot("memory-gate-global-"));
  const fake = createFakeV2Context({ directory: root, sessionDirectory: root, options: { globalDir } });
  const runtime: ModuleRuntime = { ctx: fake.ctx, settings: DEFAULT_SETTINGS };
  const registrations = [await workflowModule.register(runtime), await memoryModule.register(runtime)];
  const call = async (name: string, input: Record<string, unknown>, agent = "build"): Promise<any> => {
    const result = await fake.added.get(name).execute(input, { sessionID: "s1", agent });
    return JSON.parse(result.content);
  };
  const dispose = async () => {
    for (const registration of registrations) await registration?.dispose();
  };
  return { root, globalDir, call, dispose };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function createArchivingTask(env: Setup, taskId: string, risk?: "high") {
  await env.call("task-state-sync", {
    event: "create", taskId, to: "NEW", title: "測試任務", owner: "build", priority: "medium", ...(risk ? { risk } : {}),
  });
  for (const [from, to] of [["NEW", "PLANNED"], ["PLANNED", "IN_PROGRESS"], ["IN_PROGRESS", "REVIEWING"]]) {
    await env.call("task-state-sync", { event: "transition", taskId, from, to });
  }
  if (risk === "high") await env.call("task-state-sync", { event: "review", taskId, verdict: "approve", reviewer: "momus" });
  const archived = await env.call("task-state-sync", { event: "transition", taskId, from: "REVIEWING", to: "ARCHIVING" });
  expect(archived.ok).toBe(true);
}

const TOPIC = {
  layer: "project", topic: "release-checks", op: "create", title: "發布檢查", description: "發布前要跑的檢查",
  type: "decision", body: "發布前跑完整測試。\n", mode: "apply",
};

describe("記憶結案檢查：完整流程", () => {
  test("memorizer 寫入並宣告 recorded 之後可以結案，history 記下處置", async () => {
    const env = await setup();
    await createArchivingTask(env, "t1");
    expect((await env.call("memory-write", { ...TOPIC, taskId: "t1" }, "memorizer")).ok).toBe(true);
    const closed = await env.call("memory-task-close", { taskId: "t1", outcome: "recorded" }, "memorizer");
    expect(closed.ok).toBe(true);
    const completed = await env.call("task-state-sync", { event: "complete", taskId: "t1" });
    expect(completed.ok).toBe(true);
    const registry = JSON.parse(readFileSync(join(env.root, ".ultrawork/tasks.json"), "utf8"));
    expect(registry.tasks.t1.history.at(-1)).toContain(`memory=recorded#${closed.data.seq}`);
    await env.dispose();
  });

  test("低風險任務由主代理宣告 none 就能結案", async () => {
    const env = await setup();
    await createArchivingTask(env, "t1");
    expect((await env.call("memory-task-close", { taskId: "t1", outcome: "none", reason: "只改了測試名稱，沒有新知識" })).ok).toBe(true);
    expect((await env.call("task-state-sync", { event: "complete", taskId: "t1" })).ok).toBe(true);
    await env.dispose();
  });

  test("沒有處置時擋下，blockedBy 帶 memory", async () => {
    const env = await setup();
    await createArchivingTask(env, "t1");
    const blocked = await env.call("task-state-sync", { event: "complete", taskId: "t1" });
    expect(blocked.code).toBe("MEMORY_DISPOSITION_REQUIRED");
    expect(blocked.data.blockedBy).toEqual(["memory"]);
    await env.dispose();
  });
});

describe("記憶結案檢查：各條規則", () => {
  test("高風險任務：主代理不能宣告 none；log 裡非 writer 的處置在 complete 被擋", async () => {
    const env = await setup();
    await createArchivingTask(env, "t1", "high");
    expect((await env.call("memory-task-close", { taskId: "t1", outcome: "none", reason: "沒有值得保留的新知識" })).code).toBe("WRITER_REQUIRED");
    // 繞過工具直接寫進 log 的處置，complete 也要擋下。
    const layer = memoryLayer(env.root);
    await withMemoryLock(layer, () =>
      appendLog(layer, [{ kind: "disposition", taskId: "t1", outcome: "none", reason: "沒有值得保留的新知識", agent: "build", sessionID: "s1" }]),
    );
    expect((await env.call("task-state-sync", { event: "complete", taskId: "t1" })).code).toBe("MEMORY_WRITER_REQUIRED");
    await env.dispose();
  });

  test("處置早於進入 ARCHIVING 的時間 → MEMORY_DISPOSITION_STALE", async () => {
    const env = await setup();
    await createArchivingTask(env, "t1");
    await env.call("memory-task-close", { taskId: "t1", outcome: "none", reason: "沒有值得保留的新知識" });
    // 模擬「處置寫完之後任務才重新進入收尾」：把 archivingAt 推到處置之後。
    const path = join(env.root, ".ultrawork/tasks.json");
    const registry = JSON.parse(readFileSync(path, "utf8"));
    registry.tasks.t1.archivingAt = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(path, JSON.stringify(registry, null, 2));
    expect((await env.call("task-state-sync", { event: "complete", taskId: "t1" })).code).toBe("MEMORY_DISPOSITION_STALE");
    await env.dispose();
  });

  test("升級前就在收尾的任務（沒有 archivingAt）配 legacy-receipt 處置可以結案", async () => {
    const env = await setup();
    await createArchivingTask(env, "t1");
    const path = join(env.root, ".ultrawork/tasks.json");
    const registry = JSON.parse(readFileSync(path, "utf8"));
    delete registry.tasks.t1.archivingAt;
    writeFileSync(path, JSON.stringify(registry, null, 2));
    const layer = memoryLayer(env.root);
    await withMemoryLock(layer, () =>
      appendLog(layer, [{ kind: "disposition", taskId: "t1", outcome: "legacy-receipt", legacyReceiptId: "receipt-t1", agent: "migration", sessionID: null }]),
    );
    expect((await env.call("task-state-sync", { event: "complete", taskId: "t1" })).ok).toBe(true);
    await env.dispose();
  });

  test("主題在工具外被改 → MEMORY_OUT_OF_BAND_EDIT；reseal 之後可以結案", async () => {
    const env = await setup();
    await createArchivingTask(env, "t1");
    await env.call("memory-write", { ...TOPIC, taskId: "t1" }, "memorizer");
    await env.call("memory-task-close", { taskId: "t1", outcome: "recorded" }, "memorizer");
    appendFileSync(join(env.root, ".ultrawork/memory/topics/release-checks.md"), "手改的一行\n");
    const blocked = await env.call("task-state-sync", { event: "complete", taskId: "t1" });
    expect(blocked.code).toBe("MEMORY_OUT_OF_BAND_EDIT");
    expect(blocked.summary).toContain("project/release-checks");
    expect((await env.call("memory-maintain", { mode: "reseal-log", reason: "已核對手改內容無誤" }, "memorizer")).ok).toBe(true);
    expect((await env.call("task-state-sync", { event: "complete", taskId: "t1" })).ok).toBe(true);
    await env.dispose();
  });

  test("處置之前的 log 有壞行不影響結案；處置之後的壞行會擋下", async () => {
    const env = await setup();
    await createArchivingTask(env, "t1");
    const logPath = join(env.root, ".ultrawork/memory/log.jsonl");
    await env.call("memory-note", { content: "第一筆筆記" });
    await env.call("memory-note", { content: "第二筆筆記" });
    // 在處置之前弄壞中間一行（尾端完好，所以不需要 reseal 也能繼續附加）：
    // 它不在「處置到尾端」的驗證範圍內，不該擋下這個任務。
    const lines = readFileSync(logPath, "utf8").split("\n");
    lines[0] = "{broken";
    writeFileSync(logPath, lines.join("\n"));
    expect((await env.call("memory-task-close", { taskId: "t1", outcome: "none", reason: "沒有值得保留的新知識" })).ok).toBe(true);
    expect((await env.call("task-state-sync", { event: "complete", taskId: "t1" })).ok).toBe(true);

    await createArchivingTask(env, "t2");
    await env.call("memory-task-close", { taskId: "t2", outcome: "none", reason: "沒有值得保留的新知識" });
    appendFileSync(logPath, "{broken\n");
    expect((await env.call("task-state-sync", { event: "complete", taskId: "t2" })).code).toBe("MEMORY_LOG_TAMPERED");
    await env.dispose();
  });

  test("記憶目錄是 symlink 時結案被擋下，回結構化錯誤而不是拋例外", async () => {
    const env = await setup();
    await createArchivingTask(env, "t1");
    const outside = tempRoot("memory-gate-outside-");
    symlinkSync(outside, join(env.root, ".ultrawork/memory"));
    const blocked = await env.call("task-state-sync", { event: "complete", taskId: "t1" });
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("MEMORY_DISPOSITION_REQUIRED");
    await env.dispose();
  });
});

describe("記憶結案檢查：兩層", () => {
  test("寫在全域層的主題被工具外修改，錯誤指出 global/<主題>", async () => {
    const env = await setup();
    await createArchivingTask(env, "t1");
    await env.call("memory-write", { ...TOPIC, layer: "global", topic: "writing-style", taskId: "t1" }, "memorizer");
    await env.call("memory-task-close", { taskId: "t1", outcome: "recorded" }, "memorizer");
    appendFileSync(join(env.globalDir, ".ultrawork/memory/topics/writing-style.md"), "手改\n");
    const blocked = await env.call("task-state-sync", { event: "complete", taskId: "t1" });
    expect(blocked.code).toBe("MEMORY_OUT_OF_BAND_EDIT");
    expect(blocked.summary).toContain("global/writing-style");
    await env.dispose();
  });

  test("專案根目錄就是全域設定資料夾：兩層視為一層，log 只有一份", async () => {
    const env = await setup({ globalDir: "same" });
    await createArchivingTask(env, "t1");
    const written = await env.call("memory-write", { ...TOPIC, layer: "global", taskId: "t1" }, "memorizer");
    expect(written.data.layer).toBe("project");
    const closed = await env.call("memory-task-close", { taskId: "t1", outcome: "recorded" }, "memorizer");
    expect(closed.data.refs).toEqual([{ layer: "project", seq: written.data.seq }]);
    expect((await env.call("task-state-sync", { event: "complete", taskId: "t1" })).ok).toBe(true);
    await env.dispose();
  });
});

describe("遷移細節", () => {
  test("overview 主題的正文不重複 H1 標題", async () => {
    const { splitLegacyMemory } = await import("../../../../src/migrate/memory-store.ts");
    const [overview] = splitLegacyMemory("---\nlimit: 7000\n---\n\n# 專案設定\n\n前言內容\n\n## 規則\n內容\n");
    expect(overview!.topic).toBe("overview");
    expect(overview!.title).toBe("專案設定");
    expect(overview!.body).toBe("前言內容\n");
  });

  test("遷移時記憶目錄不存在也能建立（mkdir 在鎖之前）", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".ultrawork"));
    writeFileSync(join(root, ".ultrawork/project.md"), "# P\n\n## 規則\n一條規則\n");
    const { ensureMemoryStoreMigrated } = await import("../../../../src/migrate/memory-store.ts");
    expect(await ensureMemoryStoreMigrated(root)).toBe(true);
  });
});
