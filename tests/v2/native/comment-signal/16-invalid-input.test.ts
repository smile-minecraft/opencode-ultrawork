/**
 * 16 — malformed args 回 INVALID_INPUT 形狀（定性測試）。
 *
 * 審查發現 #6：defineTool 的 schema 驗證失敗路徑（ok:false＋code
 * INVALID_INPUT）補精確測試，7 個工具各一案。實作面無需變更；
 * 本檔釘住形狀，避免日後退化。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createWorkspace,
  setupCommentSignal,
  parse,
  type CommentSignalFixture,
} from "./_helpers.ts";

const CASES: Array<{ tool: string; malformed: unknown }> = [
  { tool: "comment_signal_check", malformed: { path: 123 } },
  { tool: "comment_signal_policy", malformed: "nope" },
  { tool: "comment_signal_touched_report", malformed: { sessionID: 42 } },
  { tool: "comment_signal_explain", malformed: { line: "two" } },
  { tool: "comment_signal_baseline", malformed: { force: "yes" } },
  { tool: "comment_signal_suppress", malformed: {} },
  { tool: "comment_signal_only_new", malformed: { changedOnly: "no" } },
];

describe("16 - malformed args 回 INVALID_INPUT", () => {
  let ws: ReturnType<typeof createWorkspace>;
  let fx: CommentSignalFixture;
  beforeEach(async () => {
    ws = createWorkspace();
    fx = await setupCommentSignal(ws.root);
  });
  afterEach(async () => {
    await fx.cleanup();
    ws.cleanup();
  });

  for (const { tool, malformed } of CASES) {
    test(`${tool} 收到型別不符參數時回 ok:false＋INVALID_INPUT`, async () => {
      const raw = await fx.tools[tool].execute(malformed, { sessionID: "s1" });
      const out = parse(raw);
      expect(out.ok).toBe(false);
      expect(out.code).toBe("INVALID_INPUT");
      expect(typeof out.summary).toBe("string");
      expect(out.summary as string).toMatch(/輸入驗證失敗/);
      expect(typeof out.nextAction).toBe("string");
    });
  }

  test("suppress 缺必填欄位時回 INVALID_INPUT（不走到 INVALID_ARGS）", async () => {
    const out = parse(
      await fx.tools["comment_signal_suppress"].execute({ filePath: "src/a.ts" }, { sessionID: "s1" }),
    );
    expect(out.ok).toBe(false);
    expect(out.code).toBe("INVALID_INPUT");
  });
});
