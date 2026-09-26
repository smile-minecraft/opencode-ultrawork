/**
 * 08 — Comment Signal JVM source scan + fail-closed（V2 新形狀）。
 *
 * 由 tests/ultrawork/comment-signal/08-jvm-scan.test.ts 移植：
 *   - `.java`／`.kt`／`.kts`／`.groovy` 列為認可 executable 副檔名。
 *   - 顯式 supported executable path 零 readable scans → fail closed。
 *   - Markdown-only 顯式 path 維持不阻擋。
 *   - report 區別 scanned／skipped／unreadable。
 *   - 父子聚合對 JVM 修改照常運作。
 *
 * V2 差異：setupUltrawork＋fake ctx 注入 commentSignalModule；
 * hook 用 fake.toolHooks 手動觸發（V2 事件形狀，路徑參數為 `path`）；
 * session 事件先塞進 fake.events 再 setup（subscribe 時 consume）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { SCAN_EXTENSIONS, listDirectoryFiles } from "../../../../src/modules/comment-signal/file-scan.ts";
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

// 在 fixture source 內的非法 tag literal 透過 runtime 拼接生成，避免檔案本身
// 被 Comment Signal scanner 抓到 UNKNOWN_TAG 而成為 blocking violation。
const TAG_OPEN = "[";

// ─── SCAN_EXTENSIONS / listDirectoryFiles 單元測試 ───────────

describe("08 - JVM scan: SCAN_EXTENSIONS 常數", () => {
  test("SCAN_EXTENSIONS 包含 .java / .kt / .kts / .groovy", () => {
    expect(SCAN_EXTENSIONS.has(".java")).toBe(true);
    expect(SCAN_EXTENSIONS.has(".kt")).toBe(true);
    expect(SCAN_EXTENSIONS.has(".kts")).toBe(true);
    expect(SCAN_EXTENSIONS.has(".groovy")).toBe(true);
  });

  test("既有 TS/JS/JSON/HTML/YAML/SH 等副檔名仍保留", () => {
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".json", ".html", ".yaml", ".yml", ".sh"]) {
      expect(SCAN_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  test("SCAN_EXTENSIONS 不含 Markdown（既有契約）", () => {
    expect(SCAN_EXTENSIONS.has(".md")).toBe(false);
    expect(SCAN_EXTENSIONS.has(".markdown")).toBe(false);
  });
});

describe("08 - JVM scan: listDirectoryFiles 遞迴列舉", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "comment-signal-jvm-"));
  });
  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  test("目錄含 .java / .kt / .kts / .groovy 時全部列入", () => {
    mkdirSync(join(tmpRoot, "src", "auth"), { recursive: true });
    writeFileSync(join(tmpRoot, "src", "auth", "Login.java"), "class Login {}\n", "utf-8");
    writeFileSync(join(tmpRoot, "src", "auth", "Session.kt"), "class Session\n", "utf-8");
    writeFileSync(join(tmpRoot, "src", "auth", "Build.kts"), "// build\n", "utf-8");
    writeFileSync(join(tmpRoot, "src", "auth", "Script.groovy"), "println 'hi'\n", "utf-8");

    const files = listDirectoryFiles(tmpRoot, "src/auth");
    expect(files).not.toBeNull();
    expect(files!.sort()).toEqual([
      "src/auth/Build.kts",
      "src/auth/Login.java",
      "src/auth/Script.groovy",
      "src/auth/Session.kt",
    ]);
  });

  test("目錄只含非 scan 副檔名（.csv / .png）時回傳空清單", () => {
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    writeFileSync(join(tmpRoot, "src", "data.csv"), "a,b\n", "utf-8");
    writeFileSync(join(tmpRoot, "src", "icon.png"), "fake\n", "utf-8");

    const files = listDirectoryFiles(tmpRoot, "src");
    expect(files).toEqual([]);
  });
});

// ─── comment_signal_check 對 JVM source 的整合測試 ─────────────

describe("08 - JVM scan: comment_signal_check 對 JVM source 路徑", () => {
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

  test("explicit .java 檔：命中非法 tag 並觸發 UNKNOWN_TAG", async () => {
    const srcDir = join(ws.root, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "Hello.java"),
      `// ${TAG_OPEN}WARN:P1] Java source 內的非法 tag 應被 parser 命中\n`,
      "utf-8",
    );

    const out = await run(fx.tools["comment_signal_check"], { path: "src/Hello.java", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect(out.shouldBlockCompletion).toBe(true);
    const codes = (out.violations as Array<{ code: string }>).map((v) => v.code);
    expect(codes).toContain("UNKNOWN_TAG");
  });

  test("explicit .kt 檔：命中 block comment 並觸發 UNKNOWN_TAG", async () => {
    const srcDir = join(ws.root, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "Auth.kt"),
      [
        "/*",
        ` * ${TAG_OPEN}WARN:P1] Kotlin block comment 內的非法 tag`,
        " */",
        "class Auth",
      ].join("\n") + "\n",
      "utf-8",
    );

    const out = await run(fx.tools["comment_signal_check"], { path: "src/Auth.kt", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect(out.shouldBlockCompletion).toBe(true);
    const codes = (out.violations as Array<{ code: string }>).map((v) => v.code);
    expect(codes).toContain("UNKNOWN_TAG");
  });

  test("explicit .kts Gradle script 與 .groovy script 都能被掃描", async () => {
    const srcDir = join(ws.root, "scripts");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "build.kts"), `// ${TAG_OPEN}WARN:P1] kts 內的非法 tag\n`, "utf-8");
    writeFileSync(join(srcDir, "deploy.groovy"), `// ${TAG_OPEN}WARN:P1] groovy 內的非法 tag\n`, "utf-8");

    const out = await run(fx.tools["comment_signal_check"], { path: "scripts", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(2);
    expect(out.shouldBlockCompletion).toBe(true);
    const codes = (out.violations as Array<{ code: string }>).map((v) => v.code);
    expect(codes.filter((c) => c === "UNKNOWN_TAG")).toHaveLength(2);
  });

  test("混合 JVM + TS 資料夾：全部被掃描、Markdown 仍跳過", async () => {
    const srcDir = join(ws.root, "src");
    mkdirSync(join(srcDir, "auth"), { recursive: true });
    writeFileSync(join(srcDir, "auth", "Login.java"), "// [TODO:P2] 之後處理\n", "utf-8");
    writeFileSync(
      join(srcDir, "auth", "session.ts"),
      "// [SECURITY:P0 owner=@auth issue=#391] 不要將 token 寫入 log\n",
      "utf-8",
    );
    writeFileSync(join(srcDir, "auth", "NOTES.md"), "// [SECURITY:P0 owner=@auth] MD 不該被掃\n", "utf-8");

    const out = await run(fx.tools["comment_signal_check"], { path: "src/auth", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(2); // .java + .ts, not .md
    expect(out.highRiskCount).toBe(1);
    const violationFiles = (out.violations as Array<{ filePath: string }>).map((v) => v.filePath);
    expect(violationFiles.some((f) => f.endsWith(".md"))).toBe(false);
    expect(violationFiles.some((f) => f.endsWith(".java"))).toBe(true);
    expect(violationFiles.some((f) => f.endsWith(".ts"))).toBe(true);
  });
});

