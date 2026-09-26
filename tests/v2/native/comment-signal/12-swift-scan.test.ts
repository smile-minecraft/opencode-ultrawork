/**
 * Red phase — Comment Signal Swift source scan
 *
 * 範圍：
 *   - `.swift` 必須被列為 Comment Signal 認可的 executable 副檔名。
 *   - Swift 真實註解（含 `///` doc comment、nested block comment）應被辨識。
 *   - 字串內的註解樣式（普通字串、三引號多行、raw string 含 hash、插值）不得誤判。
 *   - `.build` / `DerivedData` / `.swiftpm` 目錄必須被排除。
 *   - 顯式 `.swift` 不可讀取仍維持 fail-closed。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  SCAN_EXCLUDED_DIRS,
  SCAN_EXTENSIONS,
  listDirectoryFiles,
} from "../../../../src/modules/comment-signal/file-scan.ts";
import { extractSourceCommentLines } from "../../../../src/modules/comment-signal/lexer.ts";
import { fakeV2ToolContext } from "../../_fake-v2-context.ts";
import {
  createWorkspace,
  setupCommentSignal,
  parse,
  type CommentSignalFixture,
} from "./_helpers.ts";

const TAG_OPEN = "[";
const TRIPLE = ['"', '"', '"'].join("");

describe("12 - Swift scan: SCAN_EXTENSIONS / SCAN_EXCLUDED_DIRS", () => {
  test("SCAN_EXTENSIONS 包含 .swift", () => {
    expect(SCAN_EXTENSIONS.has(".swift")).toBe(true);
  });

  test("SCAN_EXCLUDED_DIRS 排除 Swift 建置產物目錄", () => {
    expect(SCAN_EXCLUDED_DIRS.has(".build")).toBe(true);
    expect(SCAN_EXCLUDED_DIRS.has("DerivedData")).toBe(true);
    expect(SCAN_EXCLUDED_DIRS.has(".swiftpm")).toBe(true);
  });
});

describe("12 - Swift scan: listDirectoryFiles", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "comment-signal-swift-"));
  });
  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  test("目錄含 .swift 時列入", () => {
    mkdirSync(join(tmpRoot, "Sources", "App"), { recursive: true });
    writeFileSync(join(tmpRoot, "Sources", "App", "Main.swift"), "let x = 1\n", "utf-8");
    const files = listDirectoryFiles(tmpRoot, "Sources/App");
    expect(files).toEqual(["Sources/App/Main.swift"]);
  });

  test("directory scan 不納入 .build / DerivedData / .swiftpm 產物", () => {
    mkdirSync(join(tmpRoot, "Sources"), { recursive: true });
    writeFileSync(join(tmpRoot, "Sources", "Main.swift"), "let x = 1\n", "utf-8");
    mkdirSync(join(tmpRoot, ".build", "artifacts"), { recursive: true });
    writeFileSync(join(tmpRoot, ".build", "artifacts", "Gen.swift"), "let g = 1\n", "utf-8");
    mkdirSync(join(tmpRoot, "DerivedData", "App"), { recursive: true });
    writeFileSync(join(tmpRoot, "DerivedData", "App", "Idx.swift"), "let i = 1\n", "utf-8");
    mkdirSync(join(tmpRoot, ".swiftpm"), { recursive: true });
    writeFileSync(join(tmpRoot, ".swiftpm", "Cache.swift"), "let c = 1\n", "utf-8");
    const files = listDirectoryFiles(tmpRoot, ".");
    expect(files).toEqual(["Sources/Main.swift"]);
  });
});

describe("12 - Swift scan: lexer", () => {
  test("普通字串內的 // 與 /* */ 不當註解，真實註解仍辨識", () => {
    const src = [
      `let s = "// ${TAG_OPEN}TODO:P2] in string"`,
      `let t = "/* ${TAG_OPEN}TODO:P2] in string */"`,
      `// ${TAG_OPEN}TODO:P2] real`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "Sources/Main.swift");
    expect(out.map((c) => c.text)).toEqual([" [TODO:P2] real"]);
  });

  test("三引號多行字串內容不當註解", () => {
    const src = [
      `let html = ${TRIPLE}`,
      `// ${TAG_OPEN}TODO:P2] inside multiline`,
      `/* ${TAG_OPEN}TODO:P2] inside block */`,
      `${TRIPLE}`,
      `// ${TAG_OPEN}TODO:P2] real`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "Sources/Main.swift");
    expect(out.map((c) => c.text)).toEqual([" [TODO:P2] real"]);
  });

  test("raw string（含 hash）內容不當註解", () => {
    const src = [
      `let pattern = #"// ${TAG_OPEN}TODO:P2] inside raw"#`,
      `let block = #"/* ${TAG_OPEN}TODO:P2] inside raw */"#`,
      `// ${TAG_OPEN}TODO:P2] real`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "Sources/Main.swift");
    expect(out.map((c) => c.text)).toEqual([" [TODO:P2] real"]);
  });

  test("插值內的註解視為 code comment，插值外 raw text 跳過", () => {
    const src = [
      `let msg = "value \\(name // ${TAG_OPEN}TODO:P2] in interpolation)"`,
      `let plain = "text // ${TAG_OPEN}TODO:P2] not a comment"`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "Sources/Main.swift");
    expect(out).toHaveLength(1);
    expect(out[0].text.startsWith(" [TODO:P2] in interpolation")).toBe(true);
  });

  test("/// doc comment 被辨識", () => {
    const src = [
      `/// ${TAG_OPEN}TODO:P2] 之後處理`,
      `func f() {}`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "Sources/Main.swift");
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(1);
  });

  test("nested block comment 完整吞掉外層才結束", () => {
    // 若不支援巢狀，內層 `*/` 會提前關閉外層，使 `// ... still inside`
    // 被誤判為 line comment（共 3 個 entries）；正確應只有 2 個。
    const src = [
      `/* outer /* ${TAG_OPEN}TODO:P2] inner */ // ${TAG_OPEN}TODO:P2] still inside */`,
      `// ${TAG_OPEN}TODO:P2] real`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "Sources/Main.swift");
    expect(out).toHaveLength(2);
    expect(out[0].line).toBe(1);
    expect(out[1].text).toBe(" [TODO:P2] real");
  });

  test("tag-like text 在字串內不被當註解", () => {
    const src = `let s = "see ${TAG_OPEN}TODO:P2] tag-like text";`;
    const out = extractSourceCommentLines(src, "Sources/Main.swift");
    expect(out).toEqual([]);
  });
});

