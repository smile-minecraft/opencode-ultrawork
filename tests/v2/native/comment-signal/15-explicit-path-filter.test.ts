/**
 * 15 — explicit path 過濾一致化（Red first）。
 *
 * 審查發現 #5：check／explain 的 explicit path 可繞過目錄掃描的
 * dotfile／支援副檔名／敏感路徑過濾（目錄掃描直接排除這些 entry）。
 * 要求：explicit path 套用相同過濾；敏感檔案一律不讀。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createWorkspace,
  setupCommentSignal,
  run,
  type CommentSignalFixture,
} from "./_helpers.ts";

describe("15 - explicit path 過濾與目錄掃描一致", () => {
  let ws: ReturnType<typeof createWorkspace>;
  let fx: CommentSignalFixture;
  beforeEach(async () => {
    ws = createWorkspace();
    fx = await setupCommentSignal(ws.root);
    mkdirSync(join(ws.root, "src"), { recursive: true });
  });
  afterEach(async () => {
    await fx.cleanup();
    ws.cleanup();
  });

  test("check explicit .env：不讀不掃（縱使內容含非法 tag 也不阻擋）", async () => {
    writeFileSync(join(ws.root, ".env"), "// [WARN:P1] 讀到就會 UNKNOWN_TAG\n", "utf-8");
    const out = await run(fx.tools["comment_signal_check"], { path: ".env", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
  });

  test("check explicit 不支援副檔名（.csv）：不讀不掃", async () => {
    writeFileSync(join(ws.root, "src", "data.csv"), "// [WARN:P1] 非掃描副檔名\n", "utf-8");
    const out = await run(fx.tools["comment_signal_check"], { path: "src/data.csv", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
  });

  test("check explicit dotfile（.hidden.ts）：不讀不掃", async () => {
    writeFileSync(join(ws.root, "src", ".hidden.ts"), "// [WARN:P1] 隱藏檔\n", "utf-8");
    const out = await run(fx.tools["comment_signal_check"], { path: "src/.hidden.ts", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
  });

  test("check explicit .env.example：跟目錄掃描一致，不列入掃描（.example 非支援副檔名）", async () => {
    // 目錄掃描的副檔名過濾同樣排除 .env.example（只有 dotfile／敏感兩層豁免它）；
    // explicit 路徑一致化：不讀不掃、不阻擋、不丟錯。
    writeFileSync(join(ws.root, ".env.example"), "// [WARN:P1] 範例檔\n", "utf-8");
    const out = await run(fx.tools["comment_signal_check"], { path: ".env.example", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
  });

  test("explain .env：拒絕讀取（ok:false，訊息指明敏感路徑）", async () => {
    writeFileSync(join(ws.root, ".env"), "SECRET=xxx\n", "utf-8");
    const out = await run(fx.tools["comment_signal_explain"], { filePath: ".env", line: 1 });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toMatch(/敏感|SENSITIVE|sensitive/i);
  });

  test("explain 不支援副檔名：ok:false（不讀檔）", async () => {
    writeFileSync(join(ws.root, "src", "data.csv"), "a,b\n", "utf-8");
    const out = await run(fx.tools["comment_signal_explain"], { filePath: "src/data.csv", line: 1 });
    expect(out.ok).toBe(false);
  });
});

describe("15 - changed-only 與 hook 讀取政策一致", () => {
  let ws: ReturnType<typeof createWorkspace>;
  let fx: CommentSignalFixture;
  beforeEach(async () => {
    ws = createWorkspace();
    fx = await setupCommentSignal(ws.root);
    mkdirSync(join(ws.root, "src"), { recursive: true });
  });
  afterEach(async () => {
    await fx.cleanup();
    ws.cleanup();
  });

  test("changed-only：modifiedFiles 含 .env 時不讀不掃（計入 skipped）", async () => {
    writeFileSync(join(ws.root, ".env"), "// [WARN:P1] 讀到就會 UNKNOWN_TAG\n", "utf-8");
    writeFileSync(join(ws.root, "src", "a.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
    await fx.store.recordModifiedFile("s1", ".env");
    await fx.store.recordModifiedFile("s1", "src/a.ts");

    const out = await run(fx.tools["comment_signal_check"], {}, "s1");
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect(out.skippedFileCount).toBe(1);
    expect(out.shouldBlockCompletion).toBe(false);
  });

  test("changed-only：modifiedFiles 含 dotfile（.hidden.ts）時不讀不掃", async () => {
    writeFileSync(join(ws.root, "src", ".hidden.ts"), "// [WARN:P1] 隱藏檔\n", "utf-8");
    await fx.store.recordModifiedFile("s1", "src/.hidden.ts");

    const out = await run(fx.tools["comment_signal_check"], {}, "s1");
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.skippedFileCount).toBe(1);
    expect(out.shouldBlockCompletion).toBe(false);
  });
});
