import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __ultraworkSelftestInternals, isSelfDiagnostic } from "../../../../src/modules/diagnostics/index.ts";
import { callTool, fileSnapshot, setupDiagnostics, writeMinimalWorkspace } from "./_helpers.ts";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-diag-selftest-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const SELF_DIAGNOSTIC = ["tool_hook_manifest", "ultrawork_selftest", "workflow_health_check"].sort();

/** 把外框的 `data` 欄位掛到外層，與 harness 的 callTool 同一個做法。 */
function hoist(parsed: any): any {
  if (parsed?.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
    for (const [key, value] of Object.entries(parsed.data)) {
      if (!(key in parsed)) Object.defineProperty(parsed, key, { value, enumerable: false, configurable: true });
    }
  }
  return parsed;
}

/** 舊版 `17-phase5-tools.test.ts` 的 selftest 區塊。 */
describe("ultrawork_selftest 預設執行", () => {
  test("預設 totalMs 遠低於 30s 上限，skip 自我診斷三工具", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const wallStart = Date.now();
    const r = await callTool(fake, "ultrawork_selftest");
    const wallMs = Date.now() - wallStart;

    expect(r.ok).toBe(true);
    expect(typeof r.totalMs).toBe("number");
    expect(r.totalMs).toBeLessThan(30_000);
    expect(wallMs).toBeLessThan(30_000);
    expect(r.overallTimeoutMs).toBe(30_000);
    expect(r.perToolTimeoutMs).toBe(5_000);

    // 診斷模組擁有 6 個工具；其中 3 個自我診斷被跳過，3 個實際 smoke
    expect(r.skipCount).toBe(3);
    expect(r.passCount).toBe(3);
    expect(r.failCount).toBe(0);
    const skips = r.results.filter((x: any) => x.status === "skip").map((x: any) => x.tool).sort();
    expect(skips).toEqual(SELF_DIAGNOSTIC);
    expect(r.notCovered.sort()).toEqual(SELF_DIAGNOSTIC);
    await fake.registration?.dispose();
  });

  test("每筆結果都有 tool／status／elapsedMs，且欄位不多不少", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "ultrawork_selftest");
    for (const item of r.results) {
      const keys = new Set(Object.keys(item));
      // error／resultKeys 只在有值時出現（JSON.stringify 會丟掉 undefined）。
      expect([...keys].every((k) => ["tool", "status", "elapsedMs", "error", "resultKeys"].includes(k))).toBe(true);
      expect(keys.has("tool")).toBe(true);
      expect(keys.has("status")).toBe(true);
      expect(keys.has("elapsedMs")).toBe(true);
      expect(["pass", "fail", "skip", "timeout"]).toContain(item.status);
      expect(typeof item.elapsedMs).toBe("number");
    }
    await fake.registration?.dispose();
  });

  test("humanSummary 帶通過結論與計數", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "ultrawork_selftest");
    expect(r.humanSummary).toMatch(/Ultrawork Selftest：通過/);
    expect(r.humanSummary).toMatch(/pass=3, fail=0, skip=3/);
    await fake.registration?.dispose();
  });

  test("重複呼叫結果穩定", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    for (let i = 0; i < 2; i++) {
      const r = await callTool(fake, "ultrawork_selftest");
      expect(r.totalMs).toBeLessThan(30_000);
      expect(r.ok).toBe(true);
    }
    await fake.registration?.dispose();
  });
});

