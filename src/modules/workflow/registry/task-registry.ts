/**
 * opencode-ultrawork — task registry leaf helpers
 *
 * 角色：
 *       · `createEmptyTasksRegistryLeaf`：建立空的 TasksRegistry。
 *       · `normalizeTaskLeaf`：自 unknown raw 物件產出合法 Task 或 null。
 *       · `pruneTasksRegistryLeaf`：保留 active task + 最多 FINISHED_TASK_LIMIT
 *         個 finished task，並重算 activeTaskIds / taskCursor。
 *       · `normalizeTasksRegistryLeaf`：自 unknown raw registry 產出合法
 *         TasksRegistry（內含 project fallback 與 active/cursor 重算）。
 *   - 本檔僅放 pure module-level 函式；無 IO、無 closure 依賴、無 plugin
 *     內部狀態耦合；與 `src/core/*` 的設計哲學一致（single direction
 *     dependency: index.ts → registry → core）。
 *     在 closure 內帶 `project = getCurrentProject()` 預設值（依賴 closure
 *     scoped `getCurrentProject`），故 leaf 版本一律加上 `Leaf` 尾綴並要求
 *     closure wrapper 作為 thin delegation，以維持對外呼叫簽名。
 *
 * 對外規則（不可破壞）：
 *     **逐字一致**，包含 field 順序、預設值、Plan/Content 子欄位寬鬆解析。
 *   - 公開函式命名帶 `Leaf` 尾綴，與 closure wrapper 區隔，避免命名衝突。
 *   - TypeScript structural typing：本檔透過 `import type` 引用
 *     `../core/types.ts` 的 `Task` / `TasksRegistry` / `ProjectBinding`,
 *     引用；引入反向 import 會形成循環依賴。
 *   - 不引入新相依（僅 `node:path` 的 `resolve`，以及 `../core/*` 的常數、
 *     types 與純函式 helpers）。
 *
 * 設計重點：
 *   - leaf 函式一律顯式要求 `project: ProjectBinding`，拒絕隱式 default；
 *   - `normalizeTaskLeaf` 對 plan system / content file 子欄位採寬鬆容忍：
 *     型別不符時整個欄位省略（`undefined`），與原行為一致。
 *   - `pruneTasksRegistryLeaf` 採 active-first / finished-second 合併策略，
 *     並以 `updatedAt` descending 排序；保留上限為 `FINISHED_TASK_LIMIT`。
 *   - `normalizeTasksRegistryLeaf` 對 raw 中跨專案的 task 採過濾策略
 *     （透過 `sameProject` 檢查），最後呼叫 `pruneTasksRegistryLeaf`
 *     做 finished 修剪。
 *
 * 限制：
 *   - 僅依賴 `node:path`（`resolve`）與 `./../core/*` 模組。
 *   - 不得引入 IO / 副作用 / closure 依賴 / plugin 內部狀態。
 *
 * @see ../../../../README.md                              — 模組一覽
 * @see ../core/types.ts                                  — Task / TasksRegistry 介面來源
 * @see ../core/constants.ts                              — TASKS_REGISTRY_VERSION / FINISHED_TASK_LIMIT
 * @see ../core/helpers.ts                                — sameProject / isFinishedTaskState / uniq
 */

import { resolve } from "node:path";
import type { ProjectBinding, Task, TasksRegistry } from "../core/types.ts";
import { FINISHED_TASK_LIMIT, TASKS_REGISTRY_VERSION } from "../core/constants.ts";
import { isFinishedTaskState, sameProject, uniq } from "../core/helpers.ts";

/**
 * 建立空的 TasksRegistry（leaf 版本；顯式 `project` 參數）。
 * `activeTaskIds` / `tasks` 為空陣列/空物件；`taskCursor` 為 null。
 *
 * `project = getCurrentProject()` 預設值語意。
 */
export function createEmptyTasksRegistryLeaf(project: ProjectBinding): TasksRegistry {
  return { version: TASKS_REGISTRY_VERSION, projectId: project.projectId, projectPath: project.projectPath, activeTaskIds: [], taskCursor: null, tasks: {} };
}

/**
 * 將未知 raw 物件轉為合法 Task；若缺少必要欄位（taskId / projectId /
 * projectPath）則回傳 null。
 *
 * `projectFallback` 用於補齊 raw 缺漏的 projectId / projectPath。
 *
 * 原行為完全一致（包含 Plan system v4.0 與 Content file v4.1 子欄位的
 * 寬鬆型別容忍）。
 */
