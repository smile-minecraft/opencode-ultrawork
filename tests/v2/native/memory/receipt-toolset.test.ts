/**
 * memory-receipt 工具組測試。
 *
 * 由 tests/ultrawork/09-receipt-toolset.test.ts 移植，改用
 * setupUltrawork(fake.ctx, { modules: [memoryModule] }) 註冊，
 * 再從 fake.added 取工具執行；workspace 在 os.tmpdir() 下建立，
 * 收據落在 <root>/.ultrawork/receipts/。
 *
 * 原第 4 個測試依賴 task-state-sync complete 閘門（workflow 任務範圍），
 * 這裡改用同一個 validator（validateReceiptForCompletion）直接驗證
 * create 產出的收據能通過專案記憶更新階段檢查，意圖不變。
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupUltrawork } from "../../../../src/index.ts";
import { memoryModule, validateReceiptForCompletion } from "../../../../src/modules/memory/index.ts";
import { deriveProjectId } from "../../../../src/modules/memory/helpers.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../../_fake-v2-context.ts";

function createWorkspace(): {
  root: string;
  memoryDir: string;
  receiptsDir: string;
  projectMd: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "uw-receipt-toolset-"));
  const memoryDir = join(root, ".ultrawork");
  const receiptsDir = join(memoryDir, "receipts");
  mkdirSync(receiptsDir, { recursive: true });
  return {
    root,
    memoryDir,
    receiptsDir,
    projectMd: join(memoryDir, "project.md"),
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // 清理失敗不擋測試結果
      }
    },
  };
}

/** 把工具執行結果（{ content } JSON 外框）攤平成舊測試的斷言形狀。 */
function parse(result: { content: string }): any {
  const parsed = JSON.parse(result.content) as Record<string, unknown>;
  if (parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
    for (const [key, value] of Object.entries(parsed.data)) {
      if (!(key in parsed)) {
        Object.defineProperty(parsed, key, { configurable: true, enumerable: false, value });
      }
    }
    if (parsed.ok === false && typeof parsed.summary === "string" && !("error" in parsed)) {
      Object.defineProperty(parsed, "error", { configurable: true, enumerable: false, value: parsed.summary });
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

describe("memory-receipt 工具組", () => {
  test("create + read roundtrip 內容一致", async () => {
    const ws = createWorkspace();
    const tools = await setupReceipts(ws.root);
    try {
      const projectId = deriveProjectId(ws.root);

      const createResult = await run(tools.create, {
        taskId: "t-roundtrip",
        status: "completed",
        zeroExtractionReason: "roundtrip smoke test",
        extractions: [{ note: "roundtrip test extraction" }],
      });
      expect(createResult.ok).toBe(true);
      expect(createResult.receiptId).toBe("receipt-t-roundtrip");
      expect(createResult.taskId).toBe("t-roundtrip");
      expect(createResult.projectId).toBe(projectId);
      expect(createResult.projectPath).toBe(ws.root);
      expect(createResult.status).toBe("completed");
      expect(typeof createResult.createdAt).toBe("string");
      expect(Number.isNaN(Date.parse(createResult.createdAt))).toBe(false);

      // 用 taskId 讀回（驗證 normalizeReceiptId 自動補 prefix）
      const readByTask = await run(tools.read, { taskId: "t-roundtrip" });
      expect(readByTask.ok).toBe(true);
      expect(readByTask.receiptId).toBe("receipt-t-roundtrip");
      const receipt = readByTask.receipt as Record<string, unknown>;
      expect(receipt).not.toBeNull();
      expect(receipt.taskId).toBe("t-roundtrip");
      expect(receipt.projectId).toBe(projectId);
      expect(receipt.projectPath).toBe(ws.root);
      expect(receipt.status).toBe("completed");
      expect(receipt.zeroExtractionReason).toBe("roundtrip smoke test");
      expect(Array.isArray(receipt.extractions)).toBe(true);
      expect((receipt.extractions as unknown[]).length).toBe(1);
      expect((receipt.extractions as Array<{ note: string }>)[0].note).toBe("roundtrip test extraction");

      // 用完整 receiptId 讀回（prefix 已存在時原樣回傳）
      const readByReceiptId = await run(tools.read, { receiptId: "receipt-t-roundtrip" });
      expect(readByReceiptId.ok).toBe(true);
      expect(readByReceiptId.receiptId).toBe("receipt-t-roundtrip");
      expect(readByReceiptId.receipt).not.toBeNull();
      expect(readByReceiptId.receipt.taskId).toBe("t-roundtrip");

      // 檔案實際落在 .ultrawork/receipts/
      const onDisk = JSON.parse(
        await Bun.file(join(ws.receiptsDir, "receipt-t-roundtrip.json")).text(),
      );
      expect(onDisk.memoryReceiptId).toBe("receipt-t-roundtrip");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("list 依 mtime 降冪排序（最新在前），含 mtimeMs／size", async () => {
    const ws = createWorkspace();
    const tools = await setupReceipts(ws.root);
    try {
      for (const t of ["t-list-a", "t-list-b", "t-list-c"]) {
        await run(tools.create, { taskId: t, zeroExtractionReason: `list test ${t}` });
      }

      // 強制設定 mtime 順序：t-list-a 最早、t-list-c 最新
      const baseTime = (Date.now() - 10 * 60 * 1000) / 1000;
      utimesSync(join(ws.receiptsDir, "receipt-t-list-a.json"), baseTime, baseTime);
      utimesSync(join(ws.receiptsDir, "receipt-t-list-b.json"), baseTime + 60, baseTime + 60);
      utimesSync(join(ws.receiptsDir, "receipt-t-list-c.json"), baseTime + 120, baseTime + 120);

      const listed = await run(tools.list, {});
      expect(listed.ok).toBe(true);
      expect(listed.count).toBe(3);
      expect(listed.receiptsDir).toBe(ws.receiptsDir);

      expect(listed.receiptIds).toEqual([
        "receipt-t-list-c",
        "receipt-t-list-b",
        "receipt-t-list-a",
      ]);

      const entries = listed.receipts as Array<{
        receiptId: string;
        path: string;
        mtimeMs: number;
        size: number;
      }>;
      expect(entries).toHaveLength(3);
      for (const entry of entries) {
        expect(typeof entry.receiptId).toBe("string");
        expect(entry.path.startsWith(ws.receiptsDir)).toBe(true);
        expect(typeof entry.mtimeMs).toBe("number");
        expect(entry.mtimeMs).toBeGreaterThan(0);
        expect(typeof entry.size).toBe("number");
        expect(entry.size).toBeGreaterThan(0);
      }
      expect(entries[0].mtimeMs).toBeGreaterThan(entries[1].mtimeMs);
      expect(entries[1].mtimeMs).toBeGreaterThan(entries[2].mtimeMs);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("read 對不存在的 receiptId／taskId 回 receipt: null", async () => {
    const ws = createWorkspace();
    const tools = await setupReceipts(ws.root);
    try {
      const missingByTask = await run(tools.read, { taskId: "t-does-not-exist" });
      expect(missingByTask.ok).toBe(true);
      expect(missingByTask.receiptId).toBe("receipt-t-does-not-exist");
      expect(missingByTask.receipt).toBeNull();

      const missingByReceiptId = await run(tools.read, { receiptId: "receipt-t-does-not-exist" });
      expect(missingByReceiptId.ok).toBe(true);
      expect(missingByReceiptId.receipt).toBeNull();

      const empty = await run(tools.read, {});
      expect(empty.ok).toBe(false);
      expect(empty.error).toContain("至少需要一個");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("create 產出的收據能通過專案記憶更新階段 validator", async () => {
    const ws = createWorkspace();
    const tools = await setupReceipts(ws.root);
    try {
      const createResult = await run(tools.create, {
        taskId: "t-g5-roundtrip",
        status: "completed",
        zeroExtractionReason: "no durable memory needed",
      });
      expect(createResult.ok).toBe(true);
      const receiptId = createResult.receiptId as string;

      const projectId = deriveProjectId(ws.root);
      const validated = validateReceiptForCompletion(
        ws.root,
        receiptId,
        { taskId: "t-g5-roundtrip" },
        { projectId, projectPath: ws.root },
      );
      expect(validated.ok).toBe(true);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("list 對 invalid JSON 容錯仍列出 receiptId", async () => {
    const ws = createWorkspace();
    const tools = await setupReceipts(ws.root);
    try {
      await run(tools.create, { taskId: "t-valid", zeroExtractionReason: "ok" });
      await Bun.write(join(ws.receiptsDir, "receipt-broken.json"), "{not json");

      const listed = await run(tools.list, {});
      expect(listed.ok).toBe(true);
      expect(listed.count).toBe(2);
      expect(listed.receiptIds).toContain("receipt-t-valid");
      expect(listed.receiptIds).toContain("receipt-broken");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });
});
