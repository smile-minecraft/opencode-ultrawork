/**
 * 診斷模組共用組件：資料層唯讀收集 + 檢查列舉。
 *
 * 為什麼抽出來：
 *   舊版 `workflow_doctor` 與 `workflow_health_check` 各自內嵌一份相同的
 *   記憶體預算／投影對不上／計畫註冊檔檢查，註解裡明講是為了避開 registry
 *   closure 變動而「自包含複本」。V2 兩者都拿到同一個 `createWorkflowRuntime`
 *   產物，沒有那個限制，複製兩份只會讓診斷結果漂移。
 *
 * 唯讀不變條件：
 *   本檔只呼叫 `existsSync` / `readFileSync` 與 runtime 的唯讀讀取
 *   （`readRegistry` / `readPlansRegistry`，`createIfMissing` 一律 false）。
 *   不呼叫 `lazyEnsure`／`writeRegistry`／`writePlansRegistry`，也不建立目錄。
 *   被依賴的資料不存在時回 skipped 並附原因，不丟例外、也不讓整個工具失敗。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolExecutionContext } from "../../kit/define-tool.ts";
import {
  BOOTSTRAP_FULL_SOFT_BUDGET,
  PROJECT_MD_HARD_LIMIT,
  STATE_MD_LIMIT,
  getProjectMdCurrentSections,
  getProjectMdNearLimitThreshold,
  getProjectMdOverLimitHint,
  resolveProjectMdPolicyFromContent,
} from "../../modules/memory/index.ts";
import {
  inspectPlanRegistry,
  readInconsistentMarker,
  type InconsistentMarker,
  type Paths,
  type PlanRegistryHealthIssue,
  type PlansRegistry,
  type PlanRegistryHealthReport,
  type ProjectBinding,
  type TasksRegistry,
} from "../workflow/index.ts";
import type { DiagnosticsDeps } from "./deps.ts";

/** 檢查列舉項。`skipped` 是 V2 新增：被依賴模組關閉或資料不可得時用它。 */
export interface CheckItem {
  name: string;
  status: "passed" | "failed" | "warn" | "skipped";
  details: string;
}

/** 記憶體預算區塊；欄位與舊版 doctor／health_check 逐字一致（外加 V2 補的診斷欄位）。 */
export interface MemoryBudget {
  project_md_size: number;
  project_md_limit: number;
  project_md_status: "ok" | "warn";
  state_md_size: number;
  state_md_limit: number;
  state_md_status: "ok" | "warn";
  bootstrap_full_estimated_chars: number;
  bootstrap_full_status: "ok" | "warn";
  missing_content_ref_plan_count: number;
  missing_content_ref_status: "ok" | "warn";
  registry_projection_divergence: boolean;
  registry_projection_status: "ok" | "warn";
  project_md_effective_limit: number;
  project_md_hard_limit: number;
  project_md_over_by?: number;
  project_md_current_sections?: ReturnType<typeof getProjectMdCurrentSections>;
  project_md_hint?: string;
}

export interface PlanRegistryHealth {
  ok: boolean;
  issue_count: number;
  error_count: number;
  warn_count: number;
  issues: PlanRegistryHealthIssue[];
}

export function emptyMemoryBudget(): MemoryBudget {
  return {
    project_md_size: 0,
    project_md_limit: PROJECT_MD_HARD_LIMIT,
    project_md_status: "ok",
    state_md_size: 0,
    state_md_limit: STATE_MD_LIMIT,
    state_md_status: "ok",
    bootstrap_full_estimated_chars: 0,
    bootstrap_full_status: "ok",
    missing_content_ref_plan_count: 0,
    missing_content_ref_status: "ok",
    registry_projection_divergence: false,
    registry_projection_status: "ok",
    project_md_effective_limit: PROJECT_MD_HARD_LIMIT,
    project_md_hard_limit: PROJECT_MD_HARD_LIMIT,
  };
}

export function emptyPlanRegistryHealth(): PlanRegistryHealth {
  return { ok: true, issue_count: 0, error_count: 0, warn_count: 0, issues: [] };
}

