/**
 * 24 — Comment Signal parent/child session aggregation（V2 新形狀）。
 *
 * 由 tests/ultrawork/24-comment-signal-parent-child.test.ts 移植：
 *   - child 修改與 warning 向所有 ancestor 聚合，不污染 sibling。
 *   - parent 對應晚於 child edit 建立時仍回填。
 *   - session.created 事件＋tool.execute.after 讓 parent 的 completion
 *     check 看見 child edit（V2 事件形狀，路徑參數為 `path`）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupUltrawork } from "../../../../src/index.ts";
import { commentSignalModule } from "../../../../src/modules/comment-signal/index.ts";
import { CommentSignalStore } from "../../../../src/modules/comment-signal/state.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../../_fake-v2-context.ts";
import {
  createWorkspace,
  setupCommentSignal,
  run,
  type CommentSignalFixture,
} from "./_helpers.ts";

describe("24 - Comment Signal parent/child session aggregation", () => {
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

  test("child 修改與 warning 會向所有 ancestor 聚合，但不污染 sibling", async () => {
    await fx.store.registerSessionParent("child", "parent");
    await fx.store.registerSessionParent("grandchild", "child");
    await fx.store.registerSessionParent("sibling", "parent");

    await fx.store.recordModifiedFile("grandchild", "src/deep.ts");
    await fx.store.recordWarning("grandchild", {
      filePath: "src/deep.ts",
      tag: "SECURITY",
      severity: "P1",
      message: "test warning",
      createdAt: "2026-08-11T00:00:00.000Z",
    });

    expect(await fx.store.getModifiedFiles("grandchild")).toEqual(["src/deep.ts"]);
    expect(await fx.store.getModifiedFiles("child")).toEqual(["src/deep.ts"]);
    expect(await fx.store.getModifiedFiles("parent")).toEqual(["src/deep.ts"]);
    expect(await fx.store.getModifiedFiles("sibling")).toEqual([]);
    expect(await fx.store.getWarnings("parent")).toHaveLength(1);
  });

  test("parent mapping 晚於 child edit 建立時仍回填既有 modifiedFiles", async () => {
    await fx.store.recordModifiedFile("late-child", "src/before-link.ts");
    await fx.store.registerSessionParent("late-child", "late-parent");

    expect(await fx.store.getModifiedFiles("late-parent")).toEqual(["src/before-link.ts"]);
  });

  test("session.created 事件讓 parent completion check 看見 child edit", async () => {
    writeFileSync(
      join(ws.root, "src", "child.ts"),
      "// " + String.fromCharCode(91) + "TODO] missing severity\nexport const value = 1;\n",
      "utf-8",
    );

    const fake = createFakeV2Context({ directory: ws.root });
    fake.events.push({ type: "session.created", data: { sessionID: "child-session", parentID: "parent-session" } });
    const cleanup = await setupUltrawork(fake.ctx, { modules: [commentSignalModule] });
    try {
      const tools: Record<string, any> = Object.fromEntries([...fake.added.entries()]);
      const store = new CommentSignalStore(fake.ctx.storage as never);
      // 等事件迴圈把父子對應寫進 storage
      const start = Date.now();
      while ((await store.getSessionAncestors("child-session")).length === 0) {
        if (Date.now() - start > 2000) throw new Error("等不到父子對應寫入");
        await new Promise((r) => setTimeout(r, 10));
      }

      const after = fake.toolHooks.get("execute.after");
      expect(after).toBeDefined();
      await after!({ tool: "edit", sessionID: "child-session", status: "completed", input: { path: "src/child.ts" } });

      const touched = await run(tools["comment_signal_touched_report"], {}, "parent-session");
      expect(touched.modifiedFiles).toEqual(["src/child.ts"]);

      const report = await run(tools["comment_signal_check"], {}, "parent-session");
      expect(report.shouldBlockCompletion).toBe(true);
      expect(report.violationCount).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  test("session.deleted 清掉該工作階段狀態", async () => {
    await fx.store.recordModifiedFile("doomed", "src/gone.ts");
    expect(await fx.store.getModifiedFiles("doomed")).toEqual(["src/gone.ts"]);
    await fx.store.clearSession("doomed");
    expect(await fx.store.getModifiedFiles("doomed")).toEqual([]);
  });

  test("重新載入後狀態仍在（同一 storage 新建 store 可讀）", async () => {
    await fx.store.recordModifiedFile("s1", "src/kept.ts");
    const reloaded = new CommentSignalStore((fx.fake.ctx.storage as never));
    expect(await reloaded.getModifiedFiles("s1")).toEqual(["src/kept.ts"]);
  });

  test("fakeV2ToolContext 預設工作階段可執行工具", async () => {
    const out = await run(fx.tools["comment_signal_policy"], {}, fakeV2ToolContext().sessionID);
    expect(out.ok).toBe(true);
  });
});

describe("24 - session.deleted 斷開 children 且不復活", () => {
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

  test("刪 parent 後 child 再 edit：parent 狀態不得重建，child 自身保留", async () => {
    await fx.store.registerSessionParent("child", "parent");
    await fx.store.recordModifiedFile("child", "src/before.ts");
    expect(await fx.store.getModifiedFiles("parent")).toEqual(["src/before.ts"]);

    await fx.store.clearSession("parent");

    await fx.store.recordModifiedFile("child", "src/after.ts");
    // parent 不得復活
    expect(await fx.store.getModifiedFiles("parent")).toEqual([]);
    expect(await fx.store.getLastReport("parent")).toBeNull();
    // child 自身狀態保留（含刪除前的紀錄）
    expect(await fx.store.getModifiedFiles("child")).toEqual(["src/before.ts", "src/after.ts"]);
  });

  test("刪 parent 後 late parent 事件不得重新註冊（tombstone）", async () => {
    await fx.store.registerSessionParent("child", "parent");
    await fx.store.clearSession("parent");

    expect(await fx.store.registerSessionParent("child", "parent")).toBe(false);
    expect(await fx.store.registerSessionParent("new-child", "parent")).toBe(false);
    await fx.store.recordModifiedFile("new-child", "src/x.ts");
    expect(await fx.store.getModifiedFiles("parent")).toEqual([]);
  });

  test("session.deleted 事件經模組事件迴圈同樣斷開不斷復活", async () => {
    const fake = createFakeV2Context({ directory: ws.root });
    fake.events.push({ type: "session.created", data: { sessionID: "ec-child", parentID: "ec-parent" } });
    const cleanup = await setupUltrawork(fake.ctx, { modules: [commentSignalModule] });
    try {
      const store = new CommentSignalStore(fake.ctx.storage as never);
      const start = Date.now();
      while ((await store.getSessionAncestors("ec-child")).length === 0) {
        if (Date.now() - start > 2000) throw new Error("等不到父子對應寫入");
        await new Promise((r) => setTimeout(r, 10));
      }
      await store.recordModifiedFile("ec-child", "src/a.ts");
      expect(await store.getModifiedFiles("ec-parent")).toEqual(["src/a.ts"]);

      await store.clearSession("ec-parent");
      await store.recordModifiedFile("ec-child", "src/b.ts");
      expect(await store.getModifiedFiles("ec-parent")).toEqual([]);
      expect(await store.getModifiedFiles("ec-child")).toEqual(["src/a.ts", "src/b.ts"]);
    } finally {
      await cleanup();
    }
  });
});

describe("24 - deleted child 防 late 事件重掛", () => {
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

  test("刪 child 後 late created（活 parent）不得重掛：註冊拒絕、edit no-op、parent 乾淨", async () => {
    await fx.store.registerSessionParent("child", "parent");
    await fx.store.clearSession("child");

    // late session.created 指向活 parent：必須拒絕重掛
    expect(await fx.store.registerSessionParent("child", "parent")).toBe(false);
    expect(await fx.store.getSessionAncestors("child")).toEqual([]);

    // child 再 edit：no-op，不得寫入自身也不得污染 parent
    await fx.store.recordModifiedFile("child", "src/x.ts");
    expect(await fx.store.getModifiedFiles("child")).toEqual([]);
    expect(await fx.store.getModifiedFiles("parent")).toEqual([]);

    await fx.store.recordWarning("child", {
      filePath: "src/x.ts",
      tag: "SECURITY",
      severity: "P1",
      message: "late warning",
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    expect(await fx.store.getWarnings("child")).toEqual([]);
    expect(await fx.store.getWarnings("parent")).toEqual([]);
  });

  test("刪 child 後 late updated 同樣不得重掛", async () => {
    await fx.store.clearSession("gone-child");
    expect(await fx.store.registerSessionParent("gone-child", "live-parent")).toBe(false);
    await fx.store.recordModifiedFile("gone-child", "src/y.ts");
    expect(await fx.store.getModifiedFiles("live-parent")).toEqual([]);
  });
});
