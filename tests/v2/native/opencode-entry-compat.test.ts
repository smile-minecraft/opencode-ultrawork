/** 正式入口相容：default plugin／setupUltrawork 經薄接入走到同一核心。 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { setupUltrawork } from "../../../src/index.ts";
import { EXPECTED_TOOL_NAMES, HOOK_NAMES } from "../../../src/modules/diagnostics/inventory.ts";
import { MEMORY_MARKER } from "../../../src/modules/memory/snapshot.ts";
import { SessionStateStore } from "../../../src/state/store.ts";
import { createWorkOrderStore } from "../../../src/modules/workflow/tools/work-order-store.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../_fake-v2-context.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempDirs() {
  const projectDir = mkdtempSync(join(tmpdir(), "uw-entry-project-"));
  const globalDir = mkdtempSync(join(tmpdir(), "uw-entry-global-"));
  roots.push(projectDir, globalDir);
  return { projectDir, globalDir };
}

async function callEntryTool(
  fake: ReturnType<typeof createFakeV2Context>,
  name: string,
  input: Record<string, unknown> = {},
  sessionID = "s1",
  agent?: string,
): Promise<any> {
  const definition = fake.added.get(name);
  if (!definition) throw new Error(`正式入口沒有註冊工具：${name}`);
  const execution = { ...fakeV2ToolContext(sessionID), ...(agent !== undefined ? { agent } : {}) };
  const raw = await definition.execute(input, execution);
  const parsed = JSON.parse((raw as { content: string }).content) as Record<string, unknown>;
  // 跟診斷測試同一做法：data 內的欄位以 getter 掛到外層，外框照舊可斷言。
  const data = parsed.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (!(key in parsed)) {
        Object.defineProperty(parsed, key, { configurable: true, enumerable: false, value });
      }
    }
  }
  return parsed;
}

/** 把同一相位的多個註冊回呼都收下來（假 context 同名會覆蓋，只看 map 會漏）。 */
function collectHooks(fake: ReturnType<typeof createFakeV2Context>) {
  const toolBefore: Array<(event: any) => unknown> = [];
  const toolAfter: Array<(event: any) => unknown> = [];
  const context: Array<(event: any) => unknown> = [];
  const compaction: Array<(event: any) => unknown> = [];
  const originalToolHook = fake.ctx.tool.hook.bind(fake.ctx.tool);
  const originalSessionHook = fake.ctx.session.hook.bind(fake.ctx.session);
  fake.ctx.tool.hook = (async (name: string, callback: (event: any) => unknown) => {
    if (name === "execute.before") toolBefore.push(callback);
    if (name === "execute.after") toolAfter.push(callback);
    return originalToolHook(name, callback);
  }) as typeof fake.ctx.tool.hook;
  fake.ctx.session.hook = (async (name: string, callback: (event: any) => unknown) => {
    if (name === "context") context.push(callback);
    if (name === "compaction") compaction.push(callback);
    return originalSessionHook(name, callback);
  }) as typeof fake.ctx.session.hook;
  return { toolBefore, toolAfter, context, compaction };
}

