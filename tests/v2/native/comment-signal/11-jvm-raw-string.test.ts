/**
 * Phase Red/Green — Comment Signal JVM triple-quoted raw / text-block strings
 *
 * 範圍（與 實作說明 對齊，本 Task 處理 JVM triple-quote literal lexer）：
 *   - Java text block / Kotlin raw string / Groovy triple-quoted string 內含的
 *     line comment marker、block comment marker、fake tag header、workflow-ID
 *     文字均不得被解析為 comment / signal。
 *     header、workflow-ID-like 文字均不得被解析為 comment / signal。
 *   - 同一檔案內 text block / raw string 旁的真實 JVM 註解仍應被解析並
 *     觸發既有 rule。
 *   - 既有的 JS / TS template literal 行為（單行 / 多行 / interpolation）
 *     必須保持不變。
 *   - 既有的 JS / TS 單/雙引號字串內 fake tag 不觸發 signal 的 rule
 *     仍維持。
 *   - 既有 JVM scan 測試（08-jvm-scan.test.ts）與 string literal 測試
 *     （10-string-literal-red.test.ts）不得被 regression。
 *
 * 設計重點：
 *   - 本檔涵蓋 Red phase：先用 failing cases 鎖定 lexer 對 triple quote 的
 *     處理缺口；Green 後預期全綠。
 *   - 對 lexer 直接呼叫 + 對 parseCommentSignals / comment_signal_check
 *     雙路徑都驗證，避免只 fix 其中一條路徑。
 *   - JVM source fixture 以 string 拼接或 array.join 構造，避免在
 *     TypeScript 檔內直接寫 JVM triple-quote 被當成 TS 字串邊界。
 *   - 每個 test 用獨立 workspace 並在 afterEach 清理 Comment Signal session
 *     state（plugin 不主動清理 session）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  extractJsStyleCommentLines,
  extractSourceCommentLines,
} from "../../../../src/modules/comment-signal/lexer.ts";
import { parseCommentSignals } from "../../../../src/modules/comment-signal/parser.ts";
import { validateSourceForWorkflowIds } from "../../../../src/modules/comment-signal/validator.ts";
import { fakeV2ToolContext } from "../../_fake-v2-context.ts";
import {
  createWorkspace,
  setupCommentSignal,
  parse,
  type CommentSignalFixture,
} from "./_helpers.ts";

// 在 fixture source 內的非法 tag literal 透過 runtime 拼接生成，避免檔案本身
// 被 Comment Signal scanner 抓到 UNKNOWN_TAG 而成為 blocking violation。
const TAG_OPEN = "[";

// 構造 JVM triple-quoted 字串內容：避免在 TS 檔內直接寫 """ 造成 lexer 衝突。
const TRIPLE = ['"', '"', '"'].join("");
const TRIPLE_LIT = `${TRIPLE}${TRIPLE}`; // 六個 quote（開 + 關）

// ─── Lexer direct test：extractJsStyleCommentLines 對 triple-quote 內容 ──

describe("11 - JVM raw string: lexer 直接跳過 triple-quote 內容", () => {
  // 三種語言的 triple-quote config 對照：
  //   - Java：{ delimiter: '"', escape: true }
  //   - Kotlin / .kts：{ delimiter: '"', escape: false }
  //   - Groovy：{ delimiter: "both", escape: false }
  const JAVA_TRIPLE = { delimiter: '"', escape: true } as const;
  const KOTLIN_TRIPLE = { delimiter: '"', escape: false } as const;
  const GROOVY_TRIPLE = { delimiter: "both", escape: false } as const;

  test("Java text block 內的 // [TODO:P2] 不會被當 comment", () => {
    const src = [
      `String html = ${TRIPLE}`,
      `<html>`,
      `// [TODO:P2] 這只是字串內容，不該被掃`,
      `</html>`,
      `${TRIPLE};`,
      `// [TODO:P2] 真實的 line comment`,
    ].join("\n");
    const out = extractJsStyleCommentLines(src, true, JAVA_TRIPLE);
    const texts = out.map((c) => c.text);
    expect(texts).toEqual([" [TODO:P2] 真實的 line comment"]);
  });

  test("Java text block 內的 /* [SECURITY:P0] */ block 不會被當 comment", () => {
    const src = [
      `String x = ${TRIPLE}`,
      `/* [SECURITY:P0] fake block in text block */`,
      `tail`,
      `${TRIPLE};`,
      `/* [FIXME:P2] real block */`,
    ].join("\n");
    const out = extractJsStyleCommentLines(src, true, JAVA_TRIPLE);
    const texts = out.map((c) => c.text);
    // 真正的 block 應解析成 1 個 entry；text block 內的 /* */ 必須跳過
    expect(texts).toEqual([" [FIXME:P2] real block "]);
  });

  test("Kotlin raw string 內含 workflow ID-like 文字不該被視為 comment", () => {
    const src = [
      `val s = ${TRIPLE}`,
      `// comment-signal-java-scan-remediation-20260811-004`,
      `/* TODO-P1 owner=@x */`,
      `${TRIPLE}`,
      `// [TODO:P2] real`,
    ].join("\n");
    const out = extractJsStyleCommentLines(src, true, KOTLIN_TRIPLE);
    const texts = out.map((c) => c.text);
    expect(texts).toEqual([" [TODO:P2] real"]);
  });

  test("Groovy triple-quoted string 內 fake marker 不該被掃", () => {
    const src = [
      `def s = ${TRIPLE}`,
      `// [DANGER:P0] fake`,
      `// [SECURITY:P0 owner=@x] fake`,
      `${TRIPLE}`,
      `// [TODO:P2] real`,
    ].join("\n");
    const out = extractJsStyleCommentLines(src, true, GROOVY_TRIPLE);
    const texts = out.map((c) => c.text);
    expect(texts).toEqual([" [TODO:P2] real"]);
  });

  test("Groovy GString interpolation 的 line comment 內 } 延續至換行", () => {
    const src = [
      `def message = ${TRIPLE}`,
      `raw // [DANGER:P0] fake`,
      `\${ value // [TODO:P2 owner=@x issue=#123] comment }`,
      `}`,
      `raw after interpolation // [SECURITY:P0] fake`,
      `${TRIPLE}`,
      `// [TODO:P2] adjacent real`,
    ].join("\n");
    const out = extractJsStyleCommentLines(src, true, GROOVY_TRIPLE);
    const texts = out.map((c) => c.text);
    expect(texts).toEqual([
      " [TODO:P2 owner=@x issue=#123] comment }",
      " [TODO:P2] adjacent real",
    ]);
  });

  test("Java text block 跨越多行 + 後接真實 line + 真實 block", () => {
    const src = [
      `String tpl = ${TRIPLE}`,
      `line 1 // [TODO:P2] inside`,
      `line 2`,
      `${TRIPLE};`,
      `// [TODO:P2] real line`,
      `/* [REVIEW:P1] real block */`,
    ].join("\n");
    const out = extractJsStyleCommentLines(src, true, JAVA_TRIPLE);
    const texts = out.map((c) => c.text);
    expect(texts).toEqual([
      " [TODO:P2] real line",
      " [REVIEW:P1] real block ",
    ]);
  });

  test("Java text block 內含反斜線 escape 不會誤關閉 triple", () => {
    // 模擬 raw 內含 \"\"\" 風格的 escape（雖然 Java text block 用 \\\"）
    const src = [
      `String tpl = ${TRIPLE}`,
      `he said \\"\\"\\" but it's still inside`,
      `// [TODO:P2] fake inside`,
      `${TRIPLE};`,
      `// [TODO:P2] real`,
    ].join("\n");
    const out = extractJsStyleCommentLines(src, true, JAVA_TRIPLE);
    const texts = out.map((c) => c.text);
    expect(texts).toEqual([" [TODO:P2] real"]);
  });

  test("空 triple-quote（6 個 quote）不會破壞後續 scanning", () => {
    // 6 個 quote：理論上可被視為 """ + """（空 triple）
    const src = [
      `String a = ${TRIPLE_LIT};`,
      `// [TODO:P2] real`,
    ].join("\n");
    const out = extractJsStyleCommentLines(src, true, JAVA_TRIPLE);
    const texts = out.map((c) => c.text);
    expect(texts).toEqual([" [TODO:P2] real"]);
  });
});

