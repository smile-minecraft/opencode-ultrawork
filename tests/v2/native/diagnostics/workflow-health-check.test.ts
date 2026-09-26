import { writeMemoryTopic } from "./_helpers.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
import { compareToolNameSets } from "../../../../src/modules/diagnostics/index.ts";
import { commentSignalModule } from "../../../../src/modules/comment-signal/index.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../../_fake-v2-context.ts";
import {
  callTool,
  diagnosticsOnlySettings,
  makePlansDir,
  setupDiagnostics,
  writeMemoryFile,
  writeMinimalWorkspace,
  writePlansRegistry,
  writeStateMd,
  writeTasksRegistry,
} from "./_helpers.ts";

/** 直接對已註冊工具呼叫並把 data 欄位掛到外層。 */
async function callEnvelopeOf(
  fake: { added: Map<string, any> },
  name: string,
  input: Record<string, unknown> = {},
): Promise<any> {
  const parsed = JSON.parse((await fake.added.get(name).execute(input, fakeV2ToolContext())).content);
  for (const [key, value] of Object.entries(parsed.data ?? {})) {
    if (!(key in parsed)) Object.defineProperty(parsed, key, { value, enumerable: false, configurable: true });
  }
  return parsed;
}

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-diag-health-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function checkByName(r: any, name: string) {
  return r.checks.find((c: any) => c.name === name);
}

