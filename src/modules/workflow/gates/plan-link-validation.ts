/**
 * opencode-ultrawork — plan/task link validation helpers
 *
 * 角色：
 *   - Plan ↔ Task 連結完整性驗證的 **固定格式 helper module**：
 *     parent/dependsOn/blockedBy 引用驗證、cycle 偵測、專案記憶更新階段 更新紀錄 extraction 判定、
 *     plan-level inconsistency 彙整，皆由本模組提供。
 *     `validateTaskLinkReferences` / `collectPlanInconsistencies` /
 *     `hasReceiptExtractions` / `taskDependsOnPlanSection` /
 *     `type LinkInconsistency` 等符號。
 *   - **型別來源**：本檔案內部 structural duplicate 介面
 *     （`Task` / `TasksRegistry` / `ProjectBinding` / `MemoryReceipt` /
 *     `Plan` / `PlanDependencyGraphEdge` / `PlanDependencyGraphNode`）已
 *     改為從 `../core/types.ts` 以 type-only import 取得，並透過
 *     `export type` re-export 維持 package.json `extractedModules.exports`
 *     描述的對外 export surface。
 *   - `LinkInconsistency` 仍保留為本模組的 local type，因其屬於 gate 驗證結果
 *     的語意專屬描述，不屬於 `core/types.ts` 的通用型別集合。
 *
 * 對外規則（不可破壞）：
 *   - TypeScript structural typing：re-export 的 Task / TasksRegistry /
 *     ProjectBinding / MemoryReceipt / Plan / PlanDependencyGraphEdge /
 *     PlanDependencyGraphNode 與 index.ts 內同名介面結構相同（皆來自
 *     `core/types.ts`），跨模組互相可代入。
 *   - 不可 value-import `core/types.ts`：本檔只需要 type-only 引用；引入反向
 *     import 會形成循環依賴並破壞模組邊界。
 *   - 不可 import `core/helpers.ts`：本檔案保留 local `sameProject` 以避免
 *     額外的模組依賴；其實作與 `core/helpers.ts` 同名 helper 完全一致。
 *   - 不引入新相依（除 `node:path` 的 `resolve`）。
 *
 * @see ../../../../README.md                              — 模組一覽
 */

import { resolve } from "node:path";
import type {
  Task,
  TasksRegistry,
  ProjectBinding,
  MemoryReceipt,
  Plan,
  PlanDependencyGraphEdge,
  PlanDependencyGraphNode,
} from "../core/types.ts";
import { isTaskResolvable } from "../registry/plan-completion.ts";

// ─── Re-export core types to maintain gates export surface ──
// 本檔案內的 structural duplicate 介面已移除，改透過 `export type`
// re-export 維持 package.json `extractedModules.exports` 描述的對外 surface。
// 這些 type 不在 production runtime 被實際 import，但 rule 文件化要求保留。
export type {
  Task,
  TasksRegistry,
  ProjectBinding,
  MemoryReceipt,
  Plan,
  PlanDependencyGraphEdge,
  PlanDependencyGraphNode,
};

// ─── Local helpers ──────────────────────────────────────────

function sameProject(a: ProjectBinding, b: ProjectBinding): boolean {
  return a.projectId === b.projectId && resolve(a.projectPath) === resolve(b.projectPath);
}

// ─── Plan/Task Link Validation (P1 hardening) ────────────────
//
// plan-task-link 需要驗證 parent/dependsOn/blockedBy 引用是否存在、同 project/plan、
// 非 self dependency、無 cycle，因此這裡提供 module-level 驗證 helper。
//
// 設計：
// - 回傳 `inconsistencies` 陣列，每個元素有 type / code / message / refs 欄位。
// - 不直接 throw，讓 plan-task-link 與 plan-status 都能消費同樣結果。
// - cycle detection 使用 DFS（白/灰/黑三色法），不仰賴外部 graph 函式庫。

