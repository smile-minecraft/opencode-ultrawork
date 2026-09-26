/**
 * memory 模組：專案記憶（project.md）與同步紀錄（receipts/）的 6 個工具。
 *
 * 開關開啟時註冊；關閉時完全不碰 ctx。
 * 工具定義在 transform 外先建好，transform 回呼只做 editor.add，
 * 保持同步、可重播、無副作用；回傳的註冊由外掛卸載時 dispose。
 *
 * 完成前檢查介面（workflow 之後會 import）：
 * - `validateReceiptForCompletion(projectRoot, receiptId, task, currentProject)`
 *   純函式，不依賴 register；簽名與規則保持穩定。
 * - `getReceiptsDir(projectRoot)` 收據目錄 helper。
 */

import type { ToolExecutionContext } from "../../kit/define-tool.ts";
import type { ModuleDefinition, ModuleRuntime, Registration } from "../types.ts";
import { createProjectMemoryTools } from "./project-memory.ts";
import { createReceiptTools } from "./receipts.ts";
import { resolveSessionDirectory, type MemoryRootResolver } from "./session-root.ts";

export const memoryModule: ModuleDefinition = {
  key: "memory",
  register: (runtime: ModuleRuntime): Promise<Registration> => {
    const resolveRoot: MemoryRootResolver = (toolCtx: ToolExecutionContext) =>
      resolveSessionDirectory(runtime.ctx, toolCtx);
    const projectMemory = createProjectMemoryTools(resolveRoot);
    const receipts = createReceiptTools(resolveRoot);
    return runtime.ctx.tool.transform((editor) => {
      editor.add(projectMemory["project-memory-read"] as never);
      editor.add(projectMemory["project-memory-update"] as never);
      editor.add(projectMemory["project-memory-rewrite"] as never);
      editor.add(receipts["memory-receipt-create"] as never);
      editor.add(receipts["memory-receipt-read"] as never);
      editor.add(receipts["memory-receipt-list"] as never);
    });
  },
};

export {
  validateReceiptForCompletion,
  hasReceiptExtractions,
  type MemoryReceipt,
  type ReceiptValidationResult,
} from "./receipt-validator.ts";
export type { ProjectBinding } from "./helpers.ts";
export { getMemoryPaths, getReceiptsDir, getReceiptPath, ensureDir, type MemoryPaths } from "./paths.ts";
export {
  resolveProjectMdPolicy,
  resolveProjectMdPolicyFromContent,
  getProjectMdNearLimitThreshold,
  getProjectMdCurrentSections,
  getProjectMdOverLimitHint,
  PROJECT_MD_HARD_LIMIT as POLICY_HARD_LIMIT,
  PROJECT_MD_LIMIT as POLICY_LIMIT,
  STATE_MD_LIMIT as POLICY_STATE_LIMIT,
  BOOTSTRAP_FULL_SOFT_BUDGET as POLICY_BOOTSTRAP_BUDGET,
  PROJECT_MD_NEAR_LIMIT_RATIO as POLICY_NEAR_LIMIT_RATIO,
  type ProjectMdPolicyResult,
  type CurrentSectionInfo,
} from "./project-md-policy.ts";
export {
  PROJECT_MD_HARD_LIMIT,
  PROJECT_MD_LIMIT,
  STATE_MD_LIMIT,
  BOOTSTRAP_FULL_SOFT_BUDGET,
  PROJECT_MD_NEAR_LIMIT_RATIO,
  RECEIPT_RETENTION_LIMIT,
  RECEIPT_ID_PREFIX,
  PROJECT_MEMORY_LOCK,
} from "./constants.ts";

// ─── 附加式匯出（diagnostics 模組的 frontmatter 解析與大小政策需要） ──
//
// 舊版 diagnostics 從 legacy 模組拿 `parseFrontmatterBlock`；V2 legacy 已移除，
// 該函式落腳在 memory 模組。l1_check／doctor 的 frontmatter 檢查改從這裡取，
// 避免再長出第二份解析器。

export { parseFrontmatterBlock } from "./frontmatter.ts";
export { splitFrontmatter } from "./helpers.ts";
export { resolveSessionDirectory, type MemoryRootResolver } from "./session-root.ts";
