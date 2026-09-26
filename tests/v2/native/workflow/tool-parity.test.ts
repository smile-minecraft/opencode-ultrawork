import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeV2ToolContext } from "../../_fake-v2-context.ts";
import { callTool, setupWorkflow } from "./_helpers.ts";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-workflow-parity-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function schemaOf(fake: Awaited<ReturnType<typeof setupWorkflow>>, name: string) {
  return fake.added.get(name).input as {
    type: string;
    required?: string[];
    properties: Record<string, { enum?: string[]; type?: string; minLength?: number }>;
  };
}

describe("workflow 工具介面 parity", () => {
  test("task-state-sync 與 plan-state-sync 欄位及 enum 沿用舊版", async () => {
    const fake = await setupWorkflow(await tempRoot());
    const task = schemaOf(fake, "task-state-sync");
    expect(task.type).toBe("object");
    expect(task.required).toEqual(["event"]);
    expect(Object.keys(task.properties)).toEqual([
      "event", "taskId", "title", "from", "to", "owner", "priority", "reason",
      "projectId", "projectPath", "risk", "verdict", "reviewer",
      "note", "acceptance", "verbose",
    ]);
    expect(task.properties.event.enum).toEqual(["create", "transition", "complete", "cancel", "fail", "block", "review", "status"]);
    expect(task.properties.acceptance.type).toBe("array");

    const plan = schemaOf(fake, "plan-state-sync");
    expect(plan.required).toEqual(["event"]);
    expect(Object.keys(plan.properties)).toEqual([
      "event", "planId", "title", "from", "to", "owner", "priority", "reason", "projectId", "projectPath",
    ]);
    expect(plan.properties.event.enum).toEqual(["create", "transition", "complete", "cancel", "fail", "block", "status", "resume"]);
    await fake.registration?.dispose();
  });

  test("work-order-build 保留七節欄位與舊版 required 集合", async () => {
    const fake = await setupWorkflow(await tempRoot());
    const schema = schemaOf(fake, "work-order-build");
    expect(Object.keys(schema.properties)).toEqual([
      "taskIdentity", "objective", "knownEvidence", "constraints", "tddRequirements",
      "acceptanceCriteria", "taskId", "requiredReturn",
    ]);
    expect(schema.required).toEqual([
      "taskIdentity", "objective", "knownEvidence", "constraints", "tddRequirements", "requiredReturn",
    ]);
    expect(schema.properties.taskIdentity.minLength).toBe(1);
    await fake.registration?.dispose();
  });

  test("plan-content-create 保留 planId 必填與 preview/apply 參數", async () => {
    const fake = await setupWorkflow(await tempRoot());
    const schema = schemaOf(fake, "plan-content-create");
    expect(Object.keys(schema.properties)).toEqual(["planId", "title", "content", "overwrite", "mode", "expectedSha256"]);
    expect(schema.required).toEqual(["planId"]);
    expect(schema.properties.mode.enum).toEqual(["preview", "apply"]);
    await fake.registration?.dispose();
  });

  test("其餘 9 個工具 schema 欄位、required 與 enum 完整覆蓋", async () => {
    const fake = await setupWorkflow(await tempRoot());
    const expected: Record<string, { required: string[]; properties: string[]; enums?: Record<string, string[]> }> = {
      "task-content-read": { required: ["taskId"], properties: ["taskId", "source", "grep", "regex", "context", "maxMatches"], enums: { source: ["section", "file"] } },
      "task-content-update": { required: ["taskId", "content"], properties: ["taskId", "content", "source", "op", "mode", "planId", "expectedSha256"], enums: { source: ["section", "file"], op: ["replace", "append", "prepend"], mode: ["preview", "apply"] } },
      "plan-task-link": { required: ["planId", "taskId"], properties: ["planId", "taskId", "taskType", "parentTaskId", "dependsOn", "blockedBy", "parallelGroup", "planStep", "acceptanceCriteria"], enums: { taskType: ["project-task", "fast-task", "subtask"] } },
      "plan-status": { required: [], properties: ["planId", "verbose"] },
      "plan-next": { required: ["planId"], properties: ["planId", "verbose"] },
      "plan-progress-reconcile": { required: ["planId"], properties: ["planId", "mode"], enums: { mode: ["preview", "apply"] } },
      "plan-content-read": { required: [], properties: ["planId", "contentRef", "taskId", "section", "outline", "grep", "regex", "context", "maxMatches", "unlockStale", "clearInconsistent"] },
      "plan-content-update": { required: ["planId"], properties: ["planId", "content", "taskId", "section", "op", "mode", "expectedSha256"], enums: { op: ["replace", "append", "prepend", "delete"], mode: ["preview", "apply"] } },
      "plan-content-delete": { required: ["planId"], properties: ["planId", "deleteTaskFiles", "force", "mode"], enums: { mode: ["preview", "apply"] } },
    };
    for (const [name, contract] of Object.entries(expected)) {
      const schema = schemaOf(fake, name);
      expect(schema.required ?? []).toEqual(contract.required);
      expect(Object.keys(schema.properties)).toEqual(contract.properties);
      for (const [field, values] of Object.entries(contract.enums ?? {})) {
        expect(schema.properties[field]?.enum).toEqual(values);
      }
    }
    await fake.registration?.dispose();
  });

  test("13 工具外框參數化：成功／失敗結果都維持 envelope", async () => {
    const fake = await setupWorkflow(await tempRoot());
    const names = [
      "task-state-sync", "task-content-read", "task-content-update", "plan-state-sync",
      "plan-task-link", "plan-status", "plan-next", "plan-progress-reconcile",
      "plan-content-create", "plan-content-read", "plan-content-update", "plan-content-delete",
      "work-order-build",
    ];
    for (const name of names) {
      const result = JSON.parse((await fake.added.get(name).execute({}, fakeV2ToolContext())).content);
      const keys = new Set(Object.keys(result));
      if (result.ok) {
        expect(keys).toEqual(new Set(["ok", "summary", "data"]));
      } else {
        expect(keys).toEqual(new Set(["ok", "code", "summary", "nextAction", "data"]));
      }
    }
    await fake.registration?.dispose();
  });

  test("代表性工具維持 ok／summary／data 失敗外層格式", async () => {
    const fake = await setupWorkflow(await tempRoot());
    const missing = await callTool(fake, "task-state-sync", { event: "status" });
    expect(new Set(Object.keys(missing))).toEqual(new Set(["ok", "summary", "data"]));
    const invalid = await callTool(fake, "task-state-sync", { event: "create", to: "NEW" });
    expect(invalid).toMatchObject({ ok: false, code: "TASK_ID_REQUIRED" });
    expect(new Set(Object.keys(invalid))).toEqual(new Set(["ok", "summary", "code", "nextAction", "data"]));
    await fake.registration?.dispose();
  });
});
