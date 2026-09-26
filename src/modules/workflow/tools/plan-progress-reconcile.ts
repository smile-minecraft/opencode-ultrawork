import { jsonResult } from "../../../kit/json.ts";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../../kit/define-tool.ts";
type ToolContext = ToolExecutionContext;
import { assertSafeContentRoot, assertSafeProjectFile } from "../content/content-store.ts";
import { sameProject, uniq } from "../core/helpers.ts";
import type { Plan, Task } from "../core/types.ts";
import { computePlanCompletionStats } from "../registry/plan-completion.ts";
import type { UltraworkRuntimeContext } from "../runtime/context-builder.ts";

export type PlanProgressReconcileMode = "preview" | "apply";

interface CompletionSourceIssue {
  code:
    | "TOMBSTONE_NOT_LINKED"
    | "LIVE_TASK_CROSS_PROJECT"
    | "LIVE_TASK_PLAN_MISMATCH"
    | "LIVE_TOMBSTONE_STATE_CONFLICT"
    | "MISSING_LINKED_TASK_SOURCE"
    | "RAW_LINKED_TASK_CROSS_PROJECT"
    | "RAW_LINKED_TASK_ID_MISMATCH"
    | "RAW_LINKED_TASK_SOURCE_CONFLICT";
  taskId: string;
  detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readRawRegistry(projectRoot: string, plansDir: string, path: string):
  | { ok: true; registry: Record<string, unknown> }
  | { ok: false; error: string } {
  assertSafeContentRoot(projectRoot, plansDir);
  assertSafeProjectFile(projectRoot, plansDir, path);
  if (!existsSync(path)) return { ok: false, error: `找不到註冊檔：${path}` };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(parsed)
      ? { ok: true, registry: parsed }
      : { ok: false, error: `註冊檔 ${path} 必須是一個 JSON 物件。` };
  } catch {
    return { ok: false, error: `註冊檔 ${path} 不是有效的 JSON。` };
  }
}

function sameStringArray(a: unknown, b: readonly string[]): boolean {
  return Array.isArray(a)
    && a.length === b.length
    && a.every((value, index) => String(value) === b[index]);
}

function collectCompletionSourceIssues(
  plan: Plan,
  tasks: Record<string, Task>,
): CompletionSourceIssue[] {
  const issues: CompletionSourceIssue[] = [];
  const linkedIds = new Set(plan.taskIds);
  const tombstones = plan.completionTombstones ?? {};

  for (const taskId of Object.keys(tombstones)) {
    if (!linkedIds.has(taskId)) {
      issues.push({
        code: "TOMBSTONE_NOT_LINKED",
        taskId,
        detail: `Completion tombstone '${taskId}' is not present in plan.taskIds. Link or remove the invalid tombstone before applying reconciliation.`,
      });
    }
  }

  for (const taskId of uniq(plan.taskIds)) {
    const live = tasks[taskId];
    if (!live) {
      if (!tombstones[taskId]) {
        issues.push({
          code: "MISSING_LINKED_TASK_SOURCE",
          taskId,
          detail: `Linked task '${taskId}' has neither a live registry record nor a completion tombstone. Restore or unlink the task before applying reconciliation.`,
        });
      }
      continue;
    }
    if (!sameProject(live, plan)) {
      issues.push({
        code: "LIVE_TASK_CROSS_PROJECT",
        taskId,
        detail: `Live task '${taskId}' does not match the target Plan project binding.`,
      });
    }
    if (live.planId && live.planId !== plan.planId) {
      issues.push({
        code: "LIVE_TASK_PLAN_MISMATCH",
        taskId,
        detail: `Live task '${taskId}' points to plan '${live.planId}', not '${plan.planId}'.`,
      });
    }
    const tombstone = tombstones[taskId];
    if (tombstone && live.state !== tombstone.state) {
      issues.push({
        code: "LIVE_TOMBSTONE_STATE_CONFLICT",
        taskId,
        detail: `Live task state '${live.state}' conflicts with tombstone state '${tombstone.state}'. Resolve the source conflict before applying reconciliation.`,
      });
    }
  }

  return issues;
}

