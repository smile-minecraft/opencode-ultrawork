/**
 * 26 — 真實 today 與掃描涵蓋（Red first）。
 *
 * 背景有二：
 *   ① `buildDeps` 從未注入 `today`，各工具退回 `"1970-01-01"`，
 *      `EXPIRED_COMMENT`／`OVERDUE_COMMENT` 永遠不觸發。
 *   ② `SCAN_EXTENSIONS` 只有 15 種（缺 `.py`／`.go`／`.rs`／`.c`／`.h`／
 *      `.toml` 等），且任一路徑段以 `.` 開頭就整段跳過（連
 *      `.github/workflows/*.yml` 都中），那些檔案裡的 `AI_DO_NOT_EDIT:P0`
 *      不會擋。
 *
 * 要求：`buildDeps` 注入真實 today（YYYY-MM-DD）；掃描政策補齊可解析註解
 * 語言的副檔名，並把 dot 目錄與 dot 檔分開處理（dot 檔仍跳過，敏感檔與
 * `.git`／`.opencode` 等排除保留）。
 *
 * P0 阻斷/G3 傳統：fixture 內的 functional tag literal 以 TAG_OPEN 拼接。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCAN_EXTENSIONS,
  isScannableDirRoot,
  isScannableExplicitPath,
  isWorktreeRootPath,
  listDirectoryFiles,
} from "../../../../src/modules/comment-signal/file-scan.ts";
import { parseCommentSignals } from "../../../../src/modules/comment-signal/parser.ts";
import { currentDayString } from "../../../../src/modules/comment-signal/tool-deps.ts";
import {
  createWorkspace,
  setupCommentSignal,
  run,
  type CommentSignalFixture,
} from "./_helpers.ts";

const TAG_OPEN = "[";

describe("26 - 真實 today：EXPIRED／OVERDUE 可觸發", () => {
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

  test("currentDayString 回傳今日 YYYY-MM-DD（非 1970-01-01）", () => {
    const today = currentDayString();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(today).not.toBe("1970-01-01");
    expect(today).toBe(new Date().toISOString().slice(0, 10));
  });

  test("過期 expires 的註解會觸發 EXPIRED_COMMENT", async () => {
    writeFileSync(
      join(ws.root, "src", "a.ts"),
      "// [TODO:P2 expires=2000-01-01] 之後補上單元測試，否則會影響上線時程。\n",
      "utf-8",
    );
    const out = await run(fx.tools["comment_signal_check"], { path: "src/a.ts", changedOnly: false });
    expect(out.ok).toBe(true);
    const codes = (out.violations as Array<{ code: string }>).map((v) => v.code);
    expect(codes).toContain("EXPIRED_COMMENT");
  });

  test("過期 due 的註解會觸發 OVERDUE_COMMENT", async () => {
    writeFileSync(
      join(ws.root, "src", "a.ts"),
      "// [TODO:P2 due=2000-01-01] 之後補上單元測試，否則會影響上線時程。\n",
      "utf-8",
    );
    const out = await run(fx.tools["comment_signal_check"], { path: "src/a.ts", changedOnly: false });
    expect(out.ok).toBe(true);
    const codes = (out.violations as Array<{ code: string }>).map((v) => v.code);
    expect(codes).toContain("OVERDUE_COMMENT");
  });
});

describe("26 - 掃描涵蓋：副檔名與 dot 目錄／dot 檔", () => {
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

  test("SCAN_EXTENSIONS 含可解析註解語言的副檔名", () => {
    for (const ext of [".py", ".go", ".rs", ".c", ".h", ".toml"]) {
      expect(SCAN_EXTENSIONS.has(ext), ext).toBe(true);
    }
  });

  test("單元：dot 目錄下的可掃描檔可掃，dot 檔／敏感／排除目錄仍擋", () => {
    expect(isScannableExplicitPath(".github/workflows/ci.yml")).toBe(true);
    expect(isScannableExplicitPath("src/app.py")).toBe(true);
    expect(isScannableExplicitPath("src/main.go")).toBe(true);
    // dot 檔仍跳過
    expect(isScannableExplicitPath("src/.hidden.ts")).toBe(false);
    expect(isScannableExplicitPath(".hidden.ts")).toBe(false);
    // 敏感與排除目錄保留
    expect(isScannableExplicitPath(".env")).toBe(false);
    expect(isScannableExplicitPath(".git/hooks/x.ts")).toBe(false);
    expect(isScannableExplicitPath(".opencode/x.ts")).toBe(false);
  });

  test("列舉：dot 目錄下的檔案會列出，dot 檔不會", () => {
    mkdirSync(join(ws.root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(ws.root, ".github", "workflows", "ci.yml"), "# deployed\n", "utf-8");
    writeFileSync(join(ws.root, "src", ".hidden.ts"), "// hidden\n", "utf-8");
    writeFileSync(join(ws.root, "src", "ok.ts"), "// ok\n", "utf-8");

    const out = listDirectoryFiles(ws.root, ".");
    expect(out).not.toBeNull();
    expect(out).toContain(".github/workflows/ci.yml");
    expect(out).toContain("src/ok.ts");
    expect(out!.some((p) => p.includes(".hidden.ts"))).toBe(false);
  });

  test("edit .py 遇 AI_DO_NOT_EDIT:P0 必須 throw 阻斷", async () => {
    writeFileSync(
      join(ws.root, "src", "gen.py"),
      `# ${TAG_OPEN}AI_DO_NOT_EDIT:P0] 此檔由 codegen 自動產生，禁止人工修改。\n`,
      "utf-8",
    );
    const before = fx.fake.toolHooks.get("execute.before");
    expect(before, "execute.before 已註冊").toBeDefined();

    await expect(
      before!({ tool: "edit", sessionID: "sess-py-dne", input: { path: "src/gen.py" } }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);
  });

  test("edit .go 遇 AI_DO_NOT_EDIT:P0 必須 throw 阻斷", async () => {
    writeFileSync(
      join(ws.root, "src", "gen.go"),
      `// ${TAG_OPEN}AI_DO_NOT_EDIT:P0] 此檔由 codegen 自動產生，禁止人工修改。\n`,
      "utf-8",
    );
    const before = fx.fake.toolHooks.get("execute.before");
    expect(before, "execute.before 已註冊").toBeDefined();

    await expect(
      before!({ tool: "edit", sessionID: "sess-go-dne", input: { path: "src/gen.go" } }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);
  });

  test("edit dot 目錄下的 yml 遇 AI_DO_NOT_EDIT:P0 必須 throw 阻斷", async () => {
    mkdirSync(join(ws.root, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(ws.root, ".github", "workflows", "ci.yml"),
      `# ${TAG_OPEN}AI_DO_NOT_EDIT:P0] 此檔由平台鎖定，禁止人工修改。\n`,
      "utf-8",
    );
    const before = fx.fake.toolHooks.get("execute.before");
    expect(before, "execute.before 已註冊").toBeDefined();

    await expect(
      before!({ tool: "edit", sessionID: "sess-dotdir-dne", input: { path: ".github/workflows/ci.yml" } }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);
  });

  test("dot 目錄（無尾斜線）在 check／baseline／only_new 都視為資料夾", async () => {
    // 判斷「單檔 or 資料夾」不能只看副檔名形狀：`.github`／`.hidden` 這類名稱
    // 本身帶點號，會被副檔名啟發式誤判成檔案，導致整棵目錄不被掃描。
    mkdirSync(join(ws.root, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(ws.root, ".github", "workflows", "ci.yml"),
      `# ${TAG_OPEN}WARN:P1] 未知 tag，之後處理\n`,
      "utf-8",
    );

    const checked = await run(fx.tools["comment_signal_check"], { path: ".github", changedOnly: false });
    expect(checked.scannedFileCount).toBe(1);
    expect(checked.shouldBlockCompletion).toBe(true);

    const based = await run(
      fx.tools["comment_signal_baseline"],
      { path: ".github", changedOnly: false, force: true },
    );
    expect(based.scannedFileCount).toBe(1);

    const onlyNew = await run(
      fx.tools["comment_signal_only_new"],
      { path: ".github", changedOnly: false },
    );
    expect(onlyNew.scannedFileCount).toBe(1);
  });

  test("排除目錄優先於 dot 目錄放行（.git／.opencode 下的檔案仍不掃）", () => {
    for (const dir of [".git", ".opencode"]) {
      expect(isScannableExplicitPath(`${dir}/hooks/x.ts`)).toBe(false);
    }
    expect(isScannableDirRoot(".git")).toBe(false);
    expect(isScannableDirRoot(".opencode")).toBe(false);
    // 純 build artifacts（含新增 .py 後常見的虛擬環境）維持排除
    expect(isScannableDirRoot("__pycache__")).toBe(false);
    expect(isScannableDirRoot(".venv")).toBe(false);
  });

  test("isWorktreeRootPath：只有 worktree 根算完整範圍，主機根與子目錄都不算", () => {
    // 這條判斷決定「一次掃描能不能替歸不出範圍的舊阻斷重新確立真相」，
    // 放寬等於讓局部掃描替整專案背書，所以正面與反面都要鎖住。
    // 特別是 `/`：它是主機根目錄，不是 worktree 根，只看字面形狀會誤判。
    for (const root of [".", "./", "", ".//"]) {
      expect(isWorktreeRootPath(ws.root, root), root).toBe(true);
    }
    // 判定的是「這個路徑指向哪裡」，不是「字面好不好看」：`src/..` 解析後
    // 就是 worktree 根，所以算完整範圍。
    expect(isWorktreeRootPath(ws.root, "src/..")).toBe(true);
    for (const notRoot of ["/", "/Users", "..", "src", "./src", "src/", ".github"]) {
      expect(isWorktreeRootPath(ws.root, notRoot), notRoot).toBe(false);
    }
    // 沒有 worktree 就不判定（寧可不算完整範圍，也不要誤放）
    expect(isWorktreeRootPath("", ".")).toBe(false);
  });

  test("parser：py 的 # 註解 tag 可解析，docstring 內的 # 不誤判", () => {
    const parsed = parseCommentSignals(
      `# ${TAG_OPEN}TODO:P2] 之後補上單元測試。\n`,
      "src/a.py",
    );
    expect(parsed.signals.length).toBe(1);
    expect(parsed.signals[0].tag).toBe("TODO");

    const doc = parseCommentSignals(
      `"""模組說明。\n# ${TAG_OPEN}TODO:P2] 這只是文件範例。\n"""\nx = 1\n`,
      "src/b.py",
    );
    expect(doc.signals.length).toBe(0);
  });
});
