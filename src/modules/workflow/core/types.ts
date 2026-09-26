/**
 * opencode-ultrawork — core types
 *
 * 角色：
 *     作為後續 content/tools/registry 抽離的單一入口。
 *   - 本檔僅放型別（interfaces / type aliases）與極少量緊耦合常數型別
 *     （如 `as const` tuple 的 type 用法），**不得**放 runtime logic。
 *
 * 設計重點：
 *     以維持 TypeScript structural typing 相容性。
 *   - `gates/plan-link-validation.ts` 曾經有一組同名的重複介面，
 *     現已改為 `export type` re-export 本檔的型別，
 *     所以本檔改結構時不需要再同步那一份。
 *
 * 對外規則（不可破壞）：
 *   - `UltraworkOptions` 為 public rule，shim / package consumer
 *     透過 named import 取得。本檔以 `export interface` 提供型別。
 *   - 其他 Task / Plan / Registry 介面供本 repo 內部模組共用。
 *
 * 限制：
 *   - 本檔為 pure type module，**不得** import runtime helper 或
 *   - 不得 import `src/gates/plan-link-validation.ts`（保持單向依賴：
 *     index.ts → core → leaf helpers）。
 *
 * @see ../../../../README.md                              — 模組一覽
 */

// ─── Task State Sync Types ───────────────────────────────────

export interface Task {
  taskId: string;
  projectId: string;
  projectPath: string;
  title?: string;
  state: string;
  owner: string;
  priority: string;
  dependsOn?: string[];
  phase?: string;
  milestone?: string;
  planRef?: string;
  specRef?: string;
  indexRef?: string;
  archivingAt?: string;
  updatedAt: string;
  history: string[];
  // Plan system fields (v4.0)
  planId?: string;
  taskType?: "project-task" | "fast-task" | "subtask";
  parentTaskId?: string | null;
  subTaskIds?: string[];
  blockedBy?: string[];
  parallelGroup?: string | null;
  planStep?: number;
  acceptanceCriteria?: string[];
  // Content file fields (v4.1)
  contentRef?: string;       // e.g. ".ultrawork/plans/{planId}.md#task-{taskId}"
  taskContentPath?: string;  // e.g. ".ultrawork/plans/tasks/{taskId}.md" (file mode)
  taskContentMode?: "section" | "file" | "hybrid";
  /**
   * Task-local content version（與 plan.contentVersion 解耦）：
   *   - linked Task 的 section / file 更新沿用 plan.contentVersion；
   *   - standalone Task 的 file 更新必須遞增此 task-local 計數，避免
   *     觸碰 plans registry。
   *   - 讀寫一律以 `(task.contentVersion || 0) + 1` 為單調遞增語意。
   */
  contentVersion?: number;
  /**
   * 風險申報（v4.2）：
   *   - 只有 `"high"` 一個有效值；normalize 時其餘值一律收成不存在。
   *   - 由主代理在建立任務時申報，也可在 transition 中途補報。
   *   - 單調遞增：申報之後沒有降級路徑，避免結案前一步把閘門關掉。
   */
  risk?: "high";
  /**
   * 驗收紀錄（v4.4）：
   *   - 只有在任務本身填了 `acceptanceCriteria` 時才有意義；沒填的任務
   *     不受驗收閘門影響，這個欄位也會一直是 undefined。
   *   - 由 `task-state-sync` 的 `complete` 事件在通過檢查之後寫入，
   *     記下每一項驗收條件的結論與證據，讓「有沒有真的達成」留下痕跡，
   *     而不是只存在於當次對話裡。
   *   - `items` 與結案當下的 `acceptanceCriteria` 逐項對齊；條件之後被改過
   *     的話，這份紀錄保留的是結案當時那一版。
   */
  acceptanceResults?: {
    recordedAt: string;
    recordedBy: string;
    items: { criterion: string; met: boolean; evidence?: string }[];
  };
  /**
   * 獨立審查紀錄（v4.2）：
   *   - 由 `task-state-sync` 的 review 事件寫入，重複呼叫以最新為準。
   *   - `reviewedStateUpdatedAt` 記下審查當下的 `updatedAt`，純稽核用途。
   *   - `reworkedAfterReview` 在審查之後任務又退回 IN_PROGRESS 時被打開，
   *     結案時據此提醒重新送審。之所以不直接比對 `updatedAt`，是因為
   *     REVIEWING → ARCHIVING 這個正常收尾本身就會更新 `updatedAt`，
   *     拿它當判準會讓每一次結案都跳警告，警告就失去意義了。
   */
  review?: {
    verdict: "approve" | "concerns" | "reject";
    reviewer: string;
    reviewedAt: string;
    reviewedStateUpdatedAt: string;
    reworkedAfterReview?: boolean;
    note?: string;
  };
}

