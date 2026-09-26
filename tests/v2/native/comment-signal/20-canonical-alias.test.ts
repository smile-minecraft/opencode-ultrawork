/**
 * 20 — symlink 別名政策繞過（Red first，根因修法）。
 *
 * 審查發現（第五輪）：`worktree/alias -> .hidden` 時，
 * `listDirectoryFiles(worktree, "alias")` 回 `["alias/child.ts"]`、
 * `comment_signal_check(path:"alias/")` 照掃；單檔 `alias/child.ts`
 *（真身 `.env/child.ts`）也判定 scannable 並讀到敏感內容。
 * 根因：三個判定 helper 只看字面路徑，canonical 別名一現形就放行。
 * 要求：政策判定一律以 canonical 路徑為準（單一入口），
 * alias→正常內部檔／夾的既有可掃行為保留。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  listDirectoryFiles,
  toPolicyRelativePath,
} from "../../../../src/modules/comment-signal/file-scan.ts";
import {
  createWorkspace,
  setupCommentSignal,
  run,
  type CommentSignalFixture,
} from "./_helpers.ts";

const BLOCKABLE = "// [WARN:P1] 不該被讀到\n";

describe("20 - symlink 別名政策繞過", () => {
  let ws: ReturnType<typeof createWorkspace>;
  let fx: CommentSignalFixture;
  beforeEach(async () => {
    ws = createWorkspace();
    fx = await setupCommentSignal(ws.root);
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "ok.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
    // 真身：隱藏／敏感目錄＋可掃內容
    for (const dir of [".hidden", ".env", ".git"]) {
      mkdirSync(join(ws.root, dir), { recursive: true });
      writeFileSync(join(ws.root, dir, "child.ts"), BLOCKABLE, "utf-8");
    }
    // 別名：資料夾 symlink
    symlinkSync(join(ws.root, ".hidden"), join(ws.root, "alias-hidden"));
    symlinkSync(join(ws.root, ".env"), join(ws.root, "alias-env"));
    symlinkSync(join(ws.root, ".git"), join(ws.root, "alias-git"));
    symlinkSync(join(ws.root, "src"), join(ws.root, "alias-src"));
    // 別名：單檔 symlink（真身敏感／正常）
    symlinkSync(join(ws.root, ".env", "child.ts"), join(ws.root, "alias-child.ts"));
    symlinkSync(join(ws.root, "src", "ok.ts"), join(ws.root, "alias-ok.ts"));
  });
  afterEach(async () => {
    await fx.cleanup();
    ws.cleanup();
  });

  test("單元：toPolicyRelativePath 讓別名現形", async () => {
    expect(toPolicyRelativePath(ws.root, "alias-hidden/child.ts")).toBe(".hidden/child.ts");
    expect(toPolicyRelativePath(ws.root, "alias-child.ts")).toBe(".env/child.ts");
    // 正常路徑原樣；別名指正常內部維持正常相對路徑
    expect(toPolicyRelativePath(ws.root, "src/ok.ts")).toBe("src/ok.ts");
    expect(toPolicyRelativePath(ws.root, "alias-src/ok.ts")).toBe("src/ok.ts");
    expect(toPolicyRelativePath(ws.root, "alias-ok.ts")).toBe("src/ok.ts");
  });

  test("單元：canonical 已在 root 外時回退字面路徑（交給 containment）", async () => {
    const rel = toPolicyRelativePath(ws.root, "/tmp/outside.ts");
    // 不回傳 ../ 開頭的 canonical 相對路徑（避免政策層誤判 dotfile）
    expect(rel.startsWith("..")).toBe(false);
  });

  test("list 經 alias→.hidden：不列出（回 null，fail-closed）", async () => {
    expect(listDirectoryFiles(ws.root, "alias-hidden")).toBeNull();
    expect(listDirectoryFiles(ws.root, "alias-env")).toBeNull();
    expect(listDirectoryFiles(ws.root, "alias-git")).toBeNull();
  });

  test("check 掃 alias 資料夾：不讀檔（fail-closed，不洩漏）", async () => {
    for (const alias of ["alias-hidden/", "alias-env/", "alias-git/"]) {
      const out = await run(fx.tools["comment_signal_check"], { path: alias, changedOnly: false });
      expect(out.ok).toBe(true);
      expect(out.scannedFileCount).toBe(0);
      expect(out.shouldBlockCompletion).toBe(true);
      expect(out.violations).toEqual([]);
    }
  });

  test("check 顯式單檔 alias（真身敏感）：不讀不掃", async () => {
    const out = await run(fx.tools["comment_signal_check"], { path: "alias-child.ts", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
    expect(out.violations).toEqual([]);
  });

  test("baseline 掃 alias 資料夾：不讀檔（空安全結果）", async () => {
    const out = await run(fx.tools["comment_signal_baseline"], { path: "alias-env", changedOnly: false, force: true });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.violationCount).toBe(0);
  });

  test("only_new 掃 alias 資料夾：不讀檔（空安全結果）", async () => {
    await run(fx.tools["comment_signal_baseline"], { path: "src", changedOnly: false, force: true });
    const out = await run(fx.tools["comment_signal_only_new"], { path: "alias-git", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.newViolations).toEqual([]);
  });

  test("explain 單檔 alias（真身敏感）：回安全錯誤", async () => {
    const out = await run(fx.tools["comment_signal_explain"], { filePath: "alias-child.ts", line: 1 });
    expect(out.ok).toBe(false);
  });

  test("正向：alias→正常內部資料夾照常掃", async () => {
    const out = await run(fx.tools["comment_signal_check"], { path: "alias-src", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
  });

  test("正向：alias→正常內部單檔照常掃", async () => {
    const out = await run(fx.tools["comment_signal_check"], { path: "alias-ok.ts", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
  });

  test("正向：alias 指 .env.example 仍走既有豁免語意（不列入掃描、不阻擋）", async () => {
    // lexical 形狀（alias-ex.ts）看似可掃，canonical 真身 .env.example 走既有
    // 豁免＋副檔名過濾：不讀不掃、不阻斷（跟直接指 .env.example 一致）。
    writeFileSync(join(ws.root, ".env.example"), "// [TODO:P2] 範例\n", "utf-8");
    symlinkSync(join(ws.root, ".env.example"), join(ws.root, "alias-ex.ts"));
    const out = await run(fx.tools["comment_signal_check"], { path: "alias-ex.ts", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
  });
});
