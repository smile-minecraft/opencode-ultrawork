/**
 * 07-hooks — Comment Signal execute.before／after（V2 新形狀）。
 *
 * 由 tests/ultrawork/07-hooks.test.ts 的 Comment Signal 段落移植：
 * guardBeforeEdit（P0 阻斷／highRisk 警告）、tool.execute.after
 *（成功紀錄 modifiedFiles）、guardAfterEdit（post-edit 警告＋lastReport）、
 * Markdown 忽略。Vault／Evidence Pack 屬 workflow，不搬。
 *
 * V2 差異：
 *   - hook 事件為單一物件：`input` 取代 `args`；edit／write 路徑參數為
 *     `path`，patch 走 `patchText`（含 Add／Update／Delete／Move 標頭）。
 *   - 失敗判定用 `status`：只有 `completed` 才記錄，不再解析 output 字串。
 *
 * P0 阻斷/G3 傳統：header 內不寫完整 functional tag literal
 *（以 TAG_OPEN 拼接），避免測試檔自身被掃描器命中。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { setupUltrawork } from "../../../../src/index.ts";
import { commentSignalModule } from "../../../../src/modules/comment-signal/index.ts";
import { createFakeV2Context } from "../../_fake-v2-context.ts";
import {
  createWorkspace,
  setupCommentSignal,
  run,
  type CommentSignalFixture,
} from "./_helpers.ts";

const TAG_OPEN = "[";

/** 取出已註冊的 before／after hook。 */
function hooksOf(fx: CommentSignalFixture) {
  const before = fx.fake.toolHooks.get("execute.before");
  const after = fx.fake.toolHooks.get("execute.after");
  expect(before, "execute.before 已註冊").toBeDefined();
  expect(after, "execute.after 已註冊").toBeDefined();
  return { before: before!, after: after! };
}

// ─── Comment Signal guardBeforeEdit ───────────────────────────

