/**
 * opencode-ultrawork — 狀態查詢工具的 context 投影
 *
 * 角色：
 *   - 提供 `task-state-sync status` / `plan-status` / `plan-next` 共用的
 *     Task / Plan 投影函式，把「模型決策真正要用的欄位」與「稽核與除錯才要用
 *     的欄位」分開。
 *
 * 為什麼需要這一層：
 *   - 這三個工具原本直接回傳 registry 內的完整物件。每一個 Task 都重複帶著
 *     同一份 `projectId` / `projectPath`（在同一次回應裡，這兩個值對每一筆都
 *     一樣），再加上 `history` 稽核列，模型每查一次狀態就吞下好幾 KB 對決策
 *     沒有作用的資料，而且這些位元組還會一路留在對話裡。
 *   - 投影是「減欄位」，不是「減筆數」：任務與計畫一個都不會消失，只有
 *     稽核欄位與可由外層推得的專案身分被拿掉。這樣下游讀 `registry.tasks[id]`
 *     的程式碼不會因為查不到某筆而誤判。
 *
 * 對外規則（不可破壞）：
 *   - 投影**不得**丟掉工作流決策要用的欄位：狀態機用的 `state` / `owner` /
 *     `priority`、相依判斷用的 `dependsOn` / `blockedBy` / `subTaskIds`、
 *     閘門用的 `risk` / `review`、計畫歸屬用的 `planId` / `planStep`，以及
 *     內容檔指標。要新增 Task 欄位時，預設就要想清楚它屬於哪一邊。
 *   - 執行期閘門（G0-G5、state machine、權限檢查）一律直接讀正式 registry，
 *     **不得**改為依賴這裡的投影結果。這層只影響模型看到的 context。
 *   - `verbose` 模式必須回傳未經投影的原物件，稽核與除錯才有完整資料。
 *
 * 限制：
 *   - 本檔為 pure function leaf：不得 import runtime / registry IO /
 *
 */

import type { Plan, Task } from "../core/types.ts";

/** 投影模式標記：回應中自陳，避免下游把「欄位被投影掉」誤判成資料缺漏。 */
export type ProjectionMode = "summary" | "full";

/** 只在值有意義時才寫入（省掉 `undefined` 與空陣列造成的雜訊）。 */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value) && value.length === 0) return;
  target[key] = value;
}

/**
 * Task 投影。
 *
 * 拿掉：
 *   - `history`：稽核用的 transition 列，決策不需要（要看時用 `verbose`）。
 *   - `projectId` / `projectPath`：同一次回應裡每筆都一樣，外層已經有一份。
 *     跨專案防護由 runtime 直接比對正式 registry，不靠這裡的欄位。
 */
export function projectTask(task: Task): Record<string, unknown> {
  const out: Record<string, unknown> = { taskId: task.taskId, state: task.state };
  put(out, "title", task.title);
  put(out, "owner", task.owner);
  put(out, "priority", task.priority);
  put(out, "taskType", task.taskType);
  put(out, "planId", task.planId);
  put(out, "planStep", task.planStep);
  put(out, "parallelGroup", task.parallelGroup);
  put(out, "parentTaskId", task.parentTaskId);
  put(out, "subTaskIds", task.subTaskIds);
  put(out, "dependsOn", task.dependsOn);
  put(out, "blockedBy", task.blockedBy);
  put(out, "acceptanceCriteria", task.acceptanceCriteria);
  put(out, "risk", task.risk);
  put(out, "review", task.review);
  put(out, "phase", task.phase);
  put(out, "milestone", task.milestone);
  put(out, "contentRef", task.contentRef);
  put(out, "taskContentPath", task.taskContentPath);
  put(out, "taskContentMode", task.taskContentMode);
  put(out, "contentVersion", task.contentVersion);
  put(out, "updatedAt", task.updatedAt);
  return out;
}

export function projectTasks(tasks: readonly Task[]): Array<Record<string, unknown>> {
  return tasks.map(projectTask);
}

/** `Record<taskId, Task>` 版本；鍵的順序沿用輸入順序。 */
export function projectTaskMap(tasks: Record<string, Task>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, task] of Object.entries(tasks)) out[id] = projectTask(task);
  return out;
}

/**
 * Plan 投影。
 *
 * 拿掉 `history`（稽核列）與 `dependencyGraph`（節點與邊在
 * `plan-next` 的 ready / blocked 計算裡已經解出結論），以及每筆重複的專案身分。
 * `completionTombstones` 保留：它是終態的唯一證據，投影掉會讓模型誤判進度。
 */
export function projectPlan(plan: Plan): Record<string, unknown> {
  const out: Record<string, unknown> = { planId: plan.planId, state: plan.state };
  put(out, "title", plan.title);
  put(out, "owner", plan.owner);
  put(out, "priority", plan.priority);
  put(out, "taskIds", plan.taskIds);
  put(out, "finishedTaskIds", plan.finishedTaskIds);
  put(out, "completionTombstones", plan.completionTombstones);
  put(out, "contentRef", plan.contentRef);
  put(out, "contentVersion", plan.contentVersion);
  put(out, "createdAt", plan.createdAt);
  put(out, "updatedAt", plan.updatedAt);
  return out;
}
