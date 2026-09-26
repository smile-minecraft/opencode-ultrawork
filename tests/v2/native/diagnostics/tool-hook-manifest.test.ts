import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
import { callTool, setupDiagnostics } from "./_helpers.ts";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-diag-manifest-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 舊版 `17-phase5-tools.test.ts` 的 tool_hook_manifest 區塊。 */
describe("tool_hook_manifest 完整清單", () => {
  test("預設回 tools／hooks／sources／categories 與 humanSummary", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "tool_hook_manifest");
    expect(r.ok).toBe(true);
    expect(r.toolCount).toBe(49);
    expect(r.hookCount).toBe(6);
    expect(r.sourceCount).toBe(41);
    expect(Array.isArray(r.tools)).toBe(true);
    expect(Array.isArray(r.hooks)).toBe(true);
    expect(Array.isArray(r.sources)).toBe(true);
    expect(Array.isArray(r.categories)).toBe(true);

    expect(r.hooks.map((h: any) => h.name).sort()).toEqual([
      "event",
      "experimental.chat.system.transform",
      "experimental.session.compacting",
      "tool.definition",
      "tool.execute.after",
      "tool.execute.before",
    ]);
    // 全部模組開啟時 6 個 hook 都有接線
    expect(r.hooks.every((h: any) => h.wired === true)).toBe(true);

    expect(r.humanSummary).toMatch(/Tool\/Hook Manifest/);
    expect(r.humanSummary).toMatch(/tools: 49/);
    expect(r.humanSummary).toMatch(/hooks: 6/);
    await fake.registration?.dispose();
  });

  test("tools 元素形狀為 { name, category, source } 且來源指向 V2 檔案", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "tool_hook_manifest");
    for (const tool of r.tools) {
      expect(new Set(Object.keys(tool))).toEqual(new Set(["name", "category", "source"]));
      expect(tool.source.startsWith("src/modules/")).toBe(true);
    }
    // 每個來源都被至少一個工具使用
    const used = new Set(r.tools.map((t: any) => t.source));
    expect(used.size).toBe(r.sourceCount);
    await fake.registration?.dispose();
  });

  test("sources 依路徑排序且計數正確", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "tool_hook_manifest");
    const paths = r.sources.map((s: any) => s.path);
    expect([...paths].sort()).toEqual(paths);
    const total = r.sources.reduce((sum: number, s: any) => sum + s.toolCount, 0);
    expect(total).toBe(r.toolCount);
    await fake.registration?.dispose();
  });
});

describe("tool_hook_manifest category 過濾", () => {
  test("comment_signal 只列出 7 個 comment_signal_*", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "tool_hook_manifest", { category: "comment_signal" });
    expect(r.ok).toBe(true);
    expect(r.tools.map((t: any) => t.name).sort()).toEqual([
      "comment_signal_baseline",
      "comment_signal_check",
      "comment_signal_explain",
      "comment_signal_only_new",
      "comment_signal_policy",
      "comment_signal_suppress",
      "comment_signal_touched_report",
    ]);
    expect(r.toolCount).toBe(7);
    await fake.registration?.dispose();
  });

  test("診斷六工具歸在 workflow 分類（runtime 表徵）", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "tool_hook_manifest", { category: "workflow" });
    const names = r.tools.map((t: any) => t.name);
    for (const name of [
      "workflow_bootstrap",
      "workflow_l1_check",
      "workflow_doctor",
      "workflow_health_check",
      "tool_hook_manifest",
      "ultrawork_selftest",
    ]) {
      expect(names).toContain(name);
    }
    // categories 維持 11 個（診斷三工具的語意分類 self_diagnostic 不外露）
    const all = await callTool(fake, "tool_hook_manifest");
    expect(all.categories.length).toBe(11);
    expect(all.categories).not.toContain("self_diagnostic");
    await fake.registration?.dispose();
  });

  test("無效 category 回空清單", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "tool_hook_manifest", { category: "no-such-category" });
    expect(r.ok).toBe(true);
    expect(r.toolCount).toBe(0);
    expect(r.tools).toEqual([]);
    await fake.registration?.dispose();
  });

  test("空白 category 視為未過濾", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "tool_hook_manifest", { category: "   " });
    expect(r.toolCount).toBe(49);
    await fake.registration?.dispose();
  });
});

describe("tool_hook_manifest 反映模組開關", () => {
  test("關閉 skiller → 只列 38 個工具、32 個來源", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.modules.skiller = false;
    const fake = await setupDiagnostics(await tempRoot(), settings);
    const r = await callTool(fake, "tool_hook_manifest");
    expect(r.toolCount).toBe(38);
    expect(r.sourceCount).toBe(32);
    expect(r.tools.some((t: any) => t.name === "skiller-scan")).toBe(false);
    await fake.registration?.dispose();
  });

  test("關閉 comment-signal → tool.execute.after 顯示未接線", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.modules.commentSignal = false;
    const fake = await setupDiagnostics(await tempRoot(), settings);
    const r = await callTool(fake, "tool_hook_manifest");
    const after = r.hooks.find((h: any) => h.name === "tool.execute.after");
    expect(after.wired).toBe(false);
    const before = r.hooks.find((h: any) => h.name === "tool.execute.before");
    expect(before.wired).toBe(true);
    expect(r.humanSummary).toMatch(/hooks: 6 \(5 wired\)/);
    await fake.registration?.dispose();
  });

  test("只開 diagnostics → 6 個工具、6 個來源", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    for (const key of Object.keys(settings.modules)) {
      settings.modules[key as keyof typeof settings.modules] = key === "diagnostics";
    }
    const fake = await setupDiagnostics(await tempRoot(), settings);
    const r = await callTool(fake, "tool_hook_manifest");
    expect(r.toolCount).toBe(6);
    expect(r.sourceCount).toBe(6);
    expect(r.categories).toEqual(["workflow"]);
    await fake.registration?.dispose();
  });
});
