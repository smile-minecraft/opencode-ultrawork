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
import { GLOBAL_MIGRATION_ITEMS, ultraworkGitignoreHasRequiredLines } from "../../migrate/index.ts";
import type { ToolExecutionContext } from "../../kit/define-tool.ts";
import { BOOTSTRAP_FULL_SOFT_BUDGET, STATE_MD_LIMIT } from "../workflow/core/constants.ts";
import { DEFAULT_MEMORY_BUDGET, LOG_WARN_BYTES, budgetForLayer, type MemoryBudgets } from "../memory/constants.ts";
import { memoryLayers, memoryPath, readOptional } from "../memory/layers.ts";
import { listTopics } from "../memory/topic.ts";
import { renderIndex } from "../memory/index-render.ts";
import { readLog, verifyLog, pendingNotes } from "../memory/log.ts";
import { mismatchedTopics } from "../memory/disposition.ts";
import { inspectMemoryMigration } from "../../migrate/memory-store.ts";
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

/** 單一記憶層的預算狀態（企劃書第 12 節）。欄位形狀凍結：上限走設定值，不加欄位。 */
export interface LayerBudget {
  index_chars: number;
  index_limit: number;
  topics: number;
  oversized_topics: string[];
  pinned: number;
  status: "ok" | "warn";
}

/** 記憶體預算區塊：兩層記憶各自的預算，加上 state.md 與 bootstrap 的大小。 */
export interface MemoryBudget {
  layers: Record<"project" | "global", LayerBudget>;
  state_md_size: number;
  state_md_limit: number;
  state_md_status: "ok" | "warn";
  bootstrap_full_estimated_chars: number;
  bootstrap_full_status: "ok" | "warn";
  missing_content_ref_plan_count: number;
  missing_content_ref_status: "ok" | "warn";
  registry_projection_divergence: boolean;
  registry_projection_status: "ok" | "warn";
}

export interface PlanRegistryHealth {
  ok: boolean;
  issue_count: number;
  error_count: number;
  warn_count: number;
  issues: PlanRegistryHealthIssue[];
}

function emptyLayerBudget(): LayerBudget {
  return { index_chars: 0, index_limit: DEFAULT_MEMORY_BUDGET.indexCharLimit, topics: 0, oversized_topics: [], pinned: 0, status: "ok" };
}

export function emptyMemoryBudget(): MemoryBudget {
  return {
    layers: { project: emptyLayerBudget(), global: emptyLayerBudget() },
    state_md_size: 0,
    state_md_limit: STATE_MD_LIMIT,
    state_md_status: "ok",
    bootstrap_full_estimated_chars: 0,
    bootstrap_full_status: "ok",
    missing_content_ref_plan_count: 0,
    missing_content_ref_status: "ok",
    registry_projection_divergence: false,
    registry_projection_status: "ok",
  };
}

export function emptyPlanRegistryHealth(): PlanRegistryHealth {
  return { ok: true, issue_count: 0, error_count: 0, warn_count: 0, issues: [] };
}

/** 讀檔取長度；檔案不存在回 0。不建立任何檔案。 */
export function fileSize(path: string): number {
  return existsSync(path) ? readFileSync(path, "utf-8").length : 0;
}

/** 兩層記憶的索引全文（由主題重新產生，不信任磁碟上的 MEMORY.md）；沒有主題的層是空字串。 */
export function collectMemoryIndexes(projectRoot: string, globalRoot: string): Record<"project" | "global", string> {
  const indexes = { project: "", global: "" };
  for (const layer of memoryLayers(projectRoot, globalRoot)) {
    const topics = listTopics(layer);
    indexes[layer.layer] = topics.length > 0 ? renderIndex(topics, layer.layer) : "";
  }
  return indexes;
}

export interface MemoryBudgetOutcome {
  memory_budget: MemoryBudget;
  warnings: string[];
  /** Memory Budget／Store／Log Integrity／Pending Notes／Migration 五項檢查，都是 warn 等級。 */
  checks: CheckItem[];
}

/** 未整理筆記超過這個數量就提醒派 memorizer 整理。 */
const PENDING_NOTES_WARN = 10;

