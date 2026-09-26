/**
 * Comment Signal Guard 單元測試
 *
 * 測試目標：
 *   - detectHighRiskComments：根據 highRisk tags + P0/P1 severity 正確過濾 highRisk items。
 *   - shouldBlockCompletion：只因 policy 內的 blocking violation codes 阻擋；
 *     其他 warning codes 不阻擋。
 *   - checkFile / checkFiles / checkChangedFiles：對 source 進行掃描並回傳
 *     CommentSignalReport aggregate；可注入 sourceResolver 避免 IO。
 *   - checkChangedFiles 預設檢查 session state 的 modifiedFiles；
 *     指定 path 時僅檢查符合路徑前綴的檔案。
 *
 * 設計重點：
 *   - guard.ts 保持 pure module 風格：不直接讀檔；source 由呼叫端注入。
 *     hooks 層決定如何從檔案系統讀 source。
 *   - 測試 import path 統一走 comment-signal/index.ts public API。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { parseCommentSignals } from "../../../../src/modules/comment-signal/parser.ts";
import { validateSource } from "../../../../src/modules/comment-signal/validator.ts";
import { defaultCommentSignalPolicy } from "../../../../src/modules/comment-signal/policy.ts";
import {
  detectHighRiskComments,
  shouldBlockCompletion,
  checkFile,
  checkFiles,
  checkChangedFiles,
  isMarkdownPath,
} from "../../../../src/modules/comment-signal/guard.ts";
import type {
  CommentSignalReport,
  HighRiskItem,
  Violation,
} from "../../../../src/modules/comment-signal/types.ts";
import { CommentSignalStore, type CommentSignalState } from "../../../../src/modules/comment-signal/state.ts";
import type { KeyValueStorage } from "../../../../src/modules/comment-signal/../../state/store.ts";

/** 每個測試獨立的記憶體 storage：工作階段狀態互不污染。 */
function memoryStorage(): KeyValueStorage {
  const map = new Map<string, unknown>();
  return {
    get: async (key: string) => map.get(key),
    set: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    remove: async (key: string) => {
      map.delete(key);
    },
    scan: async ({ prefix, after, limit }: { prefix: string; after?: string; limit?: number }) => {
      const keys = [...map.keys()].filter((key) => key.startsWith(prefix)).sort();
      let start = 0;
      if (after !== undefined) {
        const index = keys.findIndex((key) => key > after);
        start = index === -1 ? keys.length : index;
      }
      const sliced = limit === undefined ? keys.slice(start) : keys.slice(start, start + limit);
      const entries = sliced.map((key) => ({ key, value: map.get(key) }));
      if (start + sliced.length < keys.length) return { entries, next: sliced[sliced.length - 1] };
      return { entries };
    },
  };
}

/** 把 store 內的 modifiedFiles 包成 checkChangedFiles 吃的狀態形狀。 */
async function changedState(store: CommentSignalStore, sessionID: string): Promise<CommentSignalState> {
  return {
    sessionID,
    modifiedFiles: await store.getModifiedFiles(sessionID),
    lastReport: null,
    fileReports: {},
    warnings: [],
  };
}

// 在 fixture source 內的非法 tag literal（如 WARN 搭配 P1 severity）透過
// runtime 拼接生成，避免檔案本身被 Comment Signal scanner 抓到 UNKNOWN_TAG
// 而成為 blocking violation。runtime value 仍等於 open-bracket + tag + 結尾
// 雙中括弧的非法 functional comment，parser 仍能命中對應非法 signal。
const TAG_OPEN = "[";

// 共用輔助：將一段 source 餵給 parser+validator 產出 FileReport
function scanSource(filePath: string, source: string) {
  const parsed = parseCommentSignals(source, filePath);
  const v = validateSource(source, parsed.signals, {
    today: "2026-06-27",
    policy: defaultCommentSignalPolicy,
  });
  return v;
}

