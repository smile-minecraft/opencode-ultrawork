/**
 * commentSignal 狀態：ctx.storage 上的工作階段隔離狀態。
 *
 * 由 tests/ultrawork/comment-signal/05-state.test.ts 移植，改用新形狀：
 * CommentSignalStore（非同步、storage-backed）取代 module-level Map。
 * 語意維持：modifiedFiles 去重保序、lastReport 覆寫、warnings 累積去重、
 * 清理 API、跨工作階段隔離。reference 同一性不再保證
 *（storage 往返一律視為值語意），斷言改用 toEqual。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { buildReport } from "../../../../src/modules/comment-signal/reporter.ts";
import { defaultCommentSignalPolicy } from "../../../../src/modules/comment-signal/policy.ts";
import { CommentSignalStore, type CommentSignalWarning } from "../../../../src/modules/comment-signal/state.ts";
import type { CommentSignalReport } from "../../../../src/modules/comment-signal/types.ts";
import type { KeyValueStorage } from "../../../../src/state/store.ts";

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

describe("05 - state: session lifecycle", () => {
  let store: CommentSignalStore;
  beforeEach(() => {
    store = new CommentSignalStore(memoryStorage());
  });

  test("全新工作階段讀到空狀態", async () => {
    expect(await store.getModifiedFiles("session-A")).toEqual([]);
    expect(await store.getLastReport("session-A")).toBeNull();
    expect(await store.getWarnings("session-A")).toEqual([]);
  });

  test("record 後不同工作階段狀態隔離", async () => {
    await store.recordModifiedFile("session-A", "src/a.ts");
    expect(await store.getModifiedFiles("session-A")).toEqual(["src/a.ts"]);
    expect(await store.getModifiedFiles("session-B")).toEqual([]);
  });
});

describe("05 - state: modifiedFiles", () => {
  let store: CommentSignalStore;
  beforeEach(() => {
    store = new CommentSignalStore(memoryStorage());
  });

  test("recordModifiedFile 累積檔案路徑", async () => {
    await store.recordModifiedFile("session-A", "src/a.ts");
    await store.recordModifiedFile("session-A", "src/b.ts");
    expect((await store.getModifiedFiles("session-A")).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("recordModifiedFile 同檔案重複記錄會去重", async () => {
    await store.recordModifiedFile("session-A", "src/a.ts");
    await store.recordModifiedFile("session-A", "src/a.ts");
    await store.recordModifiedFile("session-A", "src/a.ts");
    expect(await store.getModifiedFiles("session-A")).toEqual(["src/a.ts"]);
  });

  test("getModifiedFiles 未建立過的工作階段回傳空陣列", async () => {
    expect(await store.getModifiedFiles("never-seen")).toEqual([]);
  });

  test("clearModifiedFiles 清空當前工作階段的 modifiedFiles", async () => {
    await store.recordModifiedFile("session-A", "src/a.ts");
    await store.recordModifiedFile("session-A", "src/b.ts");
    await store.clearModifiedFiles("session-A");
    expect(await store.getModifiedFiles("session-A")).toEqual([]);
  });

  test("clearModifiedFiles 不影響其他工作階段", async () => {
    await store.recordModifiedFile("session-A", "src/a.ts");
    await store.recordModifiedFile("session-B", "src/b.ts");
    await store.clearModifiedFiles("session-A");
    expect(await store.getModifiedFiles("session-A")).toEqual([]);
    expect(await store.getModifiedFiles("session-B")).toEqual(["src/b.ts"]);
  });

  test("recordModifiedFile 自動建立尚未存在的工作階段", async () => {
    await store.recordModifiedFile("auto-create", "src/x.ts");
    expect(await store.getModifiedFiles("auto-create")).toEqual(["src/x.ts"]);
  });
});

describe("05 - state: lastReport", () => {
  let store: CommentSignalStore;
  beforeEach(() => {
    store = new CommentSignalStore(memoryStorage());
  });

  test("初始工作階段的 lastReport 為 null", async () => {
    expect(await store.getLastReport("session-A")).toBeNull();
  });

  test("recordLastReport 寫入後可由 getLastReport 取回", async () => {
    const fakeReport: CommentSignalReport = {
      scannedFileCount: 1,
      checkedCommentCount: 2,
      violationCount: 1,
      errorCount: 1,
      warningCount: 0,
      highRiskCount: 0,
      shouldBlockCompletion: true,
      agentFeedback: "fb",
      violations: [],
      highRisk: [],
      humanSummary: "summary",
    };
    await store.recordLastReport("session-A", fakeReport);
    const out = await store.getLastReport("session-A");
    expect(out).toEqual(fakeReport);
    expect(out?.shouldBlockCompletion).toBe(true);
  });

  test("recordLastReport 後續呼叫會覆蓋前一次的 report", async () => {
    const r1 = buildReport([], { today: "2026-06-27", policy: defaultCommentSignalPolicy });
    const r2 = buildReport([], { today: "2026-06-28", policy: defaultCommentSignalPolicy });
    await store.recordLastReport("session-A", r1);
    await store.recordLastReport("session-A", r2);
    expect(await store.getLastReport("session-A")).toEqual(r2);
  });

  test("clearLastReport 清空當前工作階段的 lastReport", async () => {
    const r = buildReport([], { today: "2026-06-27", policy: defaultCommentSignalPolicy });
    await store.recordLastReport("session-A", r);
    await store.clearLastReport("session-A");
    expect(await store.getLastReport("session-A")).toBeNull();
  });

  test("clearLastReport 不影響其他工作階段的 lastReport", async () => {
    const rA = buildReport([], { today: "2026-06-27", policy: defaultCommentSignalPolicy });
    const rB = buildReport([], { today: "2026-06-28", policy: defaultCommentSignalPolicy });
    await store.recordLastReport("session-A", rA);
    await store.recordLastReport("session-B", rB);
    await store.clearLastReport("session-A");
    expect(await store.getLastReport("session-A")).toBeNull();
    expect(await store.getLastReport("session-B")).toEqual(rB);
  });
});

describe("05 - state: warnings", () => {
  let store: CommentSignalStore;
  beforeEach(() => {
    store = new CommentSignalStore(memoryStorage());
  });

  test("初始工作階段的 warnings 為空陣列", async () => {
    expect(await store.getWarnings("session-A")).toEqual([]);
  });

  test("recordWarning 累積多筆 warning 並保留順序", async () => {
    const w1: CommentSignalWarning = {
      filePath: "src/a.ts",
      tag: "SECURITY",
      severity: "P0",
      message: "highRisk 警告",
      createdAt: "2026-06-27T10:00:00.000Z",
    };
    const w2: CommentSignalWarning = {
      filePath: "src/b.ts",
      tag: "AI_DO_NOT_EDIT",
      severity: "P1",
      message: "禁止 AI 改寫",
      createdAt: "2026-06-27T10:01:00.000Z",
    };
    await store.recordWarning("session-A", w1);
    await store.recordWarning("session-A", w2);
    expect(await store.getWarnings("session-A")).toEqual([w1, w2]);
  });

  test("同內容 warning 重複記錄會去重", async () => {
    const w: CommentSignalWarning = {
      filePath: "src/a.ts",
      tag: "DANGER",
      severity: "P0",
      message: "highRisk 警告",
      createdAt: "2026-06-27T10:00:00.000Z",
    };
    await store.recordWarning("session-A", w);
    await store.recordWarning("session-A", { ...w });
    expect(await store.getWarnings("session-A")).toHaveLength(1);
  });

  test("getWarnings 回傳 defensive copy（外部 push 不污染狀態）", async () => {
    const w: CommentSignalWarning = {
      filePath: "src/a.ts",
      tag: "DANGER",
      severity: "P0",
      message: "highRisk 警告",
      createdAt: "2026-06-27T10:00:00.000Z",
    };
    await store.recordWarning("session-A", w);
    const out = await store.getWarnings("session-A");
    expect(out).toHaveLength(1);
    out.push({ ...w, filePath: "src/polluted.ts" });
    expect(await store.getWarnings("session-A")).toHaveLength(1);
  });

  test("clearWarnings 清空當前工作階段的 warnings", async () => {
    await store.recordWarning("session-A", {
      filePath: "src/a.ts",
      tag: "SECURITY",
      severity: "P0",
      message: "x",
      createdAt: "2026-06-27T10:00:00.000Z",
    });
    await store.clearWarnings("session-A");
    expect(await store.getWarnings("session-A")).toEqual([]);
  });

  test("clearWarnings 不影響其他工作階段的 warnings", async () => {
    const w: CommentSignalWarning = {
      filePath: "src/a.ts",
      tag: "SECURITY",
      severity: "P0",
      message: "x",
      createdAt: "2026-06-27T10:00:00.000Z",
    };
    await store.recordWarning("session-A", w);
    await store.recordWarning("session-B", w);
    await store.clearWarnings("session-A");
    expect(await store.getWarnings("session-A")).toEqual([]);
    expect(await store.getWarnings("session-B")).toHaveLength(1);
  });
});

describe("05 - state: cleanup APIs", () => {
  let store: CommentSignalStore;
  beforeEach(() => {
    store = new CommentSignalStore(memoryStorage());
  });

  test("clearSession 完整清除 modifiedFiles／lastReport／warnings", async () => {
    await store.recordModifiedFile("session-A", "src/a.ts");
    await store.recordLastReport(
      "session-A",
      buildReport([], { today: "2026-06-27", policy: defaultCommentSignalPolicy }),
    );
    await store.recordWarning("session-A", {
      filePath: "src/a.ts",
      tag: "SECURITY",
      severity: "P0",
      message: "x",
      createdAt: "2026-06-27T10:00:00.000Z",
    });

    await store.clearSession("session-A");

    expect(await store.getModifiedFiles("session-A")).toEqual([]);
    expect(await store.getLastReport("session-A")).toBeNull();
    expect(await store.getWarnings("session-A")).toEqual([]);
  });

  test("clearSession 不影響其他工作階段", async () => {
    await store.recordModifiedFile("session-A", "src/a.ts");
    await store.recordModifiedFile("session-B", "src/b.ts");
    await store.clearSession("session-A");
    expect(await store.getModifiedFiles("session-A")).toEqual([]);
    expect(await store.getModifiedFiles("session-B")).toEqual(["src/b.ts"]);
  });

  test("clearSession 後再次讀取回傳全新空狀態", async () => {
    await store.recordModifiedFile("session-A", "src/a.ts");
    await store.clearSession("session-A");
    expect(await store.getModifiedFiles("session-A")).toEqual([]);
    expect(await store.getLastReport("session-A")).toBeNull();
    expect(await store.getWarnings("session-A")).toEqual([]);
  });

  test("clearSession 同時清掉 parent 對應", async () => {
    await store.registerSessionParent("child", "parent");
    await store.clearSession("child");
    expect(await store.getSessionAncestors("child")).toEqual([]);
  });

  test("resetCommentSignalState 是 clearSession 的等效 alias", async () => {
    await store.recordModifiedFile("session-A", "src/a.ts");
    await store.recordWarning("session-A", {
      filePath: "src/a.ts",
      tag: "SECURITY",
      severity: "P0",
      message: "x",
      createdAt: "2026-06-27T10:00:00.000Z",
    });
    await store.resetCommentSignalState("session-A");
    expect(await store.getModifiedFiles("session-A")).toEqual([]);
    expect(await store.getWarnings("session-A")).toEqual([]);
  });

  test("clearAllSessions 清除所有工作階段（測試 helper）", async () => {
    await store.recordModifiedFile("session-A", "src/a.ts");
    await store.recordModifiedFile("session-B", "src/b.ts");
    await store.clearAllSessions();
    expect(await store.getModifiedFiles("session-A")).toEqual([]);
    expect(await store.getModifiedFiles("session-B")).toEqual([]);
  });
});

describe("05 - state: sessionID isolation", () => {
  let store: CommentSignalStore;
  beforeEach(() => {
    store = new CommentSignalStore(memoryStorage());
  });

  test("不同工作階段之間的 modifiedFiles 互不污染", async () => {
    await store.recordModifiedFile("session-A", "src/a.ts");
    await store.recordModifiedFile("session-B", "src/b.ts");
    expect(await store.getModifiedFiles("session-A")).toEqual(["src/a.ts"]);
    expect(await store.getModifiedFiles("session-B")).toEqual(["src/b.ts"]);
  });

  test("不同工作階段之間的 lastReport 互不污染", async () => {
    const rA = buildReport([], { today: "2026-06-27", policy: defaultCommentSignalPolicy });
    await store.recordLastReport("session-A", rA);
    expect(await store.getLastReport("session-B")).toBeNull();
  });

  test("不同工作階段之間的 warnings 互不污染", async () => {
    await store.recordWarning("session-A", {
      filePath: "src/a.ts",
      tag: "SECURITY",
      severity: "P0",
      message: "x",
      createdAt: "2026-06-27T10:00:00.000Z",
    });
    expect(await store.getWarnings("session-B")).toEqual([]);
  });

  test("record* 回傳的狀態快照含本次寫入內容", async () => {
    const s = await store.recordModifiedFile("session-A", "src/a.ts");
    expect(s.modifiedFiles).toEqual(["src/a.ts"]);
    expect(s.sessionID).toBe("session-A");
  });
});

describe("05 - state: parent/child aggregation", () => {
  let store: CommentSignalStore;
  beforeEach(() => {
    store = new CommentSignalStore(memoryStorage());
  });

  test("child 修改會向所有 ancestor 聚合，但不污染 sibling", async () => {
    await store.registerSessionParent("child", "parent");
    await store.registerSessionParent("grandchild", "child");
    await store.registerSessionParent("sibling", "parent");

    await store.recordModifiedFile("grandchild", "src/deep.ts");
    await store.recordWarning("grandchild", {
      filePath: "src/deep.ts",
      tag: "SECURITY",
      severity: "P1",
      message: "test warning",
      createdAt: "2026-08-11T00:00:00.000Z",
    });

    expect(await store.getModifiedFiles("grandchild")).toEqual(["src/deep.ts"]);
    expect(await store.getModifiedFiles("child")).toEqual(["src/deep.ts"]);
    expect(await store.getModifiedFiles("parent")).toEqual(["src/deep.ts"]);
    expect(await store.getModifiedFiles("sibling")).toEqual([]);
    expect(await store.getWarnings("parent")).toHaveLength(1);
  });

  test("parent 對應晚於 child edit 建立時仍回填既有 modifiedFiles", async () => {
    await store.recordModifiedFile("late-child", "src/before-link.ts");
    await store.registerSessionParent("late-child", "late-parent");

    expect(await store.getModifiedFiles("late-parent")).toEqual(["src/before-link.ts"]);
  });

  test("self-parent 與空 parentID 拒絕註冊", async () => {
    expect(await store.registerSessionParent("a", "a")).toBe(false);
    expect(await store.registerSessionParent("a", "  ")).toBe(false);
    expect(await store.registerSessionParent("  ", "b")).toBe(false);
  });

  test("cycle 不會造成無限迴圈", async () => {
    await store.registerSessionParent("a", "b");
    // b 的 ancestor 含 a 時，a→b 的反向註冊被拒絕（cycle 防護）
    expect(await store.registerSessionParent("b", "a")).toBe(false);
    expect(await store.getSessionAncestors("a")).toEqual(["b"]);
  });

  test("ancestor 深度上限 64", async () => {
    for (let i = 0; i < 70; i++) {
      await store.registerSessionParent(`chain-${i}`, `chain-${i + 1}`);
    }
    const ancestors = await store.getSessionAncestors("chain-0");
    expect(ancestors).toHaveLength(64);
    expect(ancestors[0]).toBe("chain-1");
    expect(ancestors[63]).toBe("chain-64");
  });
});

describe("05 - state: 並行寫入序列化", () => {
  let store: CommentSignalStore;
  beforeEach(() => {
    store = new CommentSignalStore(memoryStorage());
  });

  test("併發記錄多筆檔案：全部保留不遺失", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.recordModifiedFile("s-conc", `src/f${i}.ts`)),
    );
    const files = await store.getModifiedFiles("s-conc");
    expect(files).toHaveLength(20);
    for (let i = 0; i < 20; i++) expect(files).toContain(`src/f${i}.ts`);
  });

  test("併發記錄多筆 warning：全部保留不遺失", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.recordWarning("s-conc", {
          filePath: `src/f${i}.ts`,
          tag: "SECURITY",
          severity: "P1",
          message: `警告 ${i}`,
          createdAt: "2026-08-11T00:00:00.000Z",
        }),
      ),
    );
    expect(await store.getWarnings("s-conc")).toHaveLength(20);
  });
});
