/**
 * 07 — Comment Signal per-tool factory（V2 新形狀）。
 *
 * 由 tests/ultrawork/comment-signal/07-tool-factories.test.ts 移植：
 *   - factory 照舊各自獨立 module（tool-check／tool-policy／
 *     tool-touched-report／tool-explain／tool-deps），`tools.ts` 維持薄 barrel。
 *   - V2 差異：deps 改含 storage-backed `store` 與非同步 `resolveRoot`；
 *     工具物件帶 JSON Schema `input`（取代舊 `args`），execute 回 `{ content }`。
 *
 * 規則（不可破壞）：4 個工具名稱、參數 schema、回傳欄位、session 語意不變。
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// per-tool factory modules
import { createCommentSignalCheckTool } from "../../../../src/modules/comment-signal/tool-check.ts";
import { createCommentSignalPolicyTool } from "../../../../src/modules/comment-signal/tool-policy.ts";
import { createCommentSignalTouchedReportTool } from "../../../../src/modules/comment-signal/tool-touched-report.ts";
import { createCommentSignalExplainTool } from "../../../../src/modules/comment-signal/tool-explain.ts";
import type { CommentSignalToolDeps } from "../../../../src/modules/comment-signal/tool-deps.ts";
import { CommentSignalStore } from "../../../../src/modules/comment-signal/state.ts";
import type { KeyValueStorage } from "../../../../src/state/store.ts";

// barrel（compatibility）
import {
  createCommentSignalCheckTool as barrelCheck,
  createCommentSignalPolicyTool as barrelPolicy,
  createCommentSignalTouchedReportTool as barrelTouched,
  createCommentSignalExplainTool as barrelExplain,
  __commentSignalToolInternals,
} from "../../../../src/modules/comment-signal/tools.ts";

import { fakeV2ToolContext } from "../../_fake-v2-context.ts";
import { parse } from "./_helpers.ts";

const CS_DIR = join(import.meta.dir, "..", "..", "..", "..", "src", "modules", "comment-signal");

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

/** in-memory sourceResolver：以 map 提供檔案內容，未命中回 null。 */
function makeDeps(files: Record<string, string>): CommentSignalToolDeps {
  return {
    sourceResolver: (_worktree: string, filePath: string) =>
      Object.prototype.hasOwnProperty.call(files, filePath) ? files[filePath] : null,
    directoryResolver: (_worktree: string, _dirPath: string) => Object.keys(files),
    today: "2026-01-01",
    resolveRoot: async () => "/tmp/worktree",
    store: new CommentSignalStore(memoryStorage()),
  };
}

/** JSON Schema input 的參數名稱（舊 args keys 的對應位置）。 */
function inputKeys(tool: { input: Record<string, unknown> }): string[] {
  const properties = (tool.input as { properties?: Record<string, unknown> }).properties ?? {};
  return Object.keys(properties).sort();
}

