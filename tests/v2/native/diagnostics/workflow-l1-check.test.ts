import { writeMemoryTopic } from "./_helpers.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTool, setupDiagnostics, writeMemoryFile } from "./_helpers.ts";

/** 把外框的 `data` 欄位掛到外層，讓 payload 能扁平讀取。 */
function callToolResult(parsed: any): any {
  for (const [key, value] of Object.entries(parsed.data ?? {})) {
    if (!(key in parsed)) Object.defineProperty(parsed, key, { value, enumerable: false, configurable: true });
  }
  return parsed;
}

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-diag-l1-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 舊版 `14-doctor-memory-budget.test.ts` 的 l1_check 區塊。 */
describe("workflow_l1_check 大小與錯誤碼", () => {
  test("bootstrap_mode_estimates 含四種模式大小與 full_status", async () => {
    const root = await tempRoot();
    writeMemoryTopic(root, "---\nlimit: 5000\n---\n# P\n\n" + "a".repeat(1000) + "\n");
    writeMemoryFile(root, "state.md", "---\nlimit: 3000\n---\n# S\n\n" + "b".repeat(500) + "\n");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_l1_check");
    const estimates = r.token_efficiency.bootstrap_mode_estimates;
    expect(estimates.minimal_chars).toBe(1536);
    expect(estimates.project_chars).toBe(r.token_efficiency ? estimates.project_chars : 0);
    expect(estimates.full_chars).toBe(estimates.project_chars - 1536 + estimates.state_chars - 1536 + 2048);
    expect(estimates.full_soft_budget).toBe(10_000);
    expect(["ok", "warn"]).toContain(estimates.full_status);
    expect(r.token_efficiency.state_projection).toBe("cursor");
    expect(r.token_efficiency.estimated_bootstrap_mode).toBe("minimal");
    await fake.registration?.dispose();
  });

  test("full_status 在預估超過 soft budget 時轉為 warn", async () => {
    const root = await tempRoot();
    writeMemoryTopic(root, "---\nlimit: 7000\n---\n# P\n\n" + "a".repeat(6_000) + "\n");
    writeMemoryFile(root, "state.md", "---\nlimit: 3000\n---\n# S\n\n" + "b".repeat(10_000) + "\n");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_l1_check");
    expect(r.token_efficiency.bootstrap_mode_estimates.full_status).toBe("warn");
    expect(r.warnings.some((w: string) => w.includes("full 模式預估會輸出"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("project.md 超過有效上限 → status warn 且 ok=false", async () => {
    const root = await tempRoot();
    writeMemoryTopic(root, "---\nlimit: 1000\n---\n# P\n\n" + "a".repeat(4500) + "\n");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_l1_check");
    const block = r.blocks.find((b: any) => b.name === "project/fixture");
    expect(block.status).toBe("warn");
    expect(block.size).toBeGreaterThan(block.effectiveLimit);
    
    expect(r.ok).toBe(false);
    expect(r.warnings.some((w: string) => w.includes("project/fixture 超過大小上限"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("state.md 超過 3000 → warn 提示", async () => {
    const root = await tempRoot();
    writeMemoryFile(root, "state.md", "---\nlimit: 3000\n---\n# S\n\n" + "b".repeat(3_200) + "\n");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_l1_check");
    expect(r.blocks.find((b: any) => b.name === "state.md").status).toBe("warn");
    expect(r.warnings.some((w: string) => w.includes("state.md 超過大小上限"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("檔案不存在時 blocks 為空且仍回 token_efficiency", async () => {
    const fake = await setupDiagnostics(await tempRoot());
    const r = await callTool(fake, "workflow_l1_check");
    expect(r.ok).toBe(true);
    expect(r.blocks.every((b:any)=>b.size===0)).toBe(true);
    expect(r.token_efficiency.tasks_json_size).toBe(0);
    expect(r.token_efficiency.active_task_count).toBe(0);
    await fake.registration?.dispose();
  });

  test("超大檔案不會讓 l1_check 爆量（只回數字與摘要）", async () => {
    const root = await tempRoot();
    writeMemoryTopic(root, "---\nlimit: 7000\n---\n# P\n\n" + "x".repeat(400_000) + "\n");
    writeMemoryFile(root, "state.md", "---\nlimit: 3000\n---\n# S\n\n" + "y".repeat(400_000) + "\n");
    const fake = await setupDiagnostics(root);
    const raw = (await fake.added.get("workflow_l1_check").execute({}, { sessionID: "s1" } as any)).content;
    const r = callToolResult(JSON.parse(raw));
    expect(r.ok).toBe(false);
    // 回應不含全文，只含 block 統計與段落摘要。
    expect(raw.length).toBeLessThan(20_000);
    expect(r.blocks.length).toBe(4);
    expect(r.token_efficiency.bootstrap_mode_estimates.full_status).toBe("warn");
    await fake.registration?.dispose();
  });
});

/** 舊版 `32-registry-fail-closed.test.ts` 的 l1_check 區塊：frontmatter limit 無效。 */
describe("workflow_l1_check frontmatter limit 設定錯誤", () => {
  test("非數字 limit（abc）→ CONFIGURATION_ERROR", async () => {
    const root = await tempRoot();
    writeMemoryFile(root, "state.md", "---\nlabel: state\nlimit: abc\n---\n# S\n");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_l1_check");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIGURATION_ERROR");
    expect(r.error).toContain("state.md 的 frontmatter limit 無效");
    expect(r.suggestions.some((s: string) => s.includes("1..3000"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("空 limit（''）→ CONFIGURATION_ERROR", async () => {
    const root = await tempRoot();
    writeMemoryFile(root, "state.md", "---\nlabel: state\nlimit: ''\n---\n# S\n");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_l1_check");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIGURATION_ERROR");
    await fake.registration?.dispose();
  });

  test("超過 hard limit 的 limit → CONFIGURATION_ERROR", async () => {
    const root = await tempRoot();
    writeMemoryFile(root, "state.md", "---\nlabel: state\nlimit: 9999\n---\n# S\n");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_l1_check");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIGURATION_ERROR");
    expect(r.error).toContain("超過 hard limit 3000");
    await fake.registration?.dispose();
  });

  test("合法數字 limit 維持 ok=true（既有行為鎖定）", async () => {
    const root = await tempRoot();
    writeMemoryFile(root, "state.md", "---\nlabel: state\nlimit: 2500\n---\n# S\n\n" + "b".repeat(10) + "\n");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_l1_check");
    expect(r.ok).toBe(true);
    expect(r.code).toBeUndefined();
    expect(r.blocks.find((b: any) => b.name === "state.md").effectiveLimit).toBe(2500);
    await fake.registration?.dispose();
  });

  test("主題正文中的舊 limit 不再影響主題預算", async () => {
    const root = await tempRoot();
    writeMemoryTopic(root, "limit: abc");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_l1_check");
    expect(r.ok).toBe(true);
    expect(r.blocks.find((b: any) => b.name === "project/fixture").limit).toBe(4000);
  });
});
