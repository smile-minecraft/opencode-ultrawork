/**
 * opencode-ultrawork — runtime state projection (state.md writer)
 *
 * 角色：
 *     為 runtime module-level 函式，附掛於 `UltraworkRuntimeContext`。
 *   - `updateStateMd` 為「Cursor projection」寫入器：根據目前
 *     TasksRegistry + PlansRegistry + 當前 project binding 推導出
 *     `.ultrawork/state.md` 內容（含 frontmatter、project state
 *     section、counts、refs、preview blocks），並寫入檔案。
 *
 * 對外規則（不可破壞）：
 *   - `updateStateMd` 的行為（含讀取 plans registry / 不安全 root
 *     短路 / lazyEnsure / 3000 字元硬上限 / preview section 排序與截斷）
 *   - 唯一刻意的例外是 ready 判定：原本是本檔自己手寫的一份、不認完成終結
 *     標記，跟 `plan-next` 會對同一份資料給出不同的答案。現在一律委派給
 *     `registry/plan-completion.ts` 的 `isTaskStartable`，本檔**不得**再自己
 *   - 透過 `UltraworkRuntimeContext` 取得：當前 project binding、paths、
 *     registry IO、`debugLog`、`isUnsafeRoot` 等 primitive，避免在
 *     leaf module 內重新實作 closure-scoped 邏輯。
 *
 * 限制：
 *
 * @see ../../../../README.md                              — 模組一覽
 */

import { join } from "node:path";
import { assertSafeContentRoot, assertSafeProjectFile } from "../content/content-store.ts";
import { atomicWriteFile } from "../../../kit/atomic-write.ts";
import { withContentWriteLock } from "../../../kit/write-lock.ts";
import type { ToolExecutionContext } from "../../../kit/define-tool.ts";

type ToolContext = ToolExecutionContext;
import type { Task, PlansRegistry, TasksRegistry, Plan } from "../core/types.ts";
import { FINISHED_PLAN_LIMIT, FINISHED_TASK_LIMIT } from "../core/constants.ts";
import { isFinishedPlanState, isFinishedTaskState } from "../core/helpers.ts";
import { isTaskStartable, resolveTaskPlan } from "../registry/plan-completion.ts";
import type { RegistryRuntimeContext } from "./registry-io.ts";

/**
 * state-projection factory 接受的 context：RegistryRuntimeContext。
 *
 * 這裡只依賴 registry 層的介面（lazyEnsure / readPlansRegistry / ensureDir /
 * normalizeTasksRegistry / getCurrentProject / resolveProjectRoot / getPaths /
 * isUnsafeRoot / debugLog），不碰更上層的 runtime 組裝，state.md 的渲染因此可以
 * 獨立於 registry IO 測試。
 */
export type StateProjectionRuntimeContext = RegistryRuntimeContext;

/**
 * 將 Task 渲染為單行 markdown（`updateStateMd` 內 preview section 使用）。
 *
 * 與 closure 原版本完全一致：
 *   - `${task.taskId}(${task.state})${task.planId ? \`/${task.planId}\` : ""}: ${task.title || "Untitled"}`
 *
 * module-level private helper；目前僅供 `updateStateMd` 內部使用，不對外 export。
 *
 * 註：closure 原版另有同名 `planLine`（plan preview 格式），但實際上於
 * `updateStateMd` 內從未被呼叫過（屬 dead code），故此處省略。
 */
function taskLine(task: Task): string {
  return `${task.taskId}(${task.state})${task.planId ? `/${task.planId}` : ""}: ${task.title || "Untitled"}`;
}

/**
 * 判斷 task 是否處於 ready 狀態。供 `updateStateMd` 計算 `ready_tasks` 數量
 * 與 Ready Preview section 使用。
 *
 * 這裡原本是一份手寫的判定，而且不認完成終結標記：依賴只要被
 * `FINISHED_TASK_LIMIT` 裁出任務清單，它就在 `normalizedRegistry.tasks`
 * 裡找不到，於是判定為未完成——`plan-next` 說可以開始的任務，`ready_tasks`
 * 卻不算它。現在一律委派給 `isTaskStartable`，兩個消費端共用同一套判準。
 */