export function createPlanProgressReconcileTool(runtime: UltraworkRuntimeContext) {
  return defineTool({
    name: "plan-progress-reconcile",
    description:
      "預覽或實際修復單一計畫的 finishedTaskIds 相容索引，依據是現存的終態任務和終結標記。預設 preview；不會動到任務或計畫的狀態、依賴、更新紀錄、終結標記或 state.md。",
    inputSchema: z.object({
      planId: z.string(),
      mode: z.enum(["preview", "apply"]).optional(),
    }),
    async execute({ planId, mode }, context) {
      const effectiveMode: PlanProgressReconcileMode = mode ?? "preview";
      const targetPlanId = (planId ?? "").trim();
      if (!targetPlanId) {
        return jsonResult({
          ok: false,
          code: "PLAN_ID_REQUIRED",
          error: "需要 planId，而且不能是空字串。",
        }, null, 2);
      }

      const currentProject = runtime.getCurrentProject(context);
      const result = await runtime.transactRegistries(context, async ({ plans: planRegistry, tasks: taskRegistry }, control) => {
      const plan = planRegistry.plans[targetPlanId];
      if (!plan) {
        return jsonResult({
          ok: false,
          code: "PLAN_NOT_FOUND",
          error: `目前的專案裡找不到計畫 ${targetPlanId}。`,
        }, null, 2);
      }
      if (!sameProject(plan, currentProject)) {
        return jsonResult({
          ok: false,
          code: "CROSS_PROJECT_REJECTED",
          error: `跨專案的核對被擋下。目前的專案是 ${currentProject.projectId}。`,
        }, null, 2);
      }

      const root = runtime.resolveProjectRoot(context);
      if (runtime.isUnsafeRoot(root)) {
        return jsonResult({
          ok: false,
          code: "UNSAFE_PROJECT_ROOT",
          error: `專案根目錄不安全，不能在這裡執行核對：${root}`,
        }, null, 2);
      }
      const { PLANS_JSON, TASKS_JSON, PLANS_DIR } = runtime.getPaths(context);
      const rawPlansResult = readRawRegistry(root, PLANS_DIR, PLANS_JSON);
      if (!rawPlansResult.ok) {
        return jsonResult({ ok: false, code: "RAW_PLAN_REGISTRY_INVALID", error: rawPlansResult.error }, null, 2);
      }
      const rawPlansRegistry = rawPlansResult.registry;
      if (
        typeof rawPlansRegistry.version !== "string"
        || typeof rawPlansRegistry.projectId !== "string"
        || typeof rawPlansRegistry.projectPath !== "string"
        || !sameProject(rawPlansRegistry as unknown as { projectId: string; projectPath: string }, currentProject)
        || !isRecord(rawPlansRegistry.plans)
      ) {
        return jsonResult({
          ok: false,
          code: "RAW_PLAN_REGISTRY_INVALID",
          error: "plans.json 的檔頭、專案綁定、或 plans 對照表格式不對。",
        }, null, 2);
      }
      const rawPlans = rawPlansRegistry.plans;
      const matchingPlanEntries = Object.entries(rawPlans).filter(([, candidate]) =>
        isRecord(candidate) && candidate.planId === targetPlanId
      );
      const rawPlan = rawPlans[targetPlanId];
      if (
        matchingPlanEntries.length !== 1
        || matchingPlanEntries[0][0] !== targetPlanId
        || !isRecord(rawPlan)
        || rawPlan.planId !== targetPlanId
      ) {
        return jsonResult({
          ok: false,
          code: "PLAN_SOURCE_IDENTITY_MISMATCH",
          error: "plans.json 的 key 和內部 planId 兜不出唯一一個指定的計畫。",
        }, null, 2);
      }
      if (
        typeof rawPlan.projectId !== "string"
        || typeof rawPlan.projectPath !== "string"
        || !sameProject(rawPlan as unknown as { projectId: string; projectPath: string }, currentProject)
        || !sameStringArray(rawPlan.taskIds, plan.taskIds)
        || !sameStringArray(rawPlan.finishedTaskIds, plan.finishedTaskIds)
      ) {
        return jsonResult({
          ok: false,
          code: "PLAN_SOURCE_IDENTITY_MISMATCH",
          error: "原始的計畫綁定、或關鍵的完成狀態來源，和正規化後的目標計畫對不上。",
        }, null, 2);
      }

      const rawTombstones = rawPlan.completionTombstones;
      if (rawTombstones !== undefined && !isRecord(rawTombstones)) {
        return jsonResult({ ok: false, code: "RAW_PLAN_REGISTRY_INVALID", error: "目標計畫的 completionTombstones 必須是一個物件。" }, null, 2);
      }
      for (const [taskId, value] of Object.entries(rawTombstones ?? {})) {
        if (
          !isRecord(value)
          || !["COMPLETED", "FAILED", "CANCELLED"].includes(String(value.state))
          || typeof value.finishedAt !== "string"
          || !value.finishedAt
        ) {
          return jsonResult({
            ok: false,
            code: "RAW_PLAN_REGISTRY_INVALID",
            error: `目標計畫裡「${taskId}」的終結標記格式不對。`,
          }, null, 2);
        }
      }

      const rawTasksResult = readRawRegistry(root, PLANS_DIR, TASKS_JSON);
      if (!rawTasksResult.ok) {
        return jsonResult({ ok: false, code: "RAW_TASK_REGISTRY_INVALID", error: rawTasksResult.error }, null, 2);
      }
      const rawTasksRegistry = rawTasksResult.registry;
      if (
        typeof rawTasksRegistry.version !== "string"
        || typeof rawTasksRegistry.projectId !== "string"
        || typeof rawTasksRegistry.projectPath !== "string"
        || !sameProject(rawTasksRegistry as unknown as { projectId: string; projectPath: string }, currentProject)
        || !isRecord(rawTasksRegistry.tasks)
      ) {
        return jsonResult({
          ok: false,
          code: "RAW_TASK_REGISTRY_INVALID",
          error: "tasks.json header, project binding, or tasks map is invalid.",
        }, null, 2);
      }

      const issues = collectCompletionSourceIssues(plan, taskRegistry.tasks);
      const rawTasks = rawTasksRegistry.tasks;
      for (const taskId of uniq(plan.taskIds)) {
        const rawTask = rawTasks[taskId];
        if (rawTask === undefined) {
          if (taskRegistry.tasks[taskId]) {
            issues.push({
              code: "RAW_LINKED_TASK_SOURCE_CONFLICT",
              taskId,
              detail: `Normalized task '${taskId}' has no matching raw tasks.json entry.`,
            });
          }
          continue;
        }
        if (!isRecord(rawTask) || rawTask.taskId !== taskId) {
          issues.push({
            code: "RAW_LINKED_TASK_ID_MISMATCH",
            taskId,
            detail: `Raw tasks.json key '${taskId}' does not contain the same internal taskId.`,
          });
          continue;
        }
        if (
          typeof rawTask.projectId !== "string"
          || typeof rawTask.projectPath !== "string"
          || !sameProject(rawTask as unknown as { projectId: string; projectPath: string }, currentProject)
        ) {
          issues.push({
            code: "RAW_LINKED_TASK_CROSS_PROJECT",
            taskId,
            detail: `Raw linked task '${taskId}' does not match the current project binding.`,
          });
          continue;
        }
        const normalizedTask = taskRegistry.tasks[taskId];
        if (
          !normalizedTask
          || typeof rawTask.state !== "string"
          || rawTask.state !== normalizedTask.state
          || (rawTask.planId !== undefined && rawTask.planId !== normalizedTask.planId)
        ) {
          issues.push({
            code: "RAW_LINKED_TASK_SOURCE_CONFLICT",
            taskId,
            detail: `Raw linked task '${taskId}' does not match its normalized completion source.`,
          });
          continue;
        }
        const tombstone = plan.completionTombstones?.[taskId];
        if (tombstone && rawTask.state !== tombstone.state) {
          issues.push({
            code: "RAW_LINKED_TASK_SOURCE_CONFLICT",
            taskId,
            detail: `Raw linked task state '${rawTask.state}' conflicts with tombstone state '${tombstone.state}'.`,
          });
        }
      }
      if (issues.length > 0) {
        return jsonResult({
          ok: false,
          code: "INVALID_COMPLETION_SOURCES",
          error: "計畫的完成狀態來源彼此不一致。先把下面列出的問題都解掉，再執行核對。",
          planId: targetPlanId,
          mode: effectiveMode,
          issues,
        }, null, 2);
      }

      const stats = computePlanCompletionStats(plan, taskRegistry);
      const completed = new Set([...stats.liveFinishedIds, ...stats.tombstonedIds]);
      const after = uniq(plan.taskIds).filter((taskId) => completed.has(taskId));
      const before = Array.isArray(plan.finishedTaskIds) ? [...plan.finishedTaskIds] : [];
      const beforeSet = new Set(before);
      const afterSet = new Set(after);
      const added = after.filter((taskId) => !beforeSet.has(taskId));
      const removed = before.filter((taskId) => !afterSet.has(taskId));
      const changed = before.length !== after.length || before.some((taskId, index) => taskId !== after[index]);
      let applied = false;

      if (effectiveMode === "apply" && changed) {
        // 落盤目標必須是 transaction draft 內的 plan（`plan` 即
        // `planRegistry.plans[targetPlanId]` 的參照）；改到底層 raw 物件
        // 不會被 commit 管線寫回，會造成 applied:true 但磁碟不變。
        plan.finishedTaskIds = after;
        plan.updatedAt = new Date().toISOString();
        control.commit();
        applied = true;
      }

      return jsonResult({
        ok: true,
        planId: targetPlanId,
        mode: effectiveMode,
        before,
        after,
        added,
        removed,
        changed,
        applied,
        sources: {
          liveFinishedIds: stats.liveFinishedIds,
          tombstonedIds: stats.tombstonedIds,
          missingIds: stats.missingIds,
        },
        hint: applied
          ? "finishedTaskIds was rebuilt from canonical completion sources. No task/plan state, dependencies, receipts, tombstones, or state.md were changed."
          : (effectiveMode === "preview"
            ? "Preview only; rerun with mode='apply' to write this exact reconciliation."
            : "No write was needed because finishedTaskIds already matches canonical completion sources."),
      }, null, 2);
      });
      return result;
    },
  });
}