export interface LinkInconsistency {
  type: "parent" | "dependsOn" | "blockedBy" | "cycle" | "self" | "graph";
  code:
    | "TASK_NOT_FOUND"
    | "CROSS_PROJECT"
    | "CROSS_PLAN"
    | "SELF_REFERENCE"
    | "CYCLE_DETECTED"
    | "DANGLING_EDGE_SOURCE"
    | "DANGLING_EDGE_TARGET";
  message: string;
  refs: string[];
  cyclePath?: string[];
}

/**
 * 驗證單一 task 的 parent/dependsOn/blockedBy 引用是否合規。
 *
 * 規則：
 * - 必須存在於 taskRegistry。
 * - 必須同 project（同 projectId + projectPath）。
 * - 必須同 plan（task.planId 與引用的 task.planId 一致）。
 * - 禁止 self reference。
 * - parent/dependsOn/blockedBy 都必須同 plan。
 * - 對 dependsOn 額外偵測 cycle（自該 task 為起點，DFS 走 dependsOn 邊）。
 *
 * @param task 欲驗證的 task
 * @param options.taskRegistry 完整 task registry
 * @param options.currentProject 當前綁定的 project
 * @param options.plan 該 task 所屬的 plan（用於同 plan 檢查）
 * @returns inconsistencies 陣列；若為空表示通過
 */
export function validateTaskLinkReferences(
  task: Task,
  options: {
    taskRegistry: TasksRegistry;
    currentProject: ProjectBinding;
    plan: Plan;
  }
): LinkInconsistency[] {
  const { taskRegistry, plan } = options;
  const inconsistencies: LinkInconsistency[] = [];
  const allProject = options.currentProject;

  const checkRef = (refId: string, kind: "parent" | "dependsOn" | "blockedBy"): void => {
    if (!refId) return;
    if (refId === task.taskId) {
      inconsistencies.push({
        type: "self",
        code: "SELF_REFERENCE",
        message: `任務 ${task.taskId} 的 ${kind} 不能指向自己`,
        refs: [refId],
      });
      return;
    }
    const ref = taskRegistry.tasks[refId];
    if (!ref) {
      // Invariant：合法 tombstone 不得被視為
      // TASK_NOT_FOUND；下游 resolver / plan-next / plan-status 會用 tombstone
      // 判斷依賴是否滿足。
      if (isTaskResolvable(refId, taskRegistry, plan)) {
        return;
      }
      inconsistencies.push({
        type: kind,
        code: "TASK_NOT_FOUND",
        message: `任務 ${task.taskId} 的 ${kind} 指向一個不存在的任務 ${refId}`,
        refs: [refId],
      });
      return;
    }
    if (!sameProject(ref, allProject)) {
      inconsistencies.push({
        type: kind,
        code: "CROSS_PROJECT",
        message: `任務 ${task.taskId} 的 ${kind} ${refId} 屬於另一個專案（${ref.projectId}）`,
        refs: [refId],
      });
      return;
    }
    if (ref.planId !== plan.planId) {
      inconsistencies.push({
        type: kind,
        code: "CROSS_PLAN",
        message: `任務 ${task.taskId} 的 ${kind} ${refId} 屬於計畫 ${ref.planId ?? "<無>"}，但這裡預期是 ${plan.planId}`,
        refs: [refId],
      });
    }
  };

  // parentTaskId
  if (task.parentTaskId) {
    checkRef(task.parentTaskId, "parent");
  }

  // dependsOn + cycle detection
  for (const dep of task.dependsOn || []) {
    checkRef(dep, "dependsOn");
  }
  if ((task.dependsOn || []).length > 0) {
    const cycle = findDependencyCycle(task.taskId, taskRegistry);
    if (cycle) {
      inconsistencies.push({
        type: "cycle",
        code: "CYCLE_DETECTED",
        message: `任務 ${task.taskId} 的 dependsOn 形成了循環依賴`,
        refs: cycle.slice(0, -1),
        cyclePath: cycle,
      });
    }
  }

  // blockedBy
  for (const blocker of task.blockedBy || []) {
    checkRef(blocker, "blockedBy");
  }

  return inconsistencies;
}