describe("04 - guard: detectHighRiskComments", () => {
  test("過濾出 highRisk tags + P0/P1 severity 的 items", () => {
    const highRisk: HighRiskItem[] = [
      { filePath: "src/a.ts", line: 1, tag: "SECURITY", severity: "P0", body: "token" },
      { filePath: "src/b.ts", line: 2, tag: "DANGER", severity: "P1", body: "rm -rf" },
      { filePath: "src/c.ts", line: 3, tag: "PRIVACY", severity: "P0", body: "PII" },
      { filePath: "src/d.ts", line: 4, tag: "DATA", severity: "P1", body: "data integrity" },
      { filePath: "src/e.ts", line: 5, tag: "INVARIANT", severity: "P0", body: "must hold" },
      { filePath: "src/f.ts", line: 6, tag: "AI_TRAP", severity: "P1", body: "do not refactor" },
      { filePath: "src/g.ts", line: 7, tag: "AI_DO_NOT_EDIT", severity: "P1", body: "generated" },
    ];
    const out = detectHighRiskComments(highRisk);
    expect(out).toHaveLength(7);
    expect(out.map((h) => h.tag).sort()).toEqual(
      ["AI_DO_NOT_EDIT", "AI_TRAP", "DANGER", "DATA", "INVARIANT", "PRIVACY", "SECURITY"].sort(),
    );
  });

  test("非 highRisk tag 不會被納入（如 TODO）", () => {
    const highRisk: HighRiskItem[] = [
      { filePath: "src/a.ts", line: 1, tag: "TODO", severity: "P0", body: "todo" },
      { filePath: "src/b.ts", line: 2, tag: "WARNING", severity: "P0", body: "warn" },
    ];
    const out = detectHighRiskComments(highRisk);
    expect(out).toEqual([]);
  });

  test("severity 不在 P0/P1 不會被納入", () => {
    const highRisk: HighRiskItem[] = [
      { filePath: "src/a.ts", line: 1, tag: "SECURITY", severity: "P2", body: "low" },
      { filePath: "src/b.ts", line: 2, tag: "DANGER", severity: "P3", body: "low" },
    ];
    const out = detectHighRiskComments(highRisk);
    expect(out).toEqual([]);
  });

  test("空輸入回傳空陣列", () => {
    expect(detectHighRiskComments([])).toEqual([]);
  });

  test("支援 policy override", () => {
    const highRisk: HighRiskItem[] = [
      { filePath: "src/a.ts", line: 1, tag: "SECURITY", severity: "P0", body: "x" },
    ];
    // 自訂 policy 把 SECURITY 從 highRiskTags 移除
    const customPolicy = {
      ...defaultCommentSignalPolicy,
      highRiskTags: ["AI_DO_NOT_EDIT" as const],
    };
    const out = detectHighRiskComments(highRisk, customPolicy);
    expect(out).toEqual([]);
  });
});

