/**
 * memory-receipt 工具組：建立、讀取、列舉專案記憶更新紀錄。
 *
 * 自舊外掛 tools/receipt-toolset 移植，行為逐字一致：
 * - `memory-receipt-create`：寫入 `.ultrawork/receipts/<id>.json`（id 為
 *   `receipt-{taskId}`）；欄位含 taskId／projectId／projectPath／status／
 *   createdAt／extraction 或 zeroExtractionReason；原子寫入；寫入後若超過
 *   RECEIPT_RETENTION_LIMIT=50 直接刪最舊，回 autoTrim 區塊。
 * - `memory-receipt-read`：receiptId 或 taskId 擇一（缺 prefix 自動補）；
 *   不存在回 `{ ok: true, receipt: null }`。
 * - `memory-receipt-list`：mtime 降冪、invalid JSON 容錯仍列出。
 *
 * create 寫出的收據必須能通過 `validateReceiptForCompletion`，
 * 因此缺 extraction 證據又缺 zeroExtractionReason 時預先拒絕。
 *
 * V2 差異（僅接線層）：defineTool＋zod、根目錄由呼叫端解析傳入、
 * 專案綁定 fallback 為 deriveProjectId(root)（舊版 getCurrentProject 同語意）。
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { defineTool, type DefinedTool } from "../../kit/define-tool.ts";
import { jsonResult } from "../../kit/json.ts";
import { atomicWriteFile } from "../../kit/atomic-write.ts";
import { RECEIPT_RETENTION_LIMIT, RECEIPT_ID_PREFIX } from "./constants.ts";
import { deriveProjectId } from "./helpers.ts";
import { ensureDir, getMemoryPaths, assertSafeMemoryPath } from "./paths.ts";
import type { MemoryReceipt } from "./receipt-validator.ts";
import type { MemoryRootResolver } from "./session-root.ts";

/** 取得目前 UTC ISO timestamp。 */
function nowIso(): string {
  return new Date().toISOString();
}

export interface ReceiptToolset {
  "memory-receipt-create": DefinedTool;
  "memory-receipt-read": DefinedTool;
  "memory-receipt-list": DefinedTool;
}

/**
 * 標準化 receiptId：若呼叫端傳入 taskId（不含 `receipt-` prefix），自動補上；
 * 已含 prefix 則原樣回傳。
 */
function normalizeReceiptId(input: string): string {
  return input.startsWith(RECEIPT_ID_PREFIX) ? input : `${RECEIPT_ID_PREFIX}${input}`;
}

/**
 * Receipt auto trim：
 * 當 receipts/ 數量超過 RECEIPT_RETENTION_LIMIT 時，依 mtime 升冪排序並
 * 直接刪除最舊的多餘收據（不歸檔：50 筆對驗證與審計已足夠，
 * 歸檔會產生第二個目錄增加維護負擔）。
 */
function pruneReceiptsByMtime(projectRoot: string, receiptsDir: string): { removed: string[]; remaining: number } {
  if (!existsSync(receiptsDir)) return { removed: [], remaining: 0 };
  const entries = readdirSync(receiptsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const fullPath = join(receiptsDir, name);
      try {
        assertSafeMemoryPath(projectRoot, fullPath);
        return { name, id: basename(name, ".json"), path: fullPath, mtimeMs: statSync(fullPath).mtimeMs };
      } catch {
        return { name, id: basename(name, ".json"), path: fullPath, mtimeMs: 0 };
      }
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);  // 升冪：最舊在前
  const overflow = Math.max(0, entries.length - RECEIPT_RETENTION_LIMIT);
  if (overflow === 0) return { removed: [], remaining: entries.length };
  const toRemove = entries.slice(0, overflow);
  const removed: string[] = [];
  for (const e of toRemove) {
    try {
      assertSafeMemoryPath(projectRoot, e.path);
      unlinkSync(e.path);
      removed.push(e.id);
    } catch {
      // ignore: best-effort trim
    }
  }
  return { removed, remaining: entries.length - removed.length };
}

