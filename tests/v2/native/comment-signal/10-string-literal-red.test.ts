import { describe, test, expect } from "bun:test";
import { parseCommentSignals } from "../../../../src/modules/comment-signal/parser.ts";

describe("Red - string literal tag headers", () => {
  test("string literal with tag header content is not a signal", () => {
    const src = `const examples = ["// [TODO:P2] 之後處理"];`;
    expect(parseCommentSignals(src, "src/a.ts").signals).toEqual([]);
  });

  test("tag header inside object string property is not a signal", () => {
    const src = [
      `const config = {`,
      `  examples: ["// [FIXME:P1 owner=@x] 修正"],`,
      `};`,
    ].join("\n");
    expect(parseCommentSignals(src, "src/a.ts").signals).toEqual([]);
  });

  test("tag header inside single-quoted string is not a signal", () => {
    const src = `const s = '// [DANGER:P0] rm -rf dangerous';`;
    expect(parseCommentSignals(src, "src/a.ts").signals).toEqual([]);
  });

  test("tag header inside template literal raw text is not a signal", () => {
    const src = "const t = `// [PRIVACY:P0] do not log PII`;";
    expect(parseCommentSignals(src, "src/a.ts").signals).toEqual([]);
  });

  test("tag header inside template interpolation IS a signal (current contract)", () => {
    const src = "const t = `${// [TODO:P2] in interp`};";
    const out = parseCommentSignals(src, "src/a.ts");
    // 變基：interpolation 中的 // [TODO:P2] 視為 code comment（與現行 rule 一致）
    expect(out.signals).toHaveLength(1);
    expect(out.signals[0].tag).toBe("TODO");
  });

  test("real line comment after string literal still parses", () => {
    const src = [
      `const s = "// [TODO:P2] in string";`,
      `// [TODO:P2] real comment`,
    ].join("\n");
    const out = parseCommentSignals(src, "src/a.ts");
    expect(out.signals).toHaveLength(1);
    expect(out.signals[0].line).toBe(2);
    expect(out.signals[0].tag).toBe("TODO");
  });

  test("real block comment after string literal still parses", () => {
    const src = [
      `const s = "/* [TODO:P1] in string */";`,
      `/* [FIXME:P2] real block */`,
    ].join("\n");
    const out = parseCommentSignals(src, "src/a.ts");
    expect(out.signals).toHaveLength(1);
    expect(out.signals[0].tag).toBe("FIXME");
    expect(out.signals[0].severity).toBe("P2");
  });

  test("multi-line block comment with tag still parses", () => {
    const src = [
      `/**`,
      ` * [目的] 提供 plugin entry`,
      ` * 與 DI 組裝`,
      ` */`,
    ].join("\n");
    const out = parseCommentSignals(src, "src/x.ts");
    expect(out.signals).toHaveLength(1);
    expect(out.signals[0].tag).toBe("目的");
    expect(out.signals[0].line).toBe(2);
  });

  test("real line comment with AI_DO_NOT_EDIT string still parses from real source", () => {
    // 對齊 tool-explain.ts 範例：字串 ["// [TAG:P0]"] 不應被視為 comment
    const src = `const TAG_EXAMPLE = "// [AI_DO_NOT_EDIT:P0] 此檔由 codegen 自動產生";`;
    expect(parseCommentSignals(src, "src/x.ts").signals).toEqual([]);
  });
});
