/**
 * opencode-ultrawork — plan registry leaf helpers
 *
 * 角色：
 *       · `createEmptyPlansRegistry`：建立空的 PlansRegistry。
 *       · `normalizePlan`：自 unknown raw 物件產出合法 Plan 或 null。
 *       · `normalizePlansRegistry`：自 unknown raw registry 產出合法
 *         PlansRegistry（內含 project fallback 與 active/cursor 重算）。
 *       · `prunePlansRegistry`：保留 active plan + 最多 FINISHED_PLAN_LIMIT
 *         個 finished plan，並重算 activePlanIds / planCursor。
 *   - 本檔僅放 pure module-level 函式；無 IO、無 closure 依賴、無 plugin
 *     內部狀態耦合；與 `src/core/*` 的設計哲學一致（single direction
 *     dependency: index.ts → registry → core）。
 *
 * 對外規則（不可破壞）：
 *     包含 plan field 順序、預設值、dependencyGraph nodes/edges 容忍度、
 *     finished plan 保留數量與排序（updatedAt desc）。
 *   - TypeScript structural typing：本檔透過 `import type` 引用
 *     `../core/types.ts` 的 `Plan` / `PlansRegistry` / `ProjectBinding`,
 *     引用；引入反向 import 會形成循環依賴。
 *   - 不引入新相依（僅 `node:path` 的 `resolve`，以及 `../core/*` 的常數、
 *     types 與純函式 helpers）。
 *
 * 設計重點：
 *   - `normalizePlansRegistry` 在 `raw` 非 object 或 `plans` 非 object 時，
 *     回傳以傳入 `project` 為基底的 empty registry（與原行為一致）。
 *   - `normalizePlan` 對 `dependencyGraph` 採寬鬆容忍（缺欄位時 fallback
 *     至 `{ nodes: [], edges: [] }`），與原行為一致。
 *   - `prunePlansRegistry` 採 active-first / finished-second 合併策略，
 *     並以 `updatedAt` descending 排序；保留上限為 `FINISHED_PLAN_LIMIT`。
 *   - `planCursor`：若現有 cursor 仍指 active plan 則保留，否則 fallback
 *     至 activePlanIds 第一筆或 null（與原行為一致）。
 *
 * 限制：
 *   - 僅依賴 `node:path`（`resolve`）與 `./../core/*` 模組。
 *   - 不得引入 IO / 副作用 / closure 依賴 / plugin 內部狀態。
 *
 * @see ../../../../README.md                              — 模組一覽
 * @see ../core/types.ts                                  — Plan / PlansRegistry 介面來源
 * @see ../core/constants.ts                              — PLANS_REGISTRY_VERSION / FINISHED_PLAN_LIMIT
 * @see ../core/helpers.ts                                — sameProject / isFinishedPlanState / uniq
 */

import { resolve } from "node:path";
import type { Plan, PlansRegistry, PlanCompletionTombstone, ProjectBinding } from "../core/types.ts";
import { FINISHED_PLAN_LIMIT, PLANS_REGISTRY_VERSION } from "../core/constants.ts";
import { isFinishedPlanState, sameProject, uniq } from "../core/helpers.ts";

/**
 * 建立空的 PlansRegistry。
 * `activePlanIds` / `plans` 為空物件/空陣列；`planCursor` 為 null。
 *
 * 原行為完全一致。
 */
export function createEmptyPlansRegistry(project: ProjectBinding): PlansRegistry {
  return { version: PLANS_REGISTRY_VERSION, projectId: project.projectId, projectPath: project.projectPath, activePlanIds: [], planCursor: null, plans: {} };
}

/**
 * 將未知 raw 物件轉為合法 Plan；若缺少必要欄位（planId / projectId /
 * projectPath）則回傳 null。
 *
 * `projectFallback` 用於補齊 raw 缺漏的 projectId / projectPath。
 *
 * 原行為完全一致（包含 dependencyGraph 寬鬆解析與 content fields）。
 */
export function normalizePlan(raw: unknown, projectFallback?: ProjectBinding): Plan | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const planId = String(source.planId || "").trim();
  if (!planId) return null;

  const projectId = String(source.projectId || projectFallback?.projectId || "").trim();
  const projectPathRaw = String(source.projectPath || projectFallback?.projectPath || "").trim();
  if (!projectId || !projectPathRaw) return null;
  const projectPath = resolve(projectPathRaw);

  const dependencyGraph = source.dependencyGraph && typeof source.dependencyGraph === "object"
    ? source.dependencyGraph as Record<string, unknown>
    : { nodes: [], edges: [] };

  return {
    planId,
    projectId,
    projectPath,
    title: typeof source.title === "string" ? source.title : undefined,
    state: String(source.state || "DRAFT").trim() || "DRAFT",
    owner: typeof source.owner === "string" ? source.owner : undefined,
    priority: typeof source.priority === "string" ? source.priority : undefined,
    createdAt: String(source.createdAt || new Date(0).toISOString()),
    updatedAt: String(source.updatedAt || new Date(0).toISOString()),
    taskIds: Array.isArray(source.taskIds) ? source.taskIds.map(String) : [],
    finishedTaskIds: Array.isArray(source.finishedTaskIds) ? source.finishedTaskIds.map(String) : [],
    dependencyGraph: {
      nodes: Array.isArray(dependencyGraph.nodes) ? dependencyGraph.nodes.map((n: unknown) => {
        const node = n as Record<string, unknown>;
        return { id: String(node.id || ""), taskId: String(node.taskId || ""), title: typeof node.title === "string" ? node.title : undefined };
      }) : [],
      edges: Array.isArray(dependencyGraph.edges) ? dependencyGraph.edges.map((e: unknown) => {
        const edge = e as Record<string, unknown>;
        return { source: String(edge.source || ""), target: String(edge.target || ""), type: String(edge.type || "depends_on") };
      }) : [],
    },
    history: Array.isArray(source.history) ? source.history.map(String) : [],
    // Content file fields (v1.1)
    contentRef: typeof source.contentRef === "string" ? source.contentRef : undefined,
    contentPath: typeof source.contentPath === "string" ? source.contentPath : undefined,
    contentVersion: typeof source.contentVersion === "number" ? source.contentVersion : undefined,
    // Completion tombstones (v1.2 schema, )
    // optional；舊 Plan 無此欄位時省略。寬鬆解析：僅接受 object，
    // 否則降級為 undefined 以維持向後相容。
    completionTombstones: normalizeCompletionTombstones(source.completionTombstones),
  };
}

