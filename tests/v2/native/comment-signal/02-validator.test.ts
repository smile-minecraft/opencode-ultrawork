/**
 * Comment Signal Validator 單元測試
 *
 * 測試目標：
 *   - validator 覆蓋第 5 節全部 violation / warning code：
 *     UNFORMATTED_FUNCTIONAL_COMMENT / UNKNOWN_TAG / MISSING_SEVERITY /
 *     INVALID_SEVERITY / NO_CHINESE / TOO_SHORT / GENERIC_COMMENT /
 *     MISSING_REASON / BAD_METADATA / EXPIRED_COMMENT / OVERDUE_COMMENT /
 *     MISSING_OWNER / MISSING_ISSUE。
 *   - blocking violation codes（UNKNOWN_TAG / MISSING_SEVERITY / INVALID_SEVERITY /
 *     BAD_METADATA）預期 shouldBlockCompletion=true。
 *   - 給定 today=2026-06-27 時 expires=2026-06-01 / due=2026-06-01 應過期。
 *
 * 設計重點：
 *   - 直接以 parser 輸出當輸入；validator 為 pure function，不接 IO。
 */

import { describe, test, expect } from "bun:test";
import { parseCommentSignals } from "../../../../src/modules/comment-signal/parser.ts";
import { validateCommentSignals, validateSource } from "../../../../src/modules/comment-signal/validator.ts";
import { defaultCommentSignalPolicy } from "../../../../src/modules/comment-signal/policy.ts";

describe("02 - validator: policy coverage", () => {
  test("default policy contains all descriptive tags", () => {
    for (const t of ["目的", "原因", "限制", "範例", "AI脈絡"]) {
      expect(defaultCommentSignalPolicy.descriptiveTags).toContain(t as never);
    }
  });

  test("default policy contains all functional tags across categories", () => {
    const want = [
      // 工作流
      "TODO", "FIXME", "REVIEW", "VERIFY", "TEST",
      // 風險
      "WARNING", "DANGER", "SECURITY", "PRIVACY", "DATA", "COMPAT",
      // 工程
      "PERF", "CACHE", "SIDE_EFFECT",
      // 架構
      "CONTRACT", "INVARIANT", "BOUNDARY", "LIFECYCLE", "OWNERSHIP",
      // AI
      "AI_TRAP", "AI_CHECK", "AI_HANDOFF", "AI_ASSUMPTION", "AI_DO_NOT_EDIT",
    ];
    for (const t of want) {
      expect(defaultCommentSignalPolicy.functionalTags).toContain(t as never);
    }
  });

  test("default policy contains severities P0/P1/P2/P3", () => {
    expect(defaultCommentSignalPolicy.severities).toEqual(["P0", "P1", "P2", "P3"]);
  });

  test("default policy contains metadata keys owner/issue/due/expires/test/policy/scope", () => {
    for (const k of ["owner", "issue", "due", "expires", "test", "policy", "scope"]) {
      expect(defaultCommentSignalPolicy.metadataKeys).toContain(k as never);
    }
  });

  test("default policy contains blocking violation codes", () => {
    for (const c of [
      "UNKNOWN_TAG",
      "MISSING_SEVERITY",
      "INVALID_SEVERITY",
      "BAD_METADATA",
      "WORKFLOW_ID_IN_COMMENT",
    ]) {
      expect(defaultCommentSignalPolicy.blockingViolationCodes).toContain(c as never);
    }
  });

  test("default policy contains highRisk tags and highRisk severities", () => {
    for (const t of ["DANGER", "SECURITY", "PRIVACY", "DATA", "INVARIANT", "AI_TRAP", "AI_DO_NOT_EDIT"]) {
      expect(defaultCommentSignalPolicy.highRiskTags).toContain(t as never);
    }
    expect(defaultCommentSignalPolicy.highRiskSeverities).toEqual(["P0", "P1"]);
  });
});

