/**
 * opencode-ultrawork — plan completion resolver helpers 
 *
 * 角色：
 *   - 為 Plan ↔ Task registry 提供**向後相容的 completion tombstone** 統一解析層。
 *   - 三種狀態：
 *       · live：task 仍在 `tasks.tasks` 內。
 *       · tombstone：task 已從 `tasks.tasks` 被 FINISHED_TASK_LIMIT prune，
 *         但在所屬 Plan 的 `completionTombstones` 保留 `{ state, finishedAt }`。
 *       · missing：兩處都沒有（真正缺漏）。
 *   - 解析結果供 `validateTaskLinkReferences` / `collectPlanInconsistencies` /
 *     `plan-next` / `plan-status` / `plan-task-link` 共用，避免重複實作導致語意漂移。
 *   - `isTaskStartable` 是「這個任務現在可以開始了嗎」的唯一入口，
 *     `plan-next` 與 `state.md` 投影都必須走它，不得各自再寫一份。
 *
 * 設計重點：
 *   - 純 module-level 函式，無 closure / IO 依賴。
 *   - `isDependencySatisfied` 對 tombstone state === "COMPLETED" 視為滿足，
 *     "FAILED" / "CANCELLED" 視為障礙（呼叫端需以 `blockingIds` 提供原因）。
 *   - migration/normalization 僅在「有可靠證據」時回填 tombstone：
 *     `recordCompletionTombstone` 只在尚無 tombstone 時寫入；不從未知 missing
 *     task 猜測補資料。
 *
 * 對外規則（不可破壞）：
 *   - 所有匯出函式為 pure；輸入相同則輸出相同。
 *   - 不寫任何檔案，不修改傳入的 `plan` 以外的物件。
 *   - `recordCompletionTombstone` 會 mutate 傳入的 `plan`（呼叫端需自行決定
 *     commit 時機）。
 *
 * 限制：
 *   - 僅依賴 `./../core/types.ts`、`./../core/helpers.ts`（isFinishedTaskState）
 *     與 `./../core/constants.ts`（STARTABLE_TASK_STATES）；三者皆為 pure leaf。
 *
 * @see ../core/types.ts                                          — PlanCompletionTombstone
 * @see ../gates/plan-link-validation.ts                          — TASK_NOT_FOUND 消費端
 * @see ../runtime/registry-io.ts                                  — atomic tombstone recording
 * @see ../tools/plan-next.ts                                      — resolver consumer
 * @see ../tools/plan-status.ts                                    — resolver consumer
 */

import type { Plan, PlanCompletionTombstone, PlansRegistry, Task, TasksRegistry } from "../core/types.ts";
import { isFinishedPlanState, isFinishedTaskState } from "../core/helpers.ts";
import { STARTABLE_TASK_STATES } from "../core/constants.ts";

/**
 * 單一 task 在 plan 內的完成狀態解析結果。
 *
 * 三種分支互斥，呼叫端可用 `switch (res.kind)` exhaustive 處理。
 */
export type CompletionResolution =
  | { kind: "live"; task: Task }
  | { kind: "tombstone"; tombstone: PlanCompletionTombstone; taskId: string }
  | { kind: "missing" };

/**
 * 統一解析單一 taskId 在 plan / task registry 的狀態。
 *
 * @param taskId 欲解析的 task ID
 * @param taskRegistry 當前 task registry（live 來源）
 * @param plan 該 task 所屬的 plan（tombstone 來源）
 */
export function resolveCompletion(
  taskId: string,
  taskRegistry: TasksRegistry,
  plan: Plan | null,
): CompletionResolution {
  const live = taskRegistry.tasks[taskId];
  if (live) return { kind: "live", task: live };
  const tombstone = plan?.completionTombstones?.[taskId];
  if (tombstone) return { kind: "tombstone", tombstone, taskId };
  return { kind: "missing" };
}