export function normalizeTaskLeaf(raw: unknown, projectFallback?: ProjectBinding): Task | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const taskId = String(source.taskId || "").trim();
  if (!taskId) return null;

  const projectId = String(source.projectId || projectFallback?.projectId || "").trim();
  const projectPathRaw = String(source.projectPath || projectFallback?.projectPath || "").trim();
  if (!projectId || !projectPathRaw) return null;
  const projectPath = resolve(projectPathRaw);

  return {
    taskId,
    projectId,
    projectPath,
    title: typeof source.title === "string" ? source.title : undefined,
    state: String(source.state || "NEW").trim() || "NEW",
    owner: String(source.owner || "—").trim() || "—",
    priority: String(source.priority || "—").trim() || "—",
    dependsOn: Array.isArray(source.dependsOn) ? source.dependsOn.map(String) : undefined,
    phase: typeof source.phase === "string" ? source.phase : undefined,
    milestone: typeof source.milestone === "string" ? source.milestone : undefined,
    planRef: typeof source.planRef === "string" ? source.planRef : undefined,
    specRef: typeof source.specRef === "string" ? source.specRef : undefined,
    indexRef: typeof source.indexRef === "string" ? source.indexRef : undefined,
    archivingAt: typeof source.archivingAt === "string" ? source.archivingAt : undefined,
    updatedAt: String(source.updatedAt || new Date(0).toISOString()),
    history: Array.isArray(source.history) ? source.history.map(String) : [],
    // Plan system fields (v4.0)
    planId: typeof source.planId === "string" ? source.planId : undefined,
    taskType: (source.taskType === "project-task" || source.taskType === "fast-task" || source.taskType === "subtask") ? source.taskType : undefined,
    parentTaskId: source.parentTaskId !== undefined ? (source.parentTaskId === null ? null : String(source.parentTaskId || "")) : undefined,
    subTaskIds: Array.isArray(source.subTaskIds) ? source.subTaskIds.map(String) : undefined,
    blockedBy: Array.isArray(source.blockedBy) ? source.blockedBy.map(String) : undefined,
    parallelGroup: source.parallelGroup !== undefined ? (source.parallelGroup === null ? null : String(source.parallelGroup || "")) : undefined,
    planStep: typeof source.planStep === "number" ? source.planStep : undefined,
    acceptanceCriteria: Array.isArray(source.acceptanceCriteria) ? source.acceptanceCriteria.map(String) : undefined,
    // Content file fields (v4.1)
    contentRef: typeof source.contentRef === "string" ? source.contentRef : undefined,
    taskContentPath: typeof source.taskContentPath === "string" ? source.taskContentPath : undefined,
    taskContentMode: (source.taskContentMode === "section" || source.taskContentMode === "file" || source.taskContentMode === "hybrid") ? source.taskContentMode : undefined,
    contentVersion: typeof source.contentVersion === "number" ? source.contentVersion : undefined,
    // 風險申報（v4.2）：只認 "high"，其餘一律收成不存在，避免髒值把閘門繞過去。
    risk: source.risk === "high" ? "high" : undefined,
    review: normalizeTaskReview(source.review),
    acceptanceResults: normalizeAcceptanceResults(source.acceptanceResults),
  };
}

/**
 * 寬鬆解析 `Task.acceptanceResults`。
 *
 * 任何結構不對的值（null / 非陣列 / 空陣列 / 項目缺 criterion）一律降級為
 * undefined。降級的意思是「沒有驗收紀錄」——對有驗收條件的任務來說，結案
 * 那一關會再擋一次，所以降級的方向是安全的。`met` 只認真正的 `true`，
 * 避免 "false" 這種字串被當成通過。
 */
function normalizeAcceptanceResults(raw: unknown): Task["acceptanceResults"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  if (!Array.isArray(source.items)) return undefined;
  const items = source.items
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      criterion: String(item.criterion || "").trim(),
      met: item.met === true,
      ...(typeof item.evidence === "string" && item.evidence.trim() ? { evidence: item.evidence.trim() } : {}),
    }))
    .filter((item) => !!item.criterion);
  if (items.length === 0) return undefined;
  return {
    recordedAt: String(source.recordedAt || new Date(0).toISOString()),
    recordedBy: String(source.recordedBy || "—").trim() || "—",
    items,
  };
}

/**
 * 寬鬆解析 `Task.review`。
 *
 * 只接受三種審查結論之一，而且 reviewer 要有值；其餘（null / array /
 * 缺欄位 / 不認得的結論）一律降級為 undefined。降級的結果是「沒有審查
 * 紀錄」，對高風險任務來說會擋在結案那一關，這是刻意選的安全方向。
 */
