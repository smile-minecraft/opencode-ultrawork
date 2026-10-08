import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryLayer, memoryPath, withMemoryLock } from "../../../../src/modules/memory/layers.ts";
import { appendLog } from "../../../../src/modules/memory/log.ts";
import { verifyTaskDisposition } from "../../../../src/modules/memory/disposition.ts";
import { createMemorySnapshotStore, renderMemorySnapshot } from "../../../../src/modules/memory/snapshot.ts";
import { renderTopic, type TopicFrontmatter } from "../../../../src/modules/memory/topic.ts";
import { createMemoryExtractTool } from "../../../../src/modules/memory/tools/memory-extract.ts";
import { createMemoryMaintainTool } from "../../../../src/modules/memory/tools/memory-maintain.ts";
import { createMemoryNoteTool } from "../../../../src/modules/memory/tools/memory-note.ts";
import { createMemoryTaskCloseTool } from "../../../../src/modules/memory/tools/memory-task-close.ts";
import { createMemoryWriteTool } from "../../../../src/modules/memory/tools/memory-write.ts";
import type { MemoryToolDeps } from "../../../../src/modules/memory/tools/shared.ts";
import { createRuntimeContext } from "../../../../src/modules/workflow/runtime/context-builder.ts";
import { createEmptyTasksRegistryLeaf, normalizeTasksRegistryLeaf } from "../../../../src/modules/workflow/registry/task-registry.ts";
import type { Task } from "../../../../src/modules/workflow/core/types.ts";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
import { createFakeV2Context } from "../../_fake-v2-context.ts";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memory-writer-policy-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeDeps(root: string, writerAgents: readonly string[]): MemoryToolDeps {
  return {
    globalRoot: root,
    writerAgents,
    resolveRoot: async () => root,
    taskMaterials: async () => null,
  };
}

function toolsFor(deps: MemoryToolDeps) {
  return [
    createMemoryExtractTool(deps),
    createMemoryWriteTool(deps),
    createMemoryMaintainTool(deps),
    createMemoryTaskCloseTool(deps),
    createMemoryNoteTool(deps),
  ];
}