/**
 * 依賴障礙的種類。三種的處置完全不同，所以必須分得出來：
 *   - `failed`：依賴已經失敗或取消。等下去沒有用，要改依賴或另開替代任務。
 *   - `unfinished`：依賴還在進行中。等它做完就好。
 *   - `missing`：依賴既不在任務清單，也沒有完成終結標記。這是資料缺漏，
 *     要用狀態診斷去查，不是排程問題。
 */
export type DependencyBlockerKind = "failed" | "unfinished" | "missing";

/** 單一依賴障礙（taskId + 種類）。 */
export interface DependencyBlocker {
  taskId: string;
  kind: DependencyBlockerKind;
}

/** 依 `DependencyBlocker[]` 組出一句人看得懂、而且說得出下一步的原因。 */
function describeBlockers(blockers: readonly DependencyBlocker[]): string {
  const byKind = (kind: DependencyBlockerKind) =>
    blockers.filter((b) => b.kind === kind).map((b) => b.taskId);
  const parts: string[] = [];
  const failed = byKind("failed");
  const unfinished = byKind("unfinished");
  const missing = byKind("missing");
  if (failed.length > 0) {
    parts.push(`依賴的 ${failed.join("、")} 已經失敗或取消，等下去不會變成完成，要改依賴或另開替代任務`);
  }
  if (unfinished.length > 0) {
    parts.push(`依賴的 ${unfinished.join("、")} 還沒完成`);
  }
  if (missing.length > 0) {
    parts.push(`找不到依賴的 ${missing.join("、")}：任務清單裡沒有，計畫上也沒有對應的完成終結標記`);
  }
  return parts.join("；");
}

/**
 * 判斷 task 的 dependsOn 是否全部滿足。
 *
 * 規則（live 與完成終結標記共用同一套判準）：
 *   - 依賴為 COMPLETED → satisfied，不管它還在任務清單裡還是只剩完成終結標記。
 *   - 依賴為 FAILED / CANCELLED → 障礙（kind: "failed"），同樣不分 live 與標記。
 *   - 依賴尚未進入終態 → 障礙（kind: "unfinished"）。
 *   - 兩處都找不到 → 障礙（kind: "missing"）。
 *   - blockedBy 不納入本檢查（維持獨立語意，見 `isTaskStartable`）。
 *
 * 為什麼 live 的失敗也算障礙：
 *   這裡原本對 live 依賴問的是「結束了嗎」（`isFinishedTaskState`），於是
 *   FAILED / CANCELLED 會被當成滿足；可是同一個依賴一旦被
 *   `FINISHED_TASK_LIMIT` 裁成完成終結標記，判準又變成「必須是 COMPLETED」。
 *   同一條依賴，只因為資料被裁剪過，答案就相反。下游要的是上游的產出，
 *   失敗的上游沒有產出，所以統一收斂成「只有 COMPLETED 才算滿足」。
 *
 * @returns `{ satisfied: true }` 或
 *   `{ satisfied: false, blockingIds, blockers, reason }`。
 *   `blockingIds` 與 `blockers` 順序一致，前者保留給既有呼叫端。
 */
export function isDependencySatisfied(
  task: Task,
  taskRegistry: TasksRegistry,
  plan: Plan | null,
):
  | { satisfied: true }
  | { satisfied: false; blockingIds: string[]; blockers: DependencyBlocker[]; reason: string } {
  const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
  if (deps.length === 0) return { satisfied: true };

  const blockers: DependencyBlocker[] = [];
  for (const depId of deps) {
    const res = resolveCompletion(depId, taskRegistry, plan);
    if (res.kind === "live") {
      if (res.task.state === "COMPLETED") continue;
      blockers.push({ taskId: depId, kind: isFinishedTaskState(res.task.state) ? "failed" : "unfinished" });
      continue;
    }
    if (res.kind === "tombstone") {
      if (res.tombstone.state === "COMPLETED") continue;
      blockers.push({ taskId: depId, kind: "failed" });
      continue;
    }
    blockers.push({ taskId: depId, kind: "missing" });
  }

  if (blockers.length === 0) return { satisfied: true };
  return {
    satisfied: false,
    blockingIds: blockers.map((b) => b.taskId),
    blockers,
    reason: describeBlockers(blockers),
  };
}