/**
 * 記憶預算與健康診斷（唯讀）。
 *
 * 所有項目都是 warn，不影響診斷 ok：預算超標、紀錄斷裂、待遷移都不會讓外掛停擺，
 * 需要的是派 memorizer 整理。state.md 與 bootstrap 的大小規則與舊版相同。
 *
 * 上限用「該層」的設定（`budgets` 沒給時用內建預設）；回傳欄位形狀不變，
 * 超過上限（索引、超大主題、pinned 過多、主題數超限）都走同一個 warn。
 */
export function collectMemoryBudget(paths: Paths, globalRoot: string = paths.PROJECT_ROOT, budgets?: MemoryBudgets): MemoryBudgetOutcome {
  const memory_budget = emptyMemoryBudget();
  const warnings: string[] = [];
  const checks: CheckItem[] = [];
  let readable = true;
  let integrity = true;
  let pendingNoteCount = 0;

  try {
    for (const layer of memoryLayers(paths.PROJECT_ROOT, globalRoot)) {
      try {
        const budget = budgetForLayer(budgets, layer.layer);
        const topics = listTopics(layer);
        const index = topics.length > 0 ? renderIndex(topics, layer.layer) : "";
        const oversized = topics.filter((topic) => topic.size > budget.topicCharLimit).map((topic) => topic.topic);
        const pinned = topics.filter((topic) => topic.frontmatter.pinned).length;
        const overCount = budget.maxTopics > 0 && topics.length > budget.maxTopics;
        const overBudget = index.length > budget.indexCharLimit || oversized.length > 0 || pinned > budget.pinnedLimit || overCount;
        memory_budget.layers[layer.layer] = {
          index_chars: index.length,
          index_limit: budget.indexCharLimit,
          topics: topics.length,
          oversized_topics: oversized,
          pinned,
          status: overBudget ? "warn" : "ok",
        };
        if (overBudget) {
          const reasons = [
            index.length > budget.indexCharLimit ? `索引 ${index.length} 字元超過上限 ${budget.indexCharLimit}` : null,
            oversized.length > 0 ? `主題 ${oversized.join("、")} 超過單主題上限 ${budget.topicCharLimit} 字元` : null,
            pinned > budget.pinnedLimit ? `pinned ${pinned} 個超過上限 ${budget.pinnedLimit}` : null,
            overCount ? `主題 ${topics.length} 個超過上限 ${budget.maxTopics}（既有主題保留，只擋新增）` : null,
          ].filter((reason): reason is string => reason !== null);
          warnings.push(`${layer.layer} 層記憶超過預算（${reasons.join("；")}），請派 memorizer 用 memory-maintain report 整理。`);
        }
        if (topics.length > 0 && readOptional(memoryPath(layer, "MEMORY.md")) !== index) {
          warnings.push(`${layer.layer} 層的 MEMORY.md 與主題不一致，下一次 memory-write 會重建。`);
        }
        const entries = readLog(layer);
        const layerIntact = verifyLog(entries) && mismatchedTopics(layer, entries, topics.map((topic) => topic.topic)).length === 0;
        integrity = integrity && layerIntact;
        pendingNoteCount += pendingNotes(entries).length;
        if (Buffer.byteLength(readOptional(memoryPath(layer, "log.jsonl")) ?? "") > LOG_WARN_BYTES) {
          warnings.push(`${layer.layer} 層的 log.jsonl 超過 ${LOG_WARN_BYTES / 1024 / 1024} MB；目前不會自動輪替。`);
        }
      } catch {
        // 讀不到就無法確認紀錄與主題一致，完整性一併視為未通過。
        readable = false;
        integrity = false;
        memory_budget.layers[layer.layer].status = "warn";
        warnings.push(`${layer.layer} 層的記憶無法安全讀取，請檢查主題格式、權限與符號連結。`);
      }
    }
  } catch {
    readable = false;
    integrity = false;
    warnings.push("記憶根目錄不安全（系統根目錄、家目錄或符號連結），未讀取記憶。");
  }

  const overBudgetLayers = Object.values(memory_budget.layers).filter((layer) => layer.status === "warn").length;
  checks.push({
    name: "Memory Budget",
    status: overBudgetLayers > 0 ? "warn" : "passed",
    details: overBudgetLayers > 0
      ? "有記憶層超過預算，請派 memorizer 用 memory-maintain report 整理。"
      : "兩層記憶都在預算內。",
  });
  checks.push({
    name: "Memory Store",
    status: readable ? "passed" : "warn",
    details: readable ? "兩層記憶都能讀取（還沒有記憶不算失敗）。" : "有記憶層讀取失敗，詳見 warnings。",
  });
  checks.push({
    name: "Memory Log Integrity",
    status: integrity ? "passed" : "warn",
    details: integrity
      ? "記憶紀錄的 hash 鏈完整，主題與最後一筆寫入紀錄一致。"
      : "紀錄鏈斷裂或主題在工具外被修改，請派 memorizer 用 memory-maintain report 檢查，確認後用 reseal-log。",
  });
  checks.push({
    name: "Memory Pending Notes",
    status: pendingNoteCount > PENDING_NOTES_WARN ? "warn" : "passed",
    details: `未整理的筆記 ${pendingNoteCount} 筆${pendingNoteCount > PENDING_NOTES_WARN ? "，請派 memorizer 整理" : ""}。`,
  });
  const migration = inspectMemoryMigration(paths.PROJECT_ROOT);
  checks.push({
    name: "Memory Migration",
    status: migration.pending || migration.error ? "warn" : "passed",
    details:
      migration.error ??
      (migration.pending ? "舊的 project.md 還沒遷移，下次啟動或存取記憶時會重試。" : "沒有待遷移的舊記憶。"),
  });

  memory_budget.state_md_size = fileSize(paths.STATE_MD);
  if (memory_budget.state_md_size > STATE_MD_LIMIT) {
    memory_budget.state_md_status = "warn";
    warnings.push(`state.md 超過大小上限（${memory_budget.state_md_size} > ${STATE_MD_LIMIT}），請精簡游標投影。`);
  }
  const indexChars = memory_budget.layers.project.index_chars + memory_budget.layers.global.index_chars;
  memory_budget.bootstrap_full_estimated_chars = indexChars + memory_budget.state_md_size + 2048;
  if (memory_budget.bootstrap_full_estimated_chars > BOOTSTRAP_FULL_SOFT_BUDGET) {
    memory_budget.bootstrap_full_status = "warn";
    warnings.push("bootstrap full 模式的預估大小超過建議上限，請改用 minimal 模式。");
  }
  return { memory_budget, warnings, checks };
}

