/**
 * 14 — symlink containment 硬化（Red first）。
 *
 * 審查發現 #1：sourceResolver／directoryResolver／file-scan 只做 lexical
 * containment；worktree 內的 symlink 可讀到專案外內容。
 * 要求：canonical 化（realpath；不存在時取最近存在祖先）後仍在 root 內，
 * 否則讀取面丟結構化錯誤、hook 丟錯 fail closed。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  createWorkspace,
  setupCommentSignal,
  run,
  type CommentSignalFixture,
} from "./_helpers.ts";

describe("14 - symlink containment", () => {
  let ws: ReturnType<typeof createWorkspace>;
  let outside: ReturnType<typeof createWorkspace>;
  let fx: CommentSignalFixture;
  beforeEach(async () => {
    ws = createWorkspace();
    outside = createWorkspace();
    fx = await setupCommentSignal(ws.root);
    mkdirSync(join(ws.root, "src"), { recursive: true });
  });
  afterEach(async () => {
    await fx.cleanup();
    ws.cleanup();
    outside.cleanup();
  });

  test("explicit 檔案 symlink→外部：拒絕讀取（丟 outside worktree）", async () => {
    writeFileSync(join(outside.root, "evil.ts"), "// [TODO:P2] 外部檔案不該被讀到\n", "utf-8");
    symlinkSync(join(outside.root, "evil.ts"), join(ws.root, "src", "link.ts"));

    await expect(
      fx.tools["comment_signal_check"].execute(
        { path: "src/link.ts", changedOnly: false },
        { sessionID: "s1" },
      ),
    ).rejects.toThrow(/outside worktree/);
  });

  test("目錄內含 symlink→外部檔案：列舉時跳過，不洩漏外部內容", async () => {
    writeFileSync(join(ws.root, "src", "real.ts"), "// [TODO:P2] 內部檔案\n", "utf-8");
    writeFileSync(join(outside.root, "evil.ts"), "// [TODO:P2] 外部檔案不該被掃\n", "utf-8");
    symlinkSync(join(outside.root, "evil.ts"), join(ws.root, "src", "link.ts"));

    const out = await run(fx.tools["comment_signal_check"], { path: "src", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    const files = (out.violations as Array<{ filePath: string }>).map((v) => v.filePath);
    expect(files.every((f) => !f.includes("link.ts"))).toBe(true);
  });

  test("目錄 symlink→外部目錄：視同越界目錄直接丟錯（跟 lexical 越界一致）", async () => {
    writeFileSync(join(outside.root, "evil.ts"), "// [TODO:P2] 外部目錄內容\n", "utf-8");
    symlinkSync(outside.root, join(ws.root, "linkdir"));

    await expect(
      fx.tools["comment_signal_check"].execute(
        { path: "linkdir", changedOnly: false },
        { sessionID: "s1" },
      ),
    ).rejects.toThrow(/outside worktree/);
  });

  test("edit hook 經 symlink→外部路徑：丟錯阻斷", async () => {
    writeFileSync(join(outside.root, "evil.ts"), "// [TODO:P2] 外部檔案\n", "utf-8");
    symlinkSync(join(outside.root, "evil.ts"), join(ws.root, "src", "link.ts"));
    const before = fx.fake.toolHooks.get("execute.before");
    expect(before, "execute.before 已註冊").toBeDefined();

    await expect(
      before!({ tool: "edit", sessionID: "sess-link", input: { path: "src/link.ts" } }),
    ).rejects.toThrow(/outside worktree/);
  });

  test("symlink→內部檔案：照常讀取掃描（不誤傷）", async () => {
    writeFileSync(join(ws.root, "src", "real.ts"), "// [TODO:P2] 內部檔案\n", "utf-8");
    symlinkSync(join(ws.root, "src", "real.ts"), join(ws.root, "src", "alias.ts"));

    const out = await run(fx.tools["comment_signal_check"], { path: "src/alias.ts", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect(out.checkedCommentCount).toBe(1);
  });
});