/** 舊版 `17-phase5-tools.test.ts` 的 health_check 區塊。 */
describe("workflow_health_check 檢查與健康訊號", () => {
  test("健康骨架 workspace：checks 有項目、health_signals 含 baseline 與工具比對", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const fake = await setupDiagnostics(root, diagnosticsOnlySettings("commentSignal"), {
      extraModules: [commentSignalModule],
    });
    const r = await callTool(fake, "workflow_health_check");
    expect(r.ok).toBe(true);
    expect(r.checks.length).toBeGreaterThan(0);
    expect(checkByName(r, "Memory Directory Resolution").status).toBe("passed");
    expect(checkByName(r, "Tasks Registry Project Binding").status).toBe("passed");
    expect(checkByName(r, "Memory Store").status).toBe("passed");
    expect(r.health_signals.baseline_state).toBe("missing");
    expect(r.health_signals.suppressions_total).toBe(0);
    // commentSignal 真的註冊了 7 個工具，預期 6 + 7 == 實際 13
    expect(r.health_signals.tool_count_actual).toBe(13);
    expect(r.health_signals.tool_count_expected).toBe(13);
    expect(r.health_signals.tool_count_match).toBe(true);
    await fake.registration?.dispose();
  });

  test("資料層完全不存在時如實回報失敗（不是 skipped，也不是假裝健康）", async () => {
    const fake = await setupDiagnostics(await tempRoot(), diagnosticsOnlySettings());
    const r = await callTool(fake, "workflow_health_check");
    expect(r.ok).toBe(false);
    expect(r.overallStatus).toBe("failed");
    expect(checkByName(r, "Memory Directory Resolution").status).toBe("failed");
    expect(checkByName(r, "Memory Store").status).toBe("passed");
    expect(checkByName(r, "Content Store Consistency").status).toBe("skipped");
    await fake.registration?.dispose();
  });

  test("includeBaselineCheck=false 跳過快照檢查", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const fake = await setupDiagnostics(root, diagnosticsOnlySettings());
    const r = await callTool(fake, "workflow_health_check", { includeBaselineCheck: false });
    expect(r.ok).toBe(true);
    expect(r.health_signals.baseline_state).toBe("skipped");
    expect(r.health_signals.baseline_age_hours).toBeUndefined();
    await fake.registration?.dispose();
  });

  test("快照存在且新鮮 → baseline_state=fresh", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeMemoryFile(
      root,
      "comment-signal-baseline.json",
      JSON.stringify({
        version: "1.0",
        projectId: "p",
        createdAt: new Date().toISOString(),
        source: "comment_signal_baseline",
        changedOnly: false,
        fingerprints: [],
        metrics: { violationCount: 0, errorCount: 0, warningCount: 0, highRiskCount: 0, scannedFileCount: 0, checkedCommentCount: 0, violationsSignature: "0".repeat(32) },
      }),
    );
    const fake = await setupDiagnostics(root, diagnosticsOnlySettings("commentSignal"), {
      extraModules: [commentSignalModule],
    });
    const r = await callTool(fake, "workflow_health_check");
    expect(r.health_signals.baseline_state).toBe("fresh");
    expect(r.health_signals.baseline_age_hours).toBeGreaterThanOrEqual(0);
    expect(checkByName(r, "Comment Signal Baseline Fresh").status).toBe("passed");
    await fake.registration?.dispose();
  });

  test("快照過期（超過 7 天）→ baseline_state=stale 且 warn", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeMemoryFile(
      root,
      "comment-signal-baseline.json",
      JSON.stringify({
        version: "1.0",
        projectId: "p",
        createdAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
        source: "comment_signal_baseline",
        changedOnly: false,
        fingerprints: [],
        metrics: { violationCount: 0, errorCount: 0, warningCount: 0, highRiskCount: 0, scannedFileCount: 0, checkedCommentCount: 0, violationsSignature: "0".repeat(32) },
      }),
    );
    const fake = await setupDiagnostics(root, diagnosticsOnlySettings("commentSignal"), {
      extraModules: [commentSignalModule],
    });
    const r = await callTool(fake, "workflow_health_check");
    expect(r.health_signals.baseline_state).toBe("stale");
    expect(checkByName(r, "Comment Signal Baseline Fresh").status).toBe("warn");
    await fake.registration?.dispose();
  });

  test("屏蔽清單有 blocking 項 → 高風險計數與 warn", async () => {
    const root = await tempRoot();
    writeMemoryFile(
      root,
      "comment-signal-suppressions.json",
      JSON.stringify({
        version: "1.0",
        projectId: "p",
        updatedAt: new Date().toISOString(),
        suppressions: [
          { id: "a", filePath: "a.ts", line: 1, code: "X", severity: "blocking", createdAt: new Date().toISOString() },
          { id: "b", filePath: "b.ts", line: 2, code: "Y", severity: "warning", createdAt: new Date().toISOString() },
        ],
      }),
    );
    const fake = await setupDiagnostics(root, diagnosticsOnlySettings("commentSignal"), {
      extraModules: [commentSignalModule],
    });
    const r = await callTool(fake, "workflow_health_check");
    expect(r.health_signals.suppressions_total).toBe(2);
    expect(r.health_signals.suppressions_high_risk_count).toBe(1);
    expect(checkByName(r, "Comment Signal High-Risk Suppressions").status).toBe("warn");
    await fake.registration?.dispose();
  });

  test("屏蔽清單損壞 → warn 提示", async () => {
    const root = await tempRoot();
    writeMemoryFile(root, "comment-signal-suppressions.json", "{{{ broken");
    const fake = await setupDiagnostics(root, diagnosticsOnlySettings("commentSignal"), {
      extraModules: [commentSignalModule],
    });
    const r = await callTool(fake, "workflow_health_check");
    expect(checkByName(r, "Comment Signal Suppression Store").status).toBe("warn");
    await fake.registration?.dispose();
  });

  test("comment-signal 模組關閉 → 快照與屏蔽檢查標 skipped", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const settings = diagnosticsOnlySettings("commentSignal");
    const fake = await setupDiagnostics(root, settings);
    // 只開 commentSignal 與 diagnostics，其餘關閉 → 工具集合自洽
    const r = await callTool(fake, "workflow_health_check", { includeBaselineCheck: true });
    expect(checkByName(r, "Comment Signal Snapshot Exists").status).not.toBe("skipped");
    await fake.registration?.dispose();

    const off = structuredClone(settings);
    off.modules.commentSignal = false;
    const fake2 = await setupDiagnostics(root, off);
    const r2 = await callTool(fake2, "workflow_health_check");
    expect(checkByName(r2, "Comment Signal Snapshot Exists").status).toBe("skipped");
    expect(checkByName(r2, "Comment Signal Suppression Store").status).toBe("skipped");
    expect(r2.health_signals.baseline_state).toBe("skipped");
    expect(r2.health_signals.baseline_age_hours).toBeUndefined();
    await fake2.registration?.dispose();
  });
});