describe("02 - validator: blocking violations", () => {
  // 將開頭中括號拆到 TAG_OPEN / CLOSE 變數，避免外層 comment-signal
  // scanner 對此檔案 fixture literal 誤判為 functional tag；runtime 字串
  // 仍拼接為完整的 functional header（例如 WARN:P1 等非法標頭）供 parser 拆解。
  const TAG_OPEN = "[";
  const CLOSE = "]";

  test("UNKNOWN_TAG: [WARN:P1] should block", () => {
    const src = "// " + TAG_OPEN + "WARN:P1" + CLOSE + " 注意這裡。";
    const out = parseCommentSignals(src, "src/a.ts");
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    const codes = v.violations.map((x) => x.code);
    expect(codes).toContain("UNKNOWN_TAG");
    expect(v.errorCount).toBeGreaterThanOrEqual(1);
  });

  test("MISSING_SEVERITY: [TODO] 補測試 should block", () => {
    const src = "// " + TAG_OPEN + "TODO" + CLOSE + " 補測試";
    const out = parseCommentSignals(src, "src/a.ts");
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    const codes = v.violations.map((x) => x.code);
    expect(codes).toContain("MISSING_SEVERITY");
  });

  test("INVALID_SEVERITY: [TODO:HIGH] should block", () => {
    const src = "// " + TAG_OPEN + "TODO:HIGH" + CLOSE + " 補測試";
    const out = parseCommentSignals(src, "src/a.ts");
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    const codes = v.violations.map((x) => x.code);
    expect(codes).toContain("INVALID_SEVERITY");
  });

  test("BAD_METADATA: not key=value should block", () => {
    const src = "// " + TAG_OPEN + "TODO:P2 owner-@bad" + CLOSE + " 之後處理";
    const out = parseCommentSignals(src, "src/a.ts");
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    const codes = v.violations.map((x) => x.code);
    expect(codes).toContain("BAD_METADATA");
  });

  test("shouldBlockComposition true when any blocking violation present", () => {
    // 直接拼一個含兩種 blocking code 的檔案
    const src = [
      "// " + TAG_OPEN + "WARN:P1" + CLOSE + " a",
      "// " + TAG_OPEN + "TODO:HIGH" + CLOSE + " b",
    ].join("\n");
    const out = parseCommentSignals(src, "src/a.ts");
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    expect(v.shouldBlockCompletion).toBe(true);
  });
});