export interface TasksRegistry {
  version: string;
  projectId: string;
  projectPath: string;
  activeTaskIds: string[];
  taskCursor: string | null;
  tasks: Record<string, Task>;
}

export interface ProjectBinding {
  projectId: string;
  projectPath: string;
}



// ─── Plan Registry (v1.0) ───────────────────────────────────

export interface PlanDependencyGraphEdge {
  source: string;
  target: string;
  type: string;
}

export interface PlanDependencyGraphNode {
  id: string;
  taskId: string;
  title?: string;
}

/**
 * Completion tombstone：
 *   - 當 task 達到終態（COMPLETED / FAILED / CANCELLED）並被
 *     `FINISHED_TASK_LIMIT` prune 從 `tasks.tasks` 移除後，仍在所屬 Plan
 *     保留最小狀態證據，讓下游 dep 解析、plan-next / plan-status /
 *     validate 等 consumer 能在 task 不存在的情況下仍正確判斷依賴滿足。
 *   - 不內嵌 owner / priority / title 等個人化欄位；僅保留語意必要的
 *     `state` 與 `finishedAt`，避免雙索引（tasks.json ↔ tombstone）漂移。
 */
export interface PlanCompletionTombstone {
  state: "COMPLETED" | "FAILED" | "CANCELLED";
  finishedAt: string;
  /**
   * 稽核欄位（v4.2）：任務本體只留最近 5 筆、history 只留 3 行，
   * 風險申報與審查結論在任務被裁掉之後就查不到了。這兩個欄位讓完成註記
   * 承接長期證據；皆為選填，舊資料沒有時不視為損壞。
   */
  risk?: string;
  reviewVerdict?: string;
}

export interface Plan {
  planId: string;
  projectId: string;
  projectPath: string;
  title?: string;
  state: string;
  owner?: string;
  priority?: string;
  createdAt: string;
  updatedAt: string;
  taskIds: string[];
  /**
   * 向後相容索引：列出此 plan 中曾達終態的 task ID。
   * 不作為 唯一正式資料；以 `completionTombstones` 為唯一終態證據。
   * 新寫入仍會同步維護此欄位；舊資料缺漏時 consumer 應容錯。
   */
  finishedTaskIds: string[];
  dependencyGraph: {
    nodes: PlanDependencyGraphNode[];
    edges: PlanDependencyGraphEdge[];
  };
  history: string[];
  // Content file fields (v1.1)
  contentRef?: string;       // e.g. ".ultrawork/plans/{planId}.md"
  contentPath?: string;     // absolute path fallback
  contentVersion?: number;  // incremented on each update
  /**
   * Completion tombstones（ — v1.2 schema）：
   *   - optional；舊 Plan 無此欄位時以「無 tombstone」處理，不視為損壞。
   *   - taskId → tombstone；同一 taskId 多筆以先入為準（idempotent）。
   *   - 由 `task-state-sync` 終態轉換與 `writeRegistry` safety net 共同維護。
   */
  completionTombstones?: Record<string, PlanCompletionTombstone>;
}

export interface PlansRegistry {
  version: string;
  projectId: string;
  projectPath: string;
  activePlanIds: string[];
  planCursor: string | null;
  plans: Record<string, Plan>;
}
