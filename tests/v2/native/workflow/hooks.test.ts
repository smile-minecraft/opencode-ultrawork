import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkOrderStore } from "../../../../src/modules/workflow/tools/work-order-store.ts";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
import { callTool, setupWorkflow, validWorkOrder } from "./_helpers.ts";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-workflow-hooks-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function gatedSettings() {
  return {
    ...DEFAULT_SETTINGS,
    workflow: {
      ...DEFAULT_SETTINGS.workflow,
      evidencePack: { gatedSubagents: ["implementer", "debugger", "ultra-coder"] },
    },
  };
}

describe("workflow V2 hooks", () => {
  test("預設空 gatedSubagents 時不執行七節檢查", async () => {
    const fake = await setupWorkflow(await tempRoot());
    const input = { agent: "implementer", prompt: "不是七節也允許" };
    await fake.toolHooks.get("execute.before")!({ tool: "subagent", sessionID: "s1", input });
    expect(input.prompt).toBe("不是七節也允許");
    await fake.registration?.dispose();
  });

  test("execute.before 展開代號並修正 heading 層級", async () => {
    const fake = await setupWorkflow(await tempRoot(), gatedSettings());
    const built = await callTool(fake, "work-order-build", validWorkOrder());
    const input = {
      agent: "implementer",
      prompt: built.data.workOrderRef,
    };
    const hook = fake.toolHooks.get("execute.before")!;
    await hook({ tool: "subagent", sessionID: "s1", input });
    expect(input.prompt).toContain("### 1. Task Identity");
    input.prompt = input.prompt.replace(/^### /gm, "## ");
    await hook({ tool: "subagent", sessionID: "s1", input });
    expect(input.prompt).toContain("### 1. Task Identity");
    expect(input.prompt).not.toMatch(/^## 1\. Task Identity/m);
    await fake.registration?.dispose();
  });

  test("代號四種解析結果：可展開、夾帶文字、找不到、其他工作階段", async () => {
    const fake = await setupWorkflow(await tempRoot());
    const built = await callTool(fake, "work-order-build", validWorkOrder());
    const hook = fake.toolHooks.get("execute.before")!;
    const resolved = { agent: "implementer", prompt: built.data.workOrderRef };
    await hook({ tool: "subagent", sessionID: "s1", input: resolved });
    expect(resolved.prompt).toContain("### 7. Required Return");

    const malformed = { agent: "implementer", prompt: `${built.data.workOrderRef} 額外文字` };
    await expect(hook({ tool: "subagent", sessionID: "s1", input: malformed })).rejects.toThrow(
      "subagent 的 prompt 夾帶了工作說明代號和其他文字。prompt 只能是 work-order-build 回傳的 workOrderRef 原文；要補內容請重新組裝。",
    );

    const missing = { agent: "implementer", prompt: "work-order:wo_missing_1234abcd" };
    await expect(hook({ tool: "subagent", sessionID: "s1", input: missing })).rejects.toThrow(
      "找不到工作說明 wo_missing_1234abcd：可能工作階段已不存在或已超過 24 小時。請重新呼叫 work-order-build 取得新的 workOrderRef。",
    );

    const wrongSession = { agent: "implementer", prompt: built.data.workOrderRef };
    await expect(hook({ tool: "subagent", sessionID: "s2", input: wrongSession })).rejects.toThrow(
      `工作說明 ${built.data.workOrderRef.slice("work-order:".length)} 是在其他工作階段組裝的，不能在這裡派遣。請在目前的工作階段重新呼叫 work-order-build。`,
    );
    await fake.registration?.dispose();
  });

  test("七節各種錯誤都擋下，非受控 agent 不受影響", async () => {
    const fake = await setupWorkflow(await tempRoot(), gatedSettings());
    const built = await callTool(fake, "work-order-build", validWorkOrder());
    const resolveInput = { agent: "implementer", prompt: built.data.workOrderRef };
    await fake.toolHooks.get("execute.before")!({ tool: "subagent", sessionID: "s1", input: resolveInput });
    const valid = String(resolveInput.prompt);
    const hook = fake.toolHooks.get("execute.before")!;
    const badCases = [
      valid.replace("### 2. Objective", "### 2. Wrong Name"),
      valid.replace("讓行為可觀察且可驗證。", ""),
      valid.replace("### 3. Known Evidence", "### 4. Known Evidence"),
      valid.replace("### 1. Task Identity\n", "### 1. Task Identity\n\n### 1. Task Identity\n重複\n"),
      valid.replace("- [ ] 目標測試通過", "沒有 checkbox"),
      valid.replace("### 7. Required Return\n", ""),
    ];
    for (const prompt of badCases) {
      const input = { agent: "implementer", prompt };
      await expect(hook({ tool: "subagent", sessionID: "s1", input })).rejects.toThrow("實作準備未通過");
      expect(input.prompt).toBe(prompt);
    }
    const nonGated = { agent: "explore", prompt: "不是七節也允許" };
    await hook({ tool: "subagent", sessionID: "s1", input: nonGated });
    expect(nonGated.prompt).toBe("不是七節也允許");
    await fake.registration?.dispose();
  });

  test("其他七節錯誤維持原 prompt 並擋下", async () => {
    const fake = await setupWorkflow(await tempRoot(), gatedSettings());
    const input = { agent: "debugger", prompt: "### 1. Task Identity\n只有一節" };
    await expect(fake.toolHooks.get("execute.before")!({
      tool: "subagent", sessionID: "s1", input,
    })).rejects.toThrow();
    expect(input.prompt).toBe("### 1. Task Identity\n只有一節");
    await fake.registration?.dispose();
  });

  test("ultra-coder 的合法七節工作說明不受升級紀錄限制", async () => {
    const fake = await setupWorkflow(await tempRoot(), gatedSettings());
    const built = await callTool(fake, "work-order-build", validWorkOrder());
    const input = { agent: "ultra-coder", prompt: built.data.workOrderRef };
    await fake.toolHooks.get("execute.before")!({ tool: "subagent", sessionID: "s1", input });
    expect(input.prompt).toContain("### 1. Task Identity");
    expect(input.prompt).not.toBe(built.data.workOrderRef);
    await fake.registration?.dispose();
  });

  test("session.created 與 session.updated 不讀寫升級紀錄", async () => {
    const legacy = { parentID: "old-parent", agent: "old-agent", createdAt: 123 };
    const fake = await setupWorkflow(await tempRoot(), gatedSettings(), {
      events: [
        { type: "session.created", data: { sessionID: "ses_legacy", parentID: "s1", agent: "implementer" } },
        { type: "session.updated", data: { sessionID: "ses_new", parentID: "s1", agent: "debugger" } },
      ],
      prepareStorage: async (storage) => {
        await storage.set("session/ses_legacy/escalation", legacy);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await fake.ctx.storage.get("session/ses_legacy/escalation")).toEqual(legacy);
    expect(await fake.ctx.storage.get("session/ses_new/escalation")).toBeUndefined();
    await fake.registration?.dispose();
  });

  test("審查指引不依賴角色檔路徑", async () => {
    const fake = await setupWorkflow(await tempRoot(), gatedSettings());
    const description = fake.added.get("task-state-sync").description as string;
    expect(description).toContain("approve（同意）、concerns（有疑慮）、reject（不同意）");
    expect(description).not.toContain("agents/momus.md");
    await fake.registration?.dispose();
  });

  test("七節錯誤訊息不依賴角色檔路徑", async () => {
    const fake = await setupWorkflow(await tempRoot(), gatedSettings());
    let message = "";
    try {
      await fake.toolHooks.get("execute.before")!({
        tool: "subagent",
        sessionID: "s1",
        input: { agent: "implementer", prompt: "不是七節" },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("實作準備未通過");
    expect(message).toContain("codes=[");
    expect(message).toContain("missing_or_empty=[");
    expect(message).toContain("example_heading=### 1. Task Identity");
    expect(message).toContain("issues=[");
    expect(message).not.toContain("template=agents/build.md");
    await fake.registration?.dispose();
  });

  test("session.deleted 清理工作說明代號", async () => {
    let ref = "";
    const fake = await setupWorkflow(await tempRoot(), undefined, {
      events: [{ type: "session.deleted", data: { sessionID: "s1" } }],
      prepareStorage: async (storage) => {
        const id = await createWorkOrderStore(storage).save("完整工作說明", "s1");
        ref = `work-order:${id}`;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(fake.toolHooks.get("execute.before")!({
      tool: "subagent",
      sessionID: "s1",
      input: { agent: "implementer", prompt: ref },
    })).rejects.toThrow("找不到工作說明");
    await fake.registration?.dispose();
  });

  test("context 只推固定專案段，compaction 只對已綁定工作階段提醒", async () => {
    const fake = await setupWorkflow(await tempRoot());
    const first = { sessionID: "s1", system: [] as any[] };
    await fake.sessionHooks.get("context")!(first);
    await callTool(fake, "task-state-sync", { event: "create", taskId: "t1", to: "NEW", title: "測試", owner: "ultra", priority: "normal" });
    const second = { sessionID: "s1", system: [] as any[] };
    await fake.sessionHooks.get("context")!(second);
    expect(first.system[0].text).toBe(second.system[0].text);
    expect(first.system[0].text).not.toContain("t1");

    const compaction = { sessionID: "s1", system: [] as any[] };
    await fake.sessionHooks.get("compaction")!(compaction);
    expect(compaction.system).toHaveLength(1);
    await fake.registration?.dispose();
  });
});

describe("實作說明 gate 的受控清單可由設定覆寫", () => {
  test("gatedSubagents 改成 custom-agent 時，只有它被檢查", async () => {
    const fake = await setupWorkflow(await tempRoot(), {
      ...DEFAULT_SETTINGS,
      workflow: {
        ...DEFAULT_SETTINGS.workflow,
        evidencePack: { gatedSubagents: ["custom-agent"] },
      },
    });
    const hook = fake.toolHooks.get("execute.before")!;
    const gated = { agent: "custom-agent", prompt: "亂寫的 prompt" };
    await expect(hook({ tool: "subagent", sessionID: "s1", input: gated })).rejects.toThrow(
      "實作準備未通過",
    );
    const ungated = { agent: "implementer", prompt: "亂寫的 prompt" };
    await hook({ tool: "subagent", sessionID: "s1", input: ungated });
    expect(ungated.prompt).toBe("亂寫的 prompt");
    await fake.registration?.dispose();
  });
});