// ─── Lexer default extractSourceCommentLines：JVM 副檔名開啟 triple-quote ──

describe("11 - JVM raw string: extractSourceCommentLines 對 JVM 副檔名", () => {
  test(".java text block 內 fake marker 不會被掃", () => {
    const src = [
      `String tpl = ${TRIPLE}`,
      `// [TODO:P2] inside`,
      `${TRIPLE};`,
      `// [TODO:P2] real`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "src/Hello.java");
    const texts = out.map((c) => c.text);
    expect(texts).toEqual([" [TODO:P2] real"]);
  });

  test(".kt raw string 內 fake marker 不會被掃", () => {
    const src = [
      `val s = ${TRIPLE}`,
      `// [DANGER:P0] inside`,
      `${TRIPLE}`,
      `// [TODO:P2] real`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "src/Hello.kt");
    const texts = out.map((c) => c.text);
    expect(texts).toEqual([" [TODO:P2] real"]);
  });

  test(".kts script 內 triple-quoted 字串 fake marker 不會被掃", () => {
    const src = [
      `val s = ${TRIPLE}`,
      `// [SECURITY:P0] inside`,
      `${TRIPLE}`,
      `// [TODO:P2] real`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "build.gradle.kts");
    const texts = out.map((c) => c.text);
    expect(texts).toEqual([" [TODO:P2] real"]);
  });

  test(".groovy 內 triple-quoted 字串 fake marker 不會被掃", () => {
    const src = [
      `def s = ${TRIPLE}`,
      `/* [PRIVACY:P0] fake */`,
      `${TRIPLE}`,
      `// [TODO:P2] real`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "src/Hello.groovy");
    const texts = out.map((c) => c.text);
    expect(texts).toEqual([" [TODO:P2] real"]);
  });

  test(".ts 的 triple-quote 不會被當 triple-quote（JS 不支援三引號）", () => {
    // JS / TS 的 `"""foo"""` 是 3 個相鄰雙引號字串："" + "foo" + ""。
    // lexer 不應主動啟用 triple-quote 模式；行為等同三段雙引號字串拼接。
    const src = [
      `const a = ${TRIPLE_LIT}in TS this is not a triple quote${TRIPLE_LIT};`,
      `// [TODO:P2] real`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "src/x.ts");
    const texts = out.map((c) => c.text);
    expect(texts).toEqual([" [TODO:P2] real"]);
  });
});