/**
 * 「這個任務現在可以開始了嗎」的**唯一**判定入口。
 *
 * 為什麼要有這個函式：
 *   這個問題原本有三份分開寫的答案——`plan-next` 走
 *   `isDependencySatisfied`、`state.md` 的投影自己手寫了一份不認完成終結
 *   標記的 `isTaskReady`、而 `isDependencySatisfied` 自己對 live 與標記
 *   又用不同判準。同一份資料會得到不同的可開始清單，模型看到的「還有
 *   幾件事能做」因此取決於它是從哪個工具問的。三個消費端一律改走這裡。
 *
 * 判定順序（先擋的先回報，因為處置成本由低到高）：
 *   1. `STATE`：只有 NEW / PLANNED 算得上「還沒開始」。
 *   2. `BLOCKED_BY`：明確申報的障礙，優先於依賴——它通常是人為判斷的結果。
 *   3. `DEPENDS_ON`：依賴未滿足，細分見 `DependencyBlocker`。
 *
 * `blockedBy` 與 `dependsOn` 的差別是刻意的：`blockedBy` 指向的任務**不存在**
 * 時視同已解除（障礙消失了就是消失了），`dependsOn` 指向不存在的任務則是
 * 資料缺漏、必須擋下。這個不對稱由 53 號測試釘住。
 *
 * @param plan 任務所屬的計畫；獨立任務傳 `null`（沒有計畫就沒有完成終結標記）。
 */
export function isTaskStartable(
  task: Task,
  taskRegistry: TasksRegistry,
  plan: Plan | null,
):
  | { startable: true }
  | {
      startable: false;
      code: "STATE" | "BLOCKED_BY" | "DEPENDS_ON";
      reason: string;
      blockingIds: string[];
      blockers?: DependencyBlocker[];
    } {
  if (!STARTABLE_TASK_STATES.includes(task.state as (typeof STARTABLE_TASK_STATES)[number])) {
    return {
      startable: false,
      code: "STATE",
      reason: `任務目前是 ${task.state}，不在可開始的狀態（${STARTABLE_TASK_STATES.join(" / ")}）。`,
      blockingIds: [],
    };
  }

  const unresolvedBlockedBy = (task.blockedBy || []).filter((id) => {
    const blocker = taskRegistry.tasks[id];
    // 找不到的 blocker 視同已解除：障礙消失了就是消失了。
    return blocker && !isFinishedTaskState(blocker.state);
  });
  if (unresolvedBlockedBy.length > 0) {
    return {
      startable: false,
      code: "BLOCKED_BY",
      reason: `尚未解除的障礙：${unresolvedBlockedBy.join("、")}`,
      blockingIds: unresolvedBlockedBy,
    };
  }

  const depCheck = isDependencySatisfied(task, taskRegistry, plan);
  if (!depCheck.satisfied) {
    return {
      startable: false,
      code: "DEPENDS_ON",
      reason: depCheck.reason,
      blockingIds: depCheck.blockingIds,
      blockers: depCheck.blockers,
    };
  }

  return { startable: true };
}

/**
 * 找出某個 task 所屬的 Plan（給只拿得到整份 plans registry 的呼叫端用）。
 *
 * `state.md` 的投影是對整份 task registry 做的，手上沒有特定的 plan，但是
 * 完成終結標記掛在 plan 上，不先找到 plan 就讀不到標記——這正是投影那份
 * 判定會跟 `plan-next` 給出不同答案的原因。
 *
 * @returns 對應的 Plan；獨立任務（沒有 planId）或計畫已不存在時回 `null`。
 */
