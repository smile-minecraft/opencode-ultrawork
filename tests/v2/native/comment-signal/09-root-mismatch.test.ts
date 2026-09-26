/**
 * 09 — Comment Signal root resolution（V2 新形狀）。
 *
 * 由 tests/ultrawork/comment-signal/09-root-mismatch.test.ts 移植。
 * 舊版測的是 V1 `ToolContext.worktree` 被誤設為 `/` 時退回 runtime 綁定
 * project root；V2 沒有 worktree 欄位，改為工作階段位置解析
 * （session.location.directory → project.directory → directory）。
 * 移植後覆蓋同等契約：
 *   1. 相對 supported executable path + changedOnly=false 可掃描。
 *   2. 工作階段位置優先於外掛實例位置（session 目錄才是準）。
 *   3. 專案外的絕對路徑仍被拒絕（fail closed，安全規則不退化）。
 *   4. 資料夾路徑 + changedOnly=false 可掃描。
 *   5. 專案根內的絕對 modifiedFiles path + changedOnly=true 可掃描。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { setupUltrawork } from "../../../../src/index.ts";
import { commentSignalModule } from "../../../../src/modules/comment-signal/index.ts";
import { CommentSignalStore } from "../../../../src/modules/comment-signal/state.ts";
import { createFakeV2Context } from "../../_fake-v2-context.ts";
import {
  createWorkspace,
  setupCommentSignal,
  run,
  type CommentSignalFixture,
} from "./_helpers.ts";

/** 在 workspace 內建立 fixture source 檔。 */
function writeSource(root: string, relativePath: string, body: string): string {
  const abs = join(root, relativePath);
  mkdirSync(join(root, relativePath.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(abs, body, "utf-8");
  return relativePath;
}

describe("09 - comment-signal root resolution（工作階段位置為準）", () => {
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

  test("(1) relative explicit supported path with changedOnly=false scans", async () => {
    const rel = writeSource(ws.root, "plugins/opencode-ultrawork/src/sample.ts", "// [TODO:P2] 之後處理\n");

    const out = await run(fx.tools["comment_signal_check"], { path: rel, changedOnly: false });
    expect(out.ok).toBe(true);
    // 預期掃到該檔（1 個 TODO comment）
    expect(out.scannedFileCount).toBe(1);
    expect(out.checkedCommentCount).toBeGreaterThanOrEqual(1);
  });

  test("(2) 工作階段位置優先：外掛實例位置錯誤也不誤導解析", async () => {
    // 外掛實例位置指向別處，但工作階段位置才是 workspace：工具照工作階段位置解析。
    writeSource(ws.root, "sample.ts", "// [TODO:P2] 之後處理\n");
    const fake = createFakeV2Context({ directory: "/other/plugin-dir", sessionDirectory: ws.root });
    const cleanup = await setupUltrawork(fake.ctx, { modules: [commentSignalModule] });
    try {
      const tools: Record<string, any> = Object.fromEntries([...fake.added.entries()]);
      const out = await run(tools["comment_signal_check"], { path: "sample.ts", changedOnly: false });
      expect(out.ok).toBe(true);
      expect(out.scannedFileCount).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("(3) /tmp/outside.ts still rejected (path safety preserved)", async () => {
    // 即使 session 位置正常，專案外的絕對路徑仍必須被拒絕（fail closed）。
    await expect(
      fx.tools["comment_signal_check"].execute(
        { path: "/tmp/outside.ts", changedOnly: false },
        { sessionID: "s1" },
      ),
    ).rejects.toThrow(/outside worktree/);
  });

  test("(4) explicit directory with changedOnly=false scans", async () => {
    writeSource(ws.root, "plugins/opencode-ultrawork/src/dir-sample.ts", "// [TODO:P2] 之後處理\n");

    const out = await run(fx.tools["comment_signal_check"], { path: "plugins/opencode-ultrawork", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
  });

  test("(5) absolute modifiedFiles path under project root + changedOnly=true scans", async () => {
    const abs = join(ws.root, "src", "auth", "login.ts");
    mkdirSync(join(ws.root, "src", "auth"), { recursive: true });
    writeFileSync(abs, "// [TODO:P2] 之後處理\n", "utf-8");

    // 模擬 child session 寫入絕對路徑的 modifiedFiles 聚合
    await fx.store.recordModifiedFile("s1", abs);

    const out = await run(fx.tools["comment_signal_check"], {}, "s1");
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
  });
});
