import { jsonResult } from "../../../kit/json.ts";
/**
 * opencode-ultrawork — plan-task-link tool factory
 *
 * 角色：
 *   - 將 task 連結至 plan，同步寫入 task 上的 planId / taskType / parentTaskId
 *     / dependsOn / blockedBy / parallelGroup / planStep / acceptanceCriteria，
 *     以及 plan 上的 taskIds / dependencyGraph.nodes+edges。
 *   - 透過 `validateTaskLinkReferences`（module-level helper，於
 *     `gates/plan-link-validation.ts`）做 single-task link 驗證（含
 *     CROSS_PROJECT / CROSS_PLAN / DANGLING_REF / SELF_DEPENDENCY /
 *     CYCLE_DETECTED 等 inconsistency codes）；驗證失敗回
 *     `code: INVALID_LINK_REFERENCES` 而非 throw。
 *
 * 對外規則（不可破壞）：
 *   - factory 簽名：`createPlanTaskLinkTool(runtime)`。
 *   - tool name：`plan-task-link`。
 *   - `args` schema 與原 closure 版本逐字一致。
 *   - cross-project 拒絕訊息（"Cross-project link rejected. Current project: ..."）
 *     必須保持原文。
 *   - 驗證後實際寫入順序（task fields → parent.subTaskIds → plan.taskIds →
 *     plan.dependencyGraph.nodes → plan.dependencyGraph.edges → plan.updatedAt）
 *     不可變動，以維持既有 plan / task registry snapshot diff 行為。
 *   - 成功回傳 JSON 形狀（planId / taskId / task 子集 / plan 子集）必須與
 *     原 closure 版本一致（含 `nodeCount` / `edgeCount`）。
 *
 * 限制：
 *   - 驗證 helper（`validateTaskLinkReferences`）以 value import 形式
 *     引用；該 helper 位於 gates 模組，並掛於
 *     `__ultraworkTestHooks.validateTaskLinkReferences`，規則不變。
 *
 * @see ../../../../README.md                                     — 模組一覽
 * @see ../gates/plan-link-validation.ts                          — link 驗證 helper
 * @see ../runtime/context-builder.ts                              — runtime 介面
 */

import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../../kit/define-tool.ts";
type ToolContext = ToolExecutionContext;
import type { Task, TasksRegistry } from "../core/types.ts";
import { isFinishedPlanState, sameProject, uniq } from "../core/helpers.ts";
import { validateTaskLinkReferences } from "../gates/plan-link-validation.ts";
import type { UltraworkRuntimeContext } from "../runtime/context-builder.ts";

/**
 * plan_task_link tool factory。
 *
 *   `UltraworkRuntimeContext` 實例。
 */