export function resolveTaskPlan(task: Task, plansRegistry: PlansRegistry): Plan | null {
  if (!task.planId) return null;
  return plansRegistry.plans[task.planId] ?? null;
}

/**
 * 判斷 task 是否「可解析」（存在於 tasks.json 或 tombstone）。
 *
 * 給 `validateTaskLinkReferences` / dangling-edge cleanup 等 consumer 使用，
 * 避免對合法 tombstone 誤報 TASK_NOT_FOUND / DANGLING_EDGE。
 */
export function isTaskResolvable(
  taskId: string,
  taskRegistry: TasksRegistry,
  plan: Plan,
): boolean {
  if (taskRegistry.tasks[taskId]) return true;
  if (plan.completionTombstones?.[taskId]) return true;
  return false;
}

/**
 * 在 plan 上記錄 completion tombstone（idempotent）。
 *
 * - 若已存在同名 tombstone，視為冪等（不覆寫既有 finishedAt/state）。
 * - 同時將 taskId 加入 `plan.finishedTaskIds`（如尚未存在），維持兩個索引一致。
 * - 更新 `plan.updatedAt` 為當前時間。
 *
 * 設計動機：
 *   - `task-state-sync` 終態轉換與 `writeRegistry` safety net 共用此函式。
 *   - 不主動 push history（plan.history 由 plan-state-sync 自行管理）。
 *
 * @param plan 欲寫入的 plan（會 mutate）
 * @param taskId 完成的 task ID
 * @param state 終態（"COMPLETED" | "FAILED" | "CANCELLED"）
 * @param finishedAt 完成時間（ISO 字串）
 * @param audit 選填的稽核欄位（風險申報與審查結論），缺省時不寫入
 * @returns `true` 若有新增；`false` 若冪等命中既有 tombstone
 */
export function recordCompletionTombstone(
  plan: Plan,
  taskId: string,
  state: "COMPLETED" | "FAILED" | "CANCELLED",
  finishedAt: string,
  audit: { risk?: string; reviewVerdict?: string } = {},
): boolean {
  if (!plan.completionTombstones) {
    plan.completionTombstones = {};
  }
  if (plan.completionTombstones[taskId]) return false;
  // 稽核欄位為選填：沒申報風險、沒審查紀錄的任務就不寫，
  // 保持完成註記原本「只留語意必要欄位」的克制。
  plan.completionTombstones[taskId] = {
    state,
    finishedAt,
    ...(audit.risk ? { risk: audit.risk } : {}),
    ...(audit.reviewVerdict ? { reviewVerdict: audit.reviewVerdict } : {}),
  };
  if (!Array.isArray(plan.finishedTaskIds)) {
    plan.finishedTaskIds = [];
  }
  if (!plan.finishedTaskIds.includes(taskId)) {
    plan.finishedTaskIds = [...plan.finishedTaskIds, taskId];
  }
  plan.updatedAt = new Date().toISOString();
  return true;
}

/**
 * 統計 plan 的完成進度（固定分母 = plan.taskIds.length）。
 *
 * 規則：
 *   - `liveFinishedIds` = 在 tasks.json 內且為終態的 task IDs（plan.taskIds 子集）
 *   - `tombstonedIds` = 已被 prune 但 plan.completionTombstones 有紀錄的 task IDs
 *   - `missingIds` = 既不在 tasks.json 也無 tombstone 的 task IDs
 *   - `finishedCount` = liveFinishedIds.length + tombstonedIds.length
 *   - `totalCount` = plan.taskIds.length（固定分母，不受 prune 影響）
 *   - `progress` = totalCount === 0 ? 0 : round(finishedCount / totalCount * 100)
 *
 * 注意：`finishedTaskIds` 為向後相容索引，本函式不直接讀它；改以 live + tombstone
 * 為 唯一正式資料，避免雙索引漂移。
 */
export interface PlanCompletionStats {
  totalCount: number;
  finishedCount: number;
  progress: number;
  liveIds: string[];
  liveFinishedIds: string[];
  tombstonedIds: string[];
  missingIds: string[];
}