// ─── Parser 端對 JVM triple-quote：不應產出 fake signal ────────────

describe("11 - JVM raw string: parseCommentSignals 對 JVM triple-quote", () => {
  test("Java text block 內 fake marker 不會被 parser 當成 signal", () => {
    const src = [
      `String tpl = ${TRIPLE}`,
      `// [DANGER:P0] fake`,
      `/* [SECURITY:P0] fake */`,
      `${TRIPLE};`,
      `// [TODO:P2] real`,
    ].join("\n");
    const out = parseCommentSignals(src, "src/Hello.java");
    expect(out.signals).toHaveLength(1);
    expect(out.signals[0].tag).toBe("TODO");
    expect(out.signals[0].line).toBe(5);
  });

  test("Kotlin raw string 內 fake workflow-id like 文字不應觸發 WORKFLOW_ID_IN_COMMENT", () => {
    const src = [
      `val s = ${TRIPLE}`,
      `comment-signal-java-scan-remediation-20260811-004`,
      `task #123 fake inside`,
      `${TRIPLE}`,
      `// real plan-fixme-update-20260811-005`,
    ].join("\n");
    const violations = validateSourceForWorkflowIds(src, "src/Hello.kt");
    // 只有 line 5 的真實註解應被命中；raw string 內不應觸發
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(5);
  });
});

// ─── Comment Signal tool 整合：JVM triple-quote 不應觸發 violation ──

