/**
 * Comment Signal Parser 單元測試
 *
 * 測試目標：
 *   - parser 能解析 `[TODO:P2]`、`[SECURITY:P0 owner=@auth issue=#391]`、
 *     `[目的]`、`[AI_TRAP:P1]`、metadata、body、line number。
 *   - parser / validator 能辨識未格式化功能型註解（例如 `TODO fix later`、
 *     `FIXME 之後處理`、看似 WARNING/SECURITY/待辦/之後處理但未用正式格式）。
 *   - parser 為 pure function，不接 hooks、不讀檔、不 IO。
 *
 * 設計重點：
 *   - 測試以純函式 import 取代 runtime 串接：parser 為 pure function，
 *     不依賴 plugin runtime / ToolContext。
 *   - 中文 / emoji 內容以繁體中文為主，符合 AGENTS.md 全域語言規範。
 */

import { describe, test, expect } from "bun:test";
import { parseCommentSignals, detectUnformattedFunctionalComment } from "../../../../src/modules/comment-signal/parser.ts";

describe("01 - parser: parseCommentSignals", () => {
  test("parses [TODO:P2] with body and line number", () => {
    // 拆開開頭中括號以避免外層 comment-signal scanner 對此 fixture literal
    // 誤判為 functional tag；runtime src 仍拼接為 `// [TODO:P2] 之後補上單元測試`。
    const TAG_OPEN = "[";
    const src = [
      "function f() {",
      "  // " + TAG_OPEN + "TODO:P2] 之後補上單元測試",
      "  return 1;",
      "}",
    ].join("\n");
    const out = parseCommentSignals(src, "src/a.ts");
    expect(out.filePath).toBe("src/a.ts");
    expect(out.signals).toHaveLength(1);
    const sig = out.signals[0];
    expect(sig.kind).toBe("functional");
    expect(sig.tag).toBe("TODO");
    expect(sig.severity).toBe("P2");
    expect(sig.body).toBe("之後補上單元測試");
    expect(sig.line).toBe(2);
    // sig.raw 是 parser 從 src 抽出後 trimStart 過的原始字串
    const EXPECTED_RAW = "// " + TAG_OPEN + "TODO:P2] 之後補上單元測試";
    expect(sig.raw).toBe(EXPECTED_RAW);
  });

  test("parses [SECURITY:P0] with metadata key=value pairs", () => {
    const src = "// [SECURITY:P0 owner=@auth issue=#391 expires=2026-12-31] 不要將 token 寫入 log";
    const out = parseCommentSignals(src, "src/auth.ts");
    expect(out.signals).toHaveLength(1);
    const sig = out.signals[0];
    expect(sig.tag).toBe("SECURITY");
    expect(sig.severity).toBe("P0");
    expect(sig.metadata.owner).toBe("@auth");
    expect(sig.metadata.issue).toBe("#391");
    expect(sig.metadata.expires).toBe("2026-12-31");
    expect(sig.body).toBe("不要將 token 寫入 log");
    expect(sig.line).toBe(1);
  });

  test("parses descriptive [目的] tag without severity", () => {
    const src = "/**\n * [目的]\n * 提供 plugin 的 entry point 與 DI 組裝\n */";
    const out = parseCommentSignals(src, "src/index.ts");
    expect(out.signals).toHaveLength(1);
    const sig = out.signals[0];
    expect(sig.kind).toBe("descriptive");
    expect(sig.tag).toBe("目的");
    expect(sig.severity).toBeNull();
    expect(sig.line).toBe(2);
    // descriptive tag body 應抓取後續說明行
    expect(sig.body).toMatch(/提供 plugin/);
  });

  test("parses [AI_TRAP:P1] body and metadata", () => {
    const src = "// [AI_TRAP:P1 owner=@build] 不要把 closure state 寫進 module-level 常數";
    const out = parseCommentSignals(src, "src/x.ts");
    const sig = out.signals[0];
    expect(sig.tag).toBe("AI_TRAP");
    expect(sig.severity).toBe("P1");
    expect(sig.metadata.owner).toBe("@build");
    expect(sig.body).toMatch(/不要把 closure state/);
  });

  test("captures multiple signals across lines", () => {
    const src = [
      "// [目的] 主要流程入口",
      "function f() {",
      "  // [TODO:P2] 之後處理",
      "  // [WARNING:P1] 注意這裡",
      "}",
    ].join("\n");
    const out = parseCommentSignals(src, "src/multi.ts");
    expect(out.signals.map((s) => s.line)).toEqual([1, 3, 4]);
    expect(out.signals.map((s) => s.tag)).toEqual(["目的", "TODO", "WARNING"]);
  });

  test("ignores empty body and returns null body for header-only tag", () => {
    const src = "// [TODO:P2]";
    const out = parseCommentSignals(src, "src/a.ts");
    const sig = out.signals[0];
    expect(sig.tag).toBe("TODO");
    expect(sig.severity).toBe("P2");
    expect(sig.body).toBe("");
  });

  test("rejects [WARN:P1] as UNKNOWN_TAG style but still captures raw text", () => {
    // 拆開開頭中括號以避免外層 scanner 對 fixture literal 誤判。
    const TAG_OPEN = "[";
    const src = "// " + TAG_OPEN + "WARN:P1] 注意這裡";
    const out = parseCommentSignals(src, "src/a.ts");
    // parser 仍會嘗試拆解；UNKNOWN_TAG 判定屬 validator 責任，但 parser 須保留
    // 原始 raw 以供 validator 與 reporter 顯示。
    expect(out.signals).toHaveLength(1);
    const EXPECTED_RAW = "// " + TAG_OPEN + "WARN:P1] 注意這裡";
    expect(out.signals[0].raw).toBe(EXPECTED_RAW);
    // parser 對未知 tag 仍可拆出 tag string（WARN），validator 再標 UNKNOWN_TAG
    expect(out.signals[0].tag).toBe("WARN");
  });

  test("supports block comment markers /* */ as well as // ", () => {
    const src = "/* [SECURITY:P0] 不可繞過 */";
    const out = parseCommentSignals(src, "src/x.ts");
    expect(out.signals).toHaveLength(1);
    expect(out.signals[0].tag).toBe("SECURITY");
    expect(out.signals[0].severity).toBe("P0");
    expect(out.signals[0].body).toBe("不可繞過");
  });

  test("不把註解內的程式碼索引與 CLI 參數誤認為 tag", () => {
    const left = String.fromCharCode(91);
    const right = String.fromCharCode(93);
    const src = [
      "/**",
      ` * exports${left}\"./server\"${right} 指向 canonical entry。`,
      ` * CLI: update ${left}path${right}`,
      " */",
      `const value = categories${left}name${right}; // 一般行尾註解`,
    ].join("\n");

    expect(parseCommentSignals(src, "src/docs.ts").signals).toEqual([]);
  });

  test("tag 必須是註解的第一個語意項目", () => {
    const left = String.fromCharCode(91);
    const src = `// 前綴文字 ${left}TODO:P2] 之後處理`;

    expect(parseCommentSignals(src, "src/prefix.ts").signals).toEqual([]);
  });
});

