import { jsonResult } from "../../../kit/json.ts";
/**
 * opencode-ultrawork — plan-status tool factory
 *
 * 角色：
 *     公開工具定義。回傳單一 plan（指定 planId）或全部 active plans
 *     的進度、子任務、orphan、inconsistencies 報告。
 *
 * 對外規則（不可破壞）：
 *   - tool name / args schema / execute 固定外層 JSON 格式必須維持一致
 *     （含 taskId 列表、progress 百分比、subtasks 排序、orphans /
 *     inconsistencies 結構）。
 *   - 單一計畫查詢的 `plan` / `tasks` / `subtasks` / `orphans` 預設為投影
 *     （`projection: "summary"`，少 history / dependencyGraph / 重複的專案身分），
 *     `verbose: true` 回完整物件（`projection: "full"`）。筆數與統計欄位不受
 *     投影影響。見 ./context-projection.ts。
 *   - 透過 `UltraworkRuntimeContext` 取得 registry IO，行為與 closure
 *     原版本完全一致。
 *     僅由 index.ts 反向引用；引入反向 import 會形成循環依賴。
 *
 * 設計重點：
 *   - 採 factory 形式（`createPlanStatusTool(runtime)`），接受 runtime
 *     context 注入；tool 內所有 IO 與 path 推導皆透過 `runtime.*`，
 *     不持有 closure-scoped 狀態。
 *   - `collectPlanInconsistencies` 自 `../gates/plan-link-validation.ts`
 *     引入；`isFinishedPlanState` / `isFinishedTaskState` 自
 *     `../core/helpers.ts` 引入。
 *
 * @see ../../../../README.md                              — 模組一覽
 */

import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../../kit/define-tool.ts";
type ToolContext = ToolExecutionContext;
import type { UltraworkRuntimeContext } from "../runtime/context-builder.ts";
import { isFinishedPlanState, isFinishedTaskState } from "../core/helpers.ts";
import { collectPlanInconsistencies } from "../gates/plan-link-validation.ts";
import { computePlanCompletionStats } from "../registry/plan-completion.ts";
import { projectPlan, projectTasks, type ProjectionMode } from "./context-projection.ts";

/**
 * 建立 `plan_status` tool。
 *
 * behavior-preserving extraction：行為、args schema、固定外層 JSON 回覆
 * 完全等價。
 *
 * ：
 *   - `totalCount` 固定為 `plan.taskIds.length`（不受 prune 影響）。
 *   - `finishedCount` 含 live terminal + tombstoned。
 *   - 新增 `liveIds / tombstonedIds / missingIds` 結構供 caller debug。
 *   - `progress` 由 `computePlanCompletionStats` 統一計算（與 plan-next 一致）。
 */
export function createPlanStatusTool(runtime: UltraworkRuntimeContext) {
  return defineTool({
    name: "plan-status",
    description: "查詢計畫進度、任務、子任務、未歸屬項目與資料不一致問題。",
    inputSchema: z.object({
      planId: z.string().optional(),
      verbose: z.boolean().optional().describe(
        "預設回投影的計畫與任務欄位（不含 history、dependencyGraph 與每筆重複的專案身分）。要完整物件時才傳 true。",
      ),
    }),
    async execute({ planId, verbose }, context) {
      const planRegistry = runtime.readPlansRegistry(context, false);
      const taskRegistry = runtime.readRegistry(context, false);
      const currentProject = runtime.getCurrentProject(context);

      if (planId) {
        const plan = planRegistry.plans[planId];
        if (!plan) return jsonResult({ ok: false, code: "PLAN_NOT_FOUND", error: `找不到計畫 ${planId}` });
        // Invariant：tasks / subtasks 仍以
        // live registry 為主；tombstone 在 completionStats 內揭露。
        const tasks = plan.taskIds.map(id => taskRegistry.tasks[id]).filter(Boolean);
        const subtasks = tasks.flatMap(t => (t.subTaskIds || []).map(sid => taskRegistry.tasks[sid])).filter(Boolean);
        const stats = computePlanCompletionStats(plan, taskRegistry);
        const finishedTasks = tasks.filter(t => isFinishedTaskState(t.state));
        const orphans = tasks.filter(t => !t.planId || t.planId !== planId);
        const inconsistencies = collectPlanInconsistencies(plan, taskRegistry, currentProject);
        // 預設回投影：計畫與任務一筆不少，只拿掉 history、dependencyGraph
        // 與每筆重複的專案身分。統計與不一致報告維持原樣。
        const projection: ProjectionMode = verbose === true ? "full" : "summary";
        return jsonResult({
          ok: true,
          projection,
          plan: projection === "full" ? plan : projectPlan(plan),
          tasks: projection === "full" ? tasks : projectTasks(tasks),
          subtasks: projection === "full" ? subtasks : projectTasks(subtasks),
          progress: stats.progress,
          finishedCount: stats.finishedCount,
          totalCount: stats.totalCount,
          liveIds: stats.liveIds,
          liveFinishedIds: stats.liveFinishedIds,
          tombstonedIds: stats.tombstonedIds,
          missingIds: stats.missingIds,
          orphans: projection === "full" ? orphans : projectTasks(orphans),
          inconsistencies,
        });
      }

      // Full status: all active plans
      const activePlans = Object.values(planRegistry.plans).filter(p => !isFinishedPlanState(p.state));
      const reports = activePlans.map(plan => {
        const stats = computePlanCompletionStats(plan, taskRegistry);
        return {
          planId: plan.planId,
          title: plan.title,
          state: plan.state,
          progress: stats.progress,
          totalCount: stats.totalCount,
          finishedCount: stats.finishedCount,
          liveFinishedIds: stats.liveFinishedIds,
          tombstonedIds: stats.tombstonedIds,
          missingIds: stats.missingIds,
          inconsistencies: collectPlanInconsistencies(plan, taskRegistry, currentProject),
        };
      });
      return jsonResult({ ok: true, plans: reports, activePlanIds: planRegistry.activePlanIds, planCursor: planRegistry.planCursor });
    }
  });
}
