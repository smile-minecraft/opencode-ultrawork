/**
 * opencode-ultrawork — core constants
 *
 * 角色：
 *   - 包含 registry 版本號、finished state 集合 / 保留上限、合法狀態轉換表。
 *
 * 設計重點：
 *   - 所有 `as const` tuple 維持 literal type，便於 `core/helpers.ts`
 *     中 `Array.includes(state as ...)` 維持 narrow 行為。
 *   - `VALID_TRANSITIONS` 為 task state 機；`VALID_PLAN_TRANSITIONS`
 *     為 plan state 機。兩者刻意分開命名，避免混淆。
 *
 * 對外規則（不可破壞）：
 *     若修改值，須同步調整對應 unit test（測試目前僅透過 read-only hook
 *     觀察，不直接斷言這些常數值）。
 *
 * 限制：
 *   - 本檔為 pure constants，**不得** import runtime helper，
 *     也不得引入任何有 IO 或副作用的依賴。
 *
 * @see ./helpers.ts                                       — 主要 consumer
 */

// ─── Task Registry Constants ────────────────────────────────

export const TASKS_REGISTRY_VERSION = "4.0";
export const FINISHED_TASK_STATES = ["COMPLETED", "FAILED", "CANCELLED"] as const;
/**
 * 還沒開始、因此有資格被排進「下一步可以做什麼」的任務狀態。
 *
 * 與 `VALID_TRANSITIONS` 的差別：那張表管的是「能不能轉過去」，這裡管的是
 * 「排程時要不要考慮它」。`CLARIFYING` 不在其中——需求還沒確認完就不該被
 * 當成可以動手的任務。
 */
export const STARTABLE_TASK_STATES = ["NEW", "PLANNED"] as const;
export const FINISHED_TASK_LIMIT = 5;
/** Task history 內保留的最大 transition 筆數（task-state-sync push 後 trim）。 */
export const TASK_HISTORY_LIMIT = 3;

/** project.md 字符上限。單一來源 7000；具體判定由 project-md-policy 統一。 */
export const PROJECT_MD_HARD_LIMIT = 7000;
export const PROJECT_MD_LIMIT = PROJECT_MD_HARD_LIMIT;
export const STATE_MD_LIMIT = 3000;
export const BOOTSTRAP_FULL_SOFT_BUDGET = 10_000;
export const PROJECT_MD_NEAR_LIMIT_RATIO = 0.8;

// ─── Plan Registry Constants (v1.0) ─────────────────────────

export const PLANS_REGISTRY_VERSION = "1.0";
export const FINISHED_PLAN_STATES = ["COMPLETED", "FAILED", "CANCELLED"] as const;
export const FINISHED_PLAN_LIMIT = 5;
/** Plan history 內保留的最大 transition 筆數（plan-state-sync push 後 trim）。 */
export const PLAN_HISTORY_LIMIT = 3;

// ─── State Machines ─────────────────────────────────────────

/**
 * Plan state machine：每個 state 可合法轉換到哪些 state。
 */
export const VALID_PLAN_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["CLARIFYING", "PLANNED", "CANCELLED"],
  CLARIFYING: ["PLANNED", "FAILED", "CANCELLED"],
  PLANNED: ["IN_PROGRESS", "FAILED", "CANCELLED"],
  IN_PROGRESS: ["BLOCKED", "REVIEWING", "FAILED", "CANCELLED"],
  BLOCKED: ["IN_PROGRESS", "FAILED", "CANCELLED"],
  REVIEWING: ["ARCHIVING", "IN_PROGRESS", "FAILED", "CANCELLED"],
  ARCHIVING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

/**
 * Task state machine：每個 task state 可合法轉換到哪些 state。
 * ARCHIVING → COMPLETED 收尾檢查。
 */
export const VALID_TRANSITIONS: Record<string, string[]> = {
  NEW: ["CLARIFYING", "PLANNED", "FAILED", "CANCELLED"],
  CLARIFYING: ["PLANNED", "FAILED", "CANCELLED"],
  PLANNED: ["IN_PROGRESS", "FAILED", "CANCELLED"],
  IN_PROGRESS: ["BLOCKED", "REVIEWING", "FAILED", "CANCELLED"],
  BLOCKED: ["IN_PROGRESS", "FAILED", "CANCELLED"],
  REVIEWING: ["ARCHIVING", "IN_PROGRESS", "FAILED", "CANCELLED"],
  ARCHIVING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

// ─── Receipt Retention  ──────────
export const RECEIPT_RETENTION_LIMIT = 50;