describe("11 - JVM raw string: comment_signal_check 對 triple-quote 內容", () => {
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

  test(".java 內 triple-quoted string 含 fake DANGER：無 blocking violation、不阻擋", async () => {
    const srcDir = join(ws.root, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "Html.java"),
      [
        `String html = ${TRIPLE}`,
        `// ${TAG_OPEN}DANGER:P0] fake inside text block`,
        `/* ${TAG_OPEN}SECURITY:P0] fake block inside */`,
        `${TRIPLE};`,
        `// ${TAG_OPEN}TODO:P2] 真實的 line comment 之後處理`,
      ].join("\n") + "\n",
      "utf-8",
    );

    const out = parse(
      await fx.tools["comment_signal_check"].execute(
        { path: "src/Html.java", changedOnly: false },
        fakeV2ToolContext(),
      ),
    );
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    // text block 內的 fake DANGER/SECURITY 不應被解析為 signal/violation；
    // 唯一的真實 comment 是合法 TODO:P2 標籤，無 violation。
    expect(out.violationCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
  });

  test(".kt 內 triple-quoted raw string 含 fake DANGER：無 blocking violation、不阻擋", async () => {
    const srcDir = join(ws.root, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "Tpl.kt"),
      [
        `val s = ${TRIPLE}`,
        `// ${TAG_OPEN}DANGER:P0] fake inside raw string`,
        `${TRIPLE}`,
        `// ${TAG_OPEN}TODO:P2] 真實的 raw string 之後處理`,
      ].join("\n") + "\n",
      "utf-8",
    );

    const out = parse(
      await fx.tools["comment_signal_check"].execute(
        { path: "src/Tpl.kt", changedOnly: false },
        fakeV2ToolContext(),
      ),
    );
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    expect(out.violationCount).toBe(0);
    expect(out.shouldBlockCompletion).toBe(false);
  });

  test(".groovy 內 triple-quoted string 含 fake + 真實 comment 混合：只有真實命中", async () => {
    const srcDir = join(ws.root, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "Script.groovy"),
      [
        `def tpl = ${TRIPLE}`,
        `// ${TAG_OPEN}SECURITY:P0 owner=@x] fake`,
        `/* ${TAG_OPEN}PRIVACY:P0 owner=@x] fake block */`,
        `${TRIPLE}`,
        `// ${TAG_OPEN}UNKNOWN:P1] real illegal tag`,
      ].join("\n") + "\n",
      "utf-8",
    );

    const out = parse(
      await fx.tools["comment_signal_check"].execute(
        { path: "src/Script.groovy", changedOnly: false },
        fakeV2ToolContext(),
      ),
    );
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    // 真實的 illegal UNKNOWN tag 仍應被命中
    const codes = (out.violations as Array<{ code: string }>).map((v) => v.code);
    expect(codes).toContain("UNKNOWN_TAG");
    // 但 fake 不應被掃出
    const fakeHits = codes.filter((c) => c === "UNKNOWN_TAG");
    expect(fakeHits).toHaveLength(1);
    expect(out.shouldBlockCompletion).toBe(true); // 真實的 UNKNOWN_TAG 仍要阻擋
  });

  test("comment_signal_explain 對 JVM triple-quote 內容不應被當合法 tag", async () => {
    const srcDir = join(ws.root, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "Example.java"),
      [
        `String tpl = ${TRIPLE}`,
        `// ${TAG_OPEN}DANGER:P0] fake inside`,
        `${TRIPLE};`,
      ].join("\n") + "\n",
      "utf-8",
    );

    const out = parse(
      await fx.tools["comment_signal_explain"].execute(
        { filePath: "src/Example.java", line: 2 },
        fakeV2ToolContext(),
      ),
    );
    expect(out.ok).toBe(true);
    // 第 2 行是 text block 內的 fake marker → 不應被視為合法 comment
    expect(out.mode).toBe("file");
    expect(out.raw).toBe(`// ${TAG_OPEN}DANGER:P0] fake inside`);
    // diagnosis 應說明「未格式化」或「此行不含功能型 tag header」，
    // 不應判定為格式正確的 tag。
    expect(typeof out.explanation).toBe("string");
  });
});

// ─── 回歸：JS/TS template literal 行為維持 ───────────────────────

