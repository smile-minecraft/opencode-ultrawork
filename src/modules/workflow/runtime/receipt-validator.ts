/**
 * opencode-ultrawork — runtime memory 更新紀錄 validator
 *
 * 角色：
 *     `validateMemoryReceiptForTask` 為 runtime module-level 函式，附掛於
 *     `UltraworkRuntimeContext`。
 *   - 此函式為 專案記憶更新階段 memory 更新紀錄 gate 的核心驗證邏輯，於 `task-state-sync`
 *     完整覆蓋）。
 *
 * 對外規則（不可破壞）：
 *   - `validateMemoryReceiptForTask` 的所有白名單 / 必填檢查
 *     （含 `momus C1.1` status whitelist、`C1.2` createdAt 格式、
 *     `C1.3` extraction 證據 + zeroExtractionReason fallback、
 *     `C1.4` taskId / projectId / projectPath 一致性）必須與
 *   - 回傳型別為 union：
 *       `{ ok: true; receipt: MemoryReceipt } | { ok: false; code: "INVALID_MEMORY_RECEIPT"; error: string }`
 *   - 透過 `UltraworkRuntimeContext.getPaths(context)` 取得 `RECEIPTS_DIR`
 *     路徑，並使用 module-level `sameProject` / `hasReceiptExtractions`
 *     helper 進行比對。
 *
 * 限制：
 *
 * @see ../../../../README.md                              — 模組一覽
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryReceipt, ProjectBinding, Task } from "../core/types.ts";
import { sameProject } from "../core/helpers.ts";
import { assertSafeContentRoot, assertSafeProjectFile } from "../content/content-store.ts";
import { hasReceiptExtractions } from "../gates/plan-link-validation.ts";
import type { UltraworkRuntimeContext, StateProjectionRuntimeContextEx } from "./context-builder.ts";
import type { ToolExecutionContext } from "../../../kit/define-tool.ts";

type ToolContext = ToolExecutionContext;

export type ReceiptValidationResult =
  | { ok: true; receipt: MemoryReceipt }
  | { ok: false; code: "INVALID_MEMORY_RECEIPT"; error: string };

/**
 * 建立 更新紀錄 validator，附掛於 `UltraworkRuntimeContext`。
 *
 * 與 closure 原版本逐字一致，包含：
 *   - `receiptId.trim()` 後空字串 / 含 `/` `\` → INVALID_MEMORY_RECEIPT
 *   - 收據檔不存在於 `RECEIPTS_DIR/<id>.json` → INVALID_MEMORY_RECEIPT
 *   - JSON parse 失敗 → INVALID_MEMORY_RECEIPT
 *   - 收據不是 object → INVALID_MEMORY_RECEIPT
 *   - `status` 必須 ∈ { ok, completed, success }（case-insensitive）
 *   - `createdAt` 必須為合法 Date.parse 字串
 *   - 必須有 extraction evidence 或 `zeroExtractionReason` 非空
 *   - `taskId` 必須等於傳入 task.taskId
 *   - `projectId` / `projectPath` 必須等於 currentProject（透過 `sameProject`）
 */
export function createReceiptValidator(runtime: StateProjectionRuntimeContextEx) {
  return function validateMemoryReceiptForTask(
    receiptId: string,
    task: Task,
    currentProject: ProjectBinding,
    context?: ToolContext,
  ): ReceiptValidationResult {
    const normalizedId = receiptId.trim();
    if (!normalizedId || /[\\/]/.test(normalizedId)) {
      return { ok: false, code: "INVALID_MEMORY_RECEIPT", error: "memoryReceiptId 無效" };
    }

    const root = runtime.resolveProjectRoot(context);
    const { RECEIPTS_DIR, PLANS_DIR } = runtime.getPaths(context);
    const receiptPath = join(RECEIPTS_DIR, `${normalizedId}.json`);
    assertSafeContentRoot(root, PLANS_DIR);
    assertSafeProjectFile(root, PLANS_DIR, receiptPath);
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
  };
}