/** 讀檔取長度；檔案不存在回 0。不建立任何檔案。 */
export function fileSize(path: string): number {
  return existsSync(path) ? readFileSync(path, "utf-8").length : 0;
}

export interface MemoryBudgetOutcome {
  memory_budget: MemoryBudget;
  warnings: string[];
  /** project.md frontmatter limit 無效時的錯誤字串（對應 `CONFIGURATION_ERROR`）。 */
  configurationError?: string;
  /** project.md 有效上限（frontmatter 收緊後）。 */
  effectiveProjectLimit: number;
  projectMdContent: string;
  projectMdSize: number;
  stateMdSize: number;
  /** near-limit 閾值與是否落在區間內，供 l1_check 補提示。 */
  nearLimitThreshold: number;
  nearLimitHit: boolean;
}

/**
 * 記憶體預算診斷（唯讀）。
 *
 * 規則與舊版一致：project.md 走 frontmatter 政策（limit 只能收緊），
 * state.md 固定 3000；bootstrap full 預估 = 兩者長度 + 2048 的 JSON 結構。
 */
export function collectMemoryBudget(paths: Paths): MemoryBudgetOutcome {
  const memory_budget = emptyMemoryBudget();
  const warnings: string[] = [];
  const projectMdExists = existsSync(paths.PROJECT_MD);
  const projectMdContent = projectMdExists ? readFileSync(paths.PROJECT_MD, "utf-8") : "";
  const policy = projectMdExists
    ? resolveProjectMdPolicyFromContent(projectMdContent)
    : {
        hardLimit: PROJECT_MD_HARD_LIMIT,
        effectiveLimit: PROJECT_MD_HARD_LIMIT,
        rawLimit: undefined as string | undefined,
        isValid: true,
        configurationError: undefined as string | undefined,
      };
  const effectiveProjectLimit = policy.effectiveLimit;
  const projectMdSize = projectMdContent.length;
  const stateMdSize = fileSize(paths.STATE_MD);

  memory_budget.project_md_size = projectMdSize;
  memory_budget.project_md_limit = effectiveProjectLimit;
  memory_budget.project_md_effective_limit = effectiveProjectLimit;
  memory_budget.project_md_hard_limit = PROJECT_MD_HARD_LIMIT;
  memory_budget.state_md_size = stateMdSize;

  let configurationError: string | undefined;
  if (projectMdExists && !policy.isValid) {
    memory_budget.project_md_status = "warn";
    configurationError = `project.md 的 frontmatter limit 無效：${policy.configurationError}`;
    warnings.push(configurationError);
    warnings.push(
      `project.md frontmatter 設定錯誤（raw limit: ${policy.rawLimit}），有效上限仍為 hard limit ${PROJECT_MD_HARD_LIMIT}`,
    );
  }

  if (projectMdSize > effectiveProjectLimit) {
    memory_budget.project_md_status = "warn";
    const overBy = projectMdSize - effectiveProjectLimit;
    const currentSections = getProjectMdCurrentSections(projectMdContent);
    memory_budget.project_md_over_by = overBy;
    memory_budget.project_md_current_sections = currentSections;
    memory_budget.project_md_hint = getProjectMdOverLimitHint(effectiveProjectLimit, overBy, currentSections);
    warnings.push(
      `project.md 超過大小上限（${projectMdSize} > ${effectiveProjectLimit}，over by ${overBy}）。bootstrap 的 full 模式會整份讀進來，先精簡它。`,
    );
    warnings.push(memory_budget.project_md_hint);
  }

  if (stateMdSize > STATE_MD_LIMIT) {
    memory_budget.state_md_status = "warn";
    warnings.push(
      `state.md 超過大小上限（${stateMdSize} > ${STATE_MD_LIMIT}）。bootstrap 的 full 模式會整份讀進來，做人工診斷前先精簡它。`,
    );
  }

  const bootstrapFullEstimated = projectMdSize + stateMdSize + 2048;
  memory_budget.bootstrap_full_estimated_chars = bootstrapFullEstimated;
  if (bootstrapFullEstimated > BOOTSTRAP_FULL_SOFT_BUDGET) {
    memory_budget.bootstrap_full_status = "warn";
    warnings.push(
      `bootstrap 的 full 模式預估會輸出約 ${bootstrapFullEstimated} 字，超過建議上限（${BOOTSTRAP_FULL_SOFT_BUDGET}）。一般工作階段用 mode='minimal' 就好。`,
    );
  }

  const nearLimitThreshold = getProjectMdNearLimitThreshold(effectiveProjectLimit);
  return {
    memory_budget,
    warnings,
    configurationError,
    effectiveProjectLimit,
    projectMdContent,
    projectMdSize,
    stateMdSize,
    nearLimitThreshold,
    nearLimitHit: projectMdSize >= nearLimitThreshold && projectMdSize <= effectiveProjectLimit,
  };
}

