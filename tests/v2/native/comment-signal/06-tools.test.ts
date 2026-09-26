/**
 * commentSignal 工具整合測試（4 個工具）。
 *
 * 由 tests/ultrawork/comment-signal/06-tools.test.ts 移植，改用新形狀：
 * setupUltrawork(fake.ctx, { modules: [commentSignalModule] }) 註冊，
 * 從 fake.added 取工具執行；workspace 在 os.tmpdir() 下建立；
 * modifiedFiles 改走跟工具共用 storage 的 CommentSignalStore。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createWorkspace,
  setupCommentSignal,
  run,
  type CommentSignalFixture,
} from "./_helpers.ts";

// 在 fixture source 內的非法 tag literal（如 WARN 搭配 P1 severity）透過
// runtime 拼接生成，避免檔案本身被 Comment Signal scanner 抓到 UNKNOWN_TAG
// 而成為 blocking violation。runtime value 仍等於 open-bracket + tag + 結尾
// 雙中括弧的非法 functional comment，parser 仍能命中對應非法 signal。
const TAG_OPEN = "[";

describe("06 - tools: tool surface", () => {
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

  test("7 個 comment_signal_* 工具都已註冊", () => {
    for (const name of [
      "comment_signal_check",
      "comment_signal_policy",
      "comment_signal_touched_report",
      "comment_signal_explain",
      "comment_signal_baseline",
      "comment_signal_suppress",
      "comment_signal_only_new",
    ]) {
      expect(typeof fx.tools[name]?.execute, name).toBe("function");
    }
  });

  test("7 個工具都有非空 description＋JSON Schema input", () => {
    for (const tool of Object.values(fx.tools)) {
      expect(typeof tool.description).toBe("string");
      expect((tool.description as string).length).toBeGreaterThan(0);
      expect(tool.input).toBeDefined();
      expect(tool.options).toEqual({ codemode: false });
    }
  });

  test("工具名稱、描述與舊版一致", () => {
    expect(fx.tools["comment_signal_check"].description).toMatch(/^Comment Signal 註解必要檢查/);
    expect(fx.tools["comment_signal_policy"].description).toMatch(/^回傳 Comment Signal policy 摘要/);
    expect(fx.tools["comment_signal_touched_report"].description).toMatch(/^回報目前 session 的 modifiedFiles/);
    expect(fx.tools["comment_signal_explain"].description).toMatch(/^解釋 Comment Signal tag 語意/);
    expect(fx.tools["comment_signal_baseline"].description).toMatch(/^建立 Comment Signal 的目前問題快照/);
    expect(fx.tools["comment_signal_suppress"].description).toMatch(/^精準抑制 Comment Signal violation/);
    expect(fx.tools["comment_signal_only_new"].description).toMatch(/^報告相較於目前問題快照新增/);
  });
});

describe("06 - tools: comment_signal_check", () => {
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

  test("預設 changedOnly=true：未記錄 modifiedFiles 時回傳空 report", async () => {
    const out = await run(fx.tools["comment_signal_check"], {});
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
    expect(typeof out.checkedCommentCount).toBe("number");
    expect(typeof out.violationCount).toBe("number");
    expect(typeof out.errorCount).toBe("number");
    expect(typeof out.warningCount).toBe("number");
    expect(typeof out.highRiskCount).toBe("number");
    expect(typeof out.agentFeedback).toBe("string");
    expect(Array.isArray(out.violations)).toBe(true);
    expect(Array.isArray(out.highRisk)).toBe(true);
    expect(typeof out.humanSummary).toBe("string");
  });

  test("指定 path 時掃描指定資料夾", async () => {
    const srcDir = join(ws.root, "src", "auth");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "login.ts"),
      "// [SECURITY:P0 owner=@auth issue=#391] 不要將 token 寫入 log，否則會洩漏個資\n",
      "utf-8",
    );
    writeFileSync(join(srcDir, "session.ts"), "// [TODO:P2] 之後處理\n", "utf-8");

    const out = await run(fx.tools["comment_signal_check"], { path: "src/auth", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(2);
    expect(out.highRiskCount).toBeGreaterThanOrEqual(1);
  });

  test("指定 path=精確檔案路徑時只檢查該檔", async () => {
    const srcDir = join(ws.root, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "a.ts"), `// ${TAG_OPEN}WARN:P1] 未知 tag 觸發 UNKNOWN_TAG\n`, "utf-8");
    writeFileSync(join(srcDir, "b.ts"), "// [TODO:P2] 之後處理\n", "utf-8");

    const out = await run(fx.tools["comment_signal_check"], { path: "src/a.ts", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    const files = (out.violations as Array<{ filePath: string }>).map((v) => v.filePath);
    expect(files.some((f) => f === "src/a.ts")).toBe(true);
    expect(files.some((f) => f === "src/b.ts")).toBe(false);
  });

  test("blocking violation 觸發 shouldBlockCompletion=true", async () => {
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "a.ts"), `// ${TAG_OPEN}WARN:P1] 未知 tag 觸發 UNKNOWN_TAG\n`, "utf-8");

    const out = await run(fx.tools["comment_signal_check"], { path: "src/a.ts", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.shouldBlockCompletion).toBe(true);
    expect(out.errorCount).toBeGreaterThanOrEqual(1);
    const codes = (out.violations as Array<{ code: string }>).map((v) => v.code);
    expect(codes).toContain("UNKNOWN_TAG");
  });

  test("端到端阻擋 YAML 與 HTML 原生註解中的 workflow ID", async () => {
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "config.yml"), "# task 031 先處理相依性\n", "utf-8");
    writeFileSync(join(ws.root, "src", "page.html"), "<!-- plan parser-v2-compatibility -->\n", "utf-8");

    const out = await run(fx.tools["comment_signal_check"], { path: "src", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(2);
    expect(out.shouldBlockCompletion).toBe(true);
    const codes = (out.violations as Array<{ code: string }>).map((item) => item.code);
    expect(codes.filter((code) => code === "WORKFLOW_ID_IN_COMMENT")).toHaveLength(2);
  });

  test("warning-only source 不阻擋完成，agentFeedback 仍含修正建議", async () => {
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "a.ts"), "// [TODO:P2] 之後處理\n", "utf-8");

    const out = await run(fx.tools["comment_signal_check"], { path: "src/a.ts", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.shouldBlockCompletion).toBe(false);
    expect(out.warningCount).toBeGreaterThanOrEqual(1);
    expect(typeof out.agentFeedback).toBe("string");
    expect(out.agentFeedback).toMatch(/修正/);
  });

  test("回傳 report 包含 plan 第 7 節全部必要欄位", async () => {
    const out = await run(fx.tools["comment_signal_check"], {});
    const requiredKeys = [
      "scannedFileCount",
      "checkedCommentCount",
      "violationCount",
      "errorCount",
      "warningCount",
      "highRiskCount",
      "shouldBlockCompletion",
      "agentFeedback",
      "violations",
      "highRisk",
      "humanSummary",
    ];
    for (const k of requiredKeys) {
      expect(out[k], `missing field: ${k}`).toBeDefined();
    }
  });

  test("changedOnly=true 只掃 modifiedFiles 內的檔案", async () => {
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "a.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
    writeFileSync(join(ws.root, "src", "b.ts"), `// ${TAG_OPEN}WARN:P1] 未知 tag\n`, "utf-8");
    await fx.store.recordModifiedFile("s1", "src/a.ts");

    const out = await run(fx.tools["comment_signal_check"], {});
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    const files = (out.violations as Array<{ filePath: string }>).map((v) => v.filePath);
    expect(files.some((f) => f === "src/b.ts")).toBe(false);
  });
});

describe("06 - tools: comment_signal_policy", () => {
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

  test("回傳 policy 摘要完整欄位", async () => {
    const out = await run(fx.tools["comment_signal_policy"], {});
    expect(out.ok).toBe(true);
    expect(out.descriptiveTags).toContain("目的");
    expect(out.functionalTags).toContain("TODO");
    expect(out.functionalTags).toContain("SECURITY");
    expect(out.severities).toEqual(["P0", "P1", "P2", "P3"]);
    expect(out.metadataKeys).toContain("owner");
    expect(out.metadataKeys).toContain("issue");
    expect(out.metadataKeys).toContain("expires");
    expect(out.blockingViolationCodes).toContain("UNKNOWN_TAG");
    expect(out.blockingViolationCodes).toContain("MISSING_SEVERITY");
    expect(out.blockingViolationCodes).toContain("INVALID_SEVERITY");
    expect(out.blockingViolationCodes).toContain("BAD_METADATA");
    expect(out.blockingViolationCodes).toContain("WORKFLOW_ID_IN_COMMENT");
    expect(out.highRiskTags).toContain("DANGER");
    expect(out.highRiskTags).toContain("SECURITY");
    expect(out.highRiskTags).toContain("AI_DO_NOT_EDIT");
    expect(out.highRiskSeverities).toEqual(["P0", "P1"]);
    expect(Array.isArray(out.commonMistakes)).toBe(true);
    expect(out.commonMistakes.length).toBeGreaterThan(0);
    expect(JSON.stringify(out.commonMistakes)).toMatch(/固定格式文件|工作流 ID/);
  });

  test("policy 摘要不含完整規格 raw dump（避免 prompt 膨脹）", async () => {
    const out = await run(fx.tools["comment_signal_policy"], {});
    expect(typeof out.humanSummary).toBe("string");
    expect((out.humanSummary as string).length).toBeLessThan(4000);
  });
});

describe("06 - tools: comment_signal_touched_report", () => {
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

  test("回報工作階段 modifiedFiles、lastReport、warnings", async () => {
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "a.ts"), "// [TODO:P2] 之後處理\n", "utf-8");

    const sessionID = "test-session";
    await fx.store.recordModifiedFile(sessionID, "src/a.ts");
    await run(fx.tools["comment_signal_check"], { path: "src/a.ts", changedOnly: false }, sessionID);

    const out = await run(fx.tools["comment_signal_touched_report"], { sessionID }, sessionID);
    expect(out.ok).toBe(true);
    expect(out.sessionID).toBe(sessionID);
    expect(Array.isArray(out.modifiedFiles)).toBe(true);
    expect(out.modifiedFiles).toContain("src/a.ts");
    const lastReport = out.lastReport as { shouldBlockCompletion: boolean } | undefined;
    expect(lastReport).toBeDefined();
    expect(lastReport?.shouldBlockCompletion).toBe(false);
    expect(Array.isArray(out.warnings)).toBe(true);
    const perFile = out.perFile as Array<{ filePath: string }>;
    expect(perFile).toBeDefined();
    expect(perFile[0]?.filePath).toBe("src/a.ts");
  });

  test("未指定 sessionID 時 fallback 為工具執行的工作階段", async () => {
    await fx.store.recordModifiedFile("s1", "src/x.ts");
    const out = await run(fx.tools["comment_signal_touched_report"], {}, "s1");
    expect(out.ok).toBe(true);
    expect(out.sessionID).toBe("s1");
    expect(out.modifiedFiles).toContain("src/x.ts");
  });
});

describe("06 - tools: comment_signal_explain", () => {
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

  test("以 tag 參數查詢：回傳該 tag 的說明與正確格式示範", async () => {
    const out = await run(fx.tools["comment_signal_explain"], { tag: "SECURITY" });
    expect(out.ok).toBe(true);
    expect(out.tag).toBe("SECURITY");
    expect(typeof out.explanation).toBe("string");
    expect(out.explanation).toMatch(/安全|風險|token/);
    expect(out.examples).toBeDefined();
    expect(Array.isArray(out.examples)).toBe(true);
  });

  test("以 tag 查詢說明型 tag：回傳 descriptive 語意", async () => {
    const out = await run(fx.tools["comment_signal_explain"], { tag: "目的" });
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("descriptive");
    expect(out.explanation).toMatch(/目的|說明/);
  });

  test("AI脈絡範例只教持久技術脈絡，不保存執行歷史", async () => {
    const out = await run(fx.tools["comment_signal_explain"], { tag: "AI脈絡" });
    expect(out.ok).toBe(true);
    expect(out.explanation).toMatch(/長期|技術脈絡|執行歷史/);
    expect(JSON.stringify(out.examples)).not.toMatch(/Phase|sibling implementer|Task ID|Plan ID/);
  });

  test("以 filePath＋line 查詢：回傳該行註解的診斷", async () => {
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(
      join(ws.root, "src", "a.ts"),
      ["// [TODO:P2] 之後處理", "// [SECURITY:P0 owner=@auth] 不要將 token 寫入 log"].join("\n") + "\n",
      "utf-8",
    );

    const out = await run(fx.tools["comment_signal_explain"], { filePath: "src/a.ts", line: 2 });
    expect(out.ok).toBe(true);
    expect(out.filePath).toBe("src/a.ts");
    expect(out.line).toBe(2);
    expect(out.raw).toContain("SECURITY");
    expect(out.diagnosis).toBeDefined();
  });

  test("未提供任何參數時回傳錯誤（錯誤碼與訊息逐字）", async () => {
    const out = await run(fx.tools["comment_signal_explain"], {});
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/tag|filePath/);
  });

  test("讀不到的檔案回傳 cannot read file", async () => {
    const out = await run(fx.tools["comment_signal_explain"], { filePath: "src/missing.ts", line: 1 });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toMatch(/cannot read file/);
  });

  test("超出行數回傳 out of range", async () => {
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "a.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
    const out = await run(fx.tools["comment_signal_explain"], { filePath: "src/a.ts", line: 99 });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toMatch(/out of range/);
  });
});

describe("06 - tools: comment-signal state integration", () => {
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

  test("comment_signal_check 完成後會更新工作階段 lastReport", async () => {
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "a.ts"), "// [TODO:P2] 之後處理\n", "utf-8");

    await fx.store.recordModifiedFile("s1", "src/a.ts");
    await run(fx.tools["comment_signal_check"], { changedOnly: true }, "s1");

    const out = await run(fx.tools["comment_signal_touched_report"], { sessionID: "s1" }, "s1");
    const lastReport = out.lastReport as { checkedCommentCount: number } | undefined;
    expect(lastReport).toBeDefined();
    expect(lastReport?.checkedCommentCount).toBeGreaterThanOrEqual(1);
  });
});

describe("06 - tools: comment_signal_check ignores Markdown", () => {
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

  test("指定 path=README.md 且 changedOnly=false 時回傳空 report", async () => {
    writeFileSync(join(ws.root, "README.md"), `// ${TAG_OPEN}WARN:P1] MD 內的未知 tag 不該被掃\n`, "utf-8");

    const out = await run(fx.tools["comment_signal_check"], { path: "README.md", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.checkedCommentCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
    expect(out.violations).toEqual([]);
    expect(out.highRisk).toEqual([]);
  });

  test("指定 path=docs/guide.markdown 時也跳過掃描", async () => {
    mkdirSync(join(ws.root, "docs"), { recursive: true });
    writeFileSync(join(ws.root, "docs", "guide.markdown"), "// [TODO:P2] 之後處理\n", "utf-8");

    const out = await run(fx.tools["comment_signal_check"], { path: "docs/guide.markdown", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
  });

  test("掃資料夾時排除 .md 與 .markdown", async () => {
    mkdirSync(join(ws.root, "src", "auth"), { recursive: true });
    writeFileSync(
      join(ws.root, "src", "auth", "login.ts"),
      "// [SECURITY:P0 owner=@auth issue=#391] 不要將 token 寫入 log，否則會洩漏\n",
      "utf-8",
    );
    writeFileSync(join(ws.root, "src", "auth", "session.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
    writeFileSync(join(ws.root, "README.md"), "// [SECURITY:P0 owner=@auth] MD 內容不該被掃\n", "utf-8");
    writeFileSync(join(ws.root, "src", "auth", "NOTES.markdown"), "// [TODO:P2] MD 變體也不該被掃\n", "utf-8");

    const out = await run(fx.tools["comment_signal_check"], { path: "src/auth", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(2);
    expect(out.highRiskCount).toBe(1);
    const allViolations = (out.violations as Array<{ filePath: string }>).map((v) => v.filePath);
    const allHighRisk = (out.highRisk as Array<{ filePath: string }>).map((h) => h.filePath);
    expect(allViolations.some((f) => f.endsWith(".md"))).toBe(false);
    expect(allViolations.some((f) => f.endsWith(".markdown"))).toBe(false);
    expect(allHighRisk.some((f) => f.endsWith(".md"))).toBe(false);
    expect(allHighRisk.some((f) => f.endsWith(".markdown"))).toBe(false);
  });

  test("changedOnly=true 時 MD 檔案也不會從 modifiedFiles 中被掃描", async () => {
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "README.md"), "// [TODO:P2] MD 內的待辦\n", "utf-8");
    writeFileSync(join(ws.root, "src", "a.ts"), "// [TODO:P2] 之後處理\n", "utf-8");

    await fx.store.recordModifiedFile("s1", "README.md");
    await fx.store.recordModifiedFile("s1", "src/a.ts");

    const out = await run(fx.tools["comment_signal_check"], {}, "s1");
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect(out.checkedCommentCount).toBe(1);
  });
});