export function computePlanCompletionStats(
  plan: Plan,
  taskRegistry: TasksRegistry,
): PlanCompletionStats {
  const totalCount = Array.isArray(plan.taskIds) ? plan.taskIds.length : 0;
  const liveIds: string[] = [];
  const liveFinishedIds: string[] = [];
  const tombstonedIds: string[] = [];
  const missingIds: string[] = [];
  const tombstones = plan.completionTombstones || {};
  const taskIds = Array.isArray(plan.taskIds) ? plan.taskIds : [];
  for (const tid of taskIds) {
    const live = taskRegistry.tasks[tid];
    if (live) {
      liveIds.push(tid);
      if (isFinishedTaskState(live.state)) liveFinishedIds.push(tid);
      continue;
    }
    if (tombstones[tid]) {
      tombstonedIds.push(tid);
      continue;
    }
    missingIds.push(tid);
  }
  const finishedCount = liveFinishedIds.length + tombstonedIds.length;
  const progress = totalCount === 0 ? 0 : Math.round((finishedCount / totalCount) * 100);
  return { totalCount, finishedCount, progress, liveIds, liveFinishedIds, tombstonedIds, missingIds };
}

/**
 * 檢查 plan 是否有任何 active（非終態）linked task。
 *
 * 給 `plan-state-sync complete` / `cancel` invariant 使用：
 *   - 若 plan 含 active linked task，拒絕 transition 至 terminal 狀態。
 *
 * @param plan 欲檢查的 plan
 * @param taskRegistry 當前 task registry
 * @returns active task IDs 陣列（空陣列表示安全可終結）
 */
export function findActiveLinkedTaskIds(
  plan: Plan,
  taskRegistry: TasksRegistry,
): string[] {
  const active: string[] = [];
  for (const tid of Array.isArray(plan.taskIds) ? plan.taskIds : []) {
    const t = taskRegistry.tasks[tid];
    if (t && !isFinishedTaskState(t.state)) active.push(tid);
  }
  return active;
}

// ─── Plan Registry Health Inspection────

/**
 * Plan registry health issue 一筆。
 *
 * `severity = "error"` 會讓 `ok=false`；`"warn"` 只列入提示。
 * 給 `workflow_doctor` / `workflow_health_check` 共享偵測邏輯，避免兩處漂移。
 */
export interface PlanRegistryHealthIssue {
  planId: string;
  /** stable check identifier，供測試與 caller 對照。 */
  checkName:
    | "tombstone-missing-from-finishedTaskIds"
    | "finishedTaskIds-orphan"
    | "finishedTaskIds-non-terminal-live"
    | "finished-plan-active-linked-task"
    | "archiving-plan-active-linked-task"
    | "dangling-edge-source"
    | "dangling-edge-target"
    | "active-plan-missing-tasks"
    | "state-divergence"
    | "state-divergence-planned-with-active-task"
    | "plan-progress-divergence"
    | "dependency-graph-not-aligned-with-task-dependsOn"
    | "dependency-graph-edge-without-task-dependsOn";
  severity: "error" | "warn";
  message: string;
  refs: string[];
}

export interface PlanRegistryHealthReport {
  ok: boolean;
  issueCount: number;
  errorCount: number;
  warnCount: number;
  issues: PlanRegistryHealthIssue[];
}