/** 目前任務：游標優先，退回第一個進行中任務。 */
export function resolveCurrentTaskId(registry: TasksRegistry): string | null {
  return registry.taskCursor || (registry.activeTaskIds.length > 0 ? registry.activeTaskIds[0] : null);
}

export interface DivergenceOutcome {
  /** state.md 與 tasks.json 對不上。 */
  divergence: boolean;
  warnings: string[];
  /** state.md 不存在時為 true（無法比對，檢查標成 skipped）。 */
  stateMdMissing: boolean;
}

/**
 * `state.md` ↔ `tasks.json` 的游標投影對不上檢查。
 *
 * 只在有進行中任務時比對（閒置時 state.md 的 `state: IDLE`／`task_id: —`
 * 本來就不對應任何任務）。state.md 不存在時回 stateMdMissing，呼叫端標 skipped。
 */
export function collectStateProjectionDivergence(
  paths: Paths,
  registry: TasksRegistry,
): DivergenceOutcome {
  const warnings: string[] = [];
  if (!existsSync(paths.STATE_MD)) return { divergence: false, warnings, stateMdMissing: true };
  const currentTaskId = resolveCurrentTaskId(registry);
  if (!currentTaskId) return { divergence: false, warnings, stateMdMissing: false };
  const task = registry.tasks[currentTaskId];
  if (!task) return { divergence: false, warnings, stateMdMissing: false };

  const stateMdContent = readFileSync(paths.STATE_MD, "utf-8");
  const taskInMd = stateMdContent.match(/task_id:\s*([^\n]+)/)?.[1]?.trim();
  const stateInMd = stateMdContent.match(/state:\s*([^\n]+)/)?.[1]?.trim();
  let divergence = false;
  if (taskInMd !== task.taskId) {
    warnings.push(
      `對不上：state.md 的 task_id（${taskInMd}）和 tasks.json 的 task_id（${task.taskId}）不一致`,
    );
    divergence = true;
  }
  if (stateInMd !== task.state) {
    warnings.push(
      `對不上：state.md 的 state（${stateInMd}）和 tasks.json 的 state（${task.state}）不一致`,
    );
    divergence = true;
  }
  if (divergence) {
    warnings.push("tasks.json 和 state.md 的內容對不上。呼叫 task-state-sync 重新把游標狀態寫進 state.md。");
  }
  return { divergence, warnings, stateMdMissing: false };
}

export interface ContentRefOutcome {
  count: number;
  warnings: string[];
  /** plans.json 缺檔或損壞 → skipped。 */
  unavailableReason?: string;
}

/** 進行中計畫缺 `contentRef` 的數量（內容檔缺漏診斷）。 */
export function collectMissingContentRef(
  plansRegistry: PlansRegistry | null,
  plansUnavailableReason?: string,
): ContentRefOutcome {
  if (!plansRegistry) {
    return { count: 0, warnings: [], unavailableReason: plansUnavailableReason };
  }
  let count = 0;
  for (const plan of Object.values(plansRegistry.plans)) {
    const isActive = !["COMPLETED", "FAILED", "CANCELLED"].includes(plan.state);
    if (isActive && !plan.contentRef) count += 1;
  }
  const warnings: string[] = [];
  if (count > 0) {
    warnings.push(
      `有 ${count} 個進行中的計畫沒有 contentRef——.ultrawork/plans/ 底下缺少這些計畫的正文內容。用 plan-content-create 補上。`,
    );
  }
  return { count, warnings };
}