/**
 *  — 寬鬆解析 Plan.completionTombstones。
 * 僅接受 `Record<string, { state: "COMPLETED" | "FAILED" | "CANCELLED"; finishedAt: string }>`
 * 形狀；其餘（null / array / 缺欄位）一律降級為 undefined。
 */
function normalizeCompletionTombstones(raw: unknown): Plan["completionTombstones"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const result: Record<string, PlanCompletionTombstone> = {};
  let hasAny = false;
  for (const [taskId, value] of Object.entries(obj)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const state = v.state;
    if (state !== "COMPLETED" && state !== "FAILED" && state !== "CANCELLED") continue;
    const finishedAt = typeof v.finishedAt === "string" ? v.finishedAt : new Date(0).toISOString();
    // 稽核欄位（v4.2）：選填且寬鬆，只要是非空字串就原樣留著。
    // 這裡若不接住，寫進去的風險與審查結論會在下一次讀取時被抹掉。
    const risk = typeof v.risk === "string" && v.risk.trim() ? v.risk : undefined;
    const reviewVerdict = typeof v.reviewVerdict === "string" && v.reviewVerdict.trim() ? v.reviewVerdict : undefined;
    result[taskId] = {
      state,
      finishedAt,
      ...(risk ? { risk } : {}),
      ...(reviewVerdict ? { reviewVerdict } : {}),
    };
    hasAny = true;
  }
  return hasAny ? result : undefined;
}

/**
 * 將未知 raw registry 轉為合法 PlansRegistry，並重算 activePlanIds /
 * planCursor。對 raw 中跨專案的 plan 採過濾策略（透過 `sameProject` 檢查）。
 *
 * 原行為完全一致（包含 registry-level fallback 推導、cross-project
 * 過濾、active 排序與 cursor fallback）。
 */
export function normalizePlansRegistry(raw: unknown, project: ProjectBinding): PlansRegistry {
  const normalized = createEmptyPlansRegistry(project);
  if (!raw || typeof raw !== "object") return normalized;

  const source = raw as Record<string, unknown>;
  const registryFallback = typeof source.projectId === "string" && typeof source.projectPath === "string"
    ? { projectId: source.projectId.trim(), projectPath: resolve(source.projectPath.trim()) }
    : undefined;
  const rawPlans = source.plans && typeof source.plans === "object"
    ? source.plans as Record<string, unknown>
    : {};

  for (const rawPlan of Object.values(rawPlans)) {
    const plan = normalizePlan(rawPlan, registryFallback);
    if (!plan || !sameProject(plan, project)) continue;
    normalized.plans[plan.planId] = plan;
  }

  const activePlans = Object.values(normalized.plans)
    .filter((plan) => !isFinishedPlanState(plan.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const activePlanIds = uniq([...normalized.activePlanIds, ...activePlans.map((plan) => plan.planId)])
    .filter((planId) => !!normalized.plans[planId] && !isFinishedPlanState(normalized.plans[planId].state));
  const planCursor = normalized.planCursor && activePlanIds.includes(normalized.planCursor)
    ? normalized.planCursor
    : (activePlanIds[0] ?? null);

  return {
    version: PLANS_REGISTRY_VERSION,
    projectId: normalized.projectId,
    projectPath: resolve(normalized.projectPath),
    activePlanIds,
    planCursor,
    plans: normalized.plans,
  };
}

/**
 * 將 PlansRegistry 中 finished plan 修剪至最多 `FINISHED_PLAN_LIMIT` 筆，
 * 並重算 activePlanIds / planCursor。
 *
 * 原行為完全一致（active-first / finished-second 合併策略與 cursor fallback）。
 */
export function prunePlansRegistry(registry: PlansRegistry): PlansRegistry {
  const activePlans = Object.values(registry.plans)
    .filter((plan) => !isFinishedPlanState(plan.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const finishedPlans = Object.values(registry.plans)
    .filter((plan) => isFinishedPlanState(plan.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, FINISHED_PLAN_LIMIT);

  const keptPlans: Record<string, Plan> = {};
  for (const plan of [...activePlans, ...finishedPlans]) {
    keptPlans[plan.planId] = plan;
  }

  const activePlanIds = activePlans.map((p) => p.planId);
  const planCursor = registry.planCursor && activePlanIds.includes(registry.planCursor)
    ? registry.planCursor
    : (activePlanIds[0] ?? null);

  return {
    version: registry.version,
    projectId: registry.projectId,
    projectPath: registry.projectPath,
    activePlanIds,
    planCursor,
    plans: keptPlans,
  };
}
