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
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ultraworkGitignoreHasRequiredLines } from "../../migrate/index.ts";
import type { ToolExecutionContext } from "../../kit/define-tool.ts";
import {
  BOOTSTRAP_FULL_SOFT_BUDGET,
  PROJECT_MD_HARD_LIMIT,
  STATE_MD_LIMIT,
  getProjectMdCurrentSections,
  getProjectMdNearLimitThreshold,
  getProjectMdOverLimitHint,
  resolveProjectMdPolicyFromContent,
} from "../memory/index.ts";
import {
  inspectContentRef,
  inspectPlanRegistry,
  isFinishedPlanState,
  isFinishedTaskState,
  readInconsistentMarker,
  type ContentRefDefect,
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
    // 「活躍」用 `isFinishedPlanState` 判定（COMPLETED／FAILED／CANCELLED 為終態），
    // 不在這裡另寫一份狀態清單 —— 下面 `collectContentRefIntegrity` 的嚴重度分級
    // 必須與這一條同一個判斷，寫兩份就會漂。
    if (!isFinishedPlanState(plan.state) && !plan.contentRef) count += 1;
  }
  const warnings: string[] = [];
  if (count > 0) {
    warnings.push(
      `有 ${count} 個進行中的計畫沒有 contentRef——.ultrawork/plans/ 底下缺少這些計畫的正文內容。用 plan-content-create 補上。`,
    );
  }
  return { count, warnings };
}

/** 註冊檔裡一筆用不了的參照；`kind` 決定 doctor 的嚴重度（見 `collectContentRefIntegrity`）。 */
export interface ContentRefIssue {
  owner: "plan" | "task";
  id: string;
  field: "contentRef" | "contentPath" | "taskContentPath";
  ref: string;
  kind: Exclude<ContentRefDefect, null>;
  /** 可執行的修法（點名持有者、原始值、該改成什麼）。 */
  repair: string;
}

export interface ContentRefIntegrityOutcome {
  /** 全部問題（含只算 warn 的）。每筆的欄位形狀是 doctor 的對外欄位，不要加東西。 */
  issues: ContentRefIssue[];
  /** 必須讓診斷失敗的那些（`issues` 的子集，同一批物件）。 */
  blocking: ContentRefIssue[];
  /** plans.json／tasks.json 其中之一讀不到時 → skipped。 */
  unavailableReason?: string;
}

/**
 * 不論持有者是進行中還是已終態，都算必須回報的缺陷。
 *
 * 共同點是「這筆引用永遠指向不到正文」：守衛擋下（`legacy-prefix`／`outside-store`），
 * 或目標根本不是可讀的檔（`not-a-file`）。目錄不是合法的正文目標，所以它跟
 * `missing-file` 不同 —— 就算計畫已封存，引用指著目錄仍然是壞的。
 */
const STRUCTURAL_DEFECTS: ReadonlySet<ContentRefIssue["kind"]> = new Set<ContentRefIssue["kind"]>([
  "legacy-prefix",
  "outside-store",
  "not-a-file",
]);

/** 這筆問題是否必須讓診斷失敗。 */
function isBlockingRefIssue(issue: ContentRefIssue, ownerIsActive: boolean): boolean {
  if (STRUCTURAL_DEFECTS.has(issue.kind)) return true;
  // `missing-file`：引用格式沒問題，缺的只是正文。已封存／已完成的項目常是這個狀態
  // （正文清掉、引用留著），拿它擋人沒有道理；進行中／活躍的項目才是真的讀不到東西。
  return issue.kind === "missing-file" && ownerIsActive;
}