describe("02 - validator: workflow instance IDs in comments", () => {
  test.each([
    "// plan comment-signal-module-20260627-001",
    "/* uw-foo-20260713-001：完成此階段 */",
    "// task 031 先處理相依性",
    "// Task #204 對應舊流程",
    "// task uw-hardening-05-comment-legacy-boundary",
    "// plan parser-v2-compatibility",
  ])("WORKFLOW_ID_IN_COMMENT blocks concrete workflow tracking text: %s", (src) => {
    const parsed = parseCommentSignals(src, "src/workflow.ts");
    const result = validateSource(src, parsed.signals, {
      today: "2026-06-27",
      filePath: parsed.filePath,
    });

    const finding = result.violations.find((item) => item.code === "WORKFLOW_ID_IN_COMMENT");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("blocking");
    expect(finding?.filePath).toBe("src/workflow.ts");
    expect(result.shouldBlockCompletion).toBe(true);
  });

  test("detects workflow IDs inside a tagged comment body", () => {
    const src = "// [AI_HANDOFF:P2] 延續 uw-parser-20260713-001 的處理方式";
    const parsed = parseCommentSignals(src, "src/parser.ts");
    const result = validateSource(src, parsed.signals, {
      filePath: parsed.filePath,
    });

    expect(result.violations.map((item) => item.code)).toContain("WORKFLOW_ID_IN_COMMENT");
  });

  test("detects an explicit task slug continued on the next block-comment line", () => {
    const src = "/**\n * task\n * uw-hardening-05-comment-legacy-boundary\n */";
    const parsed = parseCommentSignals(src, "src/parser.ts");
    const result = validateSource(src, parsed.signals, {
      filePath: parsed.filePath,
    });

    expect(result.violations.map((item) => item.code)).toContain("WORKFLOW_ID_IN_COMMENT");
  });

  test.each([
    ["config.yml", "# task 031 先處理相依性"],
    ["scripts/check.sh", "# plan parser-v2-compatibility"],
    ["page.html", "<!-- task 031 對應舊流程 -->"],
    ["component.vue", "<!-- plan parser-v2-compatibility -->"],
  ])("detects workflow IDs in language-native comments: %s", (filePath, src) => {
    const parsed = parseCommentSignals(src, filePath);
    const result = validateSource(src, parsed.signals, { filePath });
    expect(result.violations.map((item) => item.code)).toContain("WORKFLOW_ID_IN_COMMENT");
  });

  test("detects block comments inside template interpolation", () => {
    const src = "const value = `prefix ${/* task 031 */ compute()} suffix`;";
    const parsed = parseCommentSignals(src, "src/template.ts");
    const result = validateSource(src, parsed.signals, { filePath: parsed.filePath });
    expect(result.violations.map((item) => item.code)).toContain("WORKFLOW_ID_IN_COMMENT");
  });

  test.each([
    "const ids = plan.taskIds;",
    "function load(taskId: string) { return taskId; }",
    "// taskId 參數必須來自呼叫端",
    "// plan.taskIds 用於計算完成率",
    "// plan state 必須和 registry 一致",
    "// task registry 是唯一資料來源",
    "// task 數量上限為 31",
    "const sample = \"// task 031 只是字串內容\";",
    "const url = \"https://example.test/comment-signal-module-20260627-001\";",
    "<div>https://example.test/uw-foo-20260713-001</div>",
  ])("does not flag technical prose or executable identifiers: %s", (src) => {
    const filePath = src.startsWith("<div>") ? "src/safe.tsx" : "src/safe.ts";
    const parsed = parseCommentSignals(src, filePath);
    const result = validateSource(src, parsed.signals, {
      filePath: parsed.filePath,
    });

    expect(result.violations.map((item) => item.code)).not.toContain("WORKFLOW_ID_IN_COMMENT");
  });
});