describe("11 - JVM raw string: JS/TS template literal 不受影響", () => {
  test("template literal 內 fake marker 不會被當 comment（既有契約）", () => {
    const src = "const t = `// [TODO:P2] in template`;\n";
    const out = extractSourceCommentLines(src, "src/x.ts");
    expect(out).toEqual([]);
  });

  test("多行 template literal 內 fake marker 不會被當 comment", () => {
    const src = [
      "const t = `",
      "// [TODO:P2] in multi-line template",
      "more content",
      "`;",
    ].join("\n");
    const out = extractSourceCommentLines(src, "src/x.ts");
    expect(out).toEqual([]);
  });

  test("template interpolation 內 // comment 仍視為 code comment（既有契約）", () => {
    const src = "const t = `${// [TODO:P2] in interp`};\n";
    const out = extractSourceCommentLines(src, "src/x.ts");
    // interpolation 內的 // 視為 code comment（既有規則）。
    // lexer 把整行（直到 \\n）的字串切片當 comment text，因此尾巴會含 `}；
    expect(out).toHaveLength(1);
    expect(out[0].text.startsWith(" [TODO:P2] in interp")).toBe(true);
  });
});

// ─── Momus Blockers：Kotlin 反斜線邊界 + Groovy ''' 三單引號 ───────

describe("11 - JVM raw string: Kotlin backslash boundary (Momus blocker)", () => {
  test("Kotlin raw string \\+closing delimiter 後的真實 comment 仍應被解析", () => {
    // Kotlin raw string 內 `\` 為 literal（無 escape）；
    // 故 `\"""` 表示 literal `\` + closing `"""`，
    // lexer 必須在 `"""` 處關閉 triple，後續真實 comment 才能被解析。
    const src = [
      `val s = ${TRIPLE}`,
      `content\\${TRIPLE}`,
      `// ${TAG_OPEN}TODO:P2] real after raw string`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "src/Hello.kt");
    expect(out.map((c) => c.text)).toEqual([" [TODO:P2] real after raw string"]);
  });

  test("Kotlin raw string \\+closing delimiter 後的真實 block comment 仍應被解析", () => {
    const src = [
      `val s = ${TRIPLE}`,
      `tail\\${TRIPLE}`,
      `/* ${TAG_OPEN}TODO:P2] real block */`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "src/Hello.kt");
    expect(out.map((c) => c.text)).toEqual([" [TODO:P2] real block "]);
  });
});

describe("11 - JVM raw string: Groovy ''' triple single-quote raw string (Momus blocker)", () => {
  test("Groovy ''' 內 fake line comment + workflow ID-like 不該被掃", () => {
    const src = [
      `def s = '''`,
      `// ${TAG_OPEN}SECURITY:P0] fake`,
      `task #123 fake inside`,
      `'''`,
      `// ${TAG_OPEN}TODO:P2] real`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "src/Script.groovy");
    expect(out.map((c) => c.text)).toEqual([" [TODO:P2] real"]);
  });

  test("Groovy ''' 內 fake block comment 不該被掃", () => {
    const src = [
      `def s = '''`,
      `/* ${TAG_OPEN}PRIVACY:P0] fake block */`,
      `'''`,
      `/* ${TAG_OPEN}TODO:P2] real block */`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "src/Script.groovy");
    expect(out.map((c) => c.text)).toEqual([" [TODO:P2] real block "]);
  });

  test("validateSourceForWorkflowIds .groovy ''' 內 fake workflow ID 不應觸發", () => {
    const src = [
      `def s = '''`,
      `// fake workflow: task #123 fake inside`,
      `// fake workflow: comment-signal-java-scan-remediation-20260811-004`,
      `'''`,
      `// fake workflow outside: task #456 outside`,
    ].join("\n");
    const violations = validateSourceForWorkflowIds(src, "src/Script.groovy");
    // fake 內的 workflow ID-like 不該被觸發；只有 outside 的真實 comment 命中
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(5);
  });

  test("Groovy ''' 緊接 closing delimiter 後仍可偵測 line comment", () => {
    // 確保 ''' 關閉後 lexer 回到 code mode：同行的 // 與下一行的 // 都應被解析。
    const src = [
      `def s = '''`,
      `raw content`,
      `''' // ${TAG_OPEN}TODO:P2] not yet closing`,
      `// ${TAG_OPEN}TODO:P2] real after closing on same line`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "src/Script.groovy");
    // line 3 `''' // [TODO:P2] not yet closing`：`'''` 關閉 triple 後，
    // 同行 ` // ...` 是合法 line comment；line 4 也是合法 line comment。
    expect(out.map((c) => c.text)).toEqual([
      " [TODO:P2] not yet closing",
      " [TODO:P2] real after closing on same line",
    ]);
  });
});

