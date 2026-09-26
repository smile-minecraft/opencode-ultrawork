import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkOrderStore } from "../../../../src/modules/workflow/tools/work-order-store.ts";
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

describe("workflow V2 hooks", () => {
  test("execute.before 展開代號並修正 heading 層級", async () => {
    const fake = await setupWorkflow(await tempRoot());
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
    const fake = await setupWorkflow(await tempRoot());
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
    const fake = await setupWorkflow(await tempRoot());
    const input = { agent: "debugger", prompt: "### 1. Task Identity\n只有一節" };
    await expect(fake.toolHooks.get("execute.before")!({
      tool: "subagent", sessionID: "s1", input,
    })).rejects.toThrow();
    expect(input.prompt).toBe("### 1. Task Identity\n只有一節");
    await fake.registration?.dispose();
  });

  test("Ultra-Coder 依 session 事件的 agent 核對兩次標準路徑", async () => {
    const fake = await setupWorkflow(await tempRoot(), undefined, {
      events: [
        { type: "session.created", data: { sessionID: "ses_attempt1", parentID: "s1", agent: "implementer" } },
        { type: "session.created", data: { sessionID: "ses_attempt2", parentID: "s1", agent: "debugger" } },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const built = await callTool(fake, "work-order-build", {
      ...validWorkOrder(),
      knownEvidence: "ses_attempt1 與 ses_attempt2 都已親自嘗試並失敗。",
    });
    const input = { agent: "ultra-coder", prompt: built.data.workOrderRef };
    await fake.toolHooks.get("execute.before")!({ tool: "subagent", sessionID: "s1", input });
    expect(input.prompt).toContain("ses_attempt1");
    await fake.registration?.dispose();
  });

  test.each([
    {
      name: "兩次都是錯誤 agent",
      evidence: "ses_wrong1 與 ses_wrong2 都已嘗試。",
      events: [
        { type: "session.created", data: { sessionID: "ses_wrong1", parentID: "s1", agent: "explore" } },
        { type: "session.created", data: { sessionID: "ses_wrong2", parentID: "s1", agent: "writer" } },
      ],
      message: "它是 explore，不是 Implementer 或 Debugger",
    },
    {
      name: "parent 不符",
      evidence: "ses_other1 與 ses_wrong3 都已嘗試。",
      events: [
        { type: "session.created", data: { sessionID: "ses_other1", parentID: "s2", agent: "implementer" } },
        { type: "session.created", data: { sessionID: "ses_wrong3", parentID: "s2", agent: "debugger" } },
      ],
      message: "不是從目前這個工作階段派出去的",
    },
    {
      name: "工作階段不存在",
      evidence: "ses_missing1 與 ses_missing2 都已嘗試。",
      events: [],
      message: "查不到這個工作階段",
    },
    {
      name: "非標準角色",
      evidence: "ses_nonstandard1 與 ses_nonstandard2 都已嘗試。",
      events: [
        { type: "session.created", data: { sessionID: "ses_nonstandard1", parentID: "s1", agent: "ultra-coder" } },
        { type: "session.created", data: { sessionID: "ses_nonstandard2", parentID: "s1", agent: "momus" } },
      ],
      message: "不是 Implementer 或 Debugger",
    },
  ])("Ultra-Coder 阻擋：$name", async ({ evidence, events, message }) => {
    const fake = await setupWorkflow(await tempRoot(), undefined, { events });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const built = await callTool(fake, "work-order-build", {
      ...validWorkOrder(),
      knownEvidence: evidence,
    });
    const input = { agent: "ultra-coder", prompt: built.data.workOrderRef };
    await expect(fake.toolHooks.get("execute.before")!({
      tool: "subagent", sessionID: "s1", input,
    })).rejects.toThrow(message);
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