function normalizeTaskReview(raw: unknown): Task["review"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const verdict = source.verdict;
  if (verdict !== "approve" && verdict !== "concerns" && verdict !== "reject") return undefined;
  const reviewer = String(source.reviewer || "").trim();
  if (!reviewer) return undefined;
  const note = typeof source.note === "string" && source.note.trim() ? source.note : undefined;
  return {
    verdict,
    reviewer,
    reviewedAt: String(source.reviewedAt || new Date(0).toISOString()),
    reviewedStateUpdatedAt: String(source.reviewedStateUpdatedAt || ""),
    ...(source.reworkedAfterReview === true ? { reworkedAfterReview: true } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * 將 TasksRegistry 中 finished task 修剪至最多 `FINISHED_TASK_LIMIT` 筆，
 * 並重算 activeTaskIds / taskCursor。
 *
 * `protectedTaskIds`：
 *   - 對於 active plan 仍參照的 finished task，必須豁免 `FINISHED_TASK_LIMIT`
 *     prune，否則 plan.taskIds 與 tasks.json 會出現不對稱（plan 6 個
 *     linked task 但 registry 只剩 5 個，導致 plan-status 回報
 *     `totalCount` < `plan.taskIds.length` 且 inconsistencies 上升）。
 *   - 保護邏輯：finished task 若 `protectedTaskIds` 含有其 id，則
 *     **必**進入 keptTasks；其餘 finished task 仍依 `updatedAt` desc
 *     修剪至 `FINISHED_TASK_LIMIT` 筆。
 *   - 預設 `new Set()`（向後相容舊呼叫端）。
 *
 * 原行為完全一致（active-first / finished-second 合併策略與 cursor fallback）。
 */
export function pruneTasksRegistryLeaf(
  registry: TasksRegistry,
  protectedTaskIds: ReadonlySet<string> = new Set(),
): TasksRegistry {
  const activeTasks = Object.values(registry.tasks)
    .filter((task) => !isFinishedTaskState(task.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Invariant：先取出所有 protected finished task（須保留），
  // 再對剩餘的 unfinished-or-not-protected finished task 套用 FINISHED_TASK_LIMIT。
  const protectedFinishedTasks = Object.values(registry.tasks)
    .filter((task) => isFinishedTaskState(task.state) && protectedTaskIds.has(task.taskId));
  const pruneableFinishedTasks = Object.values(registry.tasks)
    .filter((task) => isFinishedTaskState(task.state) && !protectedTaskIds.has(task.taskId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, FINISHED_TASK_LIMIT);
  const finishedTasks = [...protectedFinishedTasks, ...pruneableFinishedTasks];
  const keptTasks = [...activeTasks, ...finishedTasks];
  const tasks = Object.fromEntries(keptTasks.map((task) => [task.taskId, task])) as Record<string, Task>;
  const activeTaskIds = uniq([...registry.activeTaskIds, ...activeTasks.map((task) => task.taskId)])
    .filter((taskId) => !!tasks[taskId] && !isFinishedTaskState(tasks[taskId].state));
  const taskCursor = registry.taskCursor && activeTaskIds.includes(registry.taskCursor)
    ? registry.taskCursor
    : (activeTaskIds[0] ?? null);

  return {
    version: TASKS_REGISTRY_VERSION,
    projectId: registry.projectId,
    projectPath: resolve(registry.projectPath),
    activeTaskIds,
    taskCursor,
    tasks,
  };
}

/**
 * 將未知 raw registry 轉為合法 TasksRegistry，並重算 activeTaskIds /
 * taskCursor（最後呼叫 `pruneTasksRegistryLeaf` 修剪 finished task）。
 * 對 raw 中跨專案的 task 採過濾策略（透過 `sameProject` 檢查）。
 *
 * `protectedTaskIds`：
 *   透傳至 `pruneTasksRegistryLeaf`，讓 active plan 仍參照的 finished
 *   task 豁免 `FINISHED_TASK_LIMIT` prune。預設 `new Set()`（向後相容）。
 *
 * `project = getCurrentProject()` 預設值語意。
 */
export function normalizeTasksRegistryLeaf(
  raw: unknown,
  project: ProjectBinding,
  protectedTaskIds: ReadonlySet<string> = new Set(),
): TasksRegistry {
  const normalized = createEmptyTasksRegistryLeaf(project);
  if (!raw || typeof raw !== "object") return normalized;

  const source = raw as Record<string, unknown>;
  const registryFallback = typeof source.projectId === "string" && typeof source.projectPath === "string"
    ? { projectId: source.projectId.trim(), projectPath: resolve(source.projectPath.trim()) }
    : undefined;
  const rawTasks = source.tasks && typeof source.tasks === "object"
    ? source.tasks as Record<string, unknown>
    : {};

  for (const rawTask of Object.values(rawTasks)) {
    const task = normalizeTaskLeaf(rawTask, registryFallback);
    if (!task || !sameProject(task, project)) continue;
    normalized.tasks[task.taskId] = task;
  }

  const explicitActiveTaskIds = Array.isArray(source.activeTaskIds) ? source.activeTaskIds.map(String) : [];
  const derivedActiveTaskIds = Object.values(normalized.tasks)
    .filter((task) => !isFinishedTaskState(task.state))
    .map((task) => task.taskId);
  normalized.activeTaskIds = uniq([...explicitActiveTaskIds, ...derivedActiveTaskIds])
    .filter((taskId) => !!normalized.tasks[taskId] && !isFinishedTaskState(normalized.tasks[taskId].state));

  const rawCursor = typeof source.taskCursor === "string" ? source.taskCursor : null;
  normalized.taskCursor = rawCursor && normalized.activeTaskIds.includes(rawCursor)
    ? rawCursor
    : (normalized.activeTaskIds[0] ?? null);

  return pruneTasksRegistryLeaf(normalized, protectedTaskIds);
}