describe("04 - guard: shouldBlockCompletion", () => {
  function makeViolation(code: string, severity: "blocking" | "warning"): Violation {
    return { code, severity, filePath: "src/a.ts", line: 1, message: code };
  }

  test("只有 warning violations 時不阻擋", () => {
    const violations = [
      makeViolation("NO_CHINESE", "warning"),
      makeViolation("TOO_SHORT", "warning"),
      makeViolation("GENERIC_COMMENT", "warning"),
      makeViolation("MISSING_REASON", "warning"),
      makeViolation("EXPIRED_COMMENT", "warning"),
      makeViolation("OVERDUE_COMMENT", "warning"),
      makeViolation("MISSING_OWNER", "warning"),
      makeViolation("MISSING_ISSUE", "warning"),
      makeViolation("UNFORMATTED_FUNCTIONAL_COMMENT", "warning"),
    ];
    expect(shouldBlockCompletion(violations)).toBe(false);
  });

  test("命中 UNKNOWN_TAG 即阻擋", () => {
    expect(shouldBlockCompletion([makeViolation("UNKNOWN_TAG", "blocking")])).toBe(true);
  });

  test("命中 MISSING_SEVERITY 即阻擋", () => {
    expect(shouldBlockCompletion([makeViolation("MISSING_SEVERITY", "blocking")])).toBe(true);
  });

  test("命中 INVALID_SEVERITY 即阻擋", () => {
    expect(shouldBlockCompletion([makeViolation("INVALID_SEVERITY", "blocking")])).toBe(true);
  });

  test("命中 BAD_METADATA 即阻擋", () => {
    expect(shouldBlockCompletion([makeViolation("BAD_METADATA", "blocking")])).toBe(true);
  });

  test("命中 WORKFLOW_ID_IN_COMMENT 即阻擋", () => {
    const violations: Violation[] = [{
      code: "WORKFLOW_ID_IN_COMMENT",
      severity: "blocking",
      filePath: "src/a.ts",
      line: 1,
      message: "註解含具體工作流 instance ID",
    }];
    expect(shouldBlockCompletion(violations)).toBe(true);
  });

  test("warning 與 blocking 並存時仍阻擋", () => {
    const violations = [
      makeViolation("NO_CHINESE", "warning"),
      makeViolation("BAD_METADATA", "blocking"),
    ];
    expect(shouldBlockCompletion(violations)).toBe(true);
  });

  test("空 violations 不阻擋", () => {
    expect(shouldBlockCompletion([])).toBe(false);
  });

  test("非標準 blocking code 雖然 severity=blocking 也不阻擋（嚴格遵守 plan 第 5 節）", () => {
    // 顯示 shouldBlockCompletion 嚴格依照 plan 第 5 節指定 4 個 blocking codes；
    // 即使違反物件的 severity=blocking，若 code 不在白名單仍不阻擋。
    expect(shouldBlockCompletion([makeViolation("SOME_OTHER_BLOCKING", "blocking")])).toBe(false);
  });

  test("支援 policy override 變更 blocking 子集", () => {
    const customPolicy = {
      ...defaultCommentSignalPolicy,
      // 故意把 NO_CHINESE 拉進 blocking 子集（測試 override 行為）；
      // NO_CHINESE 原屬 WarningViolationCode，故需 double-cast 才能塞進
      // BlockingViolationCode[]。
      blockingViolationCodes: ["NO_CHINESE"] as unknown as typeof defaultCommentSignalPolicy.blockingViolationCodes,
    };
    expect(shouldBlockCompletion([makeViolation("NO_CHINESE", "warning")], customPolicy)).toBe(true);
    expect(shouldBlockCompletion([makeViolation("BAD_METADATA", "blocking")], customPolicy)).toBe(false);
  });

  test("checkFile 尊重 policy override，不因 blocking severity 繞過 blockingViolationCodes", () => {
    const policy = {
      ...defaultCommentSignalPolicy,
      blockingViolationCodes: [],
    };
    const report = checkFile("src/a.ts", "// task 031", { policy });
    expect(report.shouldBlockCompletion).toBe(false);
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(1);
  });
});

describe("04 - guard: checkFile", () => {
  test("對單一 source 回傳 CommentSignalReport aggregate", () => {
    const src = "// [SECURITY:P0 owner=@auth issue=#391] 不要將 token 寫入 log，否則會洩漏";
    const report = checkFile("src/auth.ts", src, { today: "2026-06-27" });
    expect(report.scannedFileCount).toBe(1);
    expect(report.checkedCommentCount).toBe(1);
    expect(report.highRiskCount).toBe(1);
    expect(report.shouldBlockCompletion).toBe(false); // 高風險不阻擋
    expect(report.highRisk[0]?.tag).toBe("SECURITY");
    expect(typeof report.humanSummary).toBe("string");
    expect(typeof report.agentFeedback).toBe("string");
  });

  test("blocking violation 出現時 shouldBlockCompletion=true", () => {
    const src = `// ${TAG_OPEN}WARN:P1] 注意這裡`;
    const report = checkFile("src/a.ts", src, { today: "2026-06-27" });
    expect(report.shouldBlockCompletion).toBe(true);
    expect(report.errorCount).toBeGreaterThanOrEqual(1);
    expect(report.violations.map((v) => v.code)).toContain("UNKNOWN_TAG");
  });

  test("warning-only source 不阻擋完成", () => {
    const src = "// [TODO:P2] 之後處理";
    const report = checkFile("src/a.ts", src, { today: "2026-06-27" });
    expect(report.shouldBlockCompletion).toBe(false);
    expect(report.warningCount).toBeGreaterThanOrEqual(1);
    // agentFeedback 仍應出現以提供修正建議
    expect(report.agentFeedback).toMatch(/comment_signal_check/);
  });

  test("空 source 回傳空 report", () => {
    const report = checkFile("src/empty.ts", "", { today: "2026-06-27" });
    expect(report.scannedFileCount).toBe(1);
    expect(report.checkedCommentCount).toBe(0);
    expect(report.violationCount).toBe(0);
    expect(report.shouldBlockCompletion).toBe(false);
  });
});