describe("正式入口工具與 hook 接線", () => {
  test("註冊全部 49 工具（對照凍結清單）", async () => {
    const { projectDir, globalDir } = tempDirs();
    const fake = createFakeV2Context({ directory: projectDir });
    const cleanup = await setupUltrawork(fake.ctx, { projectDir, globalDir });
    try {
      expect([...fake.added.keys()].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
      expect(fake.added.size).toBe(49);
    } finally {
      await cleanup();
    }
  });

  test("六個 hook 面向全數接線（含 manifest 交叉比對）", async () => {
    const { projectDir, globalDir } = tempDirs();
    const fake = createFakeV2Context({
      directory: projectDir,
      tools: [{ id: "subagent", description: "派遣子代理" }],
    });
    const collected = collectHooks(fake);
    const cleanup = await setupUltrawork(fake.ctx, { projectDir, globalDir });
    try {
      // 正式入口註冊數：各相位回呼數量精確釘住（漏接一個又重複另一個時下限斷言抓不出來）。
      // manifest 的 wired 由設定推導；逐模組接線由各模組行為測試覆蓋；此處數量只釘住正式入口註冊數。
      expect(collected.toolBefore.length).toBe(2);
      expect(collected.toolAfter.length).toBe(1);
      expect(collected.context.length).toBe(3);
      expect(collected.compaction.length).toBe(1);
      // 假 map 至少留下一組（實際載入時各平台會逐一呼叫）。
      expect(fake.toolHooks.has("execute.before")).toBe(true);
      expect(fake.toolHooks.has("execute.after")).toBe(true);
      expect(fake.sessionHooks.has("context")).toBe(true);
      expect(fake.sessionHooks.has("compaction")).toBe(true);
      // tool.definition 以註冊效果驗證：49 工具都在。
      expect(fake.added.size).toBe(49);
      // manifest 交叉比對：數量與接線預估一致。
      const manifest = await callEntryTool(fake, "tool_hook_manifest");
      expect(manifest.ok).toBe(true);
      expect(manifest.toolCount).toBe(49);
      expect(manifest.hookCount).toBe(6);
      expect(manifest.sourceCount).toBe(41);
      expect(manifest.hooks.map((hook: any) => hook.name).sort()).toEqual([...HOOK_NAMES].sort());
      expect(manifest.hooks.every((hook: any) => hook.wired === true)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("default plugin 經同一條路註冊（id 與 setup 一致）", async () => {
    const { projectDir, globalDir } = tempDirs();
    expect(plugin.id).toBe("ultrawork");
    const fake = createFakeV2Context({ directory: projectDir });
    // default plugin 的 setup 不帶 overrides，走共用暫存全域目錄隔離真實家目錄。
    const cleanup = await plugin.setup(fake.ctx);
    try {
      expect([...fake.added.keys()].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    } finally {
      await cleanup!();
    }
    expect(projectDir).toContain("uw-entry-project-");
    expect(globalDir).toContain("uw-entry-global-");
  });
});

describe("正式入口子代理指引經適配器生效", () => {
  test("subagent 描述含七節指引標記", async () => {
    const { projectDir, globalDir } = tempDirs();
    const fake = createFakeV2Context({
      directory: projectDir,
      tools: [{ id: "subagent", description: "派遣子代理" }],
    });
    const cleanup = await setupUltrawork(fake.ctx, { projectDir, globalDir });
    try {
      const entry = fake.registry.get("subagent") as { description?: unknown } | undefined;
      expect(entry).toBeDefined();
      const description = String(entry!.description ?? "");
      expect(description).toContain("<!-- uw-task-evidence-pack-guidance -->");
      expect(description).toContain("### 1. Task Identity");
      expect(description).toContain("### 7. Required Return");
    } finally {
      await cleanup();
    }
  });
});

describe("正式入口代表工具執行與可信身分", () => {
  test("回傳外框正確，未授權拒絕、授權後越過授權門", async () => {
    const { projectDir, globalDir } = tempDirs();
    const fake = createFakeV2Context({ directory: projectDir });
    const cleanup = await setupUltrawork(fake.ctx, {
      projectDir,
      globalDir,
      settings: { verification: { runAllowedAgents: ["momus"] } },
    });
    try {
      const denied = await callEntryTool(fake, "verification_run", { runner: "bun", script: "test" }, "s1", "intruder");
      expect(typeof denied.ok).toBe("boolean");
      expect(typeof denied.summary).toBe("string");
      expect(denied.data).toBeDefined();
      expect(denied.ok).toBe(false);
      expect(denied.code).toBe("AGENT_NOT_ALLOWED");

      // 授權身分越過授權門（後續是輸入驗證問題，不再是身分問題）。
      const passedGate = await callEntryTool(
        fake,
        "verification_run",
        { runner: "not-a-runner", script: "test" },
        "s1",
        "momus",
      );
      expect(passedGate.ok).toBe(false);
      expect(passedGate.code).not.toBe("AGENT_NOT_ALLOWED");
      expect(passedGate.code).toBe("RUNNER_NOT_SUPPORTED");
    } finally {
      await cleanup();
    }
  });

  test("缺少可信工作階段身分時適配器直接拒絕", async () => {
    const { projectDir, globalDir } = tempDirs();
    const fake = createFakeV2Context({ directory: projectDir });
    const cleanup = await setupUltrawork(fake.ctx, { projectDir, globalDir });
    try {
      const definition = fake.added.get("comment_signal_policy");
      let message = "";
      try {
        await definition.execute({}, {} as never);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("宿主未提供可信的工作階段身分");
    } finally {
      await cleanup();
    }
  });
});

describe("正式入口提示與壓縮相容", () => {
  test("context 注入專案段與記憶標記且不重複", async () => {
    const { projectDir, globalDir } = tempDirs();
    const fake = createFakeV2Context({ directory: projectDir, sessionDirectory: projectDir });
    const collected = collectHooks(fake);
    const cleanup = await setupUltrawork(fake.ctx, { projectDir, globalDir });
    try {
      const event = { sessionID: "s1", system: [] as Array<{ type: string; text: string }> };
      for (const hook of collected.context) await hook(event);
      const texts = event.system.map((part) => part.text);
      expect(texts.some((text) => text.includes("[ULTRAWORK CONTEXT]"))).toBe(true);
      expect(texts.some((text) => text.includes(MEMORY_MARKER))).toBe(true);
      expect(texts.some((text) => text.includes(".ultrawork/tasks.json"))).toBe(true);
      const sizeAfterFirst = event.system.length;
      for (const hook of collected.context) await hook(event);
      expect(event.system.length).toBe(sizeAfterFirst);
    } finally {
      await cleanup();
    }
  });

  test("compaction 只對已綁定工作階段提醒", async () => {
    const { projectDir, globalDir } = tempDirs();
    const fake = createFakeV2Context({ directory: projectDir, sessionDirectory: projectDir });
    const collected = collectHooks(fake);
    const cleanup = await setupUltrawork(fake.ctx, { projectDir, globalDir });
    try {
      const unbound = { sessionID: "s-unbound", system: [] as Array<{ type: string; text: string }> };
      for (const hook of collected.compaction) await hook(unbound);
      expect(unbound.system).toHaveLength(0);

      const created = await callEntryTool(
        fake,
        "task-state-sync",
        { event: "create", taskId: "t-bound", to: "NEW", title: "綁定測試", owner: "ultra", priority: "normal" },
        "s-bound",
      );
      expect(created.ok).toBe(true);
      const bound = { sessionID: "s-bound", system: [] as Array<{ type: string; text: string }> };
      for (const hook of collected.compaction) await hook(bound);
      expect(bound.system).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});

describe("正式入口事件迴圈清理", () => {
  test("session.deleted 經入口事件迴圈清掉該工作階段狀態且不影響其他工作階段", async () => {
    const { projectDir, globalDir } = tempDirs();
    const fake = createFakeV2Context({ directory: projectDir, sessionDirectory: projectDir });
    const store = new SessionStateStore(fake.ctx.storage);
    await store.setSession("s1", "draft", { text: "待清" });
    await store.setSession("s2", "draft", { text: "保留" });
    const workOrders = createWorkOrderStore(fake.ctx.storage);
    const workOrderId = await workOrders.save("完整工作說明", "s1");
    const otherWorkOrderId = await workOrders.save("另一個工作階段的說明", "s2");
    fake.events.push({ type: "session.deleted", data: { sessionID: "s1" } });

    const cleanup = await setupUltrawork(fake.ctx, { projectDir, globalDir });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(await store.getSession("s1", "draft")).toBeUndefined();
      expect(await store.getSession("s2", "draft")).toEqual({ text: "保留" });
      expect(await workOrders.resolve(`work-order:${workOrderId}`, "s1")).toEqual({
        kind: "not-found",
        id: workOrderId,
      });
      expect(await workOrders.resolve(`work-order:${otherWorkOrderId}`, "s2")).toMatchObject({ kind: "resolved" });
      const remaining = await store.scanSession("s1");
      expect(remaining.entries).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("正式入口卸載重載", () => {
  test("dispose 不拋錯，同一個假 context 再次 setup 仍可註冊與執行", async () => {
    const { projectDir, globalDir } = tempDirs();
    const fake = createFakeV2Context({
      directory: projectDir,
      tools: [{ id: "subagent", description: "派遣子代理" }],
    });
    const first = await setupUltrawork(fake.ctx, {
      projectDir,
      globalDir,
      settings: { verification: { runAllowedAgents: ["momus"] } },
    });
    await expect(first()).resolves.toBeUndefined();

    const second = await setupUltrawork(fake.ctx, {
      projectDir,
      globalDir,
      settings: { verification: { runAllowedAgents: ["momus"] } },
    });
    try {
      expect([...fake.added.keys()].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
      const denied = await callEntryTool(fake, "verification_run", { runner: "bun", script: "test" }, "s1", "intruder");
      expect(denied.code).toBe("AGENT_NOT_ALLOWED");
      const manifest = await callEntryTool(fake, "tool_hook_manifest");
      expect(manifest.toolCount).toBe(49);
      expect(manifest.hookCount).toBe(6);
    } finally {
      await second();
    }
  });
});

describe("正式入口路徑與 storage key 不變", () => {
  test("專案資料落 .ultrawork，工作說明 key 形狀維持 session/<id>/work-order/", async () => {
    const { projectDir, globalDir } = tempDirs();
    const fake = createFakeV2Context({ directory: projectDir, sessionDirectory: projectDir });
    const cleanup = await setupUltrawork(fake.ctx, { projectDir, globalDir });
    try {
      const created = await callEntryTool(
        fake,
        "task-state-sync",
        { event: "create", taskId: "t-path", to: "NEW", title: "路徑測試", owner: "ultra", priority: "normal" },
        "s1",
      );
      expect(created.ok).toBe(true);
      expect(existsSync(join(projectDir, ".ultrawork", "tasks.json"))).toBe(true);
      expect(existsSync(join(projectDir, ".opencode", "memory", "tasks.json"))).toBe(false);

      const built = await callEntryTool(
        fake,
        "work-order-build",
        {
          taskIdentity: "路徑測試任務",
          objective: "確認 key 形狀不變。",
          knownEvidence: "入口測試直接掃 storage。",
          constraints: "只讀 storage，不搬資料。",
          tddRequirements: "先固定行為再斷言。",
          acceptanceCriteria: ["key 形狀為 session/s1/work-order/"],
          requiredReturn: "回傳 key 與路徑證據。",
        },
        "s1",
      );
      expect(built.ok).toBe(true);
      const ref = String(built.data.workOrderRef);
      expect(ref.startsWith("work-order:")).toBe(true);
      const scan = await fake.ctx.storage.scan({ prefix: "session/s1/work-order/" });
      expect(scan.entries.length).toBeGreaterThanOrEqual(1);
      expect(scan.entries.every((entry: { key: string }) => entry.key.startsWith("session/s1/work-order/"))).toBe(true);
      const store = new SessionStateStore(fake.ctx.storage);
      expect(store.sessionKey("s1", "work-order/x")).toBe("session/s1/work-order/x");
    } finally {
      await cleanup();
    }
  });
});
