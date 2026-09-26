/**
 * 21 — 遞迴掃描敏感檔名過濾（Red first）。
 *
 * 審查發現（第六輪）：`listDirectoryFiles` 走訪只套段排除＋副檔名，
 * 未套敏感檔名過濾；白名單含 `.json`，故 `credentials.json`／
 * `service-account.json` 會被列出並讀入 parser。
 * 要求：走訪 entry 與 `inspectDirectoryListing` 都以 canonical policy path
 * 套 `isSensitivePath`；只有敏感檔的目錄視為空（語意以本檔測試釘住）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
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

const SECRET_JSON = '{"token": "s3cr3t"}\n';

describe("21 - 走訪敏感檔名過濾", () => {
  let ws: ReturnType<typeof createWorkspace>;
  let fx: CommentSignalFixture;
  beforeEach(async () => {
    ws = createWorkspace();
    fx = await setupCommentSignal(ws.root);
    mkdirSync(join(ws.root, "src"), { recursive: true });
    mkdirSync(join(ws.root, "src", "sub"), { recursive: true });
  });
  afterEach(async () => {
    await fx.cleanup();
    ws.cleanup();
  });

  test("單元：走訪跳過根與子目錄的敏感檔名，正常 .json 照列", async () => {
    writeFileSync(join(ws.root, "credentials.json"), SECRET_JSON, "utf-8");
    writeFileSync(join(ws.root, "src", "sub", "service-account.json"), SECRET_JSON, "utf-8");
    writeFileSync(join(ws.root, "ok.json"), '{"a": 1}\n', "utf-8");
    writeFileSync(join(ws.root, "src", "sub", "normal.json"), '{"b": 2}\n', "utf-8");

    expect(listDirectoryFiles(ws.root, ".")?.sort()).toEqual(["ok.json", "src/sub/normal.json"]);
  });

  test("單元：alias→目標目錄內的敏感檔不列出，正常檔照列（lexical 顯示）", async () => {
    writeFileSync(join(ws.root, "src", "sub", "credentials.json"), SECRET_JSON, "utf-8");
    writeFileSync(join(ws.root, "src", "sub", "normal.json"), '{"b": 2}\n', "utf-8");
    symlinkSync(join(ws.root, "src", "sub"), join(ws.root, "aliasdir"));

    expect(listDirectoryFiles(ws.root, "aliasdir")?.sort()).toEqual(["aliasdir/normal.json"]);
  });

  test("單元：alias→敏感目標檔不列出；alias→正常檔照列", async () => {
    writeFileSync(join(ws.root, "src", "sub", "credentials.json"), SECRET_JSON, "utf-8");
    writeFileSync(join(ws.root, "src", "sub", "normal.json"), '{"b": 2}\n', "utf-8");
    symlinkSync(join(ws.root, "src", "sub", "credentials.json"), join(ws.root, "link.json"));
    symlinkSync(join(ws.root, "src", "sub", "normal.json"), join(ws.root, "oklink.json"));

    const files = listDirectoryFiles(ws.root, ".")?.sort() ?? [];
    expect(files).not.toContain("link.json");
    expect(files).toContain("oklink.json");
    expect(files).toContain("src/sub/normal.json");
  });

  test("單元：inspect 只有敏感檔的目錄視為空；混合仍為 hasNonMarkdown", async () => {
    mkdirSync(join(ws.root, "only-secret"), { recursive: true });
    writeFileSync(join(ws.root, "only-secret", "credentials.json"), SECRET_JSON, "utf-8");
    expect(inspectDirectoryListing(ws.root, "only-secret")).toBe("empty");

    mkdirSync(join(ws.root, "mixed"), { recursive: true });
    writeFileSync(join(ws.root, "mixed", "credentials.json"), SECRET_JSON, "utf-8");
    writeFileSync(join(ws.root, "mixed", "ok.json"), '{"a": 1}\n', "utf-8");
    expect(inspectDirectoryListing(ws.root, "mixed")).toBe("hasNonMarkdown");
  });

  test("單元：.env.example 豁免不變（inspect 照常計入，不過濾）", async () => {
    mkdirSync(join(ws.root, "ex"), { recursive: true });
    writeFileSync(join(ws.root, "ex", ".env.example"), "X=1\n", "utf-8");
    expect(inspectDirectoryListing(ws.root, "ex")).toBe("hasNonMarkdown");
  });

  test("整合：check 掃只有敏感檔的目錄 → 零掃描、fail closed、不洩漏", async () => {
    mkdirSync(join(ws.root, "secrets"), { recursive: true });
    writeFileSync(join(ws.root, "secrets", "credentials.json"), SECRET_JSON, "utf-8");

    const out = await run(fx.tools["comment_signal_check"], { path: "secrets", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(true);
    expect(out.violations).toEqual([]);
  });

  test("整合：alias→敏感目錄照樣擋下", async () => {
    mkdirSync(join(ws.root, "real"), { recursive: true });
    writeFileSync(join(ws.root, "real", "service-account.json"), SECRET_JSON, "utf-8");
    symlinkSync(join(ws.root, "real"), join(ws.root, "alias-real"));

    const out = await run(fx.tools["comment_signal_check"], { path: "alias-real", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.violations).toEqual([]);
  });
});
