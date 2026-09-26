/**
 * 18 — 顯式資料夾根政策（Red first）。
 *
 * 審查發現（第三輪 #1）：`listDirectoryFiles` 只檢查走訪到的 entry，
 * 根目錄本身不檢查 dotfile／SCAN_EXCLUDED_DIRS／敏感路徑；
 * check／baseline／only_new 的資料夾分支會把這類根交給它，
 * 敏感／隱藏內容可能被解析、回傳或寫入 baseline。
 * 要求：根套用與 entry 相同政策，一律回 null（caller 走 fail-closed 空語意）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  inspectDirectoryListing,
  listDirectoryFiles,
} from "../../../../src/modules/comment-signal/file-scan.ts";
import {
  createWorkspace,
  setupCommentSignal,
  run,
  type CommentSignalFixture,
} from "./_helpers.ts";

const BLOCKABLE = "// [WARN:P1] 不該被讀到\n";

describe("18 - 資料夾根政策：隱藏／敏感／排除目錄", () => {
  let ws: ReturnType<typeof createWorkspace>;
  let fx: CommentSignalFixture;
  beforeEach(async () => {
    ws = createWorkspace();
    fx = await setupCommentSignal(ws.root);
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "ok.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
  });
  afterEach(async () => {
    await fx.cleanup();
    ws.cleanup();
  });

  test("check 掃 .hidden/ 根：一般 dot 目錄放行，內容照常掃描", async () => {
    // 政策變更（dot 目錄與 dot 檔分開處理）：`.hidden` 不是排除目錄也不是
    // 敏感路徑，其下的可掃描檔要掃、違規要擋，不再整段跳過。
    mkdirSync(join(ws.root, ".hidden"), { recursive: true });
    writeFileSync(join(ws.root, ".hidden", "child.ts"), BLOCKABLE, "utf-8");
    const out = await run(fx.tools["comment_signal_check"], { path: ".hidden/", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect(out.shouldBlockCompletion).toBe(true);
    const files = (out.violations as Array<{ filePath: string }>).map((v) => v.filePath);
    expect(files.some((f) => f === ".hidden/child.ts")).toBe(true);
  });

  test("check 掃 .env/ 根：不讀檔（fail-closed）", async () => {
    mkdirSync(join(ws.root, ".env"), { recursive: true });
    writeFileSync(join(ws.root, ".env", "child.ts"), BLOCKABLE, "utf-8");
    const out = await run(fx.tools["comment_signal_check"], { path: ".env/", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(true);
    expect(out.violations).toEqual([]);
  });

  test("baseline 掃 .git/ 根：不讀檔（空安全結果）", async () => {
    mkdirSync(join(ws.root, ".git"), { recursive: true });
    writeFileSync(join(ws.root, ".git", "child.ts"), BLOCKABLE, "utf-8");
    const out = await run(fx.tools["comment_signal_baseline"], { path: ".git", changedOnly: false, force: true });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.violationCount).toBe(0);
  });

  test("only_new 掃 .hidden/ 根：一般 dot 目錄放行，新增問題照常比對", async () => {
    // 政策變更（同上）：`.hidden` 根可掃，baseline 之後的新增違規要出現。
    mkdirSync(join(ws.root, ".hidden"), { recursive: true });
    writeFileSync(join(ws.root, ".hidden", "child.ts"), BLOCKABLE, "utf-8");
    await run(fx.tools["comment_signal_baseline"], { path: "src", changedOnly: false, force: true });
    const out = await run(fx.tools["comment_signal_only_new"], { path: ".hidden", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect((out.newViolations as unknown[]).length).toBeGreaterThan(0);
  });

  test("explain 指 .hidden 目錄：回安全錯誤（basename 仍是 dot 檔規則）", async () => {
    // explain 走顯式「單檔」路徑：basename 以 `.` 開頭仍拒絕（dot 檔規則不變）；
    // 放行的是 dot 目錄「之下」的檔案，不是 dot 路徑本身。
    mkdirSync(join(ws.root, ".hidden"), { recursive: true });
    writeFileSync(join(ws.root, ".hidden", "child.ts"), BLOCKABLE, "utf-8");
    const out = await run(fx.tools["comment_signal_explain"], { filePath: ".hidden", line: 1 });
    expect(out.ok).toBe(false);
  });

  test("explain 指 dot 目錄下的檔案：可診斷（不再整段跳過）", async () => {
    mkdirSync(join(ws.root, ".hidden"), { recursive: true });
    writeFileSync(join(ws.root, ".hidden", "child.ts"), BLOCKABLE, "utf-8");
    const out = await run(fx.tools["comment_signal_explain"], { filePath: ".hidden/child.ts", line: 1 });
    expect(out.ok).toBe(true);
  });

  test("正常內部資料夾不受影響", async () => {
    const out = await run(fx.tools["comment_signal_check"], { path: "src", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
  });

  test("單元：listDirectoryFiles／inspectDirectoryListing 對敏感／排除根回 null，一般 dot 目錄放行", async () => {
    for (const root of [".env", ".git"]) {
      mkdirSync(join(ws.root, root), { recursive: true });
      writeFileSync(join(ws.root, root, "child.ts"), BLOCKABLE, "utf-8");
      expect(listDirectoryFiles(ws.root, root)).toBeNull();
      expect(inspectDirectoryListing(ws.root, root)).toBeNull();
    }
    // 一般 dot 目錄：放行並列出其下檔案。
    mkdirSync(join(ws.root, ".hidden"), { recursive: true });
    writeFileSync(join(ws.root, ".hidden", "child.ts"), BLOCKABLE, "utf-8");
    expect(listDirectoryFiles(ws.root, ".hidden")).toEqual([".hidden/child.ts"]);
    expect(inspectDirectoryListing(ws.root, ".hidden")).toBe("hasNonMarkdown");
  });
});
