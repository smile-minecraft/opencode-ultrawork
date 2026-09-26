import { writeMemoryTopic } from "./_helpers.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTool, setupDiagnostics, writeMemoryFile } from "./_helpers.ts";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-diag-bootstrap-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 舊版 `10-bootstrap-modes.test.ts`：mode 參數規則與 refs 指向新資料層。 */
describe("workflow_bootstrap mode 參數規則", () => {
  test("預設（不傳 mode）回 minimal 摘要且不含 l1_content", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "workflow_bootstrap");
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("minimal");
    expect(r.l1_content).toBeUndefined();
    expect(r.l1_summary).toBeDefined();
    expect(r.registry_summary).toBeDefined();
    expect(r.project).toBeDefined();
    expect(typeof r.hint).toBe("string");
    expect(typeof r.l1_summary.memory_index_chars.project).toBe("number");
    expect(typeof r.l1_summary.state_md_size).toBe("number");
    await fake.registration?.dispose();
  });

  test("明確 mode='minimal' 同樣不含 l1_content", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "workflow_bootstrap", { mode: "minimal" });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("minimal");
    expect(r.l1_content).toBeUndefined();
    await fake.registration?.dispose();
  });

  test("mode='full' 同時回 project_md 與 state_md 全文", async () => {
    const root = await tempRoot();
    writeMemoryTopic(root, "---\nlabel: project\nlimit: 5000\n---\n# Project\n\nPROJECT_MARKER_FULL_MODE\n",
    );
    writeMemoryFile(
      root,
      "state.md",
      "---\nlabel: state\nlimit: 3000\n---\n# Project State\n\nSTATE_MARKER_FULL_MODE\n",
    );
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_bootstrap", { mode: "full" });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("full");
    expect(r.l1_content.memory_indexes?.project).toContain("fixture");
    expect(r.l1_content.state_md).toContain("STATE_MARKER_FULL_MODE");
    expect(r.l1_content.combined_chars).toBe(
      (r.l1_content.memory_indexes?.project ?? "").length + (r.l1_content.state_md ?? "").length,
    );
    await fake.registration?.dispose();
  });

  test("mode='project' 只回 project_md，state_md 為 null", async () => {
    const root = await tempRoot();
    writeMemoryTopic(root, "---\nlabel: project\nlimit: 5000\n---\n# Project\n\nPROJECT_ONLY_MARKER\n",
    );
    writeMemoryFile(
      root,
      "state.md",
      "---\nlabel: state\nlimit: 3000\n---\n# Project State\n\nSHOULD_NOT_APPEAR\n",
    );
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_bootstrap", { mode: "project" });
    expect(r.ok).toBe(true);
    expect(r.l1_content.memory_indexes?.project).toContain("fixture");
    expect(r.l1_content.state_md).toBeNull();
    await fake.registration?.dispose();
  });

  test("mode='state' 只回 state_md，project_md 為 null", async () => {
    const root = await tempRoot();
    writeMemoryTopic(root, "---\nlabel: project\nlimit: 5000\n---\n# Project\n\nSHOULD_NOT_APPEAR_PROJECT\n",
    );
    writeMemoryFile(
      root,
      "state.md",
      "---\nlabel: state\nlimit: 3000\n---\n# Project State\n\nSTATE_ONLY_MARKER\n",
    );
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_bootstrap", { mode: "state" });
    expect(r.ok).toBe(true);
    expect(r.l1_content.state_md).toContain("STATE_ONLY_MARKER");
    expect(r.l1_content.memory_indexes).toBeNull();
    await fake.registration?.dispose();
  });

  test("minimal 模式在檔案很大時仍只回大小，不展開內容", async () => {
    const root = await tempRoot();
    const projectMd = "---\nlabel: project\nlimit: 5000\n---\n# Project\n\n" + "x".repeat(50_000) + "\n";
    const stateMd = "---\nlabel: state\nlimit: 3000\n---\n# Project State\n\n" + "y".repeat(50_000) + "\n";
    writeMemoryTopic(root, projectMd);
    writeMemoryFile(root, "state.md", stateMd);
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_bootstrap");
    expect(r.ok).toBe(true);
    expect(r.l1_content).toBeUndefined();
    expect(r.l1_summary.memory_index_chars.project).toBeLessThan(projectMd.length);
    expect(r.l1_summary.state_md_size).toBe(stateMd.length);
    await fake.registration?.dispose();
  });
});

describe("workflow_bootstrap 資料層路徑", () => {
  test("refs 指向 .ultrawork/ 新資料層，不是舊的 .opencode/memory/", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "workflow_bootstrap");
    expect(r.registry_summary.refs).toEqual({
      tasks: ".ultrawork/tasks.json",
      plans: ".ultrawork/plans.json",
      state: ".ultrawork/state.md",
      project: ".ultrawork/memory/MEMORY.md",
    });
    await fake.registration?.dispose();
  });

  test("project.memoryDir 解析到 <root>/.ultrawork/", async () => {
    const root = await tempRoot();
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_bootstrap");
    expect(r.project.memoryDir).toBe(join(root, ".ultrawork"));
    expect(r.project.projectPath).toBe(root);
    await fake.registration?.dispose();
  });

  test("有游標任務時回摘要；游標不在進行中清單則退回第一個", async () => {
    const root = await tempRoot();
    const { writeTasksRegistry } = await import("./_helpers.ts");
    writeTasksRegistry(root, { taskId: "t-1", title: "第一個", state: "IN_PROGRESS" });
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_bootstrap");
    expect(r.registry_summary.currentTask.taskId).toBe("t-1");
    expect(r.registry_summary.currentTask.state).toBe("IN_PROGRESS");
    expect(r.registry_summary.counts.active_tasks).toBe(1);
    expect(r.registry_summary.finishedTaskLimit).toBe(5);
    expect(r.registry_summary.finishedPlanLimit).toBe(5);
    await fake.registration?.dispose();
  });
});
