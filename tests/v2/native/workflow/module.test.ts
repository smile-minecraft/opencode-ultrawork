import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
import { registerModules } from "../../../../src/modules/registry.ts";
import { buildSubagentEvidencePackGuidance, workflowModule } from "../../../../src/modules/workflow/index.ts";
import { EVIDENCE_PACK_SECTIONS } from "../../../../src/modules/workflow/gates/evidence-pack.ts";
import { createFakeV2Context } from "../../_fake-v2-context.ts";

const TOOL_NAMES = [
  "task-state-sync",
  "task-content-read",
  "task-content-update",
  "plan-state-sync",
  "plan-task-link",
  "plan-status",
  "plan-next",
  "plan-progress-reconcile",
  "plan-content-create",
  "plan-content-read",
  "plan-content-update",
  "plan-content-delete",
  "work-order-build",
] as const;

describe("workflow V2 模組註冊", () => {
  test("註冊 13 個工具與 workflow hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "uw-workflow-"));
    try {
      const fake = createFakeV2Context({
        directory: root,
        tools: [{ id: "subagent", description: "派遣子代理" }],
      });
      const registration = await workflowModule.register({ ctx: fake.ctx, settings: DEFAULT_SETTINGS });
      expect(registration).toBeDefined();

      for (const name of TOOL_NAMES) {
        expect(fake.added.has(name)).toBe(true);
        expect(fake.added.get(name).options).toEqual({ codemode: false });
      }
      expect(fake.toolHooks.has("execute.before")).toBe(true);
      expect(fake.sessionHooks.has("context")).toBe(true);
      expect(fake.sessionHooks.has("compaction")).toBe(true);
      expect(fake.registry.get("subagent")?.description).toContain("uw-task-evidence-pack-guidance");

      await registration?.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("模組關閉時不註冊工具或 hook", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.modules.workflow = false;
    const fake = createFakeV2Context({ tools: [{ id: "subagent", description: "派遣子代理" }] });
    const registrations = await registerModules({ ctx: fake.ctx, settings }, [workflowModule]);
    expect(registrations).toEqual([]);
    expect(fake.added.size).toBe(0);
    expect(fake.toolHooks.size).toBe(0);
    expect(fake.sessionHooks.size).toBe(0);
  });
});

describe("實作說明指引文字", () => {
  test("未設定時注入 subagent 的指引逐字等於改動前", () => {
    const headings = EVIDENCE_PACK_SECTIONS.map((name, index) => `- ### ${index + 1}. ${name}`);
    expect(buildSubagentEvidencePackGuidance()).toBe(
      [
        "<!-- uw-task-evidence-pack-guidance -->",
        "",
        "## 實作說明七節固定格式（subagent prompt 指引）",
        "",
        "派遣給 `implementer`、`debugger` 或 `ultra-coder` 的 subagent prompt，必須含下列七個 H3 標題，依序、每節非空、不可重複：",
        "",
        ...headings,
        "",
        "- 缺漏、空節、重複、順序錯、名稱或序號錯誤都會被擋下。",
        "- `### 6. Acceptance Criteria` 必須含至少一個 `- [ ]` 或 `- [x]` checkbox。",
        "- heading 層級混用時會在派發前自動改成 H3；其他錯誤不會自動猜測。",
        "- 用 `work-order-build` 組裝時，prompt 只填它回傳的 `work-order:<id>`，派發前會自動換回全文。",
      ].join("\n"),
    );
  });
});