export function createPlanTaskLinkTool(runtime: UltraworkRuntimeContext) {
  return defineTool({
    name: "plan-task-link",
    description: "把任務加入計畫並更新任務關係、先後順序、分組與驗收條件，同步計畫索引。",
    inputSchema: z.object({
      planId: z.string(),
      taskId: z.string(),
      taskType: z.enum(["project-task", "fast-task", "subtask"]).optional(),
      parentTaskId: z.string().optional(),
      dependsOn: z.array(z.string()).optional(),
      blockedBy: z.array(z.string()).optional(),
      parallelGroup: z.string().optional(),
      planStep: z.number().optional(),
      acceptanceCriteria: z.array(z.string()).optional(),
    }),
    async execute({ planId, taskId, taskType, parentTaskId, dependsOn, blockedBy, parallelGroup, planStep, acceptanceCriteria }, context) {
      const currentProject = runtime.getCurrentProject(context);
      const result = await runtime.transactRegistries(context, async ({ tasks: taskRegistry, plans: planRegistry }, control) => {

      const plan = planRegistry.plans[planId];
      if (!plan) return jsonResult({ ok: false, code: "PLAN_NOT_FOUND", error: `找不到計畫 ${planId}` });
      if (!sameProject(plan, currentProject)) return jsonResult({ ok: false, code: "CROSS_PROJECT", error: `跨專案的關聯操作被擋下。目前的專案是 ${currentProject.projectId}。` });
      //  — invariant：
      // 對 finished Plan（CANCELLED / COMPLETED / FAILED）一律不再 plan-task-link。
      // 先前版本有「restoration exception」（dependsOn / blockedBy 命中此 plan 的
      // 任一 completion tombstone 即放行），會讓 active task 被加回
      // plan.taskIds → inspectPlanRegistry Check 3 報
      // `finished-plan-active-linked-task` error。tombstone 語意已由
      // `isDependencySatisfied` / `validateTaskLinkReferences`（透過
      // `isTaskResolvable`）對 active Plan 認知；finished Plan 不需要此例外，
      // 一律拒絕以保持 source-of-truth 乾淨。
      if (plan.state === "ARCHIVING") {
        return jsonResult({ ok: false, code: "PLAN_NOT_LINKABLE", error: `計畫 ${planId} 目前是 ARCHIVING，不能再關聯任務。請用 plan-state-sync 的 resume 事件（ARCHIVING → IN_PROGRESS）復原後再關聯，且要填 reason。` });
      }
      if (isFinishedPlanState(plan.state)) {
        return jsonResult({ ok: false, code: "PLAN_NOT_LINKABLE", error: `計畫 ${planId} 目前是 ${plan.state}（終態），不能再關聯任務。改用新的計畫。` });
      }

      const task = taskRegistry.tasks[taskId];
      if (!task) return jsonResult({ ok: false, code: "TASK_NOT_FOUND", error: `找不到任務 ${taskId}` });
      if (!sameProject(task, currentProject)) return jsonResult({ ok: false, code: "CROSS_PROJECT", error: `跨專案的關聯操作被擋下。目前的專案是 ${currentProject.projectId}。` });

      const candidate: Task = {
        ...task,
        planId,
        taskType: taskType !== undefined ? taskType : task.taskType,
        parentTaskId: parentTaskId !== undefined ? (parentTaskId === "" ? null : parentTaskId) : task.parentTaskId,
        dependsOn: dependsOn !== undefined ? dependsOn : task.dependsOn,
        blockedBy: blockedBy !== undefined ? blockedBy : task.blockedBy,
        parallelGroup: parallelGroup !== undefined ? (parallelGroup === "" ? null : parallelGroup) : task.parallelGroup,
        planStep: planStep !== undefined ? planStep : task.planStep,
        acceptanceCriteria: acceptanceCriteria !== undefined ? acceptanceCriteria : task.acceptanceCriteria,
        updatedAt: new Date().toISOString(),
      };
      //  — tombstone 處理變更：
      // 不再把 tombstoned dep 復活成 live task（先前會寫入 taskRegistry.tasks 並
      // 透過 writeRegistry 持久化為 owner/priority="—" 的 placeholder）。
      // candidateRegistry 只包含原 taskRegistry tasks + 當下 candidate，
      // 讓 `validateTaskLinkReferences` 直接以 `isTaskResolvable(...,plan)` 認知
      // tombstone，不誤判 TASK_NOT_FOUND。cycle finder 在 `findDependencyCycle`
      // 已容忍 missing node（見 gates/plan-link-validation.ts:221）。
      const candidateRegistry: TasksRegistry = {
        ...taskRegistry,
        tasks: {
          ...taskRegistry.tasks,
          [taskId]: candidate,
        },
      };
      const inconsistencies = validateTaskLinkReferences(candidate, {
        taskRegistry: candidateRegistry,
        currentProject,
        plan,
      });
      if (inconsistencies.length > 0) {
        return jsonResult({ ok: false, code: "INVALID_LINK_REFERENCES", inconsistencies }, null, 2);
      }

      // Update task fields
      if (planId !== undefined) task.planId = planId;
      if (taskType !== undefined) task.taskType = taskType;
      if (parentTaskId !== undefined) task.parentTaskId = parentTaskId === "" ? null : parentTaskId;
      if (dependsOn !== undefined) task.dependsOn = dependsOn;
      if (blockedBy !== undefined) task.blockedBy = blockedBy;
      if (parallelGroup !== undefined) task.parallelGroup = parallelGroup === "" ? null : parallelGroup;
      if (planStep !== undefined) task.planStep = planStep;
      if (acceptanceCriteria !== undefined) task.acceptanceCriteria = acceptanceCriteria;
      task.updatedAt = new Date().toISOString();

      // Update subtask list on parent
      if (parentTaskId && parentTaskId !== "") {
        const parent = taskRegistry.tasks[parentTaskId];
        if (parent) {
          if (!parent.subTaskIds) parent.subTaskIds = [];
          if (!parent.subTaskIds.includes(taskId)) {
            parent.subTaskIds = uniq([...parent.subTaskIds, taskId]);
          }
        }
      }

      // Update plan.taskIds (dedup)
      if (!plan.taskIds.includes(taskId)) {
        plan.taskIds = uniq([...plan.taskIds, taskId]);
      }

      // Sync dependencyGraph nodes
      const existingNode = plan.dependencyGraph.nodes.find(n => n.taskId === taskId);
      if (!existingNode) {
        plan.dependencyGraph.nodes.push({ id: taskId, taskId, title: task.title });
      } else {
        existingNode.title = task.title;
      }

      // Sync dependencyGraph edges for dependsOn
      if (dependsOn !== undefined) {
        plan.dependencyGraph.edges = plan.dependencyGraph.edges.filter(
          e => !(e.target === taskId && e.type === "depends_on")
        );
        for (const dep of dependsOn) {
          plan.dependencyGraph.edges.push({ source: dep, target: taskId, type: "depends_on" });
        }
      }

      // 去除重複的邊。key 必須含 `type`：邊是有型別的（`PlanDependencyGraphEdge.type`），
      // 同一對起訖點之間可以有不只一種關係。只比對起訖點的話，日後只要新增
      // 第二種關係型別，A→B 的兩條不同型別的邊就會被默默砍掉一條，而且不報錯。
      // 目前全系統只寫得出 `depends_on`，所以這個 key 的行為與只比對起訖點等價。
      const seenEdges = new Set<string>();
      plan.dependencyGraph.edges = plan.dependencyGraph.edges.filter(e => {
        const key = `${e.source}->${e.target}#${e.type}`;
        if (seenEdges.has(key)) return false;
        seenEdges.add(key);
        return true;
      });

      plan.updatedAt = new Date().toISOString();

      //  — 父 Plan auto-promotion：
      // 若 linked task 已是 IN_PROGRESS 且 plan.state === "PLANNED"，自動升級。
      // BLOCKED 不自動解除。
      let autoPromoted = false;
      if (task.state === "IN_PROGRESS" && plan.state === "PLANNED") {
        const nowIso = new Date().toISOString();
        plan.state = "IN_PROGRESS";
        plan.updatedAt = nowIso;
        plan.history.push(`| ${nowIso} | PLANNED → IN_PROGRESS | — | auto-promoted by linked task IN_PROGRESS |`);
        plan.history = plan.history.slice(-3);
        autoPromoted = true;
      }
      control.commit();

      return jsonResult({ ok: true, planId, taskId, task: { planId: task.planId, taskType: task.taskType, parentTaskId: task.parentTaskId, subTaskIds: task.subTaskIds, dependsOn: task.dependsOn, blockedBy: task.blockedBy, parallelGroup: task.parallelGroup, planStep: task.planStep }, plan: { taskIds: plan.taskIds, nodeCount: plan.dependencyGraph.nodes.length, edgeCount: plan.dependencyGraph.edges.length }, autoPromoted }, null, 2);
      });
      await runtime.updateStateMd(runtime.readRegistry(context), context);
      return result;
    }
  });
}
