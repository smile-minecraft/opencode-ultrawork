/**
 * diagnostics 工具介面 parity。
 *
 * ⚠️ 這裡的 `FROZEN_*` 清單是**對外介面的凍結值**，不是測試Fixtures。
 *
 * 49 個工具的名稱與參數、6 個 hook 名、11 個分類、41 個來源檔位置都是這個
 * 外掛對呼叫端（OpenCode runtime、既有設定、使用者的 script）承諾的介面。
 * 改動其中任何一項都算**對外介面變更**，需要先問過使用者，不能當成普通
 * 重構順手改掉。
 *
 * 這些值原本是拿 `bun run baseline:uw:update` 產生的
 * `.opencode/baselines/ultrawork-current.json` 快照來比。V1 相容表面移除時
 * 那支 generator 與快照一起刪掉了（快照的 `source` 欄位本來就已經過時，
 * 指向 V1 移除後不存在的 `plugins/…` 路徑，而且裡面還帶著產生者機器的
 * 絕對路徑），所以凍結值改成直接內嵌在本檔。
 *
 * 內嵌之後這支測試的意義不變，而且更嚴格：從前是「src 的常數 == 某個
 * generator 從 V1 樹生出來的快照」，現在是「src 的常數 == 這份寫死的清單」。
 * 少了中間那層會自己跟著 src 漂移的自動產物。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeV2ToolContext } from "../../_fake-v2-context.ts";
import {
  EXPECTED_CATEGORIES,
  EXPECTED_SOURCE_PATHS,
  EXPECTED_TOOL_NAMES,
  HOOK_NAMES,
  TOOL_CATEGORIES,
  TOOL_SOURCES,
} from "../../../../src/modules/diagnostics/index.ts";
import {
  callTool,
  diagnosticsOnlySettings,
  setupDiagnostics,
  writeMinimalWorkspace,
} from "./_helpers.ts";

const FROZEN_TOOL_NAMES: readonly string[] = [
  "change-scope-check",
  "comment_signal_baseline",
  "comment_signal_check",
  "comment_signal_explain",
  "comment_signal_only_new",
  "comment_signal_policy",
  "comment_signal_suppress",
  "comment_signal_touched_report",
  "grep_context",
  "memory-extract",
  "memory-maintain",
  "memory-note",
  "memory-read",
  "memory-search",
  "memory-task-close",
  "memory-write",
  "peek_file",
  "plan-content-create",
  "plan-content-delete",
  "plan-content-read",
  "plan-content-update",
  "plan-next",
  "plan-progress-reconcile",
  "plan-state-sync",
  "plan-status",
  "plan-task-link",
  "skill_search",
  "skiller-draft",
  "skiller-draft-delete",
  "skiller-draft-read",
  "skiller-draft-update",
  "skiller-import",
  "skiller-policy-update",
  "skiller-promote",
  "skiller-restore",
  "skiller-retire",
  "skiller-scan",
  "skiller-validate",
  "task-content-read",
  "task-content-update",
  "task-state-sync",
  "tool_hook_manifest",
  "ultrawork_selftest",
  "verification_run",
  "work-order-build",
  "workflow_bootstrap",
  "workflow_doctor",
  "workflow_health_check",
  "workflow_l1_check",
];

const FROZEN_HOOK_NAMES: readonly string[] = [
  "event",
  "experimental.chat.system.transform",
  "experimental.session.compacting",
  "tool.definition",
  "tool.execute.after",
  "tool.execute.before",
];

const FROZEN_SOURCE_PATHS: readonly string[] = [
  "src/modules/comment-signal/baseline-tools.ts",
  "src/modules/comment-signal/tool-check.ts",
  "src/modules/comment-signal/tool-explain.ts",
  "src/modules/comment-signal/tool-policy.ts",
  "src/modules/comment-signal/tool-touched-report.ts",
  "src/modules/diagnostics/tool-hook-manifest.ts",
  "src/modules/diagnostics/ultrawork-selftest.ts",
  "src/modules/diagnostics/workflow-bootstrap.ts",
  "src/modules/diagnostics/workflow-doctor.ts",
  "src/modules/diagnostics/workflow-health-check.ts",
  "src/modules/diagnostics/workflow-l1-check.ts",
  "src/modules/memory/tools/memory-extract.ts",
  "src/modules/memory/tools/memory-maintain.ts",
  "src/modules/memory/tools/memory-note.ts",
  "src/modules/memory/tools/memory-read.ts",
  "src/modules/memory/tools/memory-search.ts",
  "src/modules/memory/tools/memory-task-close.ts",
  "src/modules/memory/tools/memory-write.ts",
  "src/modules/search/grep-context.ts",
  "src/modules/search/peek-file.ts",
  "src/modules/skiller/skiller-draft-ops.ts",
  "src/modules/skiller/skiller-draft.ts",
  "src/modules/skiller/skiller-import.ts",
  "src/modules/skiller/skiller-policy-update.ts",
  "src/modules/skiller/skiller-promote.ts",
  "src/modules/skiller/skiller-restore.ts",
  "src/modules/skiller/skiller-retire.ts",
  "src/modules/skiller/skiller-scan.ts",
  "src/modules/skiller/skiller-validate.ts",
  "src/modules/skills/skill-catalog.ts",
  "src/modules/verification/change-scope-check.ts",
  "src/modules/verification/verification-run.ts",
  "src/modules/workflow/tools/plan-content.ts",
  "src/modules/workflow/tools/plan-next.ts",
  "src/modules/workflow/tools/plan-progress-reconcile.ts",
  "src/modules/workflow/tools/plan-state-sync.ts",
  "src/modules/workflow/tools/plan-status.ts",
  "src/modules/workflow/tools/plan-task-link.ts",
  "src/modules/workflow/tools/task-content.ts",
  "src/modules/workflow/tools/task-state-sync.ts",
  "src/modules/workflow/tools/work-order-build.ts",
];

const FROZEN_CATEGORIES: readonly string[] = [
  "comment_signal",
  "grep_peek",
  "memory_curation",
  "memory_query",
  "plan_content",
  "plan_state",
  "skill",
  "task_content",
  "task_state",
  "verification",
  "workflow",
];

const FROZEN_TOOL_CATEGORIES: Readonly<Record<string, string>> = {
  "memory-search": "memory_query",
  "memory-read": "memory_query",
  "memory-note": "memory_curation",
  "memory-extract": "memory_curation",
  "memory-write": "memory_curation",
  "memory-maintain": "memory_curation",
  "memory-task-close": "memory_curation",

  "change-scope-check": "verification",
  "comment_signal_baseline": "comment_signal",
  "comment_signal_check": "comment_signal",
  "comment_signal_explain": "comment_signal",
  "comment_signal_only_new": "comment_signal",
  "comment_signal_policy": "comment_signal",
  "comment_signal_suppress": "comment_signal",
  "comment_signal_touched_report": "comment_signal",
  "grep_context": "grep_peek",
  "peek_file": "grep_peek",
  "plan-content-create": "plan_content",
  "plan-content-delete": "plan_content",
  "plan-content-read": "plan_content",
  "plan-content-update": "plan_content",
  "plan-next": "plan_state",
  "plan-progress-reconcile": "plan_state",
  "plan-state-sync": "plan_state",
  "plan-status": "plan_state",
  "plan-task-link": "plan_state",
  "skill_search": "skill",
  "skiller-draft": "skill",
  "skiller-draft-delete": "skill",
  "skiller-draft-read": "skill",
  "skiller-draft-update": "skill",
  "skiller-import": "skill",
  "skiller-policy-update": "skill",
  "skiller-promote": "skill",
  "skiller-restore": "skill",
  "skiller-retire": "skill",
  "skiller-scan": "skill",
  "skiller-validate": "skill",
  "task-content-read": "task_content",
  "task-content-update": "task_content",
  "task-state-sync": "task_state",
  "tool_hook_manifest": "workflow",
  "ultrawork_selftest": "workflow",
  "verification_run": "verification",
  "work-order-build": "workflow",
  "workflow_bootstrap": "workflow",
  "workflow_doctor": "workflow",
  "workflow_health_check": "workflow",
  "workflow_l1_check": "workflow",
};


const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-diag-parity-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function schemaOf(fake: Awaited<ReturnType<typeof setupDiagnostics>>, name: string) {
  return fake.added.get(name).input as {
    type: string;
    required?: string[];
    additionalProperties?: boolean;
    properties: Record<string, { enum?: string[]; type?: string }>;
  };
}

describe("diagnostics 工具介面 parity", () => {
  test("六個工具名稱與凍結清單一致", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    expect([...fake.added.keys()].sort()).toEqual([...EXPECTED_TOOL_NAMES].filter((n) => n.startsWith("workflow_") || n === "tool_hook_manifest" || n === "ultrawork_selftest").sort());
    await fake.registration?.dispose();
  });

  test("參數 schema 沿用舊版：mode enum、無參數工具、category 字串、逾時與清單", async () => {
    const fake = await setupDiagnostics(await tempRoot());

    const bootstrap = schemaOf(fake, "workflow_bootstrap");
    expect(bootstrap.type).toBe("object");
    expect(Object.keys(bootstrap.properties)).toEqual(["mode"]);
    expect(bootstrap.properties.mode.enum).toEqual(["minimal", "full", "project", "state"]);
    expect(bootstrap.required ?? []).toEqual([]);

    for (const name of ["workflow_l1_check", "workflow_doctor"]) {
      const schema = schemaOf(fake, name);
      expect(Object.keys(schema.properties)).toEqual([]);
      expect(schema.required ?? []).toEqual([]);
    }

    const health = schemaOf(fake, "workflow_health_check");
    expect(Object.keys(health.properties)).toEqual(["includeBaselineCheck"]);
    expect(health.properties.includeBaselineCheck.type).toBe("boolean");

    const manifest = schemaOf(fake, "tool_hook_manifest");
    expect(Object.keys(manifest.properties)).toEqual(["category"]);
    expect(manifest.properties.category.type).toBe("string");

    const selftest = schemaOf(fake, "ultrawork_selftest");
    expect(Object.keys(selftest.properties).sort()).toEqual(["timeoutMs", "toolNames"]);
    expect(selftest.properties.toolNames.type).toBe("array");
    expect(selftest.properties.timeoutMs.type).toBe("integer");

    await fake.registration?.dispose();
  });

  test("無效輸入回 INVALID_INPUT 失敗外框", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const invalid = await fake.added
      .get("workflow_bootstrap")
      .execute({ mode: "nope" }, fakeV2ToolContext());
    const parsed = JSON.parse(invalid.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_INPUT");
    expect(new Set(Object.keys(parsed))).toEqual(
      new Set(["ok", "code", "summary", "nextAction", "data"]),
    );
    await fake.registration?.dispose();
  });

  test("六個工具成功結果都維持 ok／summary／data 外框", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    // 這個案例斷言的是回傳外框，不是工具集比對。harness 只註冊診斷模組，
    // 所以其他模組要關掉，否則 health_check 會如實回報工具集不一致。
    const fake = await setupDiagnostics(root, diagnosticsOnlySettings());
    for (const name of [
      "workflow_bootstrap",
      "workflow_l1_check",
      "workflow_doctor",
      "workflow_health_check",
      "tool_hook_manifest",
      "ultrawork_selftest",
    ]) {
      const result = JSON.parse((await fake.added.get(name).execute({}, fakeV2ToolContext())).content);
      expect(result.ok, `${name} 應成功`).toBe(true);
      expect(new Set(Object.keys(result)), name).toEqual(new Set(["ok", "summary", "data"]));
    }
    await fake.registration?.dispose();
  });

  test("l1_check 的 CONFIGURATION_ERROR 走同一個失敗外框", async () => {
    const root = await tempRoot();
    const { writeMemoryFile } = await import("./_helpers.ts");
    writeMemoryFile(root, "state.md", "---\nlabel: state\nlimit: abc\n---\n# State\n");
    const fake = await setupDiagnostics(root);
    const result = await callTool(fake, "workflow_l1_check");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONFIGURATION_ERROR");
    expect(new Set(Object.keys(result))).toEqual(
      new Set(["ok", "code", "summary", "nextAction", "data"]),
    );
    await fake.registration?.dispose();
  });
});

describe("凍結介面：inventory 與內嵌清單逐項對應", () => {
  test("四個數量就是對外承諾的 49／6／41／11", () => {
    expect(FROZEN_TOOL_NAMES).toHaveLength(49);
    expect(FROZEN_HOOK_NAMES).toHaveLength(6);
    expect(FROZEN_SOURCE_PATHS).toHaveLength(41);
    expect(FROZEN_CATEGORIES).toHaveLength(11);
  });

  test("工具名稱、hook 名稱、來源路徑與分類逐一對應凍結清單", () => {
    // `HOOK_NAMES` 是 literal union，比對前先攤成 `string[]`，否則 `toEqual`
    // 會要求凍結清單也帶同一組 literal 型別，等於讓測試檔依賴內部型別細節。
    const hookNames: string[] = [...HOOK_NAMES].sort();
    expect([...EXPECTED_TOOL_NAMES]).toEqual([...FROZEN_TOOL_NAMES]);
    expect(hookNames).toEqual([...FROZEN_HOOK_NAMES]);
    expect([...EXPECTED_SOURCE_PATHS]).toEqual([...FROZEN_SOURCE_PATHS]);
    expect([...EXPECTED_CATEGORIES]).toEqual([...FROZEN_CATEGORIES]);
  });

  test("每個工具的分類與凍結清單一致", () => {
    const mismatches = FROZEN_TOOL_NAMES
      .filter((name) => TOOL_CATEGORIES[name] !== FROZEN_TOOL_CATEGORIES[name])
      .map((name) => `${name}: ${TOOL_CATEGORIES[name]} != ${FROZEN_TOOL_CATEGORIES[name]}`);
    expect(mismatches).toEqual([]);
    // 分類表不允許出現清單外的工具，否則凍結清單就不再是完整描述。
    expect(Object.keys(TOOL_CATEGORIES).sort()).toEqual([...FROZEN_TOOL_NAMES]);
  });

  test("來源路徑指向 V2 實際檔案，且每個來源都被至少一個工具使用", () => {
    const used = new Set(Object.values(TOOL_SOURCES));
    expect(used.size).toBe(FROZEN_SOURCE_PATHS.length);
    for (const path of used) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
      expect(() => readFileSync(join(process.cwd(), path), "utf-8"), path).not.toThrow();
    }
  });

  test("診斷模組自報的來源與 inventory 一致（register 出的工具名對得上）", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    for (const name of fake.added.keys()) {
      expect(TOOL_SOURCES[name], `${name} 應在 inventory 有來源`).toBeString();
    }
    await fake.registration?.dispose();
  });
});