describe("07 - hooks: Comment Signal guardBeforeEdit", () => {
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

  test("edit 遇 AI_DO_NOT_EDIT:P0 必須 throw 阻斷", async () => {
    writeFileSync(
      join(ws.root, "src", "codegen.ts"),
      "// " + TAG_OPEN + "AI_DO_NOT_EDIT:P0] 此檔由 codegen 自動產生，禁止人工修改。\n",
      "utf-8",
    );
    const { before } = hooksOf(fx);

    await expect(
      before({ tool: "edit", sessionID: "sess-ai-dne", input: { path: "src/codegen.ts" } }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);
  });

  test("write 遇 AI_DO_NOT_EDIT:P0 必須 throw 阻斷", async () => {
    writeFileSync(
      join(ws.root, "src", "codegen.ts"),
      "// " + TAG_OPEN + "AI_DO_NOT_EDIT:P0] 此檔由 codegen 自動產生，禁止人工修改。\n",
      "utf-8",
    );
    const { before } = hooksOf(fx);

    await expect(
      before({ tool: "write", sessionID: "sess-write-dne", input: { path: "src/codegen.ts" } }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);
  });

  test("patch 遇 AI_DO_NOT_EDIT:P0（patchText 標頭）必須 throw 阻斷", async () => {
    writeFileSync(
      join(ws.root, "src", "codegen.ts"),
      "// " + TAG_OPEN + "AI_DO_NOT_EDIT:P0] 此檔由 codegen 自動產生，禁止人工修改。\n",
      "utf-8",
    );
    writeFileSync(join(ws.root, "src", "clean.ts"), "// [目的] 乾淨檔案。\n", "utf-8");
    const { before } = hooksOf(fx);

    await expect(
      before({
        tool: "patch",
        sessionID: "sess-patch-dne",
        input: { patchText: "*** Update File: src/codegen.ts\n@@ patch body\n" },
      }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);
  });

  test("patch 多路徑：乾淨檔夾帶 P0 檔仍整筆阻斷", async () => {
    writeFileSync(
      join(ws.root, "src", "codegen.ts"),
      "// " + TAG_OPEN + "AI_DO_NOT_EDIT:P0] 禁止修改。\n",
      "utf-8",
    );
    writeFileSync(join(ws.root, "src", "clean.ts"), "// [目的] 乾淨檔案。\n", "utf-8");
    const { before } = hooksOf(fx);

    await expect(
      before({
        tool: "patch",
        sessionID: "sess-patch-multi",
        input: {
          patchText: [
            "*** Add File: src/clean.ts",
            "+++ clean body",
            "*** Delete File: src/codegen.ts",
            "--- removed",
          ].join("\n"),
        },
      }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);
  });

  test("patch Move to 目標含 P0 也阻斷", async () => {
    writeFileSync(
      join(ws.root, "src", "codegen.ts"),
      "// " + TAG_OPEN + "AI_DO_NOT_EDIT:P0] 禁止修改。\n",
      "utf-8",
    );
    const { before } = hooksOf(fx);

    await expect(
      before({
        tool: "patch",
        sessionID: "sess-patch-move",
        input: {
          patchText: ["*** Update File: src/old.ts", "*** Move to: src/codegen.ts"].join("\n"),
        },
      }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);
  });

  test("其他 highRisk（SECURITY:P1）只記 warning 不 throw", async () => {
    writeFileSync(
      join(ws.root, "src", "auth.ts"),
      "// [SECURITY:P1 owner=@auth issue=#391] 不要將 token 寫入 log，否則會洩漏。\n",
      "utf-8",
    );
    const { before } = hooksOf(fx);
    const sessionID = "sess-sec";

    // 不應 throw
    await before({ tool: "edit", sessionID, input: { path: "src/auth.ts" } });

    // 但必須推入 warning
    const warnings = await fx.store.getWarnings(sessionID);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.tag === "SECURITY" && w.severity === "P1")).toBe(true);
  });

  test("DANGER:P1 / PRIVACY:P1 / DATA:P1 等 highRisk 只警告不 throw", async () => {
    writeFileSync(
      join(ws.root, "src", "ops.ts"),
      [
        "// [DANGER:P1 owner=@ops] rm -rf 整個 build/，否則會誤刪用戶資料。",
        "// [PRIVACY:P1 owner=@auth] 不可將 PII 寫入 telemetry，否則違反 GDPR。",
        "// [DATA:P1] 此欄位移除會破壞舊版 client 解析。",
      ].join("\n") + "\n",
      "utf-8",
    );
    const { before } = hooksOf(fx);
    const sessionID = "sess-multi-hr";

    // 不應 throw
    await before({ tool: "edit", sessionID, input: { path: "src/ops.ts" } });

    const warnings = await fx.store.getWarnings(sessionID);
    const tags = warnings.map((w) => w.tag);
    expect(tags).toContain("DANGER");
    expect(tags).toContain("PRIVACY");
    expect(tags).toContain("DATA");
  });

  test("檔案不存在（新檔案）時 guardBeforeEdit 跳過，不 throw", async () => {
    const { before } = hooksOf(fx);

    // 不應 throw（檔案不存在 = 新檔案，跳過 guard）
    await before({ tool: "write", sessionID: "sess-new", input: { path: "src/never-existed.ts" } });

    expect((await fx.store.getWarnings("sess-new")).length).toBe(0);
  });

  test("非 highRisk 註解不推入 warning", async () => {
    writeFileSync(
      join(ws.root, "src", "ok.ts"),
      ["// [目的] 提供 utility helpers。", "// [TODO:P2] 之後補上單元測試。"].join("\n") + "\n",
      "utf-8",
    );
    const { before } = hooksOf(fx);

    // 不應 throw
    await before({ tool: "edit", sessionID: "sess-ok", input: { path: "src/ok.ts" } });

    expect((await fx.store.getWarnings("sess-ok")).length).toBe(0);
  });

  test("從 input.filePath / input.path / input.file 多種欄位抽取路徑", async () => {
    writeFileSync(
      join(ws.root, "src", "codegen.ts"),
      "// " + TAG_OPEN + "AI_DO_NOT_EDIT:P0] 禁止修改。\n",
      "utf-8",
    );
    const { before } = hooksOf(fx);

    // V2 路徑參數 path
    await expect(
      before({ tool: "edit", sessionID: "sess-path", input: { path: "src/codegen.ts" } }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);

    // 相容 filePath 欄位
    await expect(
      before({ tool: "edit", sessionID: "sess-filepath", input: { filePath: "src/codegen.ts" } }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);

    // 相容 file 欄位
    await expect(
      before({ tool: "edit", sessionID: "sess-file", input: { file: "src/codegen.ts" } }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);
  });

  test("非 file-modifying tool 不觸發 guard", async () => {
    writeFileSync(
      join(ws.root, "src", "codegen.ts"),
      "// " + TAG_OPEN + "AI_DO_NOT_EDIT:P0] 禁止修改。\n",
      "utf-8",
    );
    const { before } = hooksOf(fx);

    // read 即使指向 P0 檔也不阻斷
    await before({ tool: "read", sessionID: "sess-read", input: { path: "src/codegen.ts" } });
    expect((await fx.store.getWarnings("sess-read")).length).toBe(0);
  });
});

// ─── Comment Signal tool.execute.after ──────────────────────

describe("07 - hooks: tool.execute.after records modifiedFiles", () => {
  let ws: ReturnType<typeof createWorkspace>;
  let fx: CommentSignalFixture;
  beforeEach(async () => {
    ws = createWorkspace();
    fx = await setupCommentSignal(ws.root);
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "a.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
  });
  afterEach(async () => {
    await fx.cleanup();
    ws.cleanup();
  });

  test("edit 成功後 record modifiedFiles", async () => {
    const { after } = hooksOf(fx);
    const sessionID = "sess-edit-ok";

    await after({ tool: "edit", sessionID, status: "completed", input: { path: "src/a.ts" } });

    expect(await fx.store.getModifiedFiles(sessionID)).toContain("src/a.ts");
  });

  test("write 成功後 record modifiedFiles", async () => {
    const { after } = hooksOf(fx);
    const sessionID = "sess-write-ok";

    await after({ tool: "write", sessionID, status: "completed", input: { path: "src/a.ts" } });

    expect(await fx.store.getModifiedFiles(sessionID)).toContain("src/a.ts");
  });

  test("patch 成功後 record modifiedFiles（patchText 多路徑全記）", async () => {
    const { after } = hooksOf(fx);
    const sessionID = "sess-patch-ok";

    await after({
      tool: "patch",
      sessionID,
      status: "completed",
      input: { patchText: "*** Update File: src/a.ts\n*** Add File: src/b.ts\n" },
    });

    // src/b.ts 不存在也照記（record 不讀檔；掃描時才跳過）
    expect(await fx.store.getModifiedFiles(sessionID)).toContain("src/a.ts");
    expect(await fx.store.getModifiedFiles(sessionID)).toContain("src/b.ts");
  });

  test("apply_patch 成功後 record modifiedFiles", async () => {
    const { after } = hooksOf(fx);
    const sessionID = "sess-applypatch-ok";

    await after({ tool: "apply_patch", sessionID, status: "completed", input: { path: "src/a.ts" } });

    expect(await fx.store.getModifiedFiles(sessionID)).toContain("src/a.ts");
  });

  test("edit 失敗（status=error）不記錄", async () => {
    const { after } = hooksOf(fx);
    const sessionID = "sess-edit-fail";

    await after({ tool: "edit", sessionID, status: "error", input: { path: "src/a.ts" } });

    expect(await fx.store.getModifiedFiles(sessionID)).toEqual([]);
  });

  test("write 失敗（status=error）不記錄", async () => {
    const { after } = hooksOf(fx);
    const sessionID = "sess-write-fail";

    await after({ tool: "write", sessionID, status: "error", input: { path: "src/a.ts" } });

    expect(await fx.store.getModifiedFiles(sessionID)).toEqual([]);
  });

  test("patch 失敗（status=error）不記錄", async () => {
    const { after } = hooksOf(fx);
    const sessionID = "sess-patch-fail";

    await after({ tool: "patch", sessionID, status: "error", input: { path: "src/a.ts" } });

    expect(await fx.store.getModifiedFiles(sessionID)).toEqual([]);
  });

  test("非 file-modifying tool（read）不記錄 modifiedFiles", async () => {
    const { after } = hooksOf(fx);
    const sessionID = "sess-read";

    await after({ tool: "read", sessionID, status: "completed", input: { path: "src/a.ts" } });

    expect(await fx.store.getModifiedFiles(sessionID)).toEqual([]);
  });

  test("非 file-modifying tool（shell）不記錄 modifiedFiles", async () => {
    const { after } = hooksOf(fx);
    const sessionID = "sess-shell";

    await after({ tool: "shell", sessionID, status: "completed", input: { command: "ls src/a.ts" } });

    expect(await fx.store.getModifiedFiles(sessionID)).toEqual([]);
  });

  test("sessionID 隔離：兩個 session 互不干擾", async () => {
    const { after } = hooksOf(fx);

    await after({ tool: "edit", sessionID: "session-A", status: "completed", input: { path: "src/a.ts" } });
    await after({ tool: "edit", sessionID: "session-B", status: "completed", input: { path: "src/a.ts" } });

    expect(await fx.store.getModifiedFiles("session-A")).toContain("src/a.ts");
    expect(await fx.store.getModifiedFiles("session-B")).toContain("src/a.ts");
    // 兩個 session 互不污染：各自只有一筆記錄
    expect((await fx.store.getModifiedFiles("session-A")).length).toBe(1);
    expect((await fx.store.getModifiedFiles("session-B")).length).toBe(1);
  });

  test("input 缺路徑時不記錄", async () => {
    const { after } = hooksOf(fx);
    const sessionID = "sess-no-fp";

    await after({ tool: "edit", sessionID, status: "completed", input: {} });

    expect(await fx.store.getModifiedFiles(sessionID)).toEqual([]);
  });

  test("成功後 comment_signal_check 預設掃 modifiedFiles 內檔案", async () => {
    // 端對端整合：tool.execute.after → recordModifiedFile → comment_signal_check 預設掃它
    const { after } = hooksOf(fx);

    // 模擬主要 agent 對 src/a.ts 執行 edit
    await after({ tool: "edit", sessionID: "sess-e2e", status: "completed", input: { path: "src/a.ts" } });

    const result = await run(fx.tools["comment_signal_check"], {}, "sess-e2e");
    expect(result.ok).toBe(true);
    expect(result.scannedFileCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── Comment Signal guardAfterEdit（post-edit 行為）──────────

describe("07 - hooks: guardAfterEdit post-edit highRisk recording", () => {
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

  test("post-edit 偵測到 highRisk 時推入 warning", async () => {
    // 先建立一個無 highRisk 的檔案
    writeFileSync(join(ws.root, "src", "x.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
    const { after } = hooksOf(fx);
    const sessionID = "sess-post";

    // 模擬 edit 成功後的 after hook（內容已包含 SECURITY:P1）
    writeFileSync(join(ws.root, "src", "x.ts"), "// [SECURITY:P1 owner=@auth] 不要將 token 寫入 log\n", "utf-8");

    await after({ tool: "edit", sessionID, status: "completed", input: { path: "src/x.ts" } });

    const warnings = await fx.store.getWarnings(sessionID);
    expect(warnings.map((w) => w.tag)).toContain("SECURITY");
  });

  test("post-edit 後 lastReport 應被更新（若有 violation）", async () => {
    writeFileSync(join(ws.root, "src", "warn.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
    const { after } = hooksOf(fx);
    const sessionID = "sess-report";

    await after({ tool: "edit", sessionID, status: "completed", input: { path: "src/warn.ts" } });

    // 用 touched_report 確認 lastReport 已落地
    const result = await run(fx.tools["comment_signal_touched_report"], { sessionID }, sessionID);
    expect(result.ok).toBe(true);
    expect(result.lastReport).toBeDefined();
    expect(result.lastReport.scannedFileCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── 事件形狀寬容：未知欄位不影響 hook ───────────

describe("07 - hooks: after hook 忽略事件上的額外欄位", () => {
  let ws: ReturnType<typeof createWorkspace>;
  let fx: CommentSignalFixture;
  beforeEach(async () => {
    ws = createWorkspace();
    fx = await setupCommentSignal(ws.root);
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "a.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
  });
  afterEach(async () => {
    await fx.cleanup();
    ws.cleanup();
  });

  test("after hook 在事件含額外屬性時仍可正常運作", async () => {
    // 確認 hook 只讀自己需要的欄位（tool／sessionID／status／input）
    const { after } = hooksOf(fx);
    const sessionID = "sess-extra";

    await after({
      tool: "edit",
      sessionID,
      status: "completed",
      input: { path: "src/a.ts" },
      // 即使呼叫端多塞欄位也應忽略
      ...{ message: "should be ignored", output: "OK", title: "edit" },
    } as never);

    expect(await fx.store.getModifiedFiles(sessionID)).toContain("src/a.ts");
  });
});

// ─── Comment Signal 忽略 Markdown 檔案────
//
// Hook 層也必須避開 Markdown：MD 檔案即使含 AI_DO_NOT_EDIT:P0 等 highRisk
// 標籤，也不應觸發 throw 阻斷；after 階段也不應把 MD 寫入 modifiedFiles.

describe("07 - hooks: Comment Signal ignores Markdown (guardBeforeEdit)", () => {
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

  test("MD 檔案即使含 AI_DO_NOT_EDIT:P0 也不 throw 阻斷", async () => {
    // 在 MD 內放 AI_DO_NOT_EDIT:P0 — 預期 hook 完全忽略這個檔案，
    // 不應 throw，也不應推入 warning。
    writeFileSync(
      join(ws.root, "README.md"),
      "// " + TAG_OPEN + "AI_DO_NOT_EDIT:P0] 此檔禁止修改（但因為是 MD 應被忽略）。\n",
      "utf-8",
    );
    const { before } = hooksOf(fx);

    // 不應 throw
    await before({ tool: "edit", sessionID: "sess-md-dne", input: { path: "README.md" } });

    // 也不應推入 warning
    expect((await fx.store.getWarnings("sess-md-dne")).length).toBe(0);
  });

  test("MD 檔案含 SECURITY:P1 等 highRisk 也不推入 warning", async () => {
    mkdirSync(join(ws.root, "docs"), { recursive: true });
    writeFileSync(join(ws.root, "docs", "notes.markdown"), "// [SECURITY:P1 owner=@auth] MD 內的 security 提示不該被掃\n", "utf-8");
    const { before } = hooksOf(fx);
    const sessionID = "sess-md-sec";

    // 不應 throw、也不應推 warning
    await before({ tool: "edit", sessionID, input: { path: "docs/notes.markdown" } });

    expect((await fx.store.getWarnings(sessionID)).length).toBe(0);
  });

  test("大小寫不敏感：UPPER.MD 也跳過", async () => {
    writeFileSync(
      join(ws.root, "CHANGELOG.MD"),
      "// " + TAG_OPEN + "AI_DO_NOT_EDIT:P0] 大寫 MD 變體也應被忽略。\n",
      "utf-8",
    );
    const { before } = hooksOf(fx);

    // 不應 throw
    await before({ tool: "write", sessionID: "sess-md-upper", input: { path: "CHANGELOG.MD" } });

    expect((await fx.store.getWarnings("sess-md-upper")).length).toBe(0);
  });

  test("非 MD 檔案（含 .ts）仍正常 throw AI_DO_NOT_EDIT:P0", async () => {
    // 反向驗證：filter 不應誤傷 .ts
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(
      join(ws.root, "src", "codegen.ts"),
      "// " + TAG_OPEN + "AI_DO_NOT_EDIT:P0] 程式碼檔仍須 throw。\n",
      "utf-8",
    );
    const { before } = hooksOf(fx);

    await expect(
      before({ tool: "edit", sessionID: "sess-ts-dne", input: { path: "src/codegen.ts" } }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);
  });
});

describe("07 - hooks: Comment Signal ignores Markdown (tool.execute.after)", () => {
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

  test("edit MD 檔案成功後不寫入 modifiedFiles", async () => {
    writeFileSync(join(ws.root, "README.md"), "// [TODO:P2] 之後處理\n", "utf-8");
    const { after } = hooksOf(fx);
    const sessionID = "sess-after-md";

    await after({ tool: "edit", sessionID, status: "completed", input: { path: "README.md" } });

    // 關鍵：MD 不應被記入 modifiedFiles
    expect(await fx.store.getModifiedFiles(sessionID)).not.toContain("README.md");
    expect(await fx.store.getModifiedFiles(sessionID)).toEqual([]);
  });

  test("write / patch / apply_patch 對 MD 檔案也不記錄", async () => {
    writeFileSync(join(ws.root, "CHANGELOG.markdown"), "// 更新紀錄\n", "utf-8");
    const { after } = hooksOf(fx);

    for (const toolName of ["write", "patch", "apply_patch"]) {
      const sessionID = `sess-after-${toolName}`;
      const input = toolName === "patch"
        ? { patchText: "*** Update File: CHANGELOG.markdown\n" }
        : { path: "CHANGELOG.markdown" };
      await after({ tool: toolName, sessionID, status: "completed", input });
      expect(await fx.store.getModifiedFiles(sessionID)).not.toContain("CHANGELOG.markdown");
    }
  });

  test("混合 TS + MD 編輯時，只有 TS 被記錄", async () => {
    writeFileSync(join(ws.root, "README.md"), "// 說明文件\n", "utf-8");
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "a.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
    const { after } = hooksOf(fx);
    const sessionID = "sess-mixed";

    await after({ tool: "edit", sessionID, status: "completed", input: { path: "README.md" } });
    await after({ tool: "edit", sessionID, status: "completed", input: { path: "src/a.ts" } });

    const modified = await fx.store.getModifiedFiles(sessionID);
    expect(modified).not.toContain("README.md");
    expect(modified).toContain("src/a.ts");
    expect(modified.length).toBe(1);
  });

  test("MD 檔案編輯後不會觸發 guardAfterEdit（不推入 post-edit warning）", async () => {
    writeFileSync(join(ws.root, "README.md"), "// [SECURITY:P1 owner=@auth] MD 內 highRisk 不該被掃\n", "utf-8");
    const { after } = hooksOf(fx);
    const sessionID = "sess-md-after-warn";

    await after({ tool: "edit", sessionID, status: "completed", input: { path: "README.md" } });

    // post-edit highRisk 不該被推入
    expect((await fx.store.getWarnings(sessionID)).length).toBe(0);
  });
});

// ─── 模組關閉時零註冊 ───────────

describe("07 - hooks: 模組關閉時工具與 hook 都不註冊", () => {
  test("commentSignal=false 時 added 與 toolHooks 皆為空", async () => {
    const fake = createFakeV2Context();
    const cleanup = await setupUltrawork(fake.ctx, {
      modules: [commentSignalModule],
      settings: { modules: { commentSignal: false } },
    });
    try {
      expect(fake.added.size).toBe(0);
      expect(fake.toolHooks.size).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("模組開啟時 7 工具＋2 hook 都註冊", async () => {
    const fake = createFakeV2Context();
    const cleanup = await setupUltrawork(fake.ctx, { modules: [commentSignalModule] });
    try {
      for (const name of [
        "comment_signal_check",
        "comment_signal_policy",
        "comment_signal_touched_report",
        "comment_signal_explain",
        "comment_signal_baseline",
        "comment_signal_suppress",
        "comment_signal_only_new",
      ]) {
        expect(fake.added.get(name), name).toBeDefined();
      }
      expect(fake.toolHooks.get("execute.before")).toBeDefined();
      expect(fake.toolHooks.get("execute.after")).toBeDefined();
    } finally {
      await cleanup();
    }
  });
});

describe("07 - hooks: before hook 異常 args fail closed", () => {
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

  test("edit 缺 path 時 throw（訊息指明缺少路徑）", async () => {
    const { before } = hooksOf(fx);
    await expect(before({ tool: "edit", sessionID: "sess-mal", input: {} })).rejects.toThrow(
      /edit.*(缺少|沒有|無法).*(路徑|path)|未提供.*路徑/,
    );
  });

  test("write 缺 path 時 throw", async () => {
    const { before } = hooksOf(fx);
    await expect(
      before({ tool: "write", sessionID: "sess-mal", input: { content: "x" } }),
    ).rejects.toThrow(/write/);
  });

  test("patch 空 patchText／亂碼文本時 throw", async () => {
    const { before } = hooksOf(fx);
    await expect(
      before({ tool: "patch", sessionID: "sess-mal", input: { patchText: "" } }),
    ).rejects.toThrow(/patch/);
    await expect(
      before({ tool: "patch", sessionID: "sess-mal", input: { patchText: "hello world" } }),
    ).rejects.toThrow(/patch/);
  });
});

describe("07 - hooks: 敏感／隱藏路徑不讀不記", () => {
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

  test("edit .env 成功：不記錄、不警告、不 throw", async () => {
    writeFileSync(join(ws.root, ".env"), "// [WARN:P1] 敏感內容\n", "utf-8");
    const { before, after } = hooksOf(fx);

    // before 不 throw（跳過，不是阻斷）
    await before({ tool: "edit", sessionID: "sess-env", input: { path: ".env" } });
    expect((await fx.store.getWarnings("sess-env")).length).toBe(0);

    // after 不記錄
    await after({ tool: "edit", sessionID: "sess-env", status: "completed", input: { path: ".env" } });
    expect(await fx.store.getModifiedFiles("sess-env")).toEqual([]);
  });

  test("edit .hidden.ts 成功：不記錄、不警告、不 throw", async () => {
    writeFileSync(join(ws.root, "src", ".hidden.ts"), "// [WARN:P1] 隱藏檔\n", "utf-8");
    const { before, after } = hooksOf(fx);

    await before({ tool: "edit", sessionID: "sess-hid", input: { path: "src/.hidden.ts" } });
    expect((await fx.store.getWarnings("sess-hid")).length).toBe(0);

    await after({ tool: "edit", sessionID: "sess-hid", status: "completed", input: { path: "src/.hidden.ts" } });
    expect(await fx.store.getModifiedFiles("sess-hid")).toEqual([]);
  });

  test("正常 .ts 不受影響：照常記錄", async () => {
    writeFileSync(join(ws.root, "src", "a.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
    const { after } = hooksOf(fx);

    await after({ tool: "edit", sessionID: "sess-ts", status: "completed", input: { path: "src/a.ts" } });
    expect(await fx.store.getModifiedFiles("sess-ts")).toEqual(["src/a.ts"]);
  });
});