// ─── untracked / changed JVM 檔案透過 changedOnly=true ───────────

describe("08 - JVM scan: changedOnly=true 對 untracked JVM 修改", () => {
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

  test("modifiedFiles 含 .java 時可掃描並產 violation", async () => {
    const srcDir = join(ws.root, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "Hello.java"), `// ${TAG_OPEN}WARN:P1] untracked Java 修改應被掃\n`, "utf-8");

    // 模擬 hook 紀錄 .java 修改
    await fx.store.recordModifiedFile("s1", "src/Hello.java");

    const out = await run(fx.tools["comment_signal_check"], {}, "s1");
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect(out.shouldBlockCompletion).toBe(true);
    const codes = (out.violations as Array<{ code: string }>).map((v) => v.code);
    expect(codes).toContain("UNKNOWN_TAG");
  });
});

// ─── Fail-closed：explicit supported executable path zero readable ─────

describe("08 - JVM scan: explicit supported path zero-readable fail-closed", () => {
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

  test("explicit 單檔 .java 但 sourceResolver 回 null：fail closed", async () => {
    // 不寫檔 → sourceResolver 對該相對路徑讀不到內容
    const out = await run(fx.tools["comment_signal_check"], { path: "src/Missing.java", changedOnly: false });
    expect(out.ok).toBe(true);
    // fail-closed: explicit supported path with zero readable scans must block
    expect(out.shouldBlockCompletion).toBe(true);
    expect(out.unreadableFileCount).toBe(1);
    expect(typeof out.failClosedReason).toBe("string");
    expect((out.failClosedReason as string).length).toBeGreaterThan(0);
  });

  test("explicit 單檔 .java 但讀不到：scannedFileCount=0、unreadableFileCount=1、failClosedReason=file_unreadable", async () => {
    // 顯式 supported executable 單檔路徑，sourceResolver 回 null 時：
    //   - 不得用空 source 假裝讀到（否則 scannedFileCount 會被算成 1，與 unreadable 審計不一致）
    //   - 必須以空 entries 建 report、unreadableFileCount=1、fail closed 且 reason 為 file_unreadable
    const out = await run(fx.tools["comment_signal_check"], { path: "src/Missing.java", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.unreadableFileCount).toBe(1);
    expect(out.shouldBlockCompletion).toBe(true);
    expect(out.failClosedReason).toBe("file_unreadable");
  });

  test("explicit 資料夾路徑但目錄不存在：fail closed", async () => {
    const out = await run(fx.tools["comment_signal_check"], { path: "src/does-not-exist", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.shouldBlockCompletion).toBe(true);
    expect(typeof out.failClosedReason).toBe("string");
  });

  test("explicit 資料夾路徑但目錄全為 unreadable files：fail closed", async () => {
    // 寫入一個 .ts 檔，但用 chmod 0 讓 sourceResolver 無法讀取
    const srcDir = join(ws.root, "src", "locked");
    mkdirSync(srcDir, { recursive: true });
    const target = join(srcDir, "secret.ts");
    writeFileSync(target, "// [TODO:P2] 之後處理\n", "utf-8");
    // 用 file mode 0 模擬 unreadable；readFileSync 會 throw
    chmodSync(target, 0o000);
    try {
      const out = await run(fx.tools["comment_signal_check"], { path: "src/locked", changedOnly: false });
      expect(out.ok).toBe(true);
      expect(out.shouldBlockCompletion).toBe(true);
      // 精確值 1（避免 fail-closed 雙重計數的 regression）
      expect(out.unreadableFileCount).toBe(1);
      expect(out.failClosedReason).toBe("all_files_unreadable");
    } finally {
      // 恢復權限以便 workspace 清理
      chmodSync(target, 0o600);
    }
  });

  test("explicit 資料夾路徑但完全沒有 supported 副檔名（只有 .csv / .png）：fail closed", async () => {
    const dataDir = join(ws.root, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "table.csv"), "a,b,c\n", "utf-8");
    writeFileSync(join(dataDir, "icon.png"), "fake\n", "utf-8");

    const out = await run(fx.tools["comment_signal_check"], { path: "data", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.shouldBlockCompletion).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(typeof out.failClosedReason).toBe("string");
  });
});

// ─── Markdown-only 顯式 path 仍不阻擋 ───────────

describe("08 - JVM scan: Markdown-only 顯式 path 維持不阻擋", () => {
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

  test("explicit README.md：scannedFileCount=0 且 shouldBlockCompletion=false", async () => {
    writeFileSync(join(ws.root, "README.md"), `// ${TAG_OPEN}WARN:P1] MD 內的未知 tag 不該被掃\n`, "utf-8");
    const out = await run(fx.tools["comment_signal_check"], { path: "README.md", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
    expect(out.failClosedReason).toBeUndefined();
  });

  test("explicit .markdown 副檔名仍跳過掃描且 fail-closed 不觸發", async () => {
    mkdirSync(join(ws.root, "docs"), { recursive: true });
    writeFileSync(join(ws.root, "docs", "guide.markdown"), "// [SECURITY:P0 owner=@auth] MD 變體不該被掃\n", "utf-8");
    const out = await run(fx.tools["comment_signal_check"], { path: "docs/guide.markdown", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
    expect(out.failClosedReason).toBeUndefined();
  });

  test("explicit docs 目錄只含 .md / .markdown：scannedFileCount=0 且 shouldBlockCompletion=false", async () => {
    // 目錄內只放 Markdown 檔，應維持零掃描 + 不阻擋。
    // 不得因 directoryResolver 回空陣列就觸發 `no_supported_files` fail-closed。
    mkdirSync(join(ws.root, "docs"), { recursive: true });
    writeFileSync(join(ws.root, "docs", "README.md"), "# README\n", "utf-8");
    writeFileSync(join(ws.root, "docs", "guide.markdown"), "# Guide\n", "utf-8");

    const out = await run(fx.tools["comment_signal_check"], { path: "docs", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.skippedFileCount).toBe(0);
    expect(out.unreadableFileCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
    expect(out.failClosedReason).toBeUndefined();
  });
});

// ─── report 區別 scanned/skipped/unreadable ───────────

describe("08 - JVM scan: report 區別 scanned / skipped / unreadable", () => {
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

  test("directory mode：可讀 .ts + 不可讀 .java → unreadableFileCount=1、skippedFileCount=0", async () => {
    // directoryResolver 過濾 SCAN_EXTENSIONS 後 .md 不會進入，
    // 故此情境只驗證 scanned / unreadable 兩個分類。
    const srcDir = join(ws.root, "src", "auth");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "session.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
    writeFileSync(join(srcDir, "NOTES.md"), "// [TODO:P2] MD 不該被掃\n", "utf-8");
    // 寫入 .java 但 chmod 0 → directoryResolver 仍會列出（檔案存在），
    // 但 sourceResolver 會回 null → 計入 unreadable
    const locked = join(srcDir, "Locked.java");
    writeFileSync(locked, "// [TODO:P2] 之後處理\n", "utf-8");
    chmodSync(locked, 0o000);

    try {
      const out = await run(fx.tools["comment_signal_check"], { path: "src/auth", changedOnly: false });
      expect(out.ok).toBe(true);
      // 只有 .ts 可讀 → scannedFileCount=1
      expect(out.scannedFileCount).toBe(1);
      expect(out.skippedFileCount).toBe(0); // directoryResolver 已過濾 .md
      expect(out.unreadableFileCount).toBe(1); // Locked.java
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  test("changedOnly=true：modifiedFiles 含 Markdown + 可讀 TS + 不可讀 Java 三類並存", async () => {
    // modifiedFiles 由 hook 紀錄，可能含任意副檔名。
    // 因此可同時驗證 scanned / skipped / unreadable 三個分類。
    const srcDir = join(ws.root, "src", "auth");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "session.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
    writeFileSync(join(srcDir, "NOTES.md"), "// [TODO:P2] MD 不該被掃\n", "utf-8");
    const locked = join(srcDir, "Locked.java");
    writeFileSync(locked, "// [TODO:P2] 之後處理\n", "utf-8");
    chmodSync(locked, 0o000);

    try {
      await fx.store.recordModifiedFile("s1", "src/auth/session.ts");
      await fx.store.recordModifiedFile("s1", "src/auth/NOTES.md");
      await fx.store.recordModifiedFile("s1", "src/auth/Locked.java");

      const out = await run(fx.tools["comment_signal_check"], {}, "s1");
      expect(out.ok).toBe(true);
      expect(out.scannedFileCount).toBe(1); // session.ts
      expect(out.skippedFileCount).toBe(1); // NOTES.md
      expect(out.unreadableFileCount).toBe(1); // Locked.java
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  test("全為可讀且無 Markdown 時：skipped/unreadable 皆為 0", async () => {
    const srcDir = join(ws.root, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "a.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
    writeFileSync(join(srcDir, "b.kt"), "// [TODO:P2] 之後處理\n", "utf-8");

    const out = await run(fx.tools["comment_signal_check"], { path: "src", changedOnly: false });
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(2);
    expect(out.skippedFileCount).toBe(0);
    expect(out.unreadableFileCount).toBe(0);
  });
});

// ─── parent/child aggregation 對 JVM source ───────────

describe("08 - JVM scan: parent/child aggregation 對 JVM 修改", () => {
  let ws: ReturnType<typeof createWorkspace>;
  beforeEach(async () => {
    ws = createWorkspace();
    mkdirSync(join(ws.root, "src"), { recursive: true });
  });
  afterEach(() => {
    ws.cleanup();
  });

  test("child session 寫入 .java 觸發非法 tag，parent completion 應看到 violation", async () => {
    writeFileSync(
      join(ws.root, "src", "Hello.java"),
      `// ${TAG_OPEN}WARN:P1] parent 應該看到 child 寫的 Java violation\n`,
      "utf-8",
    );

    const fake = createFakeV2Context({ directory: ws.root });
    fake.events.push({ type: "session.created", data: { sessionID: "jvm-child", parentID: "jvm-parent" } });
    const cleanup = await setupUltrawork(fake.ctx, { modules: [commentSignalModule] });
    try {
      const tools: Record<string, any> = Object.fromEntries([...fake.added.entries()]);
      const store = new CommentSignalStore(fake.ctx.storage as never);
      // 等事件迴圈把父子對應寫進 storage
      const start = Date.now();
      while ((await store.getSessionAncestors("jvm-child")).length === 0) {
        if (Date.now() - start > 2000) throw new Error("等不到父子對應寫入");
        await new Promise((r) => setTimeout(r, 10));
      }

      const after = fake.toolHooks.get("execute.after");
      expect(after).toBeDefined();
      await after!({ tool: "edit", sessionID: "jvm-child", status: "completed", input: { path: "src/Hello.java" } });

      const out = await run(tools["comment_signal_check"], {}, "jvm-parent");
      expect(out.scannedFileCount).toBe(1);
      expect(out.shouldBlockCompletion).toBe(true);
      const codes = (out.violations as Array<{ code: string }>).map((v) => v.code);
      expect(codes).toContain("UNKNOWN_TAG");
      const filePaths = (out.violations as Array<{ filePath: string }>).map((v) => v.filePath);
      expect(filePaths).toContain("src/Hello.java");
    } finally {
      await cleanup();
    }
  });
});