describe("12 - Swift scan: comment_signal_check 整合", () => {
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

  test("explicit .swift 檔命中非法 tag 並阻擋", async () => {
    mkdirSync(join(ws.root, "Sources"), { recursive: true });
    writeFileSync(
      join(ws.root, "Sources", "Main.swift"),
      `// ${TAG_OPEN}WARN:P1] Swift 內的非法 tag 應被命中\n`,
      "utf-8",
    );
    const out = parse(
      await fx.tools["comment_signal_check"].execute(
        { path: "Sources/Main.swift", changedOnly: false },
        fakeV2ToolContext(),
      ),
    );
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect(out.shouldBlockCompletion).toBe(true);
    const codes = (out.violations as Array<{ code: string }>).map((v) => v.code);
    expect(codes).toContain("UNKNOWN_TAG");
  });

  test("directory scan 不納入 .build 產物", async () => {
    mkdirSync(join(ws.root, "Sources"), { recursive: true });
    writeFileSync(
      join(ws.root, "Sources", "Main.swift"),
      "// [TODO:P2] 之後處理\n",
      "utf-8",
    );
    mkdirSync(join(ws.root, ".build", "artifacts"), { recursive: true });
    writeFileSync(
      join(ws.root, ".build", "artifacts", "Gen.swift"),
      `// ${TAG_OPEN}WARN:P1] 產物內 tag 不該被掃\n`,
      "utf-8",
    );
    const out = parse(
      await fx.tools["comment_signal_check"].execute(
        { path: "Sources", changedOnly: false },
        fakeV2ToolContext(),
      ),
    );
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    const files = (out.violations as Array<{ filePath: string }>).map((v) => v.filePath);
    expect(files.some((f) => f.includes(".build"))).toBe(false);
  });

  test("explicit 不可讀 .swift 仍 fail closed", async () => {
    const out = parse(
      await fx.tools["comment_signal_check"].execute(
        { path: "Sources/Missing.swift", changedOnly: false },
        fakeV2ToolContext(),
      ),
    );
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(0);
    expect(out.unreadableFileCount).toBe(1);
    expect(out.shouldBlockCompletion).toBe(true);
    expect(out.failClosedReason).toBe("file_unreadable");
  });
});

// ─── 審查回歸：/// doc comment 必須走 production path 產生 tag violation ──