describe("01 - parser: detectUnformattedFunctionalComment", () => {
  test("flags TODO fix later as UNFORMATTED_FUNCTIONAL_COMMENT candidate", () => {
    const line = "// TODO fix later";
    const hit = detectUnformattedFunctionalComment(line);
    expect(hit).not.toBeNull();
    expect(hit?.matchedKeywords).toContain("TODO");
  });

  test("flags FIXME 之後處理 as candidate", () => {
    const line = "// FIXME 之後處理";
    const hit = detectUnformattedFunctionalComment(line);
    expect(hit).not.toBeNull();
    expect(hit?.matchedKeywords).toContain("FIXME");
  });

  test("flags WARNING/SECURITY 文字提及但無 tag 格式", () => {
    const line = "// WARNING: 注意這裡有副作用";
    const hit = detectUnformattedFunctionalComment(line);
    expect(hit).not.toBeNull();
    expect(hit?.matchedKeywords).toContain("WARNING");
  });

  test("flags 待辦 / 之後處理 文字", () => {
    const line = "// 待辦：補上錯誤處理";
    const hit = detectUnformattedFunctionalComment(line);
    expect(hit).not.toBeNull();
    expect(hit?.matchedKeywords.some((k) => ["待辦", "之後處理"].includes(k))).toBe(true);
  });

  test("does not flag already-formatted [TODO:P2] comment", () => {
    const line = "// [TODO:P2] 之後補測試";
    expect(detectUnformattedFunctionalComment(line)).toBeNull();
  });

  test("does not flag plain prose without functional keywords", () => {
    const line = "// 主要邏輯：依序處理每筆資料";
    // "主要邏輯" 不含功能型 keyword，但若有 GENERIC_COMMENT 判定由 validator 處理
    expect(detectUnformattedFunctionalComment(line)).toBeNull();
  });

  test.each([
    "// 此測試使用 TEST runner 驗證輸出",
    "// 說明 WARNING code 的聚合方式",
    "* 文件列出 TODO 與 FIXME 的支援格式",
  ])("不把技術說明中的關鍵字誤判為功能標記: %s", (line) => {
    expect(detectUnformattedFunctionalComment(line)).toBeNull();
  });
});
