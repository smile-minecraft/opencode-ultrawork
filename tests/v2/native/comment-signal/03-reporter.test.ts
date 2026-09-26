/**
 * Comment Signal Reporter 單元測試
 *
 * 測試目標：
 *   - reporter 產出 humanSummary / scannedFileCount / checkedCommentCount /
 *     violationCount / errorCount / warningCount / highRiskCount /
 *     shouldBlockCompletion / agentFeedback / violations / highRisk。
 *   - agentFeedback 必須是可執行修正指令，包含：只修註解、不改程式邏輯、
 *     不刪除高風險註解、修正後再次 comment_signal_check。
 *   - blocking violation 出現時 shouldBlockCompletion=true。
 *
 * 設計重點：
 *   - reporter 接受 FileReport 清單，輸出 CommentSignalReport aggregate。
 */

import { describe, test, expect } from "bun:test";
import { parseCommentSignals } from "../../../../src/modules/comment-signal/parser.ts";
import { validateCommentSignals, validateSource } from "../../../../src/modules/comment-signal/validator.ts";
import { buildReport } from "../../../../src/modules/comment-signal/reporter.ts";
import type { FileReport } from "../../../../src/modules/comment-signal/types.ts";

// 在 fixture source 內的非法 tag literal（如 WARN 搭配 P1 severity）透過
// runtime 拼接生成，避免檔案本身被 Comment Signal scanner 抓到 UNKNOWN_TAG
// 而成為 blocking violation。runtime value 仍等於 open-bracket + tag + 結尾
// 雙中括弧的非法 functional comment，parser 仍能命中對應非法 signal。
const TAG_OPEN = "[";

function fileReportFromSource(filePath: string, src: string): FileReport {
  const parsed = parseCommentSignals(src, filePath);
  const v = validateSource(src, parsed.signals, {
    today: "2026-06-27",
    filePath,
  });
  return {
    filePath,
    scanned: true,
    signals: parsed.signals,
    violations: v.violations,
    highRisk: v.highRisk,
    shouldBlockCompletion: v.shouldBlockCompletion,
    errorCount: v.errorCount,
    warningCount: v.warningCount,
    highRiskCount: v.highRiskCount,
  };
}

describe("03 - reporter: aggregate fields", () => {
  test("empty input yields empty report with all required keys", () => {
    const r = buildReport([], { today: "2026-06-27" });
    expect(r.scannedFileCount).toBe(0);
    expect(r.checkedCommentCount).toBe(0);
    expect(r.violationCount).toBe(0);
    expect(r.errorCount).toBe(0);
    expect(r.warningCount).toBe(0);
    expect(r.highRiskCount).toBe(0);
    expect(r.shouldBlockCompletion).toBe(false);
    expect(Array.isArray(r.violations)).toBe(true);
    expect(Array.isArray(r.highRisk)).toBe(true);
    expect(typeof r.humanSummary).toBe("string");
    expect(typeof r.agentFeedback).toBe("string");
  });

  test("aggregates counts across multiple files", () => {
    const f1 = fileReportFromSource("src/a.ts", "// [TODO:P2] 之後補單元測試");
    const f2 = fileReportFromSource("src/b.ts", `// ${TAG_OPEN}WARN:P1] a`);
    const f3 = fileReportFromSource("src/c.ts", "// [SECURITY:P0 owner=@auth issue=#391] 不要將 token 寫入 log，否則會洩漏");

    const r = buildReport([f1, f2, f3], { today: "2026-06-27" });
    expect(r.scannedFileCount).toBe(3);
    expect(r.checkedCommentCount).toBe(3);
    expect(r.shouldBlockCompletion).toBe(true);
    expect(r.highRiskCount).toBe(1);
  });

  test("violations contain file:line reference and code", () => {
    const f = fileReportFromSource("src/x.ts", `// ${TAG_OPEN}WARN:P1] a`);
    const r = buildReport([f], { today: "2026-06-27" });
    const blocking = r.violations.find((v) => v.code === "UNKNOWN_TAG");
    expect(blocking).toBeDefined();
    expect(blocking!.filePath).toBe("src/x.ts");
    expect(blocking!.line).toBe(1);
  });
});

describe("03 - reporter: agentFeedback content", () => {
  test("workflow ID finding tells the agent to move tracking data to canonical artifacts", () => {
    const f = fileReportFromSource(
      "src/workflow.ts",
      "// [AI_HANDOFF:P2] 延續 uw-parser-20260713-001 的處理方式",
    );
    const r = buildReport([f], { today: "2026-06-27" });

    expect(r.shouldBlockCompletion).toBe(true);
    expect(r.agentFeedback).toMatch(/Task|Plan/);
    expect(r.agentFeedback).toMatch(/artifact|registry/i);
  });

  test("contains correction rules when violations exist", () => {
    const f = fileReportFromSource("src/x.ts", [
      `// ${TAG_OPEN}WARN:P1] 注意這裡`,
      "// [TODO:P2] 之後處理",
    ].join("\n"));
    const r = buildReport([f], { today: "2026-06-27" });
    // 必要可執行修正指令內容
    expect(r.agentFeedback).toMatch(/只.*修.*註解/);
    expect(r.agentFeedback).toMatch(/不要.*修.*程式.*邏輯|不.*改.*邏輯/);
    expect(r.agentFeedback).toMatch(/不要.*刪除.*高風險.*註解|不得.*刪除.*高風險/);
    expect(r.agentFeedback).toMatch(/comment_signal_check/);
  });

  test("agentFeedback short-circuits to pass-msg when shouldBlockCompletion=false", () => {
    const r = buildReport([], { today: "2026-06-27" });
    expect(r.shouldBlockCompletion).toBe(false);
    expect(r.agentFeedback).toMatch(/通過|OK|無.*問題/);
  });

  test("humanSummary contains counts and block decision", () => {
    const f = fileReportFromSource("src/x.ts", `// ${TAG_OPEN}WARN:P1] a`);
    const r = buildReport([f], { today: "2026-06-27" });
    expect(r.humanSummary).toMatch(/掃描/);
    expect(r.humanSummary).toMatch(/註解/);
    expect(r.humanSummary).toMatch(/障礙|通過|block|pass/i);
  });

  test("agentFeedback truncates when too long to keep prompt compact", () => {
    // 製造大量 violation
    const many = Array.from({ length: 60 }, (_, i) => `// ${TAG_OPEN}WARN:P1] 注意 ${i}`).join("\n");
    const f = fileReportFromSource("src/big.ts", many);
    const r = buildReport([f], { today: "2026-06-27" });
    // 仍需保留必要指令；具體上限由實作決定，這裡只檢查不為空且結構性存在
    expect(r.agentFeedback.length).toBeGreaterThan(0);
    expect(r.agentFeedback).toMatch(/comment_signal_check/);
  });
});
