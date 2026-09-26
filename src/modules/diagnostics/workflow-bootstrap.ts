/**
 * `workflow_bootstrap`：讀專案記憶（project.md、state.md）大小與游標摘要。
 *
 * 凍結介面（與舊版一致）：
 *   - 名稱 `workflow_bootstrap`；參數 `{ mode?: "minimal" | "full" | "project" | "state" }`。
 *   - 回傳外框走 `jsonResult`，`data` 內含 `ok / mode / project / l1_summary /
 *     registry_summary / hint`（非 minimal 模式多帶 `l1_content`）。
 *
 * 與舊版的刻意落差：`registry_summary.refs` 指向 `.ultrawork/*`。
 * 舊版硬編 `.opencode/memory/*`，那是 V1 的資料層位置；V2 全部落在
 * `<專案根目錄>/.ultrawork/`。照抄舊字串會讓診斷輸出指向不存在的檔案。
 *
 * 唯讀：只算檔案長度與讀 registry，不寫任何檔案。
 */

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { defineTool } from "../../kit/define-tool.ts";
import { jsonResult } from "../../kit/json.ts";
import { FINISHED_PLAN_LIMIT, FINISHED_TASK_LIMIT } from "../workflow/index.ts";
import type { DiagnosticsDeps } from "./deps.ts";
import { fileSize, readPlansForDiagnostics, readTasksForDiagnostics } from "./shared.ts";

/** bootstrap mode 合法值。 */
export type WorkflowBootstrapMode = "minimal" | "full" | "project" | "state";

/** 資料層引用；位置隨資料層版本走，V2 是 `.ultrawork/`。 */
const REFS = {
  tasks: ".ultrawork/tasks.json",
  plans: ".ultrawork/plans.json",
  state: ".ultrawork/state.md",
  project: ".ultrawork/project.md",
} as const;

/** 終態集合；counts 與 currentXxx 的選取都用它。 */
const FINISHED_STATES = ["COMPLETED", "FAILED", "CANCELLED"] as const;

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

export function createWorkflowBootstrapTool(deps: DiagnosticsDeps) {
  return defineTool({
    name: "workflow_bootstrap",
    description:
      "讀取專案記憶（project.md、state.md）並回傳工作階段與任務摘要。預設 minimal 模式只回傳游標摘要，不讀取完整檔案以節省 token；需要診斷時可使用 full、project 或 state 模式。",
    inputSchema: z.object({
      mode: z.enum(["minimal", "full", "project", "state"]).optional(),
    }),
    execute: async (input, context) => {
      const mode: WorkflowBootstrapMode = input.mode ?? "minimal";
      const paths = deps.runtime.getPaths(context);
      const { registry: tasks, project } = readTasksForDiagnostics(deps, context);
      const { plans } = readPlansForDiagnostics(deps, context);

      // 專案記憶檔案大小（不讀全文，避免 token 爆量）
      const projectMdSize = fileSize(paths.PROJECT_MD);
      const stateMdSize = fileSize(paths.STATE_MD);
      const tasksJsonSize = fileSize(paths.TASKS_JSON);
      const plansJsonSize = fileSize(paths.PLANS_JSON);

      // 游標投影：只回當前任務／計畫摘要，不展開整個進行中清單。
      const currentTaskId =
        tasks.taskCursor && tasks.activeTaskIds.includes(tasks.taskCursor)
          ? tasks.taskCursor
          : (tasks.activeTaskIds[0] ?? null);
      const currentTask = currentTaskId ? tasks.tasks[currentTaskId] : null;
      const currentPlanId =
        plans.planCursor && plans.plans[plans.planCursor] ? plans.planCursor : null;
      const currentPlan = currentPlanId ? plans.plans[currentPlanId] : null;

      const counts = {
        active_tasks: tasks.activeTaskIds.length,
        active_plans: plans.activePlanIds.length,
        recent_finished_tasks: Object.values(tasks.tasks).filter((task) =>
          (FINISHED_STATES as readonly string[]).includes(task.state),
        ).length,
        recent_finished_plans: Object.values(plans.plans).filter((plan) =>
          (FINISHED_STATES as readonly string[]).includes(plan.state),
        ).length,
      };

      const minimal = {
        ok: true,
        mode,
        project: {
          projectId: project.projectId,
          projectPath: project.projectPath,
          memoryDir: paths.MEMORY_DIR,
        },
        l1_summary: {
          project_md_size: projectMdSize,
          state_md_size: stateMdSize,
          tasks_json_size: tasksJsonSize,
          plans_json_size: plansJsonSize,
          state_projection: "cursor" as const,
        },
        registry_summary: {
          currentTask: currentTask
            ? {
                taskId: currentTask.taskId,
                state: currentTask.state,
                title: currentTask.title || null,
                owner: currentTask.owner,
                priority: currentTask.priority,
                risk: currentTask.risk || null,
                reviewVerdict: currentTask.review?.verdict || null,
                planId: currentTask.planId || null,
              }
            : null,
          currentPlan: currentPlan
            ? {
                planId: currentPlan.planId,
                state: currentPlan.state,
                title: currentPlan.title || null,
              }
            : null,
          taskCursor: tasks.taskCursor || null,
          planCursor: plans.planCursor || null,
          counts,
          refs: REFS,
          finishedTaskLimit: FINISHED_TASK_LIMIT,
          finishedPlanLimit: FINISHED_PLAN_LIMIT,
        },
      };

      let hint: string;
      let l1Content:
        | { project_md: string | null; state_md: string | null; combined_chars: number }
        | undefined;

      if (mode === "minimal") {
        hint = "預設 minimal 模式不回傳專案記憶全文；需要診斷時可使用 full、project 或 state 模式。";
      } else {
        const wantProject = mode === "full" || mode === "project";
        const wantState = mode === "full" || mode === "state";
        const projectMd = wantProject ? readIfExists(paths.PROJECT_MD) : null;
        const stateMd = wantState ? readIfExists(paths.STATE_MD) : null;
        const combined = (projectMd?.length ?? 0) + (stateMd?.length ?? 0);
        l1Content = { project_md: projectMd, state_md: stateMd, combined_chars: combined };
        hint = `目前模式回傳完整專案記憶（共 ${combined} 字元）。一般工作階段建議使用 minimal 模式。`;
      }

      const output: Record<string, unknown> = { ...minimal, hint };
      if (l1Content) output.l1_content = l1Content;
      return jsonResult(output);
    },
  });
}