describe("記憶 writer 設定來源", () => {
  test("直接建立 runtime 時使用輸入的 writer 清單，不接受固定角色", async () => {
    const root = tempRoot();
    const project = { projectId: "writer-policy-test", projectPath: root };
    const writerAgents = ["agent-a"];
    const runtime = createRuntimeContext({
      input: { directory: root },
      options: { projectRoot: root },
      writerAgents,
      globalMemoryRoot: root,
      createEmptyTasksRegistry: (binding = project) => createEmptyTasksRegistryLeaf(binding),
      normalizeTasksRegistry: (raw, binding = project, protectedTaskIds) =>
        normalizeTasksRegistryLeaf(raw, binding, protectedTaskIds),
    });
    writerAgents.splice(0, writerAgents.length, "agent-b");

    const taskFor = (taskId: string): Task => {
      const archivingAt = new Date(Date.now() - 1_000).toISOString();
      return {
        taskId,
        projectId: project.projectId,
        projectPath: root,
        state: "ARCHIVING",
        owner: "build",
        priority: "high",
        risk: "high",
        archivingAt,
        updatedAt: archivingAt,
        history: [],
      };
    };

    const configuredTask = taskFor("configured-writer");
    await withMemoryLock(memoryLayer(root), () =>
      appendLog(memoryLayer(root), [
        {
          kind: "disposition",
          taskId: configuredTask.taskId,
          outcome: "none",
          reason: "沒有值得保留的新知識",
          agent: "agent-a",
          sessionID: "s1",
        },
      ]),
    );
    expect(
      runtime.validateMemoryDispositionForTask(configuredTask, runtime.getCurrentProject(), {
        sessionID: "s1",
        directory: root,
      }),
    ).toMatchObject({ ok: true });

    const unconfiguredTask = taskFor("unconfigured-writer");
    await withMemoryLock(memoryLayer(root), () =>
      appendLog(memoryLayer(root), [
        {
          kind: "disposition",
          taskId: unconfiguredTask.taskId,
          outcome: "none",
          reason: "沒有值得保留的新知識",
          agent: "memorizer",
          sessionID: "s1",
        },
      ]),
    );
    expect(
      runtime.validateMemoryDispositionForTask(unconfiguredTask, runtime.getCurrentProject(), {
        sessionID: "s1",
        directory: root,
      }),
    ).toMatchObject({ ok: false, code: "MEMORY_WRITER_REQUIRED" });
  });

  test("工具描述、拒絕訊息與注入指引都呈現多名 writer", async () => {
    const root = tempRoot();
    const deps = makeDeps(root, ["agent-a", "agent-b"]);
    const emptySnapshot = renderMemorySnapshot([memoryLayer(root)], undefined, deps.writerAgents);
    expect(emptySnapshot).toContain("agent-a");
    expect(emptySnapshot).toContain("agent-b");
    for (const tool of toolsFor(deps)) {
      expect(tool.description).toContain("agent-a");
      expect(tool.description).toContain("agent-b");
    }

    const denied = JSON.parse(
      (
        await createMemoryWriteTool(deps).execute(
          {
            layer: "project",
            topic: "policy-test",
            op: "create",
            title: "測試",
            description: "測試描述",
            type: "decision",
            body: "測試內容",
            mode: "apply",
          },
          { sessionID: "s1", agent: "agent-c" },
        )
      ).content,
    );
    expect(denied.code).toBe("WRITER_REQUIRED");
    expect(denied.data.error).toContain("agent-a");
    expect(denied.data.error).toContain("agent-b");

    await withMemoryLock(memoryLayer(root), () =>
      appendLog(memoryLayer(root), [
        {
          kind: "disposition",
          taskId: "blocked-task",
          outcome: "none",
          reason: "沒有值得保留的新知識",
          agent: "agent-c",
          sessionID: "s1",
        },
      ]),
    );
    const rejectedDisposition = verifyTaskDisposition({
      projectRoot: root,
      globalMemoryRoot: root,
      task: { taskId: "blocked-task", risk: "high" },
      writerAgents: deps.writerAgents,
    });
    expect(rejectedDisposition).toMatchObject({ ok: false, code: "MEMORY_WRITER_REQUIRED" });
    if (!rejectedDisposition.ok) {
      expect(rejectedDisposition.error).toContain("agent-a");
      expect(rejectedDisposition.error).toContain("agent-b");
    }

    const layer = memoryLayer(root);
    const frontmatter: TopicFrontmatter = {
      title: "政策測試",
      description: "測試注入指引",
      type: "decision",
      pinned: true,
      source: "manual",
      created: "2026-10-07T00:00:00.000Z",
      updated: "2026-10-07T00:00:00.000Z",
      verified_at: "",
    };
    mkdirSync(memoryPath(layer, "topics"), { recursive: true });
    writeFileSync(memoryPath(layer, "topics", "policy-test.md"), renderTopic(frontmatter, "記憶正文。"));
    const snapshot = renderMemorySnapshot([layer], undefined, deps.writerAgents);
    expect(snapshot).toContain("agent-a");
    expect(snapshot).toContain("agent-b");

    const store = createMemorySnapshotStore(createFakeV2Context({ directory: root }).ctx.storage);
    const first = await store("s1", async () => snapshot);
    const changedWriters = ["agent-c"];
    const reused = await store("s1", async () => renderMemorySnapshot([layer], undefined, changedWriters));
    expect(reused).toBe(first);
    expect(reused).toContain("agent-a");
    expect(reused).not.toContain("agent-c");
  });

  test("空 writer 清單明確指出設定 key，描述與錯誤不會留下破損文字", async () => {
    const root = tempRoot();
    expect(DEFAULT_SETTINGS.memory.writerAgents).toEqual([]);
    const deps = makeDeps(root, DEFAULT_SETTINGS.memory.writerAgents);
    const emptySnapshot = renderMemorySnapshot([memoryLayer(root)], undefined, deps.writerAgents);
    expect(emptySnapshot).toContain("memory.writerAgents");
    expect(emptySnapshot).toContain("目前沒有 agent 能寫入記憶");
    for (const tool of toolsFor(deps)) {
      expect(tool.description).toContain("memory.writerAgents");
      expect(tool.description).toContain("目前沒有 agent 能寫入記憶");
      expect(tool.description).not.toContain("只限 ，");
      expect(tool.description).not.toContain("僅限  使用");
    }

    const denied = JSON.parse(
      (
        await createMemoryWriteTool(deps).execute(
          {
            layer: "project",
            topic: "policy-test",
            op: "create",
            title: "測試",
            description: "測試描述",
            type: "decision",
            body: "測試內容",
            mode: "apply",
          },
          { sessionID: "s1", agent: "agent-a" },
        )
      ).content,
    );
    expect(denied.code).toBe("WRITER_REQUIRED");
    expect(denied.data.error).toContain("memory.writerAgents");

    await withMemoryLock(memoryLayer(root), () =>
      appendLog(memoryLayer(root), [
        {
          kind: "disposition",
          taskId: "blocked-empty-writer-task",
          outcome: "none",
          reason: "沒有值得保留的新知識",
          agent: "agent-a",
          sessionID: "s1",
        },
      ]),
    );
    const emptyDisposition = verifyTaskDisposition({
      projectRoot: root,
      globalMemoryRoot: root,
      task: { taskId: "blocked-empty-writer-task", risk: "high" },
      writerAgents: deps.writerAgents,
    });
    expect(emptyDisposition).toMatchObject({ ok: false, code: "MEMORY_WRITER_REQUIRED" });
    if (!emptyDisposition.ok) expect(emptyDisposition.error).toContain("memory.writerAgents");

    const layer = memoryLayer(root);
    const frontmatter: TopicFrontmatter = {
      title: "政策測試",
      description: "測試注入指引",
      type: "decision",
      pinned: true,
      source: "manual",
      created: "2026-10-07T00:00:00.000Z",
      updated: "2026-10-07T00:00:00.000Z",
      verified_at: "",
    };
    mkdirSync(memoryPath(layer, "topics"), { recursive: true });
    writeFileSync(memoryPath(layer, "topics", "policy-test.md"), renderTopic(frontmatter, "記憶正文。"));
    const snapshot = renderMemorySnapshot([layer], undefined, deps.writerAgents);
    expect(snapshot).toContain("memory.writerAgents");
    expect(snapshot).toContain("目前沒有 agent 能寫入記憶");
  });
});