/**
 * 純函式：對 (plansRegistry, taskRegistry) 做完整 health inspection。
 *
 * 涵蓋：
 *   1. **tombstone ↔ finishedTaskIds 一致性**：每筆 tombstone 必須也列於 finishedTaskIds。
 *   2. **finishedTaskIds 完整性**：每筆 finishedTaskIds 必須對應 live terminal 或 tombstone。
 *   3. **finished plan ↔ active linked task invariant**：finished plan 不應含 active task。
 *   4. **graph consistency**：edges / nodes 指向的 taskId 必須存在於 tasks.json 或 tombstone。
 *      兩者皆無則視為真正的 dangling，必須回報（不可用 tombstone 掩蓋）。
 *   5. **active plan 缺漏 task**：active plan 的 taskIds 中若有既不在 tasks.json 也無
 *      tombstone 的 ID，視為資料缺漏（warn）。
 *   6. **state divergence**：active plan.state 與其 linked tasks 的整體狀態是否一致
 *      （e.g. plan COMPLETED 但仍有 active task → 已在 check 3 涵蓋）。
 *
 * 不修改任何傳入物件（pure）。
 *
 * @see ../../diagnostics/workflow-doctor.ts                     — 主 consumer
 * @see ../../diagnostics/workflow-health-check.ts               — 次 consumer
 */