describe("12 - Swift scan: /// doc comment production path", () => {
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

  test("/// [WARN:P1] 經 comment_signal_check 產生 UNKNOWN_TAG 並阻擋", async () => {
    mkdirSync(join(ws.root, "Sources"), { recursive: true });
    writeFileSync(
      join(ws.root, "Sources", "Doc.swift"),
      `/// ${TAG_OPEN}WARN:P1] Swift doc comment 內的非法 tag\n`,
      "utf-8",
    );
    const out = parse(
      await fx.tools["comment_signal_check"].execute(
        { path: "Sources/Doc.swift", changedOnly: false },
        fakeV2ToolContext(),
      ),
    );
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect(out.shouldBlockCompletion).toBe(true);
    const codes = (out.violations as Array<{ code: string }>).map((v) => v.code);
    expect(codes).toContain("UNKNOWN_TAG");
  });

  test("/// 合法 TODO 與 // 行為一致：非阻擋、不多報", async () => {
    // `// [TODO:P2]` 無 owner 會產生 1 個非阻擋 GENERIC_COMMENT；
    // `///` 修正後必須完全一致（同 code、同不阻擋）。
    mkdirSync(join(ws.root, "Sources"), { recursive: true });
    writeFileSync(
      join(ws.root, "Sources", "Doc.swift"),
      `/// ${TAG_OPEN}TODO:P2] 之後處理\nfunc f() {}\n`,
      "utf-8",
    );
    const out = parse(
      await fx.tools["comment_signal_check"].execute(
        { path: "Sources/Doc.swift", changedOnly: false },
        fakeV2ToolContext(),
      ),
    );
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect(out.violationCount).toBe(1);
    const codes = (out.violations as Array<{ code: string }>).map((v) => v.code);
    expect(codes).toEqual(["GENERIC_COMMENT"]);
    expect(out.shouldBlockCompletion).toBe(false);
  });

  test("/// 無括號 TODO 維持既有行為：不觸發 UNFORMATTED", async () => {
    // 刻意保留的既有行為：unformatted 偵測以前綴 `//` 為準，三斜線 doc
    // 不進入該路徑；此測試釘住該行為，避免 parser 前綴修正意外擴散。
    mkdirSync(join(ws.root, "Sources"), { recursive: true });
    writeFileSync(
      join(ws.root, "Sources", "Doc.swift"),
      "/// TODO 之後處理\n",
      "utf-8",
    );
    const out = parse(
      await fx.tools["comment_signal_check"].execute(
        { path: "Sources/Doc.swift", changedOnly: false },
        fakeV2ToolContext(),
      ),
    );
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect(out.violationCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
  });
});

// ─── 複審回歸：字串內假 tag 不得污染尾端真註解（production path）──

describe("12 - Swift scan: string-interior fake tag production path", () => {
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

  test("字串內假 /// tag 加尾端真 // 註解：不產生 UNKNOWN_TAG、不阻擋", async () => {
    mkdirSync(join(ws.root, "Sources"), { recursive: true });
    writeFileSync(
      join(ws.root, "Sources", "Fake.swift"),
      `let s = "/// ${TAG_OPEN}WARN:P1] x" // real\n`,
      "utf-8",
    );
    const out = parse(
      await fx.tools["comment_signal_check"].execute(
        { path: "Sources/Fake.swift", changedOnly: false },
        fakeV2ToolContext(),
      ),
    );
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect(out.violationCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
  });

  test("字串內只有假 tag、無尾端註解：不產生 violation、不阻擋", async () => {
    mkdirSync(join(ws.root, "Sources"), { recursive: true });
    writeFileSync(
      join(ws.root, "Sources", "FakeOnly.swift"),
      `let s = "/// ${TAG_OPEN}WARN:P1] x"\n`,
      "utf-8",
    );
    const out = parse(
      await fx.tools["comment_signal_check"].execute(
        { path: "Sources/FakeOnly.swift", changedOnly: false },
        fakeV2ToolContext(),
      ),
    );
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect(out.violationCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
  });

  test("字串內假 block tag 加尾端真 block 註解：不產生 UNKNOWN_TAG、不阻擋", async () => {
    mkdirSync(join(ws.root, "Sources"), { recursive: true });
    writeFileSync(
      join(ws.root, "Sources", "FakeBlock.swift"),
      `let s = "/* ${TAG_OPEN}WARN:P1] x */" /* real */\n`,
      "utf-8",
    );
    const out = parse(
      await fx.tools["comment_signal_check"].execute(
        { path: "Sources/FakeBlock.swift", changedOnly: false },
        fakeV2ToolContext(),
      ),
    );
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect(out.violationCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
  });
});

// ─── 複審回歸：非 Swift fallback 不得接受 `///` 新前綴（production path）──

describe("12 - Swift scan: non-Swift triple-slash fallback stays two-slash", () => {
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

  test("TS 字串內假 /// tag 加尾端真 // 註解：不產生 UNKNOWN_TAG、不阻擋", async () => {
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(
      join(ws.root, "src", "Fake.ts"),
      `const s = "/// ${TAG_OPEN}WARN:P1] x" // real\n`,
      "utf-8",
    );
    const out = parse(
      await fx.tools["comment_signal_check"].execute(
        { path: "src/Fake.ts", changedOnly: false },
        fakeV2ToolContext(),
      ),
    );
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect(out.violationCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
  });
});
