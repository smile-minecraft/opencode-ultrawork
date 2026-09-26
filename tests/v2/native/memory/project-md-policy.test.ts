/**
 * project-md-policy 測試。
 *
 * 由 tests/ultrawork/42-project-md-policy.test.ts 移植policy 本體案例：
 * 常數單一來源、null frontmatter fail-closed、limit 收緊／無效判定、
 * near-limit 0.8、CRLF 計數一致、段落排序、fence 排除、over-limit 提示，
 * 以及經由 project-memory-update 的 maxChars 精確邊界。
 * 原檔依賴 workflow_l1_check／doctor／health 的兩個診斷整合案例屬於
 * workflow／diagnostics 任務範圍，不在這裡重寫。
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupUltrawork } from "../../../../src/index.ts";
import { memoryModule } from "../../../../src/modules/memory/index.ts";
import {
  PROJECT_MD_HARD_LIMIT,
  STATE_MD_LIMIT,
  BOOTSTRAP_FULL_SOFT_BUDGET,
  PROJECT_MD_LIMIT,
  resolveProjectMdPolicy,
  resolveProjectMdPolicyFromContent,
  getProjectMdNearLimitThreshold,
  getProjectMdCurrentSections,
  getProjectMdOverLimitHint,
} from "../../../../src/modules/memory/project-md-policy.ts";
import { PROJECT_MD_LIMIT as CONST_LIMIT } from "../../../../src/modules/memory/constants.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../../_fake-v2-context.ts";

function parse(result: { content: string }): any {
  const parsed = JSON.parse(result.content) as Record<string, unknown>;
  if (parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
    for (const [key, value] of Object.entries(parsed.data)) {
      if (!(key in parsed)) {
        Object.defineProperty(parsed, key, { configurable: true, enumerable: false, value });
      }
    }
  }
  return parsed;
}

describe("project-md-policy", () => {
  test("常數單一來源：policy hard === constants limit === 7000", () => {
    expect(PROJECT_MD_HARD_LIMIT).toBe(7000);
    expect(CONST_LIMIT).toBe(7000);
    expect(PROJECT_MD_LIMIT).toBe(7000);
    expect(PROJECT_MD_HARD_LIMIT).toBe(CONST_LIMIT);
    expect(STATE_MD_LIMIT).toBe(3000);
    expect(BOOTSTRAP_FULL_SOFT_BUDGET).toBe(10_000);
  });

  test("null frontmatter → invalid fail-closed", () => {
    const r = resolveProjectMdPolicy(null);
    expect(r.isValid).toBe(false);
    expect(r.configurationError).toBeDefined();
    expect(r.effectiveLimit).toBe(7000);
    expect(r.hardLimit).toBe(7000);
  });

  test("有 frontmatter 但缺 limit → valid 7000", () => {
    const content = "---\nlabel: project\n---\n# Title\n\nbody";
    const r = resolveProjectMdPolicyFromContent(content);
    expect(r.isValid).toBe(true);
    expect(r.effectiveLimit).toBe(7000);
  });

  test("limit:5000 → effective 5000 且 isTightened", () => {
    const content = "---\nlabel: project\nlimit: 5000\n---\n# Title\n";
    const r = resolveProjectMdPolicyFromContent(content);
    expect(r.isValid).toBe(true);
    expect(r.effectiveLimit).toBe(5000);
    expect(r.isTightened).toBe(true);
  });

  test.each([
    ["0", "---\nlimit: 0\n---\n# H\n"],
    ["negative", "---\nlimit: -1\n---\n# H\n"],
    ["float", "---\nlimit: 3.14\n---\n# H\n"],
    ["NaN", "---\nlimit: NaN\n---\n# H\n"],
    ["Infinity", "---\nlimit: Infinity\n---\n# H\n"],
    ["array", "---\nlimit: [1,2]\n---\n# H\n"],
    ["empty string", "---\nlimit: ''\n---\n# H\n"],
    ["7001 exceeds hard", "---\nlimit: 7001\n---\n# H\n"],
  ])("無效 limit %s → invalid", (_label, content) => {
    const r = resolveProjectMdPolicyFromContent(content);
    expect(r.isValid).toBe(false);
    expect(r.configurationError).toBeDefined();
    expect(r.effectiveLimit).toBe(7000);
  });

  test("near-limit：7000→5600、5000→4000", () => {
    expect(getProjectMdNearLimitThreshold(7000)).toBe(5600);
    expect(getProjectMdNearLimitThreshold(5000)).toBe(4000);
  });

  test("CRLF 多行段落大小把 \\r 算進去", () => {
    const crlfBody = "line1\r\nline2\r\nline3";
    const contentLf = `---\nlabel: project\n---\n# Title\n\n## SecA\n${crlfBody.replaceAll("\r\n", "\n")}\n\n## SecB\nshort\n`;
    const contentCrlf = `---\nlabel: project\n---\n# Title\n\n## SecA\n${crlfBody}\n\n## SecB\nshort\n`;
    const secLf = getProjectMdCurrentSections(contentLf).find((s) => s.name === "SecA")!;
    const secCrlf = getProjectMdCurrentSections(contentCrlf).find((s) => s.name === "SecA")!;
    expect(secCrlf.size).toBe(secLf.size + 2);
    expect(secCrlf.size).toBe(crlfBody.length);
  });

  test("段落依大小降冪排序", () => {
    const content = `---\nlabel: project\n---\n# Title\n\n## Small\na\n\n## Large\n${"x".repeat(100)}\n\n## Medium\n${"y".repeat(50)}\n`;
    const secs = getProjectMdCurrentSections(content);
    expect(secs.map((s) => s.name)).toEqual(["Large", "Medium", "Small"]);
  });

  test("fence 內的假標題不算段落", () => {
    const content = `---\nlabel: project\n---\n# Title\n\n## Real\nreal body\n\n\`\`\`\n## FakeInside\n\`\`\`\n\n## Real2\nsecond\n`;
    const secs = getProjectMdCurrentSections(content);
    expect(secs.map((s) => s.name)).toEqual(expect.arrayContaining(["Real", "Real2"]));
    expect(secs.find((s) => s.name === "FakeInside")).toBeUndefined();
  });

  test("over-limit 提示用原始字數", () => {
    const overBody = "a".repeat(100);
    const limit = 7000;
    const base = `---\nlabel: project\n---\n# Title\n\n## A\n`;
    const raw = base + overBody + "\n";
    const overBy = raw.length - limit;
    const secs = getProjectMdCurrentSections(raw);
    const hint = getProjectMdOverLimitHint(limit, overBy, secs);
    expect(overBy).toBe(raw.length - limit);
    expect(hint).toContain(String(overBy));
    expect(hint).toContain(String(limit));
  });

  test("maxChars 精確邊界：projected == effective 放行，超過拒絕", async () => {
    const root = mkdtempSync(join(tmpdir(), "uw-md-policy-"));
    try {
      const memoryDir = join(root, ".ultrawork");
      mkdirSync(memoryDir, { recursive: true });
      const base = `---\nlabel: project\nlimit: 5000\n---\n# Title\n\n## Sec\ninit\n`;
      writeFileSync(join(memoryDir, "project.md"), base, "utf-8");

      const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
      const cleanup = await setupUltrawork(fake.ctx, { modules: [memoryModule] });
      try {
        const update = fake.added.get("project-memory-update");
        if (!update) throw new Error("project-memory-update 沒有註冊");
        const run = (args: Record<string, unknown>): Promise<any> =>
          update.execute(args, fakeV2ToolContext()).then(parse);

        let exactLen = 0;
        const limit = 5000;
        for (let len = 4000; len < 6000; len++) {
          const fill = "x".repeat(len);
          const preview = await run({ section: "Sec", content: fill, op: "replace", mode: "preview" });
          if (preview.ok && preview.projected_size === limit) { exactLen = len; break; }
          if (!preview.ok && preview.projected_size > limit) continue;
        }
        expect(exactLen).toBeGreaterThan(0);
        const previewExact = await run({ section: "Sec", content: "x".repeat(exactLen), op: "replace", mode: "preview" });
        expect(previewExact.ok).toBe(true);
        if (previewExact.ok) expect(previewExact.projected_size).toBe(limit);
        const previewOver = await run({ section: "Sec", content: "x".repeat(exactLen + 1), op: "replace", mode: "preview" });
        expect(previewOver.ok).toBe(false);
        expect(previewOver.code).toBe("PROJECT_MD_OVER_LIMIT");
      } finally {
        await cleanup();
      }
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // 清理失敗不擋測試結果
      }
    }
  });
});