export function inspectPlanRegistry(
  plansRegistry: PlansRegistry,
  taskRegistry: TasksRegistry,
): PlanRegistryHealthReport {
  const issues: PlanRegistryHealthIssue[] = [];

  for (const plan of Object.values(plansRegistry.plans || {})) {
    const tombstones = plan.completionTombstones || {};
    const finishedTaskIds = Array.isArray(plan.finishedTaskIds) ? plan.finishedTaskIds : [];
    const taskIds = Array.isArray(plan.taskIds) ? plan.taskIds : [];

    // Check 1: tombstone ↔ finishedTaskIds 一致性
    for (const tid of Object.keys(tombstones)) {
      if (!finishedTaskIds.includes(tid)) {
        issues.push({
          planId: plan.planId,
          checkName: "tombstone-missing-from-finishedTaskIds",
          severity: "error",
          message: `計畫 ${plan.planId} 有 ${tid} 的終結標記，但 finishedTaskIds 裡沒有列到它`,
          refs: [tid],
        });
      }
    }

    // Check 2: finishedTaskIds 完整性
    for (const tid of finishedTaskIds) {
      const t = taskRegistry.tasks[tid];
      if (!t && !tombstones[tid]) {
        issues.push({
          planId: plan.planId,
          checkName: "finishedTaskIds-orphan",
          severity: "error",
          message: `計畫 ${plan.planId} 的 finishedTaskIds 列了 ${tid}，但既沒有對應的現存任務，也沒有終結標記`,
          refs: [tid],
        });
      } else if (t && !isFinishedTaskState(t.state)) {
        issues.push({
          planId: plan.planId,
          checkName: "finishedTaskIds-non-terminal-live",
          severity: "warn",
          message: `計畫 ${plan.planId} 的 finishedTaskIds 列了 ${tid}，但那個任務還在進行中（狀態 ${t.state}）`,
          refs: [tid],
        });
      }
    }

    // Check 3: finished plan ↔ active linked task invariant
    if (isFinishedPlanState(plan.state)) {
      const activeLinked = findActiveLinkedTaskIds(plan, taskRegistry);
      if (activeLinked.length > 0) {
        issues.push({
          planId: plan.planId,
          checkName: "finished-plan-active-linked-task",
          severity: "error",
          message: `計畫 ${plan.planId} 已經是 ${plan.state}，卻還有 ${activeLinked.length} 個進行中的關聯任務：${activeLinked.join(", ")}`,
          refs: activeLinked,
        });
      }
    }

    // Check 3b: ARCHIVING stale with active linked tasks — detectable for resume recovery
    if (plan.state === "ARCHIVING") {
      const activeLinked = findActiveLinkedTaskIds(plan, taskRegistry);
      if (activeLinked.length > 0) {
        issues.push({
          planId: plan.planId,
          checkName: "archiving-plan-active-linked-task",
          severity: "error",
          message: `計畫 ${plan.planId} 目前卡在 ARCHIVING，卻還有 ${activeLinked.length} 個進行中的關聯任務：${activeLinked.join(", ")}。請用 plan-state-sync 的 resume 事件（ARCHIVING → IN_PROGRESS）復原後處理。`,
          refs: activeLinked,
        });
      }
    }

    // Check 4: graph consistency（tombstone 視為 valid；同時缺漏才報 dangling）
    for (const edge of plan.dependencyGraph?.edges || []) {
      if (!taskRegistry.tasks[edge.source] && !tombstones[edge.source]) {
        issues.push({
          planId: plan.planId,
          checkName: "dangling-edge-source",
          severity: "error",
          message: `計畫 ${plan.planId} 依賴關係圖裡有一條邊的起點 ${edge.source}，在任務清單和終結標記裡都找不到`,
          refs: [edge.source, edge.target].filter(Boolean),
        });
      }
      if (!taskRegistry.tasks[edge.target] && !tombstones[edge.target]) {
        issues.push({
          planId: plan.planId,
          checkName: "dangling-edge-target",
          severity: "error",
          message: `計畫 ${plan.planId} 依賴關係圖裡有一條邊的終點 ${edge.target}，在任務清單和終結標記裡都找不到`,
          refs: [edge.source, edge.target].filter(Boolean),
        });
      }
    }

    // Check 5: active plan 缺漏 task（warn）
    if (!isFinishedPlanState(plan.state)) {
      const stats = computePlanCompletionStats(plan, taskRegistry);
      if (stats.missingIds.length > 0) {
        issues.push({
          planId: plan.planId,
          checkName: "active-plan-missing-tasks",
          severity: "warn",
          message: `進行中的計畫 ${plan.planId} 有 ${stats.missingIds.length} 個任務不見了（既沒有現存任務，也沒有終結標記）：${stats.missingIds.join(", ")}`,
          refs: stats.missingIds,
        });
      }
    }

    // Check 6: PLANNED plan + IN_PROGRESS linked task → state divergence（error）。
    // 語意：plan 還在 PLANNED，但已 link 的 task 已實際進入 IN_PROGRESS，代表
    // plan 沒跟著 linked task 一起往前推進。其它 non-terminal 狀態（PLANNED /
    // NEW / BLOCKED / CLARIFYING / REVIEWING / ARCHIVING）不列入：
    //   - PLANNED task 與 PLANNED plan 一致，無 drift。
    //   - NEW task 尚未啟動，不算 active drift。
    //   - BLOCKED 是刻意 halt（含 BLOCKED plan），不算 active drift。
    // 註：`findActiveLinkedTaskIds` 仍回傳所有 non-terminal（供
    // `finished-plan-active-linked-task` Check 3 與 plan-state-sync complete 流程
    // 共用），本檢查僅從中挑出 `state === "IN_PROGRESS"` 的子集。
    // BLOCKED plan 不套此規則（BLOCKED 是刻意 halt）。
    // `finished-plan-active-linked-task` 已涵蓋 finished plan 的對偶情況；
    // 本檢查專注 PLANNED ↔ IN_PROGRESS 的反向漂移。
    if (plan.state === "PLANNED") {
      const allActive = findActiveLinkedTaskIds(plan, taskRegistry);
      const inProgressIds = allActive.filter((tid) => {
        const t = taskRegistry.tasks[tid];
        return !!t && t.state === "IN_PROGRESS";
      });
      if (inProgressIds.length > 0) {
        issues.push({
          planId: plan.planId,
          checkName: "state-divergence-planned-with-active-task",
          severity: "error",
          message: `計畫 ${plan.planId} 還在 PLANNED，但已經有 ${inProgressIds.length} 個關聯任務進入 IN_PROGRESS：${inProgressIds.join(", ")}`,
          refs: inProgressIds,
        });
      }
    }

    // Check 7: progress divergence（warn）— plan.finishedTaskIds 與
    // resolveCompletion 真實統計（liveFinished + tombstoned）以 unique IDs 比較對稱差。
    // 不採單純 length 比對，避免重複 ID 造成 false negative；採 Set 對稱差。
    // 任一邊多/少都算漂移：例如 live task 已 COMPLETED 但未列入 finishedTaskIds，
    // 或 finishedTaskIds 殘留 stale ID（live 非終態或已不存在）。
    const stats = computePlanCompletionStats(plan, taskRegistry);
    const actualFinishedSet = new Set<string>([...stats.liveFinishedIds, ...stats.tombstonedIds]);
    const declaredFinishedSet = new Set<string>(finishedTaskIds);
    const progressDrift: string[] = [];
    for (const id of actualFinishedSet) {
      if (!declaredFinishedSet.has(id)) progressDrift.push(id);
    }
    for (const id of declaredFinishedSet) {
      if (!actualFinishedSet.has(id)) progressDrift.push(id);
    }
    if (progressDrift.length > 0) {
      issues.push({
        planId: plan.planId,
        checkName: "plan-progress-divergence",
        severity: "warn",
        message: `計畫 ${plan.planId} 的 finishedTaskIds 和實際情況（現存任務加終結標記）對不上，有 ${progressDrift.length} 個 ID 兜不攏`,
        refs: progressDrift,
      });
    }

    // Check 8: dependencyGraph ↔ task.dependsOn 雙向一致性（error）。
    // 雙向規則：
    //   (a) 每個 live task.dependsOn[i] → 必須有 graph edge source=dependsOn[i], target=taskId
    //   (b) 每個 graph edge (source, target) → target 若為 live task，其 dependsOn 必須含 source
    // 對稱缺失各報一個獨立 checkName，便於 caller 與測試區分方向。
    // tombstoned target 沒有 live dependsOn metadata，本檢查不臆測其依賴；跳過 (b)。
    const edges = plan.dependencyGraph?.edges || [];
    const edgeKey = (source: string, target: string): string => `${source}\u0001${target}`;
    const edgeSet = new Set<string>(edges.map((e) => edgeKey(e.source, e.target)));
    const taskIdSet = new Set<string>(taskIds);
    // (a) task.dependsOn → edge
    for (const tid of taskIds) {
      const live = taskRegistry.tasks[tid];
      if (!live) continue;
      const deps = Array.isArray(live.dependsOn) ? live.dependsOn : [];
      for (const dep of deps) {
        if (!edgeSet.has(edgeKey(dep, tid))) {
          issues.push({
            planId: plan.planId,
            checkName: "dependency-graph-not-aligned-with-task-dependsOn",
            severity: "error",
            message: `計畫 ${plan.planId} 的任務 ${tid} 的 dependsOn 列了 ${dep}，但依賴關係圖裡少了 ${dep} 指向 ${tid} 這條邊`,
            refs: [tid, dep],
          });
        }
      }
    }
    // (b) edge → target task.dependsOn（僅 live target）
    for (const edge of edges) {
      // 只對在 plan.taskIds 內的 edge target 做檢查（避免 dangling target 干擾；
      // dangling target 已由 Check 4 報告）
      if (!taskIdSet.has(edge.target)) continue;
      const targetLive = taskRegistry.tasks[edge.target];
      if (!targetLive) continue; // tombstoned target 跳過（無 live dependsOn）
      const deps = Array.isArray(targetLive.dependsOn) ? targetLive.dependsOn : [];
      if (!deps.includes(edge.source)) {
        issues.push({
          planId: plan.planId,
          checkName: "dependency-graph-edge-without-task-dependsOn",
          severity: "error",
          message: `計畫 ${plan.planId} 依賴關係圖裡有 ${edge.source} 指向 ${edge.target} 這條邊，但任務 ${edge.target} 的 dependsOn 沒有列 ${edge.source}`,
          refs: [edge.source, edge.target],
        });
      }
    }

    // Check 9: 隱式 — taskIds 自身若為空（plan 從未 link），記為 info（不計 error/warn）
    void taskIds;
  }

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warn").length;
  return {
    ok: errorCount === 0,
    issueCount: issues.length,
    errorCount,
    warnCount,
    issues,
  };
}