describe("07 - comment-signal per-tool factory（V2 新形狀）", () => {
  test("四個 factory + deps 各自獨立 module 檔案存在", () => {
    expect(existsSync(join(CS_DIR, "tool-check.ts"))).toBe(true);
    expect(existsSync(join(CS_DIR, "tool-policy.ts"))).toBe(true);
    expect(existsSync(join(CS_DIR, "tool-touched-report.ts"))).toBe(true);
    expect(existsSync(join(CS_DIR, "tool-explain.ts"))).toBe(true);
    expect(existsSync(join(CS_DIR, "tool-deps.ts"))).toBe(true);
  });

  test("tools.ts 收斂為薄 barrel：不含 factory 本體，改為 re-export", () => {
    const src = readFileSync(join(CS_DIR, "tools.ts"), "utf-8");
    // 不再內含 explain 的大型 TAG 表與診斷函式本體
    expect(src).not.toContain("const TAG_EXPLANATIONS");
    expect(src).not.toContain("function diagnoseRawLine");
    // 改為 re-export per-tool module
    expect(src).toContain("tool-check.ts");
    expect(src).toContain("tool-policy.ts");
    expect(src).toContain("tool-touched-report.ts");
    expect(src).toContain("tool-explain.ts");
    expect(src).toContain("tool-deps.ts");
  });

  test("check factory：input schema + 代表輸出（乾淨檔案 → 無 violation）", async () => {
    const deps = makeDeps({ "src/clean.ts": "// [目的] 乾淨檔案，供 factory 測試使用\nexport const a = 1;\n" });
    const t = createCommentSignalCheckTool(deps);
    expect(t.name).toBe("comment_signal_check");
    expect(inputKeys(t)).toEqual(["changedOnly", "json", "path"]);
    const out = parse(await t.execute({ path: "src/clean.ts", changedOnly: false }, fakeV2ToolContext()));
    expect(out.ok).toBe(true);
    expect(out.violationCount).toBe(0);
    expect(typeof out.scannedFileCount).toBe("number");
    expect(typeof out.shouldBlockCompletion).toBe("boolean");
  });

  test("policy factory：input 空 + 代表輸出（摘要欄位齊備）", async () => {
    const t = createCommentSignalPolicyTool(makeDeps({}));
    expect(t.name).toBe("comment_signal_policy");
    expect(inputKeys(t)).toEqual([]);
    const out = parse(await t.execute({}, fakeV2ToolContext()));
    expect(out.ok).toBe(true);
    expect(Array.isArray(out.descriptiveTags)).toBe(true);
    expect(Array.isArray(out.functionalTags)).toBe(true);
    expect(Array.isArray(out.blockingViolationCodes)).toBe(true);
    expect(out.commonMistakes.length).toBeGreaterThan(0);
  });

  test("touched_report factory：input sessionID + 代表輸出（modifiedFiles 投影）", async () => {
    const deps = makeDeps({});
    await deps.store.recordModifiedFile("factory-test-session", "src/touched.ts");
    const t = createCommentSignalTouchedReportTool(deps);
    expect(t.name).toBe("comment_signal_touched_report");
    expect(inputKeys(t)).toEqual(["sessionID"]);
    const out = parse(await t.execute({ sessionID: "factory-test-session" }, fakeV2ToolContext()));
    expect(out.ok).toBe(true);
    expect(out.modifiedFiles).toContain("src/touched.ts");
    expect(Array.isArray(out.perFile)).toBe(true);
  });

  test("explain factory：input tag/filePath/line + 代表輸出（tag 查詢）", async () => {
    const t = createCommentSignalExplainTool(makeDeps({}));
    expect(t.name).toBe("comment_signal_explain");
    expect(inputKeys(t)).toEqual(["filePath", "line", "tag"]);
    const ok = parse(await t.execute({ tag: "SECURITY" }, fakeV2ToolContext()));
    expect(ok.ok).toBe(true);
    expect(ok.mode).toBe("tag");
    expect(ok.kind).toBe("functional");
    // 未提供任何查詢參數 → ok:false
    const err = parse(await t.execute({}, fakeV2ToolContext()));
    expect(err.ok).toBe(false);
  });

  test("barrel compatibility：tools.ts re-export 4 factory 與同名 __internals", async () => {
    expect(typeof barrelCheck).toBe("function");
    expect(typeof barrelPolicy).toBe("function");
    expect(typeof barrelTouched).toBe("function");
    expect(typeof barrelExplain).toBe("function");
    // barrel factory 產生的 tool 仍具 execute
    expect(typeof barrelPolicy(makeDeps({})).execute).toBe("function");
    // __commentSignalToolInternals 保留關鍵 helper（hook 用）
    expect(typeof __commentSignalToolInternals.resolveCheckInputs).toBe("function");
    expect(typeof __commentSignalToolInternals.diagnoseRawLine).toBe("function");
    expect(Array.isArray(__commentSignalToolInternals.COMMON_MISTAKES)).toBe(true);
  });
});
