/**
 * memory-receipt 自動修剪測試。
 *
 * 由 tests/ultrawork/16-receipt-auto-trim.test.ts 移植：保留上限
 * RECEIPT_RETENTION_LIMIT=50，超過時直接刪除最舊，不歸檔。
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupUltrawork } from "../../../../src/index.ts";
import { memoryModule } from "../../../../src/modules/memory/index.ts";
import { RECEIPT_RETENTION_LIMIT } from "../../../../src/modules/memory/constants.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../../_fake-v2-context.ts";

function createWorkspace(): { root: string; receiptsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "uw-receipt-trim-"));
  const receiptsDir = join(root, ".ultrawork", "receipts");
  mkdirSync(receiptsDir, { recursive: true });
  return {
    root,
    receiptsDir,
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // 清理失敗不擋測試結果
      }
    },
  };
}

function parse(result: { content: string }): any {
  const parsed = JSON.parse(result.content) as Record<string, unknown>;
  if (parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
    for (const [key, value] of Object.entries(parsed.data)) {
      if (!(key in parsed)) {
        Object.defineProperty(parsed, key, { configurable: true, enumerable: false, value });
      }
    }
  }
  return parsed;
}

async function setupReceipts(sessionDirectory: string): Promise<{ create: any; list: any; cleanup: () => Promise<void> }> {
  const fake = createFakeV2Context({ directory: sessionDirectory, sessionDirectory });
  const cleanup = await setupUltrawork(fake.ctx, { modules: [memoryModule] });
  const create = fake.added.get("memory-receipt-create");
  const list = fake.added.get("memory-receipt-list");
  if (!create || !list) throw new Error("receipt 工具沒有註冊");
  return { create, list, cleanup };
}

function run(tool: any, args: Record<string, unknown>): Promise<any> {
  return tool.execute(args, fakeV2ToolContext()).then(parse);
}

describe("memory-receipt 自動修剪", () => {
  test("RECEIPT_RETENTION_LIMIT = 50", () => {
    expect(RECEIPT_RETENTION_LIMIT).toBe(50);
  });

  test("未超限時不刪除任何檔案", async () => {
    const ws = createWorkspace();
    const tools = await setupReceipts(ws.root);
    try {
      for (let i = 0; i < 5; i++) {
        await run(tools.create, { taskId: `noop-${i}`, status: "ok", zeroExtractionReason: "noop" });
      }
      const files = readdirSync(ws.receiptsDir).filter((n) => n.endsWith(".json"));
      expect(files.length).toBe(5);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("建立 51 筆後 receipts/ 仍有 50 筆、最舊 1 筆已刪除", async () => {
    const ws = createWorkspace();
    const tools = await setupReceipts(ws.root);
    try {
      for (let i = 0; i < 51; i++) {
        const result = await run(tools.create, {
          taskId: `trim-${String(i).padStart(3, "0")}`,
          status: "ok",
          zeroExtractionReason: "trim test",
        });
        const filePath = join(ws.receiptsDir, `${result.receiptId}.json`);
        // mtime 用未來時間 + i*1000ms，確保單調遞增且差距穩定，
        // 避免 macOS 連續寫入 mtime 差距過小造成 trim 目標不確定。
        const baseTime = (Date.now() + i * 1000) / 1000;
        utimesSync(filePath, baseTime, baseTime);
      }
      const files = readdirSync(ws.receiptsDir).filter((n) => n.endsWith(".json"));
      expect(files.length).toBe(50);
      expect(existsSync(join(ws.receiptsDir, "receipt-trim-000.json"))).toBe(false);
      expect(existsSync(join(ws.receiptsDir, "receipt-trim-050.json"))).toBe(true);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("create 回傳含 autoTrim 區塊，顯示被刪除清單", async () => {
    const ws = createWorkspace();
    const tools = await setupReceipts(ws.root);
    try {
      for (let i = 0; i < 50; i++) {
        await run(tools.create, {
          taskId: `prefill-${String(i).padStart(3, "0")}`,
          status: "ok",
          zeroExtractionReason: "prefill",
        });
        const filePath = join(ws.receiptsDir, `receipt-prefill-${String(i).padStart(3, "0")}.json`);
        const baseTime = (Date.now() + i * 1000) / 1000;
        utimesSync(filePath, baseTime, baseTime);
      }
      const result = await run(tools.create, {
        taskId: "trigger",
        status: "ok",
        zeroExtractionReason: "trigger",
      });
      expect(result.autoTrim).toBeDefined();
      expect(result.autoTrim.retentionLimit).toBe(50);
      expect(result.autoTrim.removedCount).toBe(1);
      expect(result.autoTrim.remaining).toBe(50);
      expect(result.autoTrim.removed).toContain("receipt-prefill-000");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("memory-receipt-list 不會列出已刪除的收據", async () => {
    const ws = createWorkspace();
    const tools = await setupReceipts(ws.root);
    try {
      for (let i = 0; i < 51; i++) {
        const taskId = `listcheck-${String(i).padStart(3, "0")}`;
        await run(tools.create, { taskId, status: "ok", zeroExtractionReason: "list test" });
        const filePath = join(ws.receiptsDir, `receipt-${taskId}.json`);
        const baseTime = (Date.now() + i * 1000) / 1000;
        utimesSync(filePath, baseTime, baseTime);
      }
      const listResult = await run(tools.list, {});
      expect(listResult.count).toBe(50);
      expect(listResult.receiptIds).not.toContain("receipt-listcheck-000");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });
});