const ReceiptCreateInput = z.object({
  taskId: z.string(),
  projectId: z.string().optional(),
  projectPath: z.string().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  zeroExtractionReason: z.string().optional(),
  extractionResults: z.array(z.any()).optional(),
  extractions: z.array(z.any()).optional(),
  createdCards: z.array(z.any()).optional(),
  updatedCards: z.array(z.any()).optional(),
  // 稽核欄位：純 pass-through，讓沒有關聯計畫的獨立任務
  // 也留得下風險申報與審查結論。
  risk: z.string().optional(),
  reviewVerdict: z.string().optional(),
});

const ReceiptReadInput = z.object({
  receiptId: z.string().optional(),
  taskId: z.string().optional(),
});

const ReceiptListInput = z.object({});

/** 建立 3 個收據管理工具；根目錄由呼叫端解析傳入。 */
export function createReceiptTools(resolveRoot: MemoryRootResolver): ReceiptToolset {
  // ─── memory-receipt-create ─────────────────────────────────────
  const memory_receipt_create = defineTool({
    name: "memory-receipt-create",
    description:
      "在 .ultrawork/receipts/ 建立專案記憶更新紀錄 JSON。完成任務前需要先建立這筆紀錄，並搭配完成前檢查使用。",
    inputSchema: ReceiptCreateInput,
    execute: async (
      {
        taskId,
        projectId,
        projectPath,
        status,
        createdAt,
        zeroExtractionReason,
        extractionResults,
        extractions,
        createdCards,
        updatedCards,
        risk,
        reviewVerdict,
      },
      toolCtx,
    ) => {
      if (!taskId?.trim()) {
        return jsonResult({ ok: false, error: "缺少必要欄位：taskId" });
      }

      // 專案綁定：優先使用呼叫端傳入的 projectId / projectPath；
      // 缺時 fallback 到目前專案，讓大多數情境無需重複傳遞綁定資訊。
      const root = await resolveRoot(toolCtx);
      const finalProjectId = (projectId ?? deriveProjectId(root)).trim();
      const finalProjectPath = projectPath ?? root;

      const { receiptsDir: RECEIPTS_DIR } = getMemoryPaths(root);
      assertSafeMemoryPath(root, RECEIPTS_DIR);
      const finalStatus = (status ?? "ok").trim() || "ok";
      const finalCreatedAt = createdAt?.trim() || nowIso();
      const finalZeroExtractionReason = zeroExtractionReason?.trim();

      // 至少一個 extraction array 非空，或 zeroExtractionReason 非空，
      // 否則寫入後無法通過 validator。預先擋下以提供清楚錯誤訊息。
      const hasExtractionArray =
        (Array.isArray(extractionResults) && extractionResults.length > 0) ||
        (Array.isArray(extractions) && extractions.length > 0) ||
        (Array.isArray(createdCards) && createdCards.length > 0) ||
        (Array.isArray(updatedCards) && updatedCards.length > 0);

      if (!hasExtractionArray && !finalZeroExtractionReason) {
        return jsonResult({
          ok: false,
          error:
            "必須提供 extraction 陣列（extractionResults／extractions／createdCards／updatedCards）或非空的 zeroExtractionReason，才能完成專案記憶更新。",
        });
      }

      const receiptId = `${RECEIPT_ID_PREFIX}${taskId}`;
      const receipt: MemoryReceipt = {
        memoryReceiptId: receiptId,
        taskId,
        projectId: finalProjectId,
        projectPath: finalProjectPath,
        status: finalStatus,
        createdAt: finalCreatedAt,
      };

      // 僅在呼叫端有提供時附加 optional 欄位，避免空欄位污染收據 JSON
      if (extractionResults !== undefined) receipt.extractionResults = extractionResults;
      if (extractions !== undefined) receipt.extractions = extractions;
      if (createdCards !== undefined) receipt.createdCards = createdCards;
      if (updatedCards !== undefined) receipt.updatedCards = updatedCards;
      if (finalZeroExtractionReason) receipt.zeroExtractionReason = finalZeroExtractionReason;
      if (risk?.trim()) receipt.risk = risk.trim();
      if (reviewVerdict?.trim()) receipt.reviewVerdict = reviewVerdict.trim();

      // 確保收據目錄存在
      ensureDir(RECEIPTS_DIR);

      const receiptPath = join(RECEIPTS_DIR, `${receiptId}.json`);
      assertSafeMemoryPath(root, receiptPath);
      atomicWriteFile(receiptPath, JSON.stringify(receipt, null, 2));

      // Receipt auto trim：寫入後立即檢查，若超過上限直接刪除最舊。
      const trimResult = pruneReceiptsByMtime(root, RECEIPTS_DIR);

      return jsonResult({
        ok: true,
        receiptId,
        receiptPath,
        taskId,
        projectId: finalProjectId,
        projectPath: finalProjectPath,
        status: finalStatus,
        createdAt: finalCreatedAt,
        autoTrim: {
          retentionLimit: RECEIPT_RETENTION_LIMIT,
          removed: trimResult.removed,
          removedCount: trimResult.removed.length,
          remaining: trimResult.remaining,
        },
      }, null, 2);
    },
  });

  // ─── memory-receipt-read ────────────────────────────────────────
  const memory_receipt_read = defineTool({
    name: "memory-receipt-read",
    description:
      "從 .ultrawork/receipts/ 讀取專案記憶更新紀錄 JSON。找不到時回傳 null。",
    inputSchema: ReceiptReadInput,
    execute: async ({ receiptId, taskId }, toolCtx) => {
      const input = (receiptId ?? taskId ?? "").trim();
      if (!input) {
        return jsonResult({ ok: false, error: "receiptId 或 taskId 至少需要一個" });
      }
      const id = normalizeReceiptId(input);

      const root = await resolveRoot(toolCtx);
      const { receiptsDir: RECEIPTS_DIR } = getMemoryPaths(root);
      const receiptPath = join(RECEIPTS_DIR, `${id}.json`);
      assertSafeMemoryPath(root, receiptPath);

      if (!existsSync(receiptPath)) {
        return jsonResult({ ok: true, receiptId: id, receipt: null }, null, 2);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(receiptPath, "utf-8"));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "解析失敗";
        return jsonResult({
          ok: false,
          error: `專案記憶更新紀錄不是有效的 JSON：${id}（${message}）`,
          receiptId: id,
        }, null, 2);
      }

      return jsonResult({ ok: true, receiptId: id, receiptPath, receipt: parsed }, null, 2);
    },
  });

  // ─── memory-receipt-list ────────────────────────────────────────
  const memory_receipt_list = defineTool({
    name: "memory-receipt-list",
    description:
      "列出 .ultrawork/receipts/ 下的所有更新紀錄 ID，依修改時間由新到舊排列。",
    inputSchema: ReceiptListInput,
    execute: async (_args, toolCtx) => {
      const root = await resolveRoot(toolCtx);
      const { receiptsDir: RECEIPTS_DIR } = getMemoryPaths(root);
      assertSafeMemoryPath(root, RECEIPTS_DIR);

      if (!existsSync(RECEIPTS_DIR)) {
        return jsonResult({ ok: true, receiptsDir: RECEIPTS_DIR, count: 0, receiptIds: [] }, null, 2);
      }

      const entries = readdirSync(RECEIPTS_DIR)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const id = basename(name, ".json");
          const fullPath = join(RECEIPTS_DIR, name);
          assertSafeMemoryPath(root, fullPath);
          try {
            const stat = statSync(fullPath);
            return { receiptId: id, path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size };
          } catch {
            return { receiptId: id, path: fullPath, mtimeMs: 0, size: 0 };
          }
        });

      // 依 mtime 降冪排序（最新在前）
      entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

      return jsonResult(
        {
          ok: true,
          receiptsDir: RECEIPTS_DIR,
          count: entries.length,
          receiptIds: entries.map((e) => e.receiptId),
          receipts: entries,
        },
        null,
        2,
      );
    },
  });

  return {
    "memory-receipt-create": memory_receipt_create,
    "memory-receipt-read": memory_receipt_read,
    "memory-receipt-list": memory_receipt_list,
  };
}
