/**
 * 專案記憶更新紀錄 validator：自舊外掛 runtime/receipt-validator 移植。
 *
 * 舊版掛在 UltraworkRuntimeContext 上、經 getPaths 取收據目錄；
 * V2 改為純函式 `validateReceiptForCompletion(projectRoot, ...)`，
 * 收據目錄固定為 `<projectRoot>/.ultrawork/receipts/`，
 * 不依賴 register、不依賴工具是否註冊，workflow 的完成前檢查直接 import。
 *
 * 檢查規則與訊息字串與舊版逐字一致：
 * - receiptId trim 後空字串／含 `/` `\` → INVALID_MEMORY_RECEIPT
 * - 收據檔不存在／JSON 壞／非物件 → INVALID_MEMORY_RECEIPT
 * - `status` 必須 ∈ { ok, completed, success }（case-insensitive）
 * - `createdAt` 必須為合法 Date.parse 字串
 * - 必須有 extraction 證據或 `zeroExtractionReason` 非空
 * - `taskId` 必須等於傳入 task.taskId
 * - `projectId`／`projectPath` 必須等於 currentProject（經 sameProject）
 */

import { existsSync, readFileSync } from "node:fs";
import type { ProjectBinding } from "./helpers.ts";
import { sameProject } from "./helpers.ts";
import { getReceiptPath, assertSafeMemoryPath } from "./paths.ts";

export type { ProjectBinding };

/** 收據 JSON 形狀：欄位與舊外掛 core/types 的 MemoryReceipt 一致。 */
export interface MemoryReceipt {
  memoryReceiptId?: string;
  taskId: string;
  projectId: string;
  projectPath: string;
  status: string;
  createdAt: string;
  extractionResults?: unknown[];
  extractions?: unknown[];
  createdCards?: unknown[];
  updatedCards?: unknown[];
  zeroExtractionReason?: string;
  /**
   * 稽核欄位：與完成註記同樣的用途，覆蓋沒有關聯計畫的獨立任務。
   * 純 pass-through，檢查清單不因這兩個欄位改變。
   */
  risk?: string;
  reviewVerdict?: string;
}

export type ReceiptValidationResult =
  | { ok: true; receipt: MemoryReceipt }
  | { ok: false; code: "INVALID_MEMORY_RECEIPT"; error: string };

/** 判斷收據是否包含 extraction／cards 證據。 */
export function hasReceiptExtractions(receipt: MemoryReceipt): boolean {
  return [receipt.extractionResults, receipt.extractions, receipt.createdCards, receipt.updatedCards]
    .some((value) => Array.isArray(value) && value.length > 0);
}

/**
 * 驗證指定收據能否作為任務完成的專案記憶更新證據。
 *
 * 純函式：只讀收據檔，不寫入、不取鎖；projectRoot 為工作階段位置。
 */
export function validateReceiptForCompletion(
  projectRoot: string,
  receiptId: string,
  task: { taskId: string },
  currentProject: ProjectBinding,
): ReceiptValidationResult {
  const normalizedId = receiptId.trim();
  if (!normalizedId || /[\\/]/.test(normalizedId)) {
    return { ok: false, code: "INVALID_MEMORY_RECEIPT", error: "memoryReceiptId 無效" };
  }

  let receiptPath: string;
  try {
    receiptPath = getReceiptPath(projectRoot, normalizedId);
    assertSafeMemoryPath(projectRoot, receiptPath);
  } catch {
    return { ok: false, code: "INVALID_MEMORY_RECEIPT", error: "memory receipt 路徑不安全或超出專案範圍" };
  }
  if (!existsSync(receiptPath)) {
    return { ok: false, code: "INVALID_MEMORY_RECEIPT", error: `找不到專案記憶更新紀錄：${normalizedId}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(receiptPath, "utf-8"));
  } catch {
    return { ok: false, code: "INVALID_MEMORY_RECEIPT", error: `專案記憶更新紀錄不是有效的 JSON：${normalizedId}` };
  }

  if (!raw || typeof raw !== "object") {
    return { ok: false, code: "INVALID_MEMORY_RECEIPT", error: `專案記憶更新紀錄內容無效：${normalizedId}` };
  }

  const receipt = raw as MemoryReceipt;
  const validStatus = ["ok", "completed", "success"].includes(String(receipt.status || "").toLowerCase());
  const createdAtValid = typeof receipt.createdAt === "string" && !Number.isNaN(Date.parse(receipt.createdAt));
  const hasExtractionEvidence = hasReceiptExtractions(receipt) || !!receipt.zeroExtractionReason?.trim();

  if (receipt.taskId !== task.taskId) {
    return { ok: false, code: "INVALID_MEMORY_RECEIPT", error: `專案記憶更新紀錄的 taskId 不一致：${normalizedId}` };
  }
  if (typeof receipt.projectId !== "string" || typeof receipt.projectPath !== "string" || !sameProject({ projectId: receipt.projectId, projectPath: receipt.projectPath }, currentProject)) {
    return { ok: false, code: "INVALID_MEMORY_RECEIPT", error: `專案記憶更新紀錄的專案綁定不一致：${normalizedId}` };
  }
  if (!validStatus || !createdAtValid || !hasExtractionEvidence) {
    return { ok: false, code: "INVALID_MEMORY_RECEIPT", error: `專案記憶更新紀錄缺少必要欄位：${normalizedId}` };
  }

  return { ok: true, receipt };
}