/**
 * 逐項驗證註冊檔裡的每一個 `contentRef`（計畫與任務）與 `taskContentPath`。
 *
 * 為什麼需要這一項：原本 doctor 只數「進行中計畫**缺** `contentRef`」（欄位不存在），
 * 看不到「欄位在、但指向用不了的位置」。於是註冊檔留著已搬走的 `.opencode/` 引用時，
 * 每一項檢查都回通過，直到有人建立新計畫才被路徑守衛擋下，而錯誤訊息只會講那個
 * 檔案路徑，不會講是哪個計畫害的。
 *
 * 判定**不是**另一份路徑規則：每個值都餵給讀寫工具同一個 `inspectContentRef`
 * （裡面就是 `resolvePlansContentRef` → `assertSafePlansPath`）。同一個值，
 * doctor 與工具一定給同一個答案。
 *
 * 嚴重度分兩級，界線與既有的 `collectMissingContentRef` 一致 —— 那條檢查只把
 * **進行中**（非 COMPLETED／FAILED／CANCELLED）計畫的「缺欄位」算成問題，所以
 * 「進行中項目指向不存在的正文」同樣必須算問題；已終態的正文缺失維持 warn。
 */
export function collectContentRefIntegrity(
  paths: Paths,
  plansRegistry: PlansRegistry | null,
  registry: TasksRegistry,
  plansUnavailableReason?: string,
): ContentRefIntegrityOutcome {
  const issues: ContentRefIssue[] = [];
  if (!plansRegistry) {
    return { issues, blocking: [], unavailableReason: plansUnavailableReason };
  }
  const { PROJECT_ROOT, PLANS_DIR } = paths;
  const blocking: ContentRefIssue[] = [];
  const inspect = (
    ref: string | undefined,
    owner: { owner: "plan" | "task"; id: string; field: ContentRefIssue["field"] },
    ownerIsActive: boolean,
  ): void => {
    if (!ref) return;
    const inspection = inspectContentRef(ref, PROJECT_ROOT, PLANS_DIR, owner);
    if (!inspection.defect || !inspection.message) return;
    const issue: ContentRefIssue = { ...owner, ref, kind: inspection.defect, repair: inspection.message };
    issues.push(issue);
    if (isBlockingRefIssue(issue, ownerIsActive)) blocking.push(issue);
  };
  for (const plan of Object.values(plansRegistry.plans)) {
    // 活躍語意與 `collectMissingContentRef` 同一個來源（同一組終態常數）。
    const active = !isFinishedPlanState(plan.state);
    inspect(plan.contentRef, { owner: "plan", id: plan.planId, field: "contentRef" }, active);
    inspect(plan.contentPath, { owner: "plan", id: plan.planId, field: "contentPath" }, active);
  }
  for (const task of Object.values(registry.tasks)) {
    const active = !isFinishedTaskState(task.state);
    inspect(task.contentRef, { owner: "task", id: task.taskId, field: "contentRef" }, active);
    inspect(task.taskContentPath, { owner: "task", id: task.taskId, field: "taskContentPath" }, active);
  }
  return { issues, blocking };
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

// ─── `.ultrawork/` 版控衛生（`workflow_doctor` 用，唯讀）───
//
// 三種情況（都是 warn，不影響診斷 ok；插件永遠不改使用者的版控，只提示）：
// (a) `.ultrawork/.gitignore` 缺必要行（`*`）；
// (b) `.ultrawork/` 內有檔案正被版控追蹤（含已追蹤的 `ultrawork.jsonc`）；
// (c) 專案設定檔（`ultrawork.jsonc`）仍被豁免（`!ultrawork.jsonc` 還在）。
//
// 必要行的判準與搬移端同一個（`ultraworkGitignoreHasRequiredLines`），兩端對同一個
// 檔案給同一個答案。全域層不建 `.gitignore`、插件不插手使用者的全域政策，所以這裡
// 只看專案層。

/** 專案設定檔名：豁免檢查只認它（`!ultrawork.jsonc`／`!/ultrawork.jsonc`）。 */
export const ULTRAWORK_SETTINGS_FILE = "ultrawork.jsonc";

export interface UltraworkGitignoreHealth {
  /** `.gitignore` 不存在或讀不到時為 `undefined`（等同缺必要行）。 */
  content: string | undefined;
  /** 有必要行 `*`。 */
  hasRequiredLine: boolean;
  /** 專案設定檔仍被豁免（`!ultrawork.jsonc` 還在）。 */
  exemptsSettingsFile: boolean;
}

/** 讀專案層 `.ultrawork/.gitignore` 並判斷三種情況裡的 (a) 與 (c)。 */
export function checkUltraworkGitignore(projectRoot: string): UltraworkGitignoreHealth {
  let content: string | undefined;
  try {
    const path = join(projectRoot, ".ultrawork", ".gitignore");
    content = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
  } catch {
    content = undefined;
  }
  if (content === undefined) return { content, hasRequiredLine: false, exemptsSettingsFile: false };
  return { content, ...checkUltraworkGitignoreContent(content) };
}

/** 純函式：這份 `.gitignore` 內容有沒有必要行、豁免了設定檔沒有。 */
export function checkUltraworkGitignoreContent(content: string): {
  hasRequiredLine: boolean;
  exemptsSettingsFile: boolean;
} {
  // 必要行的判準與搬移端同一個（`ultraworkGitignoreHasRequiredLines`），兩端對同一個
  // 檔案給同一個答案；豁免檢查是診斷端自己的（搬移端不管豁免，只管不覆寫）。
  return {
    hasRequiredLine: ultraworkGitignoreHasRequiredLines(content),
    exemptsSettingsFile: content
      .split("\n")
      .map((line) => line.trim().replace(/\r$/, ""))
      .some((line) => line.startsWith("!") && gitignoreNegationMatchesFile(line.slice(1).trim(), ULTRAWORK_SETTINGS_FILE)),
  };
}

/**
 * 這條否定規則（`!` 之後的內容）會不會讓 `fileName` 重新納入版控。
 *
 * 不只認 `!ultrawork.jsonc` 這種精確寫法：`!*.jsonc` 這類廣泛否定同樣會讓設定檔
 * 被追蹤，必須警告。實作是 gitignore 語意的最小子集（只為這一個檔名服務）：
 * `*` 不跨 `/`、`?` 單字元、`[...]` 字元組、雙星號斜線可匹配零層目錄；行首 `/` 與
 * `./` 視為錨定到 `.ultrawork/` 根目錄。完整語意（中段雙星號、跳脫字元等）不在
 * 範圍內 —— 判讀方向偏向「寧可多報」：寫法看不懂時當成會匹配，提醒使用者人工確認，
 * 也不影響診斷 ok。
 */
export function gitignoreNegationMatchesFile(pattern: string, fileName: string): boolean {
  let normalized = pattern.replace(/^\.\//, "").replace(/^\//, "");
  if (normalized === "" || normalized.endsWith("/")) return false;
  const anchored = normalized.includes("/");
  const candidates = anchored
    ? [normalized, normalized.replace(/\*\*\//g, "")]
    : [normalized];
  return candidates.some((candidate) => gitignoreGlobMatches(candidate, anchored ? fileName : basenameOf(fileName)));
}

/** 最小 glob：`*` 不跨 `/`，`?` 單字元，`[...]`（含 `[!...]`）字元組，`**` 跨目錄。 */
function gitignoreGlobMatches(pattern: string, text: string): boolean {
  let regex = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        regex += ".*";
        index += 1;
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close === -1) return true;
      const body = pattern.slice(index + 1, close);
      regex += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      index = close;
    } else {
      regex += char.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  try {
    return new RegExp(`^${regex}$`).test(text);
  } catch {
    return true;
  }
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export interface UltraworkGitTrackingHealth {
  /** 被版控追蹤的 `.ultrawork/` 內檔案（相對於專案根目錄）；`null` 代表查不到。 */
  tracked: string[] | null;
  /** `tracked` 為 `null` 時的原因（不是 git repo、沒有 git 等）。 */
  unavailableReason?: string;
}

/**
 * 列出被版控追蹤的 `.ultrawork/` 內檔案（唯讀的 `git ls-files`）。
 *
 * 失敗（不是 git repo、沒有 git、被拒）就回 `tracked: null` 加原因，呼叫端標
 * skipped、不假裝檢查過。絕不執行任何會改動版控的指令。
 */
export function collectUltraworkGitTracking(projectRoot: string): UltraworkGitTrackingHealth {
  try {
    const output = execFileSync("git", ["-C", projectRoot, "ls-files", "-z", "--", ".ultrawork"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tracked = output.split("\0").filter((entry) => entry !== "").sort();
    return { tracked };
  } catch (error) {
    return { tracked: null, unavailableReason: (error as Error).message };
  }
}