describe("04 - guard: checkFiles", () => {
  test("聚合多檔案結果（無 IO）", () => {
    const entries = [
      { filePath: "src/a.ts", source: "// [TODO:P2] 之後處理" },
      { filePath: "src/b.ts", source: `// ${TAG_OPEN}WARN:P1] a` },
      { filePath: "src/c.ts", source: "// [SECURITY:P0 owner=@auth issue=#391] 不要將 token 寫入 log，否則會洩漏" },
    ];
    const report = checkFiles(entries, { today: "2026-06-27" });
    expect(report.scannedFileCount).toBe(3);
    expect(report.checkedCommentCount).toBe(3);
    expect(report.shouldBlockCompletion).toBe(true); // b.ts 觸發 UNKNOWN_TAG
    expect(report.highRiskCount).toBe(1);
  });

  test("空 entries 回傳空 report", () => {
    const report = checkFiles([], { today: "2026-06-27" });
    expect(report.scannedFileCount).toBe(0);
    expect(report.shouldBlockCompletion).toBe(false);
  });

  test("全綠（無 violation）時 agentFeedback 為 pass 訊息", () => {
    const entries = [
      { filePath: "src/a.ts", source: "// [目的] 提供 plugin entry point" },
    ];
    const report = checkFiles(entries, { today: "2026-06-27" });
    expect(report.shouldBlockCompletion).toBe(false);
    expect(report.violationCount).toBe(0);
    expect(report.agentFeedback).toMatch(/通過/);
  });
});