/** `memory.writerAgents` 為空時，高風險任務無法宣告記憶處置；doctor 與 health_check 共用。 */
export function memoryWriterConfigCheck(writerAgents: readonly string[]): CheckItem {
  return writerAgents.length > 0
    ? { name: "Memory Writer Config", status: "passed", details: `允許寫記憶的 agent：${writerAgents.join("、")}。` }
    : { name: "Memory Writer Config", status: "warn", details: "memory.writerAgents 是空的，沒有 agent 能寫記憶，高風險任務將無法結案。" };
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

// ─── 專案層與全域層共用同一個資料夾 ───
//
// 在全域設定資料夾本身開工作階段時，專案根目錄就是全域設定資料夾，兩層共用同一個
// `.ultrawork/`（搬遷標記的分層記錄是同一類問題，見 `src/migrate/marker.ts`）。
// 這時 `.ultrawork/` 裡同時放著全域層的檔案：它們要不要進版控是使用者的全域政策，
// 外掛不插手，所以版控衛生檢查不能把它們當成「本機工作流狀態外洩」。

/**
 * 同資料夾時屬於全域層的 `.ultrawork/` 內路徑（相對於專案根目錄）。
 *
 * 全域層的 skiller 資料（清單與搬遷端同一份 `GLOBAL_MIGRATION_ITEMS`）、全域設定檔
 * `ultrawork.jsonc`（同一份檔案同時是兩層的設定），以及承載使用者全域版控政策的
 * `.gitignore`。專案層的工作流資料（tasks.json、plans.json…）不在清單裡，照常警告。
 */
export const SHARED_GLOBAL_LAYER_ENTRIES: readonly string[] = [
  ...GLOBAL_MIGRATION_ITEMS.map((item) => item.to),
  `.ultrawork/${ULTRAWORK_SETTINGS_FILE}`,
  ".ultrawork/.gitignore",
];

/** 這個被追蹤的路徑是不是同資料夾時的全域層檔案（目錄項目含底下所有檔案）。 */
export function isSharedGlobalLayerEntry(trackedPath: string): boolean {
  return SHARED_GLOBAL_LAYER_ENTRIES.some((entry) => trackedPath === entry || trackedPath.startsWith(`${entry}/`));
}

export { isSameAsGlobalConfigDir } from "../../settings/paths.ts";

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