export interface PlanHealthOutcome {
  health: PlanRegistryHealth | null;
  unavailableReason?: string;
}

/** 計畫註冊檔健康檢查（純函式 `inspectPlanRegistry` 的包裝）。 */
export function collectPlanRegistryHealth(
  plansRegistry: PlansRegistry | null,
  registry: TasksRegistry,
  unavailableReason?: string,
): PlanHealthOutcome {
  if (!plansRegistry) return { health: null, unavailableReason };
  const report: PlanRegistryHealthReport = inspectPlanRegistry(plansRegistry, registry);
  return {
    health: {
      ok: report.ok,
      issue_count: report.issueCount,
      error_count: report.errorCount,
      warn_count: report.warnCount,
      issues: report.issues,
    },
  };
}

export interface ContentStoreMarkerOutcome {
  marker: InconsistentMarker | null;
  /** plans 目錄不存在或路徑守衛擋下 → skipped。 */
  unavailableReason?: string;
}

/**
 * 內容庫不一致標記（只診斷、不清除、不復原）。
 *
 * V2 的 `readInconsistentMarker` 是雙參數 `(projectRoot, plansDir)`；舊版單參數
 * 簽名只收 plans 目錄，少了 projectRoot 就無法做路徑守衛。
 */
export function collectContentStoreMarker(paths: Paths): ContentStoreMarkerOutcome {
  if (!existsSync(paths.PLANS_DIR)) {
    return { marker: null, unavailableReason: `內容庫目錄不存在：${paths.PLANS_DIR}` };
  }
  try {
    return { marker: readInconsistentMarker(paths.PROJECT_ROOT, paths.PLANS_DIR) };
  } catch (error) {
    return { marker: null, unavailableReason: `讀取不一致標記失敗：${(error as Error).message}` };
  }
}

/**
 * 讀 plans.json。
 *
 * 缺檔時 runtime 本身回空 registry（不建立檔案）。損壞時 catch 並回一個同形的
 * 空 registry 加上原因，讓呼叫端能繼續產出摘要、同時把相關檢查標成 skipped，
 * 而不是整個工具失敗。
 */
export function readPlansForDiagnostics(
  deps: DiagnosticsDeps,
  context: ToolExecutionContext,
): { plans: PlansRegistry; reason?: string } {
  const project = deps.runtime.getCurrentProject(context);
  try {
    return { plans: deps.runtime.readPlansRegistry(context, false) };
  } catch (error) {
    return {
      plans: {
        version: "",
        projectId: project.projectId,
        projectPath: project.projectPath,
        activePlanIds: [],
        planCursor: null,
        plans: {},
      },
      reason: `plans.json 讀取失敗：${(error as Error).message}`,
    };
  }
}

/** 讀 tasks.json；損壞時回空 registry 加原因（同上，呼叫端自行決定要不要標 skipped）。 */
export function readTasksForDiagnostics(
  deps: DiagnosticsDeps,
  context: ToolExecutionContext,
): { registry: TasksRegistry; reason?: string; project: ProjectBinding } {
  const project = deps.runtime.getCurrentProject(context);
  try {
    return { registry: deps.runtime.readRegistry(context), project };
  } catch (error) {
    return {
      registry: deps.runtime.createEmptyTasksRegistry(project),
      reason: `tasks.json 讀取失敗：${(error as Error).message}`,
      project,
    };
  }
}

/** 把 `checks[]` 的統計拆成呼叫端需要的計數。 */
export function countByStatus(checks: readonly CheckItem[]): Record<CheckItem["status"], number> {
  return {
    passed: checks.filter((c) => c.status === "passed").length,
    failed: checks.filter((c) => c.status === "failed").length,
    warn: checks.filter((c) => c.status === "warn").length,
    skipped: checks.filter((c) => c.status === "skipped").length,
  };
}

/** 記憶體目錄（`.ultrawork/`）；bootstrap 的 `project.memoryDir` 欄位。 */
export function memoryDirOf(paths: Paths): string {
  return join(paths.PROJECT_ROOT, ".ultrawork");
}