describe("04 - guard: checkChangedFiles", () => {
  let store: CommentSignalStore;
  beforeEach(() => {
    store = new CommentSignalStore(memoryStorage());
  });

  test("預設只檢查 session 的 modifiedFiles", async () => {
    await store.recordModifiedFile("session-A", "src/a.ts");
    await store.recordModifiedFile("session-A", "src/b.ts");
    // src/c.ts 雖存在於 resolver，但不在 modifiedFiles 不該被檢查
    const sources: Record<string, string> = {
      "src/a.ts": "// [TODO:P2] 之後處理",
      "src/b.ts": "// [SECURITY:P0 owner=@auth issue=#391] 不要將 token 寫入 log，否則會洩漏",
      "src/c.ts": `// ${TAG_OPEN}WARN:P1] 這個不會被檢查`,
    };
    const resolver = (fp: string) => sources[fp] ?? null;
    const state = await changedState(store, "session-A");
    const report = checkChangedFiles(state, resolver, { today: "2026-06-27" });
    expect(report.scannedFileCount).toBe(2);
    expect(report.checkedCommentCount).toBe(2);
    // src/c.ts 不應出現在 violations 內
    const files = report.violations.map((v) => v.filePath);
    expect(files).not.toContain("src/c.ts");
  });

  test("指定 path 時只檢查符合 path 前綴的檔案", async () => {
    await store.recordModifiedFile("session-A", "src/auth/login.ts");
    await store.recordModifiedFile("session-A", "src/api/users.ts");
    const sources: Record<string, string> = {
      "src/auth/login.ts": "// [SECURITY:P0 owner=@auth issue=#391] 不要將 token 寫入 log，否則會洩漏",
      "src/api/users.ts": "// [TODO:P2] 之後處理",
    };
    const resolver = (fp: string) => sources[fp] ?? null;
    const state = await changedState(store, "session-A");
    const report = checkChangedFiles(state, resolver, {
      today: "2026-06-27",
      path: "src/auth",
    });
    expect(report.scannedFileCount).toBe(1);
    expect(report.highRiskCount).toBe(1);
    expect(report.highRisk[0]?.filePath).toBe("src/auth/login.ts");
  });

  test("modifiedFiles 為空時回傳空 report", async () => {
    const state = await changedState(store, "empty-session");
    const report = checkChangedFiles(state, () => null, { today: "2026-06-27" });
    expect(report.scannedFileCount).toBe(0);
    expect(report.shouldBlockCompletion).toBe(false);
  });

  test("resolver 回傳 null 的檔案會被跳過（不視為 scan 失敗）", async () => {
    await store.recordModifiedFile("session-A", "src/a.ts");
    await store.recordModifiedFile("session-A", "src/missing.ts");
    const sources: Record<string, string> = {
      "src/a.ts": "// [TODO:P2] 之後處理",
    };
    const resolver = (fp: string) => sources[fp] ?? null;
    const state = await changedState(store, "session-A");
    const report = checkChangedFiles(state, resolver, { today: "2026-06-27" });
    expect(report.scannedFileCount).toBe(1);
  });

  test("指定 path 但沒有檔案符合時回傳空 report", async () => {
    await store.recordModifiedFile("session-A", "src/a.ts");
    await store.recordModifiedFile("session-A", "src/b.ts");
    const resolver = (fp: string) => `// [TODO:P2] 之後處理 (${fp})`;
    const state = await changedState(store, "session-A");
    const report = checkChangedFiles(state, resolver, {
      today: "2026-06-27",
      path: "src/non-existent",
    });
    expect(report.scannedFileCount).toBe(0);
  });

  test("path 為精確檔案路徑時也應命中（不只是前綴）", async () => {
    await store.recordModifiedFile("session-A", "src/auth/login.ts");
    await store.recordModifiedFile("session-A", "src/api/users.ts");
    const sources: Record<string, string> = {
      "src/auth/login.ts": "// [SECURITY:P0 owner=@auth issue=#391] 不要將 token 寫入 log，否則會洩漏",
      "src/api/users.ts": "// [TODO:P2] 之後處理",
    };
    const resolver = (fp: string) => sources[fp] ?? null;
    const state = await changedState(store, "session-A");
    const report = checkChangedFiles(state, resolver, {
      today: "2026-06-27",
      path: "src/api/users.ts",
    });
    expect(report.scannedFileCount).toBe(1);
    expect(report.highRiskCount).toBe(0);
  });

  test("session state 為不同 session 時只檢查該 session 的 modifiedFiles", async () => {
    await store.recordModifiedFile("session-A", "src/a.ts");
    await store.recordModifiedFile("session-B", "src/b.ts");
    const sources: Record<string, string> = {
      "src/a.ts": "// [TODO:P2] 之後處理",
      "src/b.ts": "// [SECURITY:P0 owner=@auth issue=#391] 不要將 token 寫入 log，否則會洩漏",
    };
    const resolver = (fp: string) => sources[fp] ?? null;
    const stateA = await changedState(store, "session-A");
    const reportA = checkChangedFiles(stateA, resolver, { today: "2026-06-27" });
    expect(reportA.scannedFileCount).toBe(1);
    expect(reportA.highRiskCount).toBe(0);

    const stateB = await changedState(store, "session-B");
    const reportB = checkChangedFiles(stateB, resolver, { today: "2026-06-27" });
    expect(reportB.scannedFileCount).toBe(1);
    expect(reportB.highRiskCount).toBe(1);
  });
});

describe("04 - guard: integration with phase-1 reporter fields", () => {
  test("checkFile 回傳的 report 包含 plan 第 7 節全部必要欄位", () => {
    const src = "// [SECURITY:P0 owner=@auth issue=#391] 不要將 token 寫入 log，否則會洩漏";
    const report: CommentSignalReport = checkFile("src/auth.ts", src, { today: "2026-06-27" });
    // 驗證 plan 第 7 節指定欄位
    expect(typeof report.scannedFileCount).toBe("number");
    expect(typeof report.checkedCommentCount).toBe("number");
    expect(typeof report.violationCount).toBe("number");
    expect(typeof report.errorCount).toBe("number");
    expect(typeof report.warningCount).toBe("number");
    expect(typeof report.highRiskCount).toBe("number");
    expect(typeof report.shouldBlockCompletion).toBe("boolean");
    expect(typeof report.agentFeedback).toBe("string");
    expect(Array.isArray(report.violations)).toBe(true);
    expect(Array.isArray(report.highRisk)).toBe(true);
    expect(typeof report.humanSummary).toBe("string");
  });
});

