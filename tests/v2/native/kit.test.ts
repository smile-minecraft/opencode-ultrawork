/** kit：原子寫入、路徑防護、jsonResult 外框、行號輸出、defineTool。 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { atomicWriteFileWithOps } from "../../../src/kit/atomic-write.ts";
import { defineTool } from "../../../src/kit/define-tool.ts";
import { jsonError, jsonResult } from "../../../src/kit/json.ts";
import { formatNumberedLines } from "../../../src/kit/lines.ts";
import {
  AssertPathOutsideWorktree,
  assertSafeWorktreePath,
  isInsideWorktree,
  resolveInsideWorktree,
} from "../../../src/kit/path-guard.ts";
import {
  ContentLockBusyError,
  contentLockBusyGuidance,
  diagnoseContentWriteLock,
  withContentWriteLock,
} from "../../../src/kit/write-lock.ts";
import { fakeV2ToolContext } from "../_fake-v2-context.ts";

describe("jsonResult 外框（對齊舊版 search-tool-utils）", () => {
  test("成功：ok／summary／data", () => {
    const parsed = JSON.parse(jsonResult({ ok: true, count: 2 }, "找到 2 筆。"));
    expect(parsed.ok).toBe(true);
    expect(parsed.summary).toBe("找到 2 筆。");
    expect(parsed.data).toEqual({ count: 2 });
    expect(parsed.code).toBeUndefined();
  });

  test("缺 ok 的物件視為失敗，code 走 TOOL_ERROR", () => {
    const parsed = JSON.parse(jsonResult({ count: 2 }, "找到 2 筆。"));
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("TOOL_ERROR");
  });

  test("成功摘要來源：humanSummary 優先於預設句", () => {
    const parsed = JSON.parse(jsonResult({ ok: true, humanSummary: "人類可讀的摘要。" }));
    expect(parsed.ok).toBe(true);
    expect(parsed.summary).toBe("人類可讀的摘要。");
  });

  test("英文 error 走 inferErrorCode（not found → NOT_FOUND）", () => {
    const parsed = JSON.parse(jsonResult({ ok: false, error: "Target not found: x" }));
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("NOT_FOUND");
    expect(parsed.summary).toContain("找不到指定位置");
  });

  test("TERMINAL_STATE_CONFLICT 的預設 nextAction", () => {
    const parsed = JSON.parse(jsonResult({ ok: false, code: "TERMINAL_STATE_CONFLICT", error: "卡住了" }));
    expect(parsed.nextAction).toBe("請先讀取目前狀態，再使用符合狀態的操作。");
  });

  test("{summary, data} 外框原樣回傳", () => {
    const framed = { summary: "原本的摘要。", data: { a: 1 } };
    expect(jsonResult(framed)).toBe(JSON.stringify(framed));
  });

  test("純量成功", () => {
    const parsed = JSON.parse(jsonResult(42, "完成。"));
    expect(parsed.ok).toBe(true);
    expect(parsed.summary).toBe("完成。");
    expect(parsed.data).toBe(42);
  });

  test("number nextAction 不輸出", () => {
    const parsed = JSON.parse(jsonResult({ ok: true, humanSummary: "好。" }, null, 2));
    expect(parsed.ok).toBe(true);
    expect(parsed.summary).toBe("好。");
    expect("nextAction" in parsed).toBe(false);
  });

  test("失敗：加 code 與 nextAction", () => {
    const parsed = JSON.parse(jsonError("FILE_NOT_FOUND", "找不到檔案：x"));
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("FILE_NOT_FOUND");
    expect(typeof parsed.nextAction).toBe("string");
    expect(parsed.summary).toContain("找不到檔案");
  });
});

describe("路徑防護", () => {
  test("worktree 內外判斷", () => {
    expect(isInsideWorktree("/work/proj/a/b.txt", "/work/proj")).toBe(true);
    expect(isInsideWorktree("/work/proj", "/work/proj")).toBe(true);
    expect(isInsideWorktree("/work/other/x.txt", "/work/proj")).toBe(false);
    expect(isInsideWorktree("/work/proj-evil/x.txt", "/work/proj")).toBe(false);
  });

  test("../ 逃逸被擋下", () => {
    expect(() => resolveInsideWorktree("../evil.txt", "/work/proj")).toThrow(AssertPathOutsideWorktree);
    expect(() => assertSafeWorktreePath("/etc/passwd", "/work/proj")).toThrow(AssertPathOutsideWorktree);
  });

  test("預設訊息沿用舊版英文句", () => {
    let message = "";
    try {
      assertSafeWorktreePath("/etc/passwd", "/work/proj");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Path traversal attempt detected");
    expect(message).toContain("outside worktree");
  });
});

describe("原子寫入", () => {
  test("獨佔建立：temp 已存在時不覆蓋", () => {
    const written: string[] = [];
    const ops = {
      writeFileSync: ((path: string) => {
        written.push(path);
        const error = new Error("exists") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }) as any,
      renameSync: (() => {}) as any,
      existsSync: (() => false) as any,
      unlinkSync: (() => {}) as any,
    };
    expect(() => atomicWriteFileWithOps("/work/proj/a.txt", "hi", ops)).toThrow();
    expect(written[0]).not.toBe("/work/proj/a.txt");
  });

  test("rename 失敗時清掉 temp 並原樣拋錯", () => {
    let tempPath = "";
    let unlinked = "";
    const ops = {
      writeFileSync: ((path: string) => {
        tempPath = path;
      }) as any,
      renameSync: (() => {
        throw new Error("rename boom");
      }) as any,
      existsSync: ((path: string) => path === tempPath) as any,
      unlinkSync: ((path: string) => {
        unlinked = path;
      }) as any,
    };
    expect(() => atomicWriteFileWithOps("/work/proj/a.txt", "hi", ops)).toThrow("rename boom");
    expect(unlinked).toBe(tempPath);
  });

  test("併發兩次寫入的 temp 路徑不互踩", () => {
    const temps = new Set<string>();
    const ops = {
      writeFileSync: ((path: string) => {
        temps.add(path);
      }) as any,
      renameSync: (() => {}) as any,
      existsSync: (() => false) as any,
      unlinkSync: (() => {}) as any,
    };
    atomicWriteFileWithOps("/work/proj/a.txt", "one", ops);
    atomicWriteFileWithOps("/work/proj/a.txt", "two", ops);
    expect(temps.size).toBe(2);
  });
});

describe("寫入鎖", () => {
  test("鎖被佔用時第二把拿不到（CONTENT_LOCK_BUSY），放掉後可以再拿", async () => {
    const dir = `/tmp/uw-kit-lock-${process.pid}-${Date.now()}`;
    const { mkdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, "write.lock");
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = withContentWriteLock(lockPath, () => gate);
      let code = "";
      try {
        await withContentWriteLock(lockPath, async () => {});
      } catch (error) {
        code = (error as { code?: string }).code ?? "";
      }
      expect(code).toBe("CONTENT_LOCK_BUSY");
      release();
      await first;
      const held = await withContentWriteLock(lockPath, async () => "ok");
      expect(held).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("busy 訊息指引 unlockStale；孤兒鎖診斷正確", async () => {
    const dir = `/tmp/uw-kit-lockmsg-${process.pid}-${Date.now()}`;
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, "write.lock");
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = withContentWriteLock(lockPath, () => gate);
      let message = "";
      try {
        await withContentWriteLock(lockPath, async () => {});
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("unlockStale");
      release();
      await first;

      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 987654321, createdAt: new Date(Date.now() - 600_000).toISOString(), token: "old" }),
      );
      const diagnosis = diagnoseContentWriteLock(lockPath);
      expect(diagnosis.present).toBe(true);
      expect(diagnosis.looksStale).toBe(true);
      expect(diagnosis.hint).toContain("手動執行：rm");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("行號輸出", () => {
  test("行號加原文，一行一列", () => {
    expect(formatNumberedLines([{ line: 3, text: "hi" }])).toBe("3: hi");
  });
});

describe("defineTool", () => {
  test("zod schema 轉成 JSON Schema，execute 內 safeParse，codemode 固定 false", async () => {
    const tool = defineTool({
      name: "demo-tool",
      description: "示範工具",
      inputSchema: z.object({ path: z.string() }),
      execute: async (input) => ({ content: JSON.stringify({ path: input.path }) }),
    });
    expect(tool.options).toEqual({ codemode: false });
    expect(tool.input.type).toBe("object");
    const ok = await tool.execute({ path: "a.txt" }, fakeV2ToolContext() as any);
    expect(JSON.parse((ok as any).content).path).toBe("a.txt");
    const bad = await tool.execute({ path: 42 }, fakeV2ToolContext() as any);
    expect(JSON.parse((bad as any).content).ok).toBe(false);
  });
});

describe("ContentLockBusyError 訊息收斂（單一措辭）", () => {
  test("ageSeconds 為 null 時不出現 null 字樣，只講可信的年齡", () => {
    const err = new ContentLockBusyError({
      heldByPid: 12345,
      since: "2026-01-01T00:00:00.000Z",
      ageSeconds: null,
    });
    expect(err.message).not.toContain("null");
    expect(err.message).toContain("unlockStale");
  });

  test("持有者資訊全缺時不出現 null 字樣，仍保留 unlockStale 指引", () => {
    const err = new ContentLockBusyError({ heldByPid: null, since: null, ageSeconds: null });
    expect(err.message).not.toContain("null");
    expect(err.message).toContain("unlockStale");
  });

  test("defineTool 外框的 nextAction 引用同一份指引（含門檻與 unlockStale）", async () => {
    const tool = defineTool({
      name: "busy-probe",
      description: "鎖忙碌外框探針",
      inputSchema: z.object({}),
      execute: async () => {
        throw new ContentLockBusyError({ heldByPid: 999, since: null, ageSeconds: 5 });
      },
    });
    const out = await tool.execute({}, fakeV2ToolContext() as any);
    const parsed = JSON.parse(out.content);
    expect(parsed.code).toBe("CONTENT_LOCK_BUSY");
    expect(parsed.nextAction).toBe(contentLockBusyGuidance());
    expect(parsed.nextAction).toContain("unlockStale");
  });
});