/** overallStatus 聚合。 */
describe("workflow_health_check overallStatus 聚合", () => {
  test("乾淨 workspace（關閉其他模組）→ healthy", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const fake = await setupDiagnostics(root, diagnosticsOnlySettings());
    const r = await callTool(fake, "workflow_health_check", { includeBaselineCheck: false });
    expect(r.ok).toBe(true);
    expect(r.overallStatus).toBe("healthy");
    expect(r.plan_registry_health.error_count).toBe(0);
    expect(r.plan_registry_health.warn_count).toBe(0);
    expect(r.checks.filter((c: any) => c.status === "warn").length).toBe(0);
    // 診斷模組是唯一啟用的模組，工具清單自洽
    expect(r.health_signals.tool_count_expected).toBe(6);
    expect(r.health_signals.tool_count_actual).toBe(6);
    expect(r.health_signals.tool_count_match).toBe(true);
    await fake.registration?.dispose();
  });

  test("記憶主題超過預算 → warn、degraded，ok 維持 true", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeMemoryTopic(root, "x".repeat(4500) + "\n", "超大主題", "oversized");
    const fake = await setupDiagnostics(root, diagnosticsOnlySettings());
    const r = await callTool(fake, "workflow_health_check");
    // 預算超標不影響外掛運作，只提示整理；遷移產生的超大主題也走這條。
    expect(r.ok).toBe(true);
    expect(r.overallStatus).toBe("degraded");
    expect(r.memory_budget.layers.project.status).toBe("warn");
    expect(r.memory_budget.layers.project.oversized_topics).toEqual(["oversized"]);
    expect(r.warnings.some((w: string) => w.includes("超過預算"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("缺快照（warn-only）→ degraded 且 ok=true", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const fake = await setupDiagnostics(root, diagnosticsOnlySettings("commentSignal"), {
      extraModules: [commentSignalModule],
    });
    const r = await callTool(fake, "workflow_health_check");
    expect(r.ok).toBe(true);
    expect(r.overallStatus).toBe("degraded");
    expect(checkByName(r, "Comment Signal Snapshot Exists").status).toBe("warn");
    await fake.registration?.dispose();
  });

  test("計畫註冊檔只有 warn → degraded、ok=true 且頂層有 [plan-registry] 警告", async () => {
    const root = await tempRoot();
    makePlansDir(root);
    // 這個案例要斷言的只有「warn 而非 error」，所以其他存在性檢查都得先鋪好，
    // 否則 project.md exists 這類硬檢查會把 overallStatus 拉到 failed。
    writeMemoryTopic(root, "---\nlabel: project\nlimit: 7000\n---\n# Project Overview\n\n");
    // finishedTaskIds 列了 t-1，但 t-1 在 tasks.json 還是進行中 → warn（非 error）
    writePlansRegistry(root, {
      planId: "p-warn",
      state: "IN_PROGRESS",
      taskIds: ["t-1"],
      finishedTaskIds: ["t-1"],
      contentRef: ".ultrawork/plans/p-warn.md",
    });
    writeTasksRegistry(root, { taskId: "t-1", state: "IN_PROGRESS", planId: "p-warn" });
    writeStateMd(root, "IN_PROGRESS", "t-1");
    const fake = await setupDiagnostics(root, diagnosticsOnlySettings());
    const r = await callTool(fake, "workflow_health_check");
    expect(r.plan_registry_health.warn_count).toBeGreaterThanOrEqual(1);
    expect(r.plan_registry_health.error_count).toBe(0);
    expect(r.warnings.some((w: string) => /\[plan-registry\]/.test(w))).toBe(true);
    expect(r.overallStatus).toBe("degraded");
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("計畫註冊檔有 error → failed、ok=false", async () => {
    const root = await tempRoot();
    makePlansDir(root);
    writePlansRegistry(root, {
      planId: "p-err",
      state: "IN_PROGRESS",
      taskIds: ["t-1"],
      completionTombstones: { "t-1": { state: "COMPLETED", finishedAt: new Date().toISOString() } },
    });
    writeTasksRegistry(root, { taskId: "t-1", state: "IN_PROGRESS", planId: "p-err" });
    writeStateMd(root, "IN_PROGRESS", "t-1");
    const fake = await setupDiagnostics(root, diagnosticsOnlySettings());
    const r = await callTool(fake, "workflow_health_check");
    expect(r.plan_registry_health.error_count).toBeGreaterThanOrEqual(1);
    expect(r.ok).toBe(false);
    expect(r.overallStatus).toBe("failed");
    expect(r.warnings.some((w: string) => /\[plan-registry\]/.test(w))).toBe(true);
    await fake.registration?.dispose();
  });

  test("humanSummary 必含整體狀態標頭與計畫註冊檔摘要", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const fake = await setupDiagnostics(root, diagnosticsOnlySettings());
    const r = await callTool(fake, "workflow_health_check");
    expect(r.humanSummary).toMatch(/整體狀態/);
    expect(r.humanSummary).toMatch(/healthy|degraded|failed/);
    expect(r.humanSummary).toMatch(/計畫註冊檔/);
    expect(r.humanSummary).toMatch(/工具數/);
    await fake.registration?.dispose();
  });
});

/** 舊版 `17-phase5-tools.test.ts` 對 compareToolNameSets 的純函式測試意圖。 */
describe("compareToolNameSets 純函式規則", () => {
  test("任一來源缺漏 → skipped=true、match=false", () => {
    expect(compareToolNameSets([], [])).toEqual({ expected: null, actual: 0, match: false, skipped: true });
    expect(compareToolNameSets(["a"], [])).toEqual({ expected: 1, actual: 0, match: false, skipped: true });
    expect(compareToolNameSets([], ["a"])).toEqual({ expected: null, actual: 1, match: false, skipped: true });
    expect(compareToolNameSets(undefined, undefined).skipped).toBe(true);
  });

  test("長度不同 → match=false、skipped=false", () => {
    expect(compareToolNameSets(["a"], ["a", "b"])).toEqual({
      expected: 1,
      actual: 2,
      match: false,
      skipped: false,
    });
  });

  test("長度相同但內容不同 → match=false", () => {
    expect(compareToolNameSets(["a", "b"], ["a", "c"]).match).toBe(false);
  });

  test("順序不同但內容相同 → match=true", () => {
    expect(compareToolNameSets(["a", "b"], ["b", "a"])).toEqual({
      expected: 2,
      actual: 2,
      match: true,
      skipped: false,
    });
  });
});

/** 實際工具集合的來源：平台 introspection。 */
describe("實際工具集合的取得路徑", () => {
  test("平台提供 ctx.tool.list 時用實際註冊清單比對", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    const { diagnosticsModule } = await import("../../../../src/modules/diagnostics/index.ts");
    const registration = await diagnosticsModule.register({
      ctx: fake.ctx,
      settings: diagnosticsOnlySettings(),
    });
    const result = await callEnvelopeOf(fake, "workflow_health_check");
    expect(result.health_signals.tool_count_actual).toBe(6);
    expect(result.health_signals.tool_count_expected).toBe(6);
    expect(result.health_signals.tool_count_match).toBe(true);
    await registration?.dispose();
  });

  test("全部模組開啟時，預期集合是 49 個、實際只有診斷模組的 6 個 → 不一致", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const fake = await setupDiagnostics(root, DEFAULT_SETTINGS);
    const r = await callTool(fake, "workflow_health_check", { includeBaselineCheck: false });
    expect(r.health_signals.tool_count_expected).toBe(49);
    expect(r.health_signals.tool_count_actual).toBe(6);
    expect(r.health_signals.tool_count_match).toBe(false);
    expect(checkByName(r, "Tool Manifest Self-Consistency").status).toBe("failed");
    await fake.registration?.dispose();
  });

  test("關閉一個模組 → 預期集合跟著收斂", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const settings = diagnosticsOnlySettings();
    settings.modules.skiller = true;
    const fake = await setupDiagnostics(root, settings);
    const r = await callTool(fake, "workflow_health_check", { includeBaselineCheck: false });
    // skiller 開著卻沒註冊工具 → 預期 17、實際 6，不一致
    expect(r.health_signals.tool_count_expected).toBe(17);
    expect(r.health_signals.tool_count_actual).toBe(6);
    await fake.registration?.dispose();
  });

  test("平台不提供 ctx.tool.list → 該項標 skipped 並在 details 說明原因", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    delete (fake.ctx.tool as { list?: unknown }).list;
    const { diagnosticsModule } = await import("../../../../src/modules/diagnostics/index.ts");
    const registration = await diagnosticsModule.register({
      ctx: fake.ctx,
      settings: diagnosticsOnlySettings(),
    });
    const result = await callEnvelopeOf(fake, "workflow_health_check");
    const item = result.checks.find((c: any) => c.name === "Tool Manifest Self-Consistency");
    expect(item.status).toBe("skipped");
    expect(item.details).toContain("平台未提供實際註冊工具清單");
    // 不得因為略過就假裝通過
    expect(result.health_signals.tool_count_match).toBe(false);
    expect(result.warnings.some((w: string) => w.includes("無法取得平台實際註冊的工具清單"))).toBe(true);
    await registration?.dispose();
  });
});