describe("ultrawork_selftest 略過行為", () => {
  test("自訂 toolNames 子集：指定工具實際 smoke，自我診斷三工具仍以 skip 出現", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "ultrawork_selftest", {
      toolNames: ["workflow_bootstrap", "workflow_l1_check"],
    });
    expect(r.ok).toBe(true);
    const names = r.results.map((x: any) => x.tool).sort();
    expect(names).toContain("workflow_bootstrap");
    expect(names).toContain("workflow_l1_check");
    expect(r.results.length).toBe(5);
    expect(r.passCount).toBe(2);
    expect(r.skipCount).toBe(3);
    await fake.registration?.dispose();
  });

  test("診斷模組取不到的工具明確標 skipped 並附原因，不默默省略", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "ultrawork_selftest", {
      toolNames: ["task-state-sync", "grep_context"],
    });
    const items = r.results.filter((x: any) => ["task-state-sync", "grep_context"].includes(x.tool));
    expect(items.length).toBe(2);
    for (const item of items) {
      expect(item.status).toBe("skip");
      expect(item.error).toContain("沒有跨模組工具登錄清單");
    }
    expect(r.failCount).toBe(0);
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("會寫檔的工具標 skipped 並附原因（SKIP_TOOLS 真的生效）", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "ultrawork_selftest", {
      toolNames: ["task-content-update", "project-memory-update", "memory-receipt-create"],
    });
    const items = r.results.filter((x: any) => x.tool !== undefined && x.status === "skip" && x.error?.includes("會寫入檔案"));
    expect(items.length).toBe(3);
    for (const item of items) {
      expect(item.error).toContain("避免留下副作用");
    }
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("isSelfDiagnostic 涵蓋自我診斷三工具", () => {
    for (const name of SELF_DIAGNOSTIC) {
      expect(isSelfDiagnostic(name)).toBe(true);
    }
    expect(isSelfDiagnostic("workflow_bootstrap")).toBe(false);
    expect([...__ultraworkSelftestInternals.SELF_DIAGNOSTIC_TOOLS].sort()).toEqual(SELF_DIAGNOSTIC);
    expect(__ultraworkSelftestInternals.SKIP_TOOLS.has("task-content-update")).toBe(true);
  });

  test("重複的 toolNames 只跑一次", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "ultrawork_selftest", {
      toolNames: ["workflow_bootstrap", "workflow_bootstrap"],
    });
    const names = r.results.map((x: any) => x.tool);
    expect(names.filter((n: string) => n === "workflow_bootstrap").length).toBe(1);
    await fake.registration?.dispose();
  });
});

describe("ultrawork_selftest 逾時保護", () => {
  test("整體預算至少 1000ms，自訂 timeoutMs 會被夾住", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "ultrawork_selftest", { timeoutMs: 50 });
    expect(r.overallTimeoutMs).toBe(1000);
    expect(r.perToolTimeoutMs).toBe(1000);
    await fake.registration?.dispose();
  });

  test("單一工具逾時算 fail 而非整個工具失敗，且回 timeout 狀態", async () => {
    const root = await tempRoot();
    // 診斷工具本身不 sleep；用一個永遠不 resolve 的假工具定義驗證逾時分支。
    // 直接呼叫 factory（不經模組註冊）是因為 toolMap 是 factory 的參數，
    // 測試要注入一個會卡住的定義。
    const { createUltraworkSelftestTool } = await import(
      "../../../../src/modules/diagnostics/ultrawork-selftest.ts"
    );
    const { createDiagnosticsDeps } = await import(
      "../../../../src/modules/diagnostics/index.ts"
    );
    const { createFakeV2Context, fakeV2ToolContext } = await import("../../_fake-v2-context.ts");
    const { DEFAULT_SETTINGS } = await import("../../../../src/settings/defaults.ts");
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    const tool = createUltraworkSelftestTool(createDiagnosticsDeps(fake.ctx, DEFAULT_SETTINGS), {
      "slow-tool": {
        name: "slow-tool",
        description: "",
        input: {},
        options: { codemode: false as const },
        execute: () => new Promise<{ content: string }>(() => {}),
      },
    });
    const result = hoist(
      JSON.parse(
        (await tool.execute({ toolNames: ["slow-tool"], timeoutMs: 1000 }, fakeV2ToolContext())).content,
      ),
    );
    const item = result.results.find((x: any) => x.tool === "slow-tool");
    expect(item.status).toBe("timeout");
    expect(item.error).toContain("timeout after 1000ms");
    expect(result.failCount).toBe(1);
    expect(result.ok).toBe(false);
  });

  test("整體預算大於 5s 時，單一工具上限仍固定在 5000ms", async () => {
    const root = await tempRoot();
    const { createUltraworkSelftestTool } = await import(
      "../../../../src/modules/diagnostics/ultrawork-selftest.ts"
    );
    const { createDiagnosticsDeps } = await import(
      "../../../../src/modules/diagnostics/index.ts"
    );
    const { createFakeV2Context, fakeV2ToolContext } = await import("../../_fake-v2-context.ts");
    const { DEFAULT_SETTINGS } = await import("../../../../src/settings/defaults.ts");
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    const tool = createUltraworkSelftestTool(createDiagnosticsDeps(fake.ctx, DEFAULT_SETTINGS), {});
    const result = hoist(
      JSON.parse((await tool.execute({ timeoutMs: 60_000 }, fakeV2ToolContext())).content),
    );
    expect(result.overallTimeoutMs).toBe(60_000);
    expect(result.perToolTimeoutMs).toBe(5_000);
  });
});

describe("ultrawork_selftest 不產生副作用", () => {
  test("在有資料的 workspace 執行後檔案清單不變", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const before = fileSnapshot(root);
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "ultrawork_selftest");
    expect(r.ok).toBe(true);
    expect(fileSnapshot(root)).toEqual(before);
    await fake.registration?.dispose();
  });
});
