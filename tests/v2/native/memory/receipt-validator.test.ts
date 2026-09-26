/**
 * validateReceiptForCompletion 單元測試（純函式，不經工具註冊）。
 *
 * 由 tests/ultrawork/02-g5-receipt.test.ts 的 validator 白名單／必填案例移植：
 * status 白名單（C1.1）、createdAt（C1.2）、extraction 證據（C1.3）、
 * taskId／專案綁定（C1.4），外加 id 含斜線、檔案缺席、壞 JSON。
 * 其 complete 閘門整合案例（MEMORY_RECEIPT_REQUIRED 等）留給 workflow 任務。
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateReceiptForCompletion,
  getReceiptsDir,
} from "../../../../src/modules/memory/index.ts";
import { deriveProjectId } from "../../../../src/modules/memory/helpers.ts";

function createWorkspace(): {
  root: string;
  receiptsDir: string;
  projectId: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "uw-receipt-validator-"));
  const receiptsDir = join(root, ".ultrawork", "receipts");
  mkdirSync(receiptsDir, { recursive: true });
  return {
    root,
    receiptsDir,
    projectId: deriveProjectId(root),
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

function validReceipt(projectId: string, root: string, taskId: string): Record<string, unknown> {
  return {
    memoryReceiptId: "receipt-ok",
    taskId,
    projectId,
    projectPath: root,
    status: "completed",
    createdAt: new Date().toISOString(),
    zeroExtractionReason: "no durable memory needed",
  };
}

describe("validateReceiptForCompletion", () => {
  test("合法收據通過（status 白名單大小寫皆可）", () => {
    const ws = createWorkspace();
    try {
      for (const status of ["ok", "completed", "success", "OK", "Completed", "SUCCESS"]) {
        const id = `receipt-status-${status.toLowerCase()}`;
        writeReceipt(ws.receiptsDir, id, {
          ...validReceipt(ws.projectId, ws.root, "t-g5"),
          memoryReceiptId: id,
          status,
        });
        const result = validateReceiptForCompletion(
          ws.root,
          id,
          { taskId: "t-g5" },
          { projectId: ws.projectId, projectPath: ws.root },
        );
        expect(result.ok, status).toBe(true);
        if (result.ok) expect(result.receipt.taskId).toBe("t-g5");
      }
    } finally {
      ws.cleanup();
    }
  });

  test("status 不在白名單時拒絕（C1.1）", () => {
    const ws = createWorkspace();
    try {
      writeReceipt(ws.receiptsDir, "bad-status", {
        ...validReceipt(ws.projectId, ws.root, "t-status"),
        memoryReceiptId: "bad-status",
        status: "in_progress",
      });
      const result = validateReceiptForCompletion(
        ws.root,
        "bad-status",
        { taskId: "t-status" },
        { projectId: ws.projectId, projectPath: ws.root },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("INVALID_MEMORY_RECEIPT");
        expect(result.error).toContain("缺少必要欄位");
      }
    } finally {
      ws.cleanup();
    }
  });

  test("createdAt 缺漏或非法時拒絕（C1.2）", () => {
    const ws = createWorkspace();
    try {
      const base = validReceipt(ws.projectId, ws.root, "t-createdAt");
      const missing = { ...base, memoryReceiptId: "missing-createdAt" };
      delete (missing as Record<string, unknown>).createdAt;
      writeReceipt(ws.receiptsDir, "missing-createdAt", missing);
      writeReceipt(ws.receiptsDir, "malformed-createdAt", {
        ...base,
        memoryReceiptId: "malformed-createdAt",
        createdAt: "not-a-date",
      });
      for (const id of ["missing-createdAt", "malformed-createdAt"]) {
        const result = validateReceiptForCompletion(
          ws.root,
          id,
          { taskId: "t-createdAt" },
          { projectId: ws.projectId, projectPath: ws.root },
        );
        expect(result.ok, id).toBe(false);
        if (!result.ok) expect(result.code).toBe("INVALID_MEMORY_RECEIPT");
      }
    } finally {
      ws.cleanup();
    }
  });

  test("沒有 extraction 證據且 zeroExtractionReason 為空時拒絕（C1.3）", () => {
    const ws = createWorkspace();
    try {
      writeReceipt(ws.receiptsDir, "no-evidence", {
        memoryReceiptId: "no-evidence",
        taskId: "t-evidence",
        projectId: ws.projectId,
        projectPath: ws.root,
        status: "completed",
        createdAt: new Date().toISOString(),
      });
      writeReceipt(ws.receiptsDir, "blank-reason", {
        memoryReceiptId: "blank-reason",
        taskId: "t-evidence",
        projectId: ws.projectId,
        projectPath: ws.root,
        status: "completed",
        createdAt: new Date().toISOString(),
        zeroExtractionReason: "   ",
      });
      for (const id of ["no-evidence", "blank-reason"]) {
        const result = validateReceiptForCompletion(
          ws.root,
          id,
          { taskId: "t-evidence" },
          { projectId: ws.projectId, projectPath: ws.root },
        );
        expect(result.ok, id).toBe(false);
        if (!result.ok) expect(result.code).toBe("INVALID_MEMORY_RECEIPT");
      }
    } finally {
      ws.cleanup();
    }
  });

  test("extraction 陣列任一非空即算有證據", () => {
    const ws = createWorkspace();
    try {
      const fields = ["extractionResults", "extractions", "createdCards", "updatedCards"] as const;
      fields.forEach((field, index) => {
        const id = `receipt-evidence-${index}`;
        const payload = {
          ...validReceipt(ws.projectId, ws.root, "t-evidence"),
          memoryReceiptId: id,
          [field]: [{ note: "evidence" }],
        } as Record<string, unknown>;
        delete payload.zeroExtractionReason;
        writeReceipt(ws.receiptsDir, id, payload);
        const result = validateReceiptForCompletion(
          ws.root,
          id,
          { taskId: "t-evidence" },
          { projectId: ws.projectId, projectPath: ws.root },
        );
        expect(result.ok, field).toBe(true);
      });
    } finally {
      ws.cleanup();
    }
  });

  test("taskId／projectId／projectPath 不一致時拒絕（C1.4）", () => {
    const ws = createWorkspace();
    try {
      writeReceipt(ws.receiptsDir, "wrong-task", {
        ...validReceipt(ws.projectId, ws.root, "t-other"),
        memoryReceiptId: "wrong-task",
      });
      writeReceipt(ws.receiptsDir, "wrong-project", {
        ...validReceipt("totally-different-project", ws.root, "t-bind"),
        memoryReceiptId: "wrong-project",
      });
      writeReceipt(ws.receiptsDir, "wrong-path", {
        ...validReceipt(ws.projectId, "/tmp/some-foreign-project-root", "t-bind"),
        memoryReceiptId: "wrong-path",
      });
      const wrongTask = validateReceiptForCompletion(
        ws.root,
        "wrong-task",
        { taskId: "t-bind" },
        { projectId: ws.projectId, projectPath: ws.root },
      );
      expect(wrongTask.ok).toBe(false);
      if (!wrongTask.ok) expect(wrongTask.error).toContain("taskId 不一致");

      const wrongProject = validateReceiptForCompletion(
        ws.root,
        "wrong-project",
        { taskId: "t-bind" },
        { projectId: ws.projectId, projectPath: ws.root },
      );
      expect(wrongProject.ok).toBe(false);
      if (!wrongProject.ok) expect(wrongProject.error).toContain("專案綁定不一致");

      const wrongPath = validateReceiptForCompletion(
        ws.root,
        "wrong-path",
        { taskId: "t-bind" },
        { projectId: ws.projectId, projectPath: ws.root },
      );
      expect(wrongPath.ok).toBe(false);
      if (!wrongPath.ok) expect(wrongPath.error).toContain("專案綁定不一致");
    } finally {
      ws.cleanup();
    }
  });

  test("receiptId 空白或含斜線時拒絕", () => {
    const ws = createWorkspace();
    try {
      for (const id of ["", "   ", "a/b", "a\\b", "../escape"]) {
        const result = validateReceiptForCompletion(
          ws.root,
          id,
          { taskId: "t-x" },
          { projectId: ws.projectId, projectPath: ws.root },
        );
        expect(result.ok, JSON.stringify(id)).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("INVALID_MEMORY_RECEIPT");
          expect(result.error).toBe("memoryReceiptId 無效");
        }
      }
    } finally {
      ws.cleanup();
    }
  });

  test("檔案缺席回找不到收據", () => {
    const ws = createWorkspace();
    try {
      const result = validateReceiptForCompletion(
        ws.root,
        "receipt-missing",
        { taskId: "t-x" },
        { projectId: ws.projectId, projectPath: ws.root },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("INVALID_MEMORY_RECEIPT");
        expect(result.error).toBe("找不到專案記憶更新紀錄：receipt-missing");
      }
    } finally {
      ws.cleanup();
    }
  });

  test("壞 JSON 與非物件內容回對應訊息", () => {
    const ws = createWorkspace();
    try {
      writeFileSync(join(ws.receiptsDir, "broken.json"), "{not json", "utf-8");
      writeFileSync(join(ws.receiptsDir, "scalar.json"), JSON.stringify("plain string"), "utf-8");
      const broken = validateReceiptForCompletion(
        ws.root,
        "broken",
        { taskId: "t-x" },
        { projectId: ws.projectId, projectPath: ws.root },
      );
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.error).toBe("專案記憶更新紀錄不是有效的 JSON：broken");
      const scalar = validateReceiptForCompletion(
        ws.root,
        "scalar",
        { taskId: "t-x" },
        { projectId: ws.projectId, projectPath: ws.root },
      );
      expect(scalar.ok).toBe(false);
      if (!scalar.ok) expect(scalar.error).toBe("專案記憶更新紀錄內容無效：scalar");
    } finally {
      ws.cleanup();
    }
  });

  test("receipts 目錄 helper 指向 .ultrawork/receipts", () => {
    const ws = createWorkspace();
    try {
      expect(getReceiptsDir(ws.root)).toBe(join(ws.root, ".ultrawork", "receipts"));
    } finally {
      ws.cleanup();
    }
  });
});
