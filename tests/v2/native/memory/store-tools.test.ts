import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryWriteTool } from "../../../../src/modules/memory/tools/memory-write.ts";
import { createMemoryReadTool } from "../../../../src/modules/memory/tools/memory-read.ts";
import { createMemoryNoteTool } from "../../../../src/modules/memory/tools/memory-note.ts";
import { createMemoryTaskCloseTool } from "../../../../src/modules/memory/tools/memory-task-close.ts";
import { createMemoryMaintainTool } from "../../../../src/modules/memory/tools/memory-maintain.ts";
import { createMemoryExtractTool } from "../../../../src/modules/memory/tools/memory-extract.ts";
import { verifyTaskDisposition } from "../../../../src/modules/memory/disposition.ts";
import type { MemoryToolDeps } from "../../../../src/modules/memory/tools/shared.ts";
const roots: string[] = [];
function setup(risk = "low") {
  const root = mkdtempSync(join(tmpdir(), "memory-tools-"));
  roots.push(root);
  const deps: MemoryToolDeps = {
    resolveRoot: async () => root,
    globalRoot: root,
    writerAgents: ["memorizer"],
    taskMaterials: async (id) =>
      id === "task" ? { task: { taskId: id, state: "ARCHIVING", risk, title: "測試" } } : null,
  };
  return {
    root,
    deps,
    write: createMemoryWriteTool(deps),
    read: createMemoryReadTool(deps),
    note: createMemoryNoteTool(deps),
    close: createMemoryTaskCloseTool(deps),
    maintain: createMemoryMaintainTool(deps),
    extract: createMemoryExtractTool(deps),
  };
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const input = {
  layer: "project",
  topic: "checks",
  op: "create",
  title: "測試",
  description: "驗證功能",
  type: "decision",
  body: "每次執行測試",
  taskId: "task",
  mode: "apply",
};
async function call(
  tool: ReturnType<typeof createMemoryWriteTool>,
  input: unknown,
  agent: string | undefined = "memorizer",
) {
  const result = JSON.parse((await tool.execute(input, { sessionID: "s", agent })).content);
  return { ...result.data, ok: result.ok, code: result.code };
}
test("工具預覽不寫檔，非 writer 與無 agent 拒絕，寫入讀回與 SHA 衝突", async () => {
  const x = setup();
  expect((await call(x.write, input, "build")).code).toBe("WRITER_REQUIRED");
  expect((await call(x.write, input, "")).code).toBe("WRITER_REQUIRED");
  expect((await call(x.write, { ...input, mode: "preview" })).issues).toEqual([]);
  const created = await call(x.write, input);
  expect(created.ok).toBe(true);
  const read = await call(x.read, { layer: "project", topic: "checks" }, "build");
  expect(read.sha256).toBe(created.sha256);
  expect((await call(x.write, { ...input, op: "update", expectedSha256: "stale" })).code).toBe("SHA_MISMATCH");
  expect((await call(x.write, { ...input, op: "verify", expectedSha256: read.sha256 })).ok).toBe(true);
});
test("log 尾端損壞時 apply 回復主題與索引", async () => {
  const x = setup();
  const created = await call(x.write, input);
  const path = join(x.root, ".ultrawork/memory/topics/checks.md"),
    before = readFileSync(path, "utf8");
  appendFileSync(join(x.root, ".ultrawork/memory/log.jsonl"), "broken\n");
  expect((await call(x.write, { ...input, op: "update", expectedSha256: created.sha256, body: "新內容" })).code).toBe(
    "MEMORY_LOG_WRITE_FAILED",
  );
  expect(readFileSync(path, "utf8")).toBe(before);
});
test("recorded 可結案，工具外修改被擋，reseal 復原但保留引用檢查", async () => {
  const x = setup("high");
  await call(x.write, input);
  await call(x.close, { taskId: "task", outcome: "recorded" });
  const verify = () =>
    verifyTaskDisposition({
      projectRoot: x.root,
      globalMemoryRoot: x.root,
      task: { taskId: "task", risk: "high" },
      writerAgents: ["memorizer"],
    });
  expect(verify().ok).toBe(true);
  const path = join(x.root, ".ultrawork/memory/topics/checks.md");
  appendFileSync(path, "手改");
  expect(verify()).toMatchObject({ ok: false, code: "MEMORY_OUT_OF_BAND_EDIT" });
  appendFileSync(join(x.root, ".ultrawork/memory/log.jsonl"), "broken\n");
  expect(verify()).toMatchObject({ ok: false, code: "MEMORY_LOG_TAMPERED" });
  expect((await call(x.maintain, { mode: "reseal-log", reason: "已核對目前內容" })).ok).toBe(true);
  expect(verify().ok).toBe(true);
});
test("none 高風險權限、理由、與已有寫入衝突", async () => {
  const x = setup("high");
  expect(
    (await call(x.close, { taskId: "task", outcome: "none", reason: "這次沒有值得保留的內容" }, "build")).code,
  ).toBe("WRITER_REQUIRED");
  expect((await call(x.close, { taskId: "task", outcome: "none", reason: "短" })).code).toBe("REASON_REQUIRED");
  expect((await call(x.close, { taskId: "missing", outcome: "none" })).code).toBe("TASK_NOT_FOUND");
  await call(x.write, input);
  expect((await call(x.close, { taskId: "task", outcome: "none", reason: "這次沒有值得保留的內容" })).code).toBe(
    "DISPOSITION_CONFLICT",
  );
});
test("筆記 secret 不回顯、消費後不再列為 pending，extract 限 writer", async () => {
  const x = setup();
  expect((await call(x.note, { content: "sk-" + "x".repeat(32) }, "build")).code).toBe("SECRET_DETECTED");
  const note = await call(x.note, { content: "下次發布要先查版本", taskId: "task" }, "build");
  expect((await call(x.extract, { taskId: "task" }, "build")).code).toBe("WRITER_REQUIRED");
  expect((await call(x.extract, { taskId: "task" })).taskNotes).toHaveLength(1);
  await call(x.write, { ...input, consumesNotes: [note.seq] });
  expect((await call(x.extract, { taskId: "task" })).pendingNotes).toHaveLength(0);
});

describe("memory-write 不收計畫 ID、任務 ID 和夾在正文裡的 frontmatter", () => {
  const ctx = { agent: "memorizer", sessionID: "s1" } as never;
  async function run(tool: { execute: (input: never, context: never) => Promise<{ content: string }> }, value: Record<string, unknown>) {
    return JSON.parse((await tool.execute(value as never, ctx)).content);
  }

  test("標題、description 或正文裡有已登記的任務 ID 就拒絕；來源由工具記在 source", async () => {
    const env = setup();
    env.deps.knownWorkflowIds = async () => ["economy-review-03"];
    const write = createMemoryWriteTool(env.deps);
    for (const field of ["title", "description", "body"]) {
      const rejected = await run(write, { ...input, [field]: `${(input as Record<string, unknown>)[field]}（economy-review-03 的審查）` });
      expect(rejected.ok, field).toBe(false);
      expect(JSON.stringify(rejected), field).toContain("WORKFLOW_ID_IN_MEMORY");
    }
    const accepted = await run(write, input);
    expect(accepted.ok).toBe(true);
    expect(readFileSync(join(env.root, ".ultrawork/memory/topics/checks.md"), "utf8")).toContain('source: "task:task"');
  });

  test("正文開頭夾了一份 frontmatter 就拒絕，不讓它被寫成正文", async () => {
    const env = setup();
    const body = '---\ntitle: "測試"\ndescription: "驗證功能"\ntype: "decision"\n---\n\n每次執行測試';
    const rejected = await run(env.write, { ...input, body });
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(rejected)).toContain("INVALID_TOPIC_FORMAT");
  });
});