/**
 * DFS-based cycle detection。從 startId 出發沿 dependsOn 邊前進，若遇到 grey 節點表示成環。
 *
 * @returns 若有 cycle，回傳 cycle path（從 startId 出發經過的節點，最後回到 startId）；否則 null
 */
export function findDependencyCycle(startId: string, taskRegistry: TasksRegistry): string[] | null {
  const startTask = taskRegistry.tasks[startId];
  if (!startTask) return null;

  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const pathStack: string[] = [];

  const dfs = (nodeId: string): string[] | null => {
    color.set(nodeId, GREY);
    pathStack.push(nodeId);
    const node = taskRegistry.tasks[nodeId];
    if (node) {
      for (const dep of node.dependsOn || []) {
        if (!taskRegistry.tasks[dep]) continue; // 缺漏節點交由 validateTaskLinkReferences 報告
        const c = color.get(dep) ?? WHITE;
        if (c === GREY) {
          // 找到 cycle：從 dep 在 pathStack 中的位置切到目前
          const cycleStart = pathStack.indexOf(dep);
          return [...pathStack.slice(cycleStart), dep];
        }
        if (c === WHITE) {
          const found = dfs(dep);
          if (found) return found;
        }
      }
    }
    color.set(nodeId, BLACK);
    pathStack.pop();
    return null;
  };

  return dfs(startId);
}

/**
 * 判斷 task 是否依賴 plan 內容檔的 section（無法以獨立檔案讀取）。
 *
 * 規則（與 writePlansRegistry prune cleanup 對齊）：
 * - 有 taskContentPath 視為 file mode，不依賴 plan file。
 * - taskContentMode === "file" 不依賴。
 * - taskContentMode === "hybrid" 且 contentRef 指向獨立 task file，不依賴。
 * - 其他情況依賴 plan file 的 section。
 */
export function taskDependsOnPlanSection(task: Task, _planId: string): boolean {
  if (task.taskContentPath) return false;
  if (task.taskContentMode === "file") return false;
  if (task.taskContentMode === "hybrid" && task.contentRef && task.contentRef.includes("tasks/")) return false;
  return true;
}

/**
 * 判斷 memory 更新紀錄 是否包含 extraction / cards 證據。
 * 用於 專案記憶更新階段 更新紀錄 gate 與 task state sync complete 流程。
 */
export function hasReceiptExtractions(receipt: MemoryReceipt): boolean {
  return [receipt.extractionResults, receipt.extractions, receipt.createdCards, receipt.updatedCards]
    .some((value) => Array.isArray(value) && value.length > 0);
}

/**
 * 收集單一 plan 的所有 inconsistencies：包含每個 linked task 的 link validation 結果，
 * 以及 plan.dependencyGraph.edges 中 source/target 缺漏的 dangling edge 報告。
 */
export function collectPlanInconsistencies(
  plan: Plan,
  taskRegistry: TasksRegistry,
  currentProject: ProjectBinding
): LinkInconsistency[] {
  const linkedTasks = plan.taskIds.map((id) => taskRegistry.tasks[id]).filter(Boolean) as Task[];
  return [
    ...linkedTasks.flatMap((task) => validateTaskLinkReferences(task, { taskRegistry, currentProject, plan })),
    ...plan.dependencyGraph.edges.flatMap((edge) => {
      const inconsistencies: LinkInconsistency[] = [];
      // Invariant：若 source/target 在
      // plan.completionTombstones 仍有紀錄，視為已 prune 但保留依賴證據，
      // 不算 DANGLING。
      if (!isTaskResolvable(edge.source, taskRegistry, plan)) {
        inconsistencies.push({ type: "graph", code: "DANGLING_EDGE_SOURCE", message: `依賴關係圖裡有一條邊的起點不存在：${edge.source}`, refs: [edge.source, edge.target] });
      }
      if (!isTaskResolvable(edge.target, taskRegistry, plan)) {
        inconsistencies.push({ type: "graph", code: "DANGLING_EDGE_TARGET", message: `依賴關係圖裡有一條邊的終點不存在：${edge.target}`, refs: [edge.source, edge.target] });
      }
      return inconsistencies;
    }),
  ];
}