// ─── Comment Signal 忽略 Markdown 檔案────
//
// 使用者明確要求：Comment Signal 系統應完全避開 Markdown 檔案（.md / .markdown，
// 大小寫不敏感）。理由：
//   - Markdown 語法（[link](url)、# heading、```code fence```）會讓 parser 把
//     `[link]` 誤判為 functional tag 而觸發 UNKNOWN_TAG 等 blocking violation。
//   - MD 屬於文件而非程式碼，無需 Comment Signal 系統檢查。

describe("04 - guard: isMarkdownPath helper", () => {
  test(".md 視為 Markdown", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("docs/guide.md")).toBe(true);
    expect(isMarkdownPath("/abs/path/to/foo.md")).toBe(true);
  });

  test(".markdown 視為 Markdown", () => {
    expect(isMarkdownPath("README.markdown")).toBe(true);
    expect(isMarkdownPath("docs/guide.markdown")).toBe(true);
  });

  test("大小寫不敏感（.MD / .Markdown / .MarkDown）", () => {
    expect(isMarkdownPath("README.MD")).toBe(true);
    expect(isMarkdownPath("README.Markdown")).toBe(true);
    expect(isMarkdownPath("Foo.MarkDown")).toBe(true);
  });

  test("非 Markdown 副檔名回傳 false", () => {
    expect(isMarkdownPath("src/foo.ts")).toBe(false);
    expect(isMarkdownPath("foo.txt")).toBe(false);
    expect(isMarkdownPath("foo.json")).toBe(false);
    expect(isMarkdownPath("foo")).toBe(false);
    expect(isMarkdownPath("module.md.ts")).toBe(false); // .md 在中間而非結尾
  });

  test("空字串 / null-ish 回傳 false（不 throw）", () => {
    expect(isMarkdownPath("")).toBe(false);
  });
});

describe("04 - guard: checkFile 跳過 Markdown", () => {
  test("checkFile(\"README.md\") 回傳空 report（不掃內容）", () => {
    const src = `// ${TAG_OPEN}WARN:P1] 此行在 MD 內不該被解析`;
    const report = checkFile("README.md", src, { today: "2026-06-27" });
    expect(report.scannedFileCount).toBe(0);
    expect(report.checkedCommentCount).toBe(0);
    expect(report.violationCount).toBe(0);
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(0);
    expect(report.highRiskCount).toBe(0);
    expect(report.shouldBlockCompletion).toBe(false);
    expect(report.violations).toEqual([]);
    expect(report.highRisk).toEqual([]);
  });

  test("checkFile(\"docs/foo.markdown\") 也回空 report", () => {
    const src = "// [SECURITY:P0 owner=@auth issue=#391] 不要將 token 寫入 log";
    const report = checkFile("docs/foo.markdown", src, { today: "2026-06-27" });
    expect(report.scannedFileCount).toBe(0);
    expect(report.highRiskCount).toBe(0);
    expect(report.shouldBlockCompletion).toBe(false);
  });

  test("checkFile 大小寫不敏感（UPPER.MD 也跳過）", () => {
    const src = "// [TODO:P2] 之後處理";
    const report = checkFile("NOTES.MD", src, { today: "2026-06-27" });
    expect(report.scannedFileCount).toBe(0);
    expect(report.warningCount).toBe(0);
  });

  test("checkFile 對非 MD 檔案照常掃描", () => {
    const src = "// [TODO:P2] 之後處理";
    const report = checkFile("src/foo.ts", src, { today: "2026-06-27" });
    expect(report.scannedFileCount).toBe(1);
    expect(report.checkedCommentCount).toBe(1);
  });
});

