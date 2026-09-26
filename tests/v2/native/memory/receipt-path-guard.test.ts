/**
 * 收據路徑防護測試（Red → Green）：
 * - create 用含路徑穿越的 taskId 必須回結構化錯誤，且不得覆寫專案內既有檔案。
 * - read 用含 `..`、`/` 或絕對路徑的 receiptId 必須回結構化錯誤，不得讀到 receipts/ 外的檔案。
 * - 合法 id（含 `.`、`_`、`-`）仍可正常建立與讀取。
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupUltrawork } from "../../../../src/index.ts";
import { memoryModule } from "../../../../src/modules/memory/index.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../../_fake-v2-context.ts";

function createWorkspace(): { root: string; receiptsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "uw-receipt-guard-"));
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

async function setupReceipts(sessionDirectory: string): Promise<{
  create: any;
  read: any;
  list: any;
  cleanup: () => Promise<void>;
}> {
  const fake = createFakeV2Context({ directory: sessionDirectory, sessionDirectory });
  const cleanup = await setupUltrawork(fake.ctx, { modules: [memoryModule] });
  const create = fake.added.get("memory-receipt-create");
  const read = fake.added.get("memory-receipt-read");
  const list = fake.added.get("memory-receipt-list");
  if (!create || !read || !list) throw new Error("receipt 工具沒有註冊");
  return { create, read, list, cleanup };
}

function run(tool: any, args: Record<string, unknown>): Promise<any> {
  return tool.execute(args, fakeV2ToolContext()).then(parse);
}

describe("receipt 路徑防護", () => {
  test("create 拒絕含路徑穿越的 taskId，且專案內既有檔案不被覆寫", async () => {
    const ws = createWorkspace();
    const tools = await setupReceipts(ws.root);
    try {
      const sentinelPath = join(ws.root, "package.json");
      writeFileSync(sentinelPath, JSON.stringify({ name: "sentinel" }));

      const result = await run(tools.create, {
        taskId: "x/../../../package",
        zeroExtractionReason: "path traversal probe",
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe("INVALID_RECEIPT_ID");
      expect(readFileSync(sentinelPath, "utf-8")).toBe(JSON.stringify({ name: "sentinel" }));
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("read 拒絕含 ..、/ 或絕對路徑的 receiptId，不讀 receipts/ 外的檔案", async () => {
    const ws = createWorkspace();
    const tools = await setupReceipts(ws.root);
    try {
      const lootPath = join(ws.root, "loot.json");
      writeFileSync(lootPath, JSON.stringify({ secret: "must-not-leak" }));

      for (const receiptId of [
        "receipt-x/../../../loot",
        "receipt-../loot",
        "../loot",
        "/etc/hostname",
        "..\\loot",
      ]) {
        const result = await run(tools.read, { receiptId });
        expect(result.ok).toBe(false);
        expect(result.code).toBe("INVALID_RECEIPT_ID");
        expect(JSON.stringify(result)).not.toContain("must-not-leak");
      }

      const viaTask = await run(tools.read, { taskId: "x/../../../loot" });
      expect(viaTask.ok).toBe(false);
      expect(viaTask.code).toBe("INVALID_RECEIPT_ID");
      expect(JSON.stringify(viaTask)).not.toContain("must-not-leak");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("合法 id（含 .、_、-) 仍可正常建立與讀取", async () => {
    const ws = createWorkspace();
    const tools = await setupReceipts(ws.root);
    try {
      const created = await run(tools.create, {
        taskId: "t_fix.v2-ok",
        zeroExtractionReason: "legal id probe",
      });
      expect(created.ok).toBe(true);
      expect(created.receiptId).toBe("receipt-t_fix.v2-ok");

      const readBack = await run(tools.read, { receiptId: "receipt-t_fix.v2-ok" });
      expect(readBack.ok).toBe(true);
      expect((readBack.receipt as Record<string, unknown>).taskId).toBe("t_fix.v2-ok");

      const listed = await run(tools.list, {});
      expect(listed.ok).toBe(true);
      expect(listed.receiptIds).toContain("receipt-t_fix.v2-ok");
      expect(existsSync(join(ws.root, "package.json"))).toBe(false);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });
});
