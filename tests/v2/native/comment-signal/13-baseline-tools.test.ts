/**
 * 13 — Comment Signal baseline／suppress／only_new（V2 新形狀）。
 *
 * 由 tests/ultrawork/17-phase5-tools.test.ts 的 comment_signal 段落移植
 *（health_check 反映屬 workflow，不搬）：
 *   - baseline：快照建立、已存在拒覆寫、Markdown 拒絕。
 *   - suppress：新增、idempotent、reason optional、store 落檔。
 *   - only_new：無快照、無新增、有新增。
 *   - 整合流程：baseline → 加 violation → only_new → suppress → 再比對。
 *
 * V2 差異：快照檔固定在 `<專案>/.ultrawork/`（舊 `.opencode/memory/` 已搬遷）；
 * setupUltrawork＋fake ctx 注入 commentSignalModule。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_FILENAME, SUPPRESSIONS_FILENAME } from "../../../../src/modules/comment-signal/baseline-tools.ts";
import {
  createWorkspace,
  setupCommentSignal,
  run,
  type CommentSignalFixture,
} from "./_helpers.ts";

// ─── comment_signal_baseline ───────────

describe("13 - baseline: comment_signal_baseline", () => {
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

  test("path + changedOnly=false + force=true：建立空 baseline 檔", async () => {
    const r = await run(fx.tools["comment_signal_baseline"], { path: "src", changedOnly: false, force: true });
    expect(r.ok).toBe(true);
    expect(r.scannedFileCount).toBe(0);
    expect(r.violationCount).toBe(0);
    expect(typeof r.baselinePath).toBe("string");
    expect(String(r.baselinePath).endsWith(BASELINE_FILENAME)).toBe(true);
    expect(typeof r.violationsSignature).toBe("string");
    expect(typeof r.createdAt).toBe("string");

    // 檔案確實寫到 <專案>/.ultrawork
    expect(existsSync(String(r.baselinePath))).toBe(true);
    expect(String(r.baselinePath).startsWith(join(ws.root, ".ultrawork"))).toBe(true);
    const written = JSON.parse(readFileSync(String(r.baselinePath), "utf-8"));
    expect(written.version).toBe("1.0");
    expect(written.source).toBe("comment_signal_baseline");
    expect(written.changedOnly).toBe(false);
  });

  test("已存在 baseline 不指定 force 時回 BASELINE_EXISTS 並附 existingCreatedAt", async () => {
    // 第一次建立
    const first = await run(fx.tools["comment_signal_baseline"], { path: "src", changedOnly: false, force: true });
    expect(first.ok).toBe(true);
    // 第二次不帶 force
    const second = await run(fx.tools["comment_signal_baseline"], { path: "src", changedOnly: false });
    expect(second.ok).toBe(false);
    expect(second.code).toBe("BASELINE_EXISTS");
    expect(typeof second.existingCreatedAt).toBe("string");
    expect(typeof second.existingViolationsSignature).toBe("string");
  });

  test("Markdown 路徑拒絕（不回 ok）", async () => {
    const r = await run(fx.tools["comment_signal_baseline"], { path: "README.md", changedOnly: false, force: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("MARKDOWN_PATH");
  });
});

// ─── comment_signal_suppress ───────────

describe("13 - baseline: comment_signal_suppress", () => {
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

  test("基本新增 suppression：id 為 (filePath|line|code) hash", async () => {
    const r = await run(fx.tools["comment_signal_suppress"], {
      filePath: "src/foo.ts",
      line: 1,
      code: "MISSING_SEVERITY",
      reason: "test suppression",
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("added");
    expect(typeof r.id).toBe("string");
    // id 為 SHA-256 前 16 hex
    expect((r.id as string)).toMatch(/^[0-9a-f]{16}$/);
    expect(r.totalSuppressions).toBe(1);
    const sup = r.suppression as Record<string, unknown>;
    expect(sup.filePath).toBe("src/foo.ts");
    expect(sup.line).toBe(1);
    expect(sup.code).toBe("MISSING_SEVERITY");
    expect(sup.reason).toBe("test suppression");
    expect(typeof sup.id).toBe("string");
    expect(typeof sup.createdAt).toBe("string");
  });

  test("重複 (filePath, line, code) 不會產生第二筆（idempotent）", async () => {
    const args = { filePath: "src/foo.ts", line: 1, code: "MISSING_SEVERITY", reason: "test" };
    const r1 = await run(fx.tools["comment_signal_suppress"], args);
    const r2 = await run(fx.tools["comment_signal_suppress"], args);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.totalSuppressions).toBe(1);
    expect(r2.action).toBe("already-exists");
  });

  test("缺 reason 不 throw；reason 為 optional", async () => {
    const r = await run(fx.tools["comment_signal_suppress"], {
      filePath: "src/bar.ts",
      line: 5,
      code: "INVALID_SEVERITY",
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("added");
  });

  test("suppression store 寫入 <專案>/.ultrawork/comment-signal-suppressions.json", async () => {
    await run(fx.tools["comment_signal_suppress"], {
      filePath: "src/baz.ts",
      line: 10,
      code: "MISSING_OWNER",
      reason: "fixture",
    });
    const storePath = join(ws.root, ".ultrawork", SUPPRESSIONS_FILENAME);
    expect(existsSync(storePath)).toBe(true);
    const store = JSON.parse(readFileSync(storePath, "utf-8"));
    expect(store.version).toBeDefined();
    expect(Array.isArray(store.suppressions)).toBe(true);
    expect(store.suppressions.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── comment_signal_only_new ───────────

describe("13 - baseline: comment_signal_only_new", () => {
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

  test("無 baseline 時回 ok:false 並提示先呼叫 comment_signal_baseline", async () => {
    const r = await run(fx.tools["comment_signal_only_new"], {});
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(String(r.error)).toMatch(/baseline/i);
    expect(typeof r.hint).toBe("string");
  });

  test("有 baseline 且無新增 violations 時回 ok:true + newViolations=[] + agentFeedback", async () => {
    // 先建快照（path 為 src）
    await run(fx.tools["comment_signal_baseline"], { path: "src", changedOnly: false, force: true });
    const r = await run(fx.tools["comment_signal_only_new"], { path: "src", changedOnly: false });
    expect(r.ok).toBe(true);
    expect(r.hasBaseline).toBe(true);
    expect(typeof r.baselinePath).toBe("string");
    expect(typeof r.baselineCreatedAt).toBe("string");
    expect(r.scannedFileCount).toBe(0);
    const newViol = r.newViolations as unknown[];
    expect(Array.isArray(newViol)).toBe(true);
    expect(newViol.length).toBe(0);
    expect(typeof r.agentFeedback).toBe("string");
  });

  test("baseline 後新增 violation 時 newViolations 包含新命中", async () => {
    // 先建快照（在乾淨 workspace 上：0 violation）
    mkdirSync(join(ws.root, "src", "auth"), { recursive: true });
    await run(fx.tools["comment_signal_baseline"], { path: "src", changedOnly: false, force: true });
    // 之後新增違規檔案
    writeFileSync(join(ws.root, "src", "auth", "login.ts"), "// [SECURITY:P0 owner=@auth] 不要將 token 寫入 log\n", "utf-8");
    const r = await run(fx.tools["comment_signal_only_new"], { path: "src", changedOnly: false });
    expect(r.ok).toBe(true);
    expect((r.newViolations as unknown[]).length).toBeGreaterThan(0);
  });
});

// ─── 3 個工具的整合流程 ───────────

describe("13 - baseline: comment_signal baseline/suppress/only_new 整合流程", () => {
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

  test("完整流程：baseline → 加 violation → only_new 報告新增", async () => {
    mkdirSync(join(ws.root, "src"), { recursive: true });

    // Phase A：乾淨 workspace 建快照
    const baseline = await run(fx.tools["comment_signal_baseline"], { path: "src", changedOnly: false, force: true });
    expect(baseline.ok).toBe(true);

    // Phase B：模擬新增違規
    writeFileSync(join(ws.root, "src", "x.ts"), "// [DANGER:P0 owner=@ops] rm -rf 不要這樣寫\n", "utf-8");

    // Phase C：only_new 報告
    const onlyNew = await run(fx.tools["comment_signal_only_new"], { path: "src", changedOnly: false });
    expect(onlyNew.ok).toBe(true);
    expect((onlyNew.newViolations as unknown[]).length).toBeGreaterThan(0);

    // Phase D：suppress 該 violation
    const newV = (onlyNew.newViolations as Array<Record<string, unknown>>)[0];
    if (newV) {
      const supp = await run(fx.tools["comment_signal_suppress"], {
        filePath: String(newV.filePath ?? ""),
        line: Number(newV.line ?? 0),
        code: String(newV.code ?? "UNKNOWN"),
        reason: "phase5 integration test",
      });
      expect(supp.ok).toBe(true);
    }

    // Phase E：only_new 再跑一次，suppressedNewCount 應增加
    const onlyNew2 = await run(fx.tools["comment_signal_only_new"], { path: "src", changedOnly: false });
    expect(onlyNew2.ok).toBe(true);
    expect(typeof onlyNew2.suppressedNewCount).toBe("number");
    expect(Number(onlyNew2.suppressedNewCount)).toBeGreaterThanOrEqual(1);
  });
});

describe("13 - baseline/only_new 顯式單檔過濾（跟 check 一致）", () => {
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

  test("baseline explicit .env：不讀不掃", async () => {
    writeFileSync(join(ws.root, ".env"), "// [WARN:P1] 讀到就會 UNKNOWN_TAG\n", "utf-8");
    const out = await run(fx.tools["comment_signal_baseline"], { path: ".env", changedOnly: false, force: true });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.violationCount).toBe(0);
  });

  test("baseline explicit .ts 對照：照常掃描", async () => {
    writeFileSync(join(ws.root, "src", "a.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
    const out = await run(fx.tools["comment_signal_baseline"], { path: "src/a.ts", changedOnly: false, force: true });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
  });

  test("only_new explicit .env：不讀不掃", async () => {
    writeFileSync(join(ws.root, ".env"), "// [WARN:P1] 讀到就會 UNKNOWN_TAG\n", "utf-8");
    await run(fx.tools["comment_signal_baseline"], { path: "src", changedOnly: false, force: true });
    const out = await run(fx.tools["comment_signal_only_new"], { path: ".env", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect((out.newViolations as unknown[]).length).toBe(0);
  });

  test("only_new explicit .ts 對照：照常掃描", async () => {
    writeFileSync(join(ws.root, "src", "a.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
    await run(fx.tools["comment_signal_baseline"], { path: "src", changedOnly: false, force: true });
    const out = await run(fx.tools["comment_signal_only_new"], { path: "src/a.ts", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
  });
});