describe("02 - validator: warning codes", () => {
  test("UNFORMATTED_FUNCTIONAL_COMMENT: 'TODO fix later' warns", () => {
    // 走 source-level scan 路徑：parser 對未格式化註解不會抽出 signal，
    // 必須由 validateSource 對 source 逐行掃描並補上警告。
    const src = "// TODO fix later";
    const out = parseCommentSignals(src, "src/a.ts");
    const v = validateSource(src, out.signals, { today: "2026-06-27" });
    const codes = v.violations.map((x) => x.code);
    expect(codes).toContain("UNFORMATTED_FUNCTIONAL_COMMENT");
    expect(v.warningCount).toBeGreaterThanOrEqual(1);
  });

  test("UNFORMATTED_FUNCTIONAL_COMMENT: 'FIXME 之後處理' warns", () => {
    const src = "// FIXME 之後處理";
    const out = parseCommentSignals(src, "src/a.ts");
    const v = validateSource(src, out.signals, { today: "2026-06-27" });
    expect(v.violations.map((x) => x.code)).toContain("UNFORMATTED_FUNCTIONAL_COMMENT");
  });

  test.each([
    ['const TEST_RUNNER = "bun";', "src/a.ts"],
    ['import { test } from "bun:test";', "src/a.ts"],
    ['const url = "https://example.test/review";', "src/a.ts"],
    ["<div>TODO fix later</div>", "src/a.tsx"],
  ])("executable code 與字串中的功能關鍵字不應產生假警告: %s", (src, filePath) => {
    const out = parseCommentSignals(src, filePath);
    const v = validateSource(src, out.signals, { filePath, today: "2026-06-27" });
    expect(v.violations.map((x) => x.code)).not.toContain("UNFORMATTED_FUNCTIONAL_COMMENT");
  });

  test("NO_CHINESE: [TODO:P2] fix later. warns", () => {
    const out = parseCommentSignals("// [TODO:P2] fix later.", "src/a.ts");
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    expect(v.violations.map((x) => x.code)).toContain("NO_CHINESE");
  });

  test("TOO_SHORT: [WARNING:P1] 注意。 warns", () => {
    const out = parseCommentSignals("// [WARNING:P1] 注意。", "src/a.ts");
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    expect(v.violations.map((x) => x.code)).toContain("TOO_SHORT");
  });

  test("GENERIC_COMMENT: [TODO:P2] 之後處理。 warns", () => {
    const out = parseCommentSignals("// [TODO:P2] 之後處理。", "src/a.ts");
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    expect(v.violations.map((x) => x.code)).toContain("GENERIC_COMMENT");
  });

  test("MISSING_REASON: [SECURITY:P0] 不要記錄。 warns", () => {
    const out = parseCommentSignals("// [SECURITY:P0] 不要記錄。", "src/a.ts");
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    expect(v.violations.map((x) => x.code)).toContain("MISSING_REASON");
  });

  test("EXPIRED_COMMENT: expires=2026-06-01 warns (today=2026-06-27)", () => {
    const out = parseCommentSignals("// [TODO:P2 expires=2026-06-01] 之後處理", "src/a.ts");
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    expect(v.violations.map((x) => x.code)).toContain("EXPIRED_COMMENT");
  });

  test("OVERDUE_COMMENT: due=2026-06-01 warns (today=2026-06-27)", () => {
    const out = parseCommentSignals("// [TODO:P2 due=2026-06-01] 之後處理", "src/a.ts");
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    expect(v.violations.map((x) => x.code)).toContain("OVERDUE_COMMENT");
  });

  test("MISSING_OWNER: P0 without owner warns when policy requires owner", () => {
    const out = parseCommentSignals("// [SECURITY:P0] 不要將 token 寫入 log，否則會洩漏", "src/a.ts");
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    expect(v.violations.map((x) => x.code)).toContain("MISSING_OWNER");
  });

  test("MISSING_ISSUE: FIXME:P0 without issue warns when policy requires issue", () => {
    const out = parseCommentSignals(
      "// [FIXME:P0] 此流程會在大量資料下 OOM，必須先 batch 上限",
      "src/a.ts",
    );
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    expect(v.violations.map((x) => x.code)).toContain("MISSING_ISSUE");
  });
});

describe("02 - validator: high risk detection", () => {
  test("SECURITY:P0 should be classified as highRisk", () => {
    const out = parseCommentSignals(
      "// [SECURITY:P0 owner=@auth issue=#391] 不要將 token 寫入 log，否則會洩漏",
      "src/auth.ts",
    );
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    expect(v.highRisk).toHaveLength(1);
    expect(v.highRisk[0].tag).toBe("SECURITY");
    expect(v.highRisk[0].severity).toBe("P0");
    expect(v.highRiskCount).toBe(1);
  });

  test("AI_DO_NOT_EDIT:P1 should be classified as highRisk", () => {
    const out = parseCommentSignals(
      "// [AI_DO_NOT_EDIT:P1 owner=@build] 此區段為 generated，禁止 AI 改寫",
      "src/a.ts",
    );
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    expect(v.highRiskCount).toBe(1);
    expect(v.highRisk[0].tag).toBe("AI_DO_NOT_EDIT");
  });

  test("TODO:P2 is NOT highRisk", () => {
    const out = parseCommentSignals("// [TODO:P2] 之後補上單元測試", "src/a.ts");
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    expect(v.highRiskCount).toBe(0);
  });

  test("SECURITY:P3 is NOT highRisk (severity too low)", () => {
    const out = parseCommentSignals(
      "// [SECURITY:P3] 低風險：使用者頭像未快取",
      "src/a.ts",
    );
    const v = validateCommentSignals(out.signals, { today: "2026-06-27" });
    expect(v.highRiskCount).toBe(0);
  });
});