describe("04 - guard: checkFiles 從 entries 排除 Markdown", () => {
  test("混合 Markdown + TypeScript 時只掃非 MD", () => {
    const entries = [
      { filePath: "README.md", source: `// ${TAG_OPEN}WARN:P1] MD 不該被掃` },
      { filePath: "src/a.ts", source: "// [TODO:P2] 之後處理" },
      { filePath: "docs/notes.markdown", source: `// ${TAG_OPEN}WARN:P1] MD 也不該被掃` },
      { filePath: "src/b.ts", source: "// [SECURITY:P0 owner=@auth issue=#391] 不要將 token 寫入 log" },
    ];
    const report = checkFiles(entries, { today: "2026-06-27" });
    expect(report.scannedFileCount).toBe(2);
    expect(report.checkedCommentCount).toBe(2);
    // 高風險來自 src/b.ts
    expect(report.highRiskCount).toBe(1);
    expect(report.highRisk[0]?.filePath).toBe("src/b.ts");
    // 不應有 MD 檔案的 violation
    const mdFiles = report.violations.map((v) => v.filePath).filter((p) => isMarkdownPath(p));
    expect(mdFiles).toEqual([]);
  });

  test("全 MD 檔案時回空 report", () => {
    const entries = [
      { filePath: "a.md", source: "// [TODO:P2] 之後處理" },
      { filePath: "b.markdown", source: `// ${TAG_OPEN}WARN:P1] a` },
    ];
    const report = checkFiles(entries, { today: "2026-06-27" });
    expect(report.scannedFileCount).toBe(0);
    expect(report.shouldBlockCompletion).toBe(false);
  });
});

describe("04 - guard: checkChangedFiles 排除 Markdown", () => {
  let store: CommentSignalStore;
  beforeEach(() => {
    store = new CommentSignalStore(memoryStorage());
  });

  test("modifiedFiles 含 MD 時不會掃描，也不會呼叫 sourceResolver", async () => {
    await store.recordModifiedFile("session-md", "README.md");
    await store.recordModifiedFile("session-md", "docs/notes.markdown");
    await store.recordModifiedFile("session-md", "src/foo.ts");
    const resolverCalls: string[] = [];
    const resolver = (fp: string): string | null => {
      resolverCalls.push(fp);
      return `// [TODO:P2] 之後處理 (${fp})`;
    };
    const state = await changedState(store, "session-md");
    const report = checkChangedFiles(state, resolver, { today: "2026-06-27" });
    expect(report.scannedFileCount).toBe(1);
    // 關鍵：sourceResolver 不該被 MD 檔案呼叫
    expect(resolverCalls).not.toContain("README.md");
    expect(resolverCalls).not.toContain("docs/notes.markdown");
    expect(resolverCalls).toContain("src/foo.ts");
  });

  test("modifiedFiles 全為 MD 時回空 report", async () => {
    await store.recordModifiedFile("session-all-md", "README.md");
    await store.recordModifiedFile("session-all-md", "CHANGELOG.markdown");
    const resolverCalls: string[] = [];
    const resolver = (fp: string): string | null => {
      resolverCalls.push(fp);
      return "// [TODO:P2] 之後處理";
    };
    const state = await changedState(store, "session-all-md");
    const report = checkChangedFiles(state, resolver, { today: "2026-06-27" });
    expect(report.scannedFileCount).toBe(0);
    expect(resolverCalls).toEqual([]);
    expect(report.shouldBlockCompletion).toBe(false);
  });

  test("path filter 為資料夾前綴時仍會排除 MD", async () => {
    await store.recordModifiedFile("session-mix", "docs/README.md");
    await store.recordModifiedFile("session-mix", "docs/guide.md");
    await store.recordModifiedFile("session-mix", "docs/foo.ts");
    const resolverCalls: string[] = [];
    const resolver = (fp: string): string | null => {
      resolverCalls.push(fp);
      return "// [TODO:P2] 之後處理";
    };
    const state = await changedState(store, "session-mix");
    const report = checkChangedFiles(state, resolver, {
      today: "2026-06-27",
      path: "docs",
    });
    expect(report.scannedFileCount).toBe(1);
    expect(resolverCalls).toEqual(["docs/foo.ts"]);
  });

  test("MD 檔案即使 source 含 UNKNOWN_TAG 也不會觸發 blocking", async () => {
    await store.recordModifiedFile("session-md-block", "README.md");
    const resolver = (): string | null => `// ${TAG_OPEN}WARN:P1] 未知 tag`;
    const state = await changedState(store, "session-md-block");
    const report = checkChangedFiles(state, resolver, { today: "2026-06-27" });
    // 雖然 source 含非法 functional comment，但因為是 MD 直接跳過，
    // 不該觸發 UNKNOWN_TAG blocking。
    expect(report.scannedFileCount).toBe(0);
    expect(report.shouldBlockCompletion).toBe(false);
    expect(report.violations).toEqual([]);
  });
});
