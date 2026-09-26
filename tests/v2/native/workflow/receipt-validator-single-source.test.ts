import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeContext } from "../../../../src/modules/workflow/runtime/context-builder.ts";
import {
  createEmptyTasksRegistryLeaf,
  normalizeTasksRegistryLeaf,
} from "../../../../src/modules/workflow/registry/task-registry.ts";
import { deriveProjectId } from "../../../../src/modules/workflow/core/helpers.ts";
import type { Task } from "../../../../src/modules/workflow/core/types.ts";
import { validateReceiptForCompletion } from "../../../../src/modules/memory/index.ts";

/**
 * 收據 validator 合併後的行為覆蓋證明。
 *
 * `createRuntimeContext` Layer 4 的 `validateMemoryReceiptForTask` 與 memory 的
 * `validateReceiptForCompletion` 必須在同一組輸入下給出相同的結論（ok 與否、
 * 錯誤碼、錯誤訊息）：收斂前兩份實作的規則逐字一致，收斂後呼叫端共用同一份。
 * 這個矩陣同時覆蓋舊 closure 曾處理的行為（白名單／必填／綁定一致性），
 * 不是只讓原有測試變綠。
 */

function createWorkspace(): { root: string; receiptsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "uw-receipt-single-source-"));
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

function writeReceipt(receiptsDir: string, id: string, payload: Record<string, unknown>): void {
  writeFileSync(join(receiptsDir, `${id}.json`), JSON.stringify(payload, null, 2), "utf-8");
}

function makeTask(taskId: string, projectId: string, projectPath: string): Task {
  return {
    taskId,
    projectId,
    projectPath,
    state: "IN_PROGRESS",
    owner: "momus",
    priority: "P1",
    updatedAt: new Date().toISOString(),
    history: [],
  };
}

describe("收據 validator 單一來源：runtime 委派與 memory 純函式一致", () => {
  test("合法／非法收據兩邊結論相同（含錯誤碼與訊息）", () => {
    const ws = createWorkspace();
    try {
      const projectId = deriveProjectId(ws.root);
      const binding = { projectId, projectPath: ws.root };
      const runtime = createRuntimeContext({
        input: { directory: ws.root },
        options: { projectRoot: ws.root },
        createEmptyTasksRegistry: (project) =>
          createEmptyTasksRegistryLeaf(project ?? runtime.getCurrentProject()),
        normalizeTasksRegistry: (raw, project) =>
          normalizeTasksRegistryLeaf(raw, project ?? runtime.getCurrentProject()),
      });

      const cases: Array<{
        id: string;
        payload: Record<string, unknown> | null;
        taskId: string;
      }> = [
        {
          id: "receipt-ok",
          payload: {
            memoryReceiptId: "receipt-ok",
            taskId: "t-1",
            projectId,
            projectPath: ws.root,
            status: "COMPLETED",
            createdAt: new Date().toISOString(),
            extractions: [{ note: "evidence" }],
          },
          taskId: "t-1",
        },
        {
          id: "receipt-zero-reason",
          payload: {
            memoryReceiptId: "receipt-zero-reason",
            taskId: "t-1",
            projectId,
            projectPath: ws.root,
            status: "ok",
            createdAt: new Date().toISOString(),
            zeroExtractionReason: "no durable memory needed",
          },
          taskId: "t-1",
        },
        {
          id: "bad-status",
          payload: {
            memoryReceiptId: "bad-status",
            taskId: "t-1",
            projectId,
            projectPath: ws.root,
            status: "in_progress",
            createdAt: new Date().toISOString(),
            zeroExtractionReason: "reason present but status invalid",
          },
          taskId: "t-1",
        },
        {
          id: "wrong-task",
          payload: {
            memoryReceiptId: "wrong-task",
            taskId: "t-other",
            projectId,
            projectPath: ws.root,
            status: "ok",
            createdAt: new Date().toISOString(),
            zeroExtractionReason: "x",
          },
          taskId: "t-1",
        },
        {
          id: "wrong-project",
          payload: {
            memoryReceiptId: "wrong-project",
            taskId: "t-1",
            projectId: "foreign-project",
            projectPath: ws.root,
            status: "ok",
            createdAt: new Date().toISOString(),
            zeroExtractionReason: "x",
          },
          taskId: "t-1",
        },
        { id: "missing-file", payload: null, taskId: "t-1" },
      ];

      for (const { id, payload, taskId } of cases) {
        if (payload !== null) writeReceipt(ws.receiptsDir, id, payload);
        const task = makeTask(taskId, projectId, ws.root);
        const viaRuntime = runtime.validateMemoryReceiptForTask(id, task, binding);
        const viaMemory = validateReceiptForCompletion(ws.root, id, { taskId }, binding);
        expect(viaRuntime.ok, `${id}: runtime ok`).toBe(viaMemory.ok);
        if (!viaRuntime.ok && !viaMemory.ok) {
          expect(viaRuntime.code, `${id}: code`).toBe(viaMemory.code);
          expect(viaRuntime.error, `${id}: error`).toBe(viaMemory.error);
        }
        if (viaRuntime.ok && viaMemory.ok) {
          expect(viaRuntime.receipt.taskId, `${id}: receipt`).toBe(taskId === "t-1" && id !== "wrong-task" ? taskId : viaMemory.receipt.taskId);
        }
      }
    } finally {
      ws.cleanup();
    }
  });
});