function isTaskReady(task: Task, normalizedRegistry: TasksRegistry, plansRegistry: PlansRegistry): boolean {
  return isTaskStartable(task, normalizedRegistry, resolveTaskPlan(task, plansRegistry)).startable;
}

/**
 * 將指定 TasksRegistry 投影為 `.ultrawork/state.md` 的內容並寫入。
 *
 * 流程：
 *   1. 解析 project root；若屬 unsafe root（`isUnsafeRoot`）則靜默返回
 *      （與原 closure 行為一致）。
 *   2. 呼叫 `runtime.lazyEnsure(context)` 保證 專案記憶 目錄存在。
 *   3. 透過 `runtime.readPlansRegistry(context, false)` 取得 plans。
 *   4. 計算 active/inProgress/pending/blocked/ready 任務統計與 plan 統計。
 *   5. 組合 markdown（含 frontmatter + Project State + Counts + Refs +
 *      Ready Preview / Blocked Preview），並以 3000 字元為硬上限；
 *      超過時砍掉整個 preview section（保留 baseLines）。
 *
 * 此為 runtime module-level 函式，呼叫端需提供 `UltraworkRuntimeContext`。
 */
export function createStateProjection(runtime: StateProjectionRuntimeContext) {
  return async function updateStateMd(registry: TasksRegistry, context?: ToolContext): Promise<void> {
    const root = runtime.resolveProjectRoot(context);
    if (runtime.isUnsafeRoot(root)) {
      runtime.debugLog(`updateStateMd skipped: unsafe root ${root}`);
      return;
    }
    const { PLANS_DIR } = runtime.getPaths(context);
    assertSafeContentRoot(root, PLANS_DIR);
    runtime.lazyEnsure(context);
    const { MEMORY_DIR, STATE_MD } = runtime.getPaths(context);
    assertSafeProjectFile(root, PLANS_DIR, STATE_MD);
    const currentProject = runtime.getCurrentProject(context);
    const normalizedRegistry = runtime.normalizeTasksRegistry(registry, currentProject);
    const plansRegistry: PlansRegistry = runtime.readPlansRegistry(context, false);
    // Ensure MEMORY_DIR exists
    runtime.ensureDir(MEMORY_DIR, context);
    const lockDir = join(MEMORY_DIR, "cache", "locks");
    const lockPath = join(lockDir, "state.lock");
    assertSafeProjectFile(root, PLANS_DIR, lockDir);
    runtime.ensureDir(lockDir, context);
    assertSafeProjectFile(root, PLANS_DIR, lockPath);
    return withContentWriteLock(lockPath, async () => {

    // Cursor projection: 只取 cursor 與 counts，不再列完整 active task dashboard。
    const activeTasks = Object.values(normalizedRegistry.tasks)
      .filter((task) => !isFinishedTaskState(task.state));
    const inProgressTasks = activeTasks.filter((task) => !["NEW", "CLARIFYING", "PLANNED"].includes(task.state));
    const pendingTasks = activeTasks.filter((task) => ["NEW", "CLARIFYING", "PLANNED"].includes(task.state));
    const recentFinishedTasks = Object.values(normalizedRegistry.tasks)
      .filter((task) => isFinishedTaskState(task.state))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, FINISHED_TASK_LIMIT);
    const blockedTasks = activeTasks.filter((task) => task.state === "BLOCKED");
    const currentTaskId = normalizedRegistry.taskCursor && normalizedRegistry.activeTaskIds.includes(normalizedRegistry.taskCursor)
      ? normalizedRegistry.taskCursor
      : (activeTasks[0]?.taskId ?? null);
    const currentTask: Task | null = currentTaskId ? normalizedRegistry.tasks[currentTaskId] : null;

    const activePlans = Object.values(plansRegistry.plans)
      .filter((plan) => !isFinishedPlanState(plan.state));
    const recentFinishedPlans = Object.values(plansRegistry.plans)
      .filter((plan) => isFinishedPlanState(plan.state))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, FINISHED_PLAN_LIMIT);

    const readyTasks = activeTasks.filter((task) => isTaskReady(task, normalizedRegistry, plansRegistry));
    const currentPlan: Plan | null = plansRegistry.planCursor && plansRegistry.plans[plansRegistry.planCursor]
      ? plansRegistry.plans[plansRegistry.planCursor]
      : null;

    // Build the new content (cursor projection)
    const lines: string[] = [];

    // Frontmatter
    lines.push("---");
    lines.push("description: Durable memory block. Cursor projection — keep this concise and high-signal.");
    lines.push("label: state");
    lines.push("limit: 3000");
    lines.push("read_only: false");
    lines.push("---");

    // Project State — 只留 cursor 與當下資訊
    lines.push("# Project State");
    lines.push("");
    lines.push(`state: ${currentTask ? currentTask.state : "IDLE"}`);
    lines.push(`task_id: ${currentTask ? currentTask.taskId : "—"}`);
    if (currentTask) {
      lines.push(`task_title: ${currentTask.title || "Untitled"}`);
      lines.push(`owner: ${currentTask.owner || "—"}`);
      lines.push(`priority: ${currentTask.priority || "—"}`);
      // 接手的 session 必須一眼看到這是不是申報過的高風險任務，
      // 否則它不會知道結案前還有一關審查要走。
      lines.push(`risk: ${currentTask.risk || "—"}`);
    } else {
      lines.push(`owner: —`);
      lines.push(`priority: —`);
      lines.push(`risk: —`);
    }
    if (currentPlan) {
      lines.push(`current_plan: ${currentPlan.planId} (${currentPlan.state}): ${currentPlan.title || "Untitled"}`);
    } else {
      lines.push(`current_plan: —`);
    }
    lines.push("");
    lines.push("## Counts");
    lines.push(`active_tasks: ${activeTasks.length}`);
    lines.push(`in_progress_tasks: ${inProgressTasks.length}`);
    lines.push(`pending_tasks: ${pendingTasks.length}`);
    lines.push(`blocked_tasks: ${blockedTasks.length}`);
    lines.push(`ready_tasks: ${readyTasks.length}`);
    lines.push(`active_plans: ${activePlans.length}`);
    lines.push(`recent_finished_tasks: ${recentFinishedTasks.length}`);
    lines.push(`recent_finished_plans: ${recentFinishedPlans.length}`);
    lines.push("");
    lines.push("## Refs");
    lines.push(`project_id: ${currentProject.projectId}`);
    lines.push(`project_path: ${currentProject.projectPath}`);
    lines.push(`registry_ref: .ultrawork/tasks.json`);
    lines.push(`task_cursor: ${normalizedRegistry.taskCursor || "—"}`);
    lines.push(`plans_ref: .ultrawork/plans.json`);
    lines.push(`plan_cursor: ${plansRegistry.planCursor || "—"}`);
    lines.push(`finished_task_limit: ${FINISHED_TASK_LIMIT}`);
    lines.push(`finished_plan_limit: ${FINISHED_PLAN_LIMIT}`);
    lines.push(`last_sync: ${new Date().toISOString()}`);

    // 紀錄 base line 數量，作為超長 fallback 的截斷點（完整移除 preview section）
    const baseLineCount = lines.length;

    // Preview sections (最多 3 筆，避免塞爆 3000 字元)
    if (readyTasks.length > 0) {
      lines.push("");
      lines.push("## Ready Preview");
      readyTasks.slice(0, 3).forEach((task) => lines.push(`- ${taskLine(task)}`));
    }
    if (blockedTasks.length > 0) {
      lines.push("");
      lines.push("## Blocked Preview");
      blockedTasks.slice(0, 3).forEach((task) => lines.push(`- ${taskLine(task)}`));
    }

    let content = lines.join("\n").trim() + "\n";
    // 3000 字元硬上限：超長時砍掉整個 preview section（heading + list items），保留 baseLines。
    if (content.length > 3000) {
      content = lines.slice(0, baseLineCount).join("\n").trim() + "\n";
    }
    assertSafeProjectFile(root, PLANS_DIR, STATE_MD);
    atomicWriteFile(STATE_MD, content.slice(0, 3000));
    });
  };
}