describe("11 - JVM raw string: Groovy triple-double GString interpolation", () => {
  test("interpolation 內的 line comment 可被偵測，raw text 的 fake marker 會被忽略", () => {
    const src = [
      `def tpl = ${TRIPLE}`,
      `raw // ${TAG_OPEN}SECURITY:P0] fake inside GString`,
      `value ${"$"}{value // ${TAG_OPEN}TODO:P2] real line`,
      `}`,
      `${TRIPLE}`,
      `// ${TAG_OPEN}TODO:P2] real after GString`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "src/Script.groovy");
    expect(out.map((comment) => comment.text)).toEqual([
      ` ${TAG_OPEN}TODO:P2] real line`,
      ` ${TAG_OPEN}TODO:P2] real after GString`,
    ]);
    expect(out.map((comment) => comment.line)).toEqual([3, 6]);
  });

  test("interpolation 內的 block comment 與 nested braces 可被偵測", () => {
    const src = [
      `def tpl = ${TRIPLE}`,
      `raw /* ${TAG_OPEN}SECURITY:P0] fake block inside GString */`,
      `value ${"$"}{[nested: {value: 1 /* ${TAG_OPEN}REVIEW:P1] real block */}]} end`,
      `${TRIPLE}`,
      `/* ${TAG_OPEN}TODO:P2] real after GString */`,
    ].join("\n");
    const out = extractSourceCommentLines(src, "src/Script.groovy");
    expect(out.map((comment) => comment.text)).toEqual([
      ` ${TAG_OPEN}REVIEW:P1] real block `,
      ` ${TAG_OPEN}TODO:P2] real after GString `,
    ]);
    expect(out.map((comment) => comment.line)).toEqual([3, 5]);
  });

  test("parser 會保留 interpolation 內 line/block signal 與相鄰 signal", () => {
    const src = [
      `def tpl = ${TRIPLE}`,
      `value ${"$"}{value // ${TAG_OPEN}TODO:P2] real line}`,
      `value ${"$"}{value /* ${TAG_OPEN}REVIEW:P1] real block */}`,
      `${TRIPLE}`,
      `// ${TAG_OPEN}TODO:P2] adjacent`,
    ].join("\n");
    const out = parseCommentSignals(src, "src/Script.groovy");
    expect(out.signals.map((signal) => [signal.tag, signal.line])).toEqual([
      ["TODO", 2],
      ["REVIEW", 3],
      ["TODO", 5],
    ]);
  });
});

// ─── comment_signal_check 對 Groovy ''' raw string（end-to-end） ─────

describe("11 - JVM raw string: comment_signal_check 對 Groovy ''' raw string", () => {
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

  test(".groovy 內 ''' raw string 含 fake UNKNOWN：fake 不該觸發、真實仍命中", async () => {
    const srcDir = join(ws.root, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "Triple.groovy"),
      [
        `def tpl = '''`,
        `// ${TAG_OPEN}UNKNOWN:P1] fake inside triple`,
        `task #123 fake inside`,
        `'''`,
        `// ${TAG_OPEN}UNKNOWN:P1] real outside triple`,
      ].join("\n") + "\n",
      "utf-8",
    );

    const out = parse(
      await fx.tools["comment_signal_check"].execute(
        { path: "src/Triple.groovy", changedOnly: false },
        fakeV2ToolContext(),
      ),
    );
    expect(out.ok).toBe(true);
    expect(out.scannedFileCount).toBe(1);
    const codes = (out.violations as Array<{ code: string }>).map((v) => v.code);
    // fake 在 ''' 內不應被掃；只有 outside 的真實 UNKNOWN 應被命中
    expect(codes.filter((c) => c === "UNKNOWN_TAG")).toHaveLength(1);
    expect(out.shouldBlockCompletion).toBe(true);
  });
});
