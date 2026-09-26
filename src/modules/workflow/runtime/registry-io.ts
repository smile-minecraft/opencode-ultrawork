/**
 * opencode-ultrawork — runtime registry IO (tasks.json / plans.json / lazyEnsure)
 *
 * 角色：
 *     函式為 runtime module-level 函式，附掛於 `UltraworkRuntimeContext`：
 *       · `ensureDir(path, context?)`：不安全 root 短路後 `mkdir -p`。
 *       · `lazyEnsure(context?)`：首次讀/寫時建立 `project.md` / `state.md`
 *         / `tasks.json` 等 專案記憶 檔。
 *       · `readRegistry(context?, createIfMissing?)` / `writeRegistry(registry, context?)`
 *       · `readPlansRegistry(context?, createIfMissing?)` / `writePlansRegistry(registry, context?)`
 *         含 prune cleanup（刪除 finished plans 超出 limit 的 content file、
 *         清理對應 task content refs）。
 *
 * 對外規則（不可破壞）：
 *   - 所有抽出函式（含 prune cleanup 細節、order of operations、throw vs
 *   - 透過 `UltraworkRuntimeContext` 取得：當前 project binding、paths、
 *     registry normalization helpers（`createEmptyTasksRegistry` /
 *     `normalizeTasksRegistry` closure wrapper 注入）、`debugLog`、
 *     `isUnsafeRoot` 等 primitive，避免在 leaf module 內重新實作
 *     closure-scoped 邏輯。
 *   - `writePlansRegistry` 內的 prune cleanup 仍須呼叫同 runtime 的
 *     `readRegistry` / `writeRegistry`（而非直接讀檔），確保 closure 內
 *     `createEmptyTasksRegistry` closure wrapper 的 `project = getCurrentProject()`
 *     預設值語意被保留。
 *
 * 限制：
 *
 * @see ../../../../README.md                              — 模組一覽
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "../../../kit/atomic-write.ts";
import { withContentWriteLock } from "../../../kit/write-lock.ts";
import type { ToolExecutionContext } from "../../../kit/define-tool.ts";

type ToolContext = ToolExecutionContext;
import {
  assertSafePlansPath,
  deletePlanContentStrict,
  inspectContentRef,
  planContentPath,
  type ContentRefOwner,
} from "../content/content-ref.ts";
import { taskDependsOnPlanSection } from "../gates/plan-link-validation.ts";
import { restoreBytesAtomic } from "../content/byte-restore.ts";
import { assertSafeContentPath, assertSafeProjectFile } from "../content/content-store.ts";
import { pathIdentityKey, samePathIdentity } from "../content/path-identity.ts";
import { isFinishedPlanState, isFinishedTaskState } from "../core/helpers.ts";
import { PROJECT_MD_HARD_LIMIT } from "../core/constants.ts";
import {
  createEmptyPlansRegistry,
  normalizePlansRegistry,
  prunePlansRegistry,
} from "../registry/plan-registry.ts";
import { recordCompletionTombstone } from "../registry/plan-completion.ts";
import type { TasksRegistry, PlansRegistry } from "../core/types.ts";
import type { RuntimeBaseContext } from "./context-builder.ts";

/**
 * Registry IO 錯誤：攜帶固定、機器可判斷的 `code`，沿用 plugin 既有
 * UPPER_SNAKE_CASE 錯誤 code 慣例。
 *
 * - `REGISTRY_CORRUPT`：registry 檔存在但 JSON parse 失敗。
 * - `REGISTRY_READ_ERROR`：registry 檔存在但讀取失敗（權限／IO）。
 * - `MEMORY_IO_ERROR`：lazyEnsure 建立 memory 目錄或 skeleton 檔失敗。
 */
export class RegistryIOError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RegistryIOError";
    this.code = code;
  }
}

/**
 * 一次跨 tasks.json / plans.json 的原子交易草稿。
 */
export interface RegistryTransactionDraft {
  tasks: TasksRegistry;
  plans: PlansRegistry;
}

/**
 * 註冊檔裡的參照能不能解析成內容庫內的路徑；不能就回 `null` 並記一行 debug log。
 *
 * 為什麼 commit stage 不用會丟錯的解析：這裡解析出來的值只拿來做兩件事 ——
 * 組「不要誤刪別人內容檔」的名單、決定被 prune 的計畫要刪哪個檔。兩者都發生在
 * **別人**的資料上：一個殘留的舊引用（搬遷改寫漏一筆就會留下）如果讓這裡丟錯，
 * `writeRegistry`／`writePlansRegistry`／`transactRegistries` 的每一次 commit 都會
 * 失敗並回滾，於是「建立一個新計畫」這種與它無關的操作也一起被癱瘓
 * （實地回報：`plan-state-sync({event:"create"})` 被舊計畫的 `.opencode/` 引用擋死）。
 *
 * 這不是放寬路徑保護：解析不到的引用一定在 `PLANS_DIR` 之外，本來就刪不到東西，
 * 也不會與任何候選刪除檔同名同路，所以跳過它不會讓比對結果變寬鬆。真正要刪的
 * 檔案在落盤前仍逐條過 `assertSafeContentPath`（fail-closed 不變）。跳過的引用
 * 由 `workflow_doctor` 逐項回報，訊息裡帶持有者與修法。
 */
function bestEffortContentPath(
  ref: string,
  root: string,
  plansDir: string,
  owner: ContentRefOwner,
  debugLog: (message: string) => void,
): string | null {
  const inspection = inspectContentRef(ref, root, plansDir, owner);
  if (inspection.resolvedPath !== null) return inspection.resolvedPath;
  debugLog(`Skipped unresolvable ${owner.field} of ${owner.owner} ${owner.id}: ${ref} — ${inspection.message ?? "path guard rejected it"}`);
  return null;
}

export interface RegistryTransactionControl {
  commit(): void;
}

export type RegistryTransactionOperation<T> = (
  draft: RegistryTransactionDraft,
  control: RegistryTransactionControl,
) => Promise<T> | T;

export interface RegistryIOOptions {
  /** 測試注入點；正式路徑固定使用原子寫入。 */
  writeFile?: (path: string, content: string) => void;
  /** 測試注入點；正式路徑使用不吞錯的內容刪除。 */
  deleteContent?: (path: string, plansDir: string, projectRoot: string) => void;
}

/**
 * RegistryRuntimeContext：RuntimeBaseContext + lazyEnsure / readRegistry /
 * writeRegistry / readPlansRegistry / writePlansRegistry。
 *
 * 這是給 state-projection / 更新紀錄 validator 等上層 factory 用的 DI 介面：它只
 * 暴露 registry 讀寫能力，上層因此不必依賴整包 runtime context。
 */
export interface RegistryRuntimeContext extends RuntimeBaseContext {
  lazyEnsure(context?: unknown): void;
  readRegistry(context?: unknown, createIfMissing?: boolean): TasksRegistry;
  writeRegistry(registry: TasksRegistry, context?: unknown): Promise<void>;
  readPlansRegistry(context?: unknown, createIfMissing?: boolean): PlansRegistry;
  writePlansRegistry(registry: PlansRegistry, context?: unknown): Promise<void>;
  transactRegistries<T>(
    context: ToolContext | undefined,
    operation: RegistryTransactionOperation<T>,
  ): Promise<T>;
}

/**
 * 建立 registry IO 函式集合，回傳符合 `RegistryRuntimeContext` 的 DI 介面。
 *
 * 對應舊版 closure 內 lazyEnsure / readRegistry / writeRegistry /
 * readPlansRegistry / writePlansRegistry；行為與原 closure 版本**逐字一致**。
 */
export function createRegistryIO(
  runtime: RuntimeBaseContext,
  options: RegistryIOOptions = {},
): RegistryRuntimeContext {
  const writeFile = options.writeFile ?? atomicWriteFile;
  const deleteContent = options.deleteContent ?? ((path, plansDir, projectRoot) => deletePlanContentStrict(projectRoot, path, plansDir));
  let registryQueue: Promise<void> = Promise.resolve();

  async function withRegistryLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
    const run = registryQueue.then(
      () => withContentWriteLock(lockPath, operation),
      () => withContentWriteLock(lockPath, operation),
    );
    registryQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 確保指定目錄存在；若解析出的 root 屬 unsafe，靜默跳過（與原 closure
   * 版本行為一致，不 throw）。
   */
  function ensureDir(path: string, context?: ToolContext): void {
    if (!existsSync(path)) {
      const root = runtime.resolveProjectRoot(context);
      if (runtime.isUnsafeRoot(root)) {
        runtime.debugLog(`ensureDir skipped: unsafe root ${root} for path ${path}`);
        return;
      }
      mkdirSync(path, { recursive: true });
    }
  }

  /**
   * Lazy ensure: 在首次讀取/寫入時創建必要的 memory 檔案。
   *
   * 與 closure 原版本行為一致：
   *   - 不安全 root 短路（靜默 log 並返回）
   *   - `ensureDir(MEMORY_DIR)` 與 `ensureDir(RECEIPTS_DIR)`
   *   - 若 `project.md` 不存在則寫入空白 project skeleton
   *   - 若 `state.md` 不存在則寫入 idle cursor projection skeleton
   *   - 若 `tasks.json` 不存在則寫入空 TasksRegistry
   *     （透過 `runtime.createEmptyTasksRegistry(getCurrentProject(context))`
   *     closure wrapper，保持 `project = getCurrentProject()` 預設值語意）
   *   - IO 失敗（磁碟滿、權限異常、目錄被檔案占位等）以
   *     `RegistryIOError("MEMORY_IO_ERROR")` 向呼叫端傳播；靜默吞掉會讓
   *     後續寫回把使用者任務歷史整個沖掉。
   */
  function lazyEnsure(context?: ToolContext): void {
    const root = runtime.resolveProjectRoot(context);
    if (runtime.isUnsafeRoot(root)) {
      runtime.debugLog(`lazyEnsure skipped: unsafe root ${root}`);
      return;
    }
    const { MEMORY_DIR, PROJECT_MD, STATE_MD, TASKS_JSON, RECEIPTS_DIR, PLANS_DIR } = runtime.getPaths(context);
    try {
      assertSafeProjectFile(root, PLANS_DIR, MEMORY_DIR);
      ensureDir(MEMORY_DIR, context);
      assertSafeProjectFile(root, PLANS_DIR, RECEIPTS_DIR);
      ensureDir(RECEIPTS_DIR, context);
      assertSafeProjectFile(root, PLANS_DIR, PROJECT_MD);
      if (!existsSync(PROJECT_MD)) {
        writeFileSync(PROJECT_MD, `---\ndescription: ''\nlabel: project\nlimit: ${PROJECT_MD_HARD_LIMIT}\nread_only: false\n---\n\n# Project Overview\n\n`, "utf-8");
      }
      assertSafeProjectFile(root, PLANS_DIR, STATE_MD);
      if (!existsSync(STATE_MD)) {
        // Idle cursor projection — 對齊 updateStateMd() 格式，不含完整 active task dashboard。
        writeFileSync(STATE_MD, "---\ndescription: Durable memory block. Cursor projection — keep this concise and high-signal.\nlabel: state\nlimit: 3000\nread_only: false\n---\n# Project State\n\nstate: IDLE\ntask_id: —\nowner: —\npriority: —\ncurrent_plan: —\n\n## Counts\nactive_tasks: 0\nin_progress_tasks: 0\npending_tasks: 0\nblocked_tasks: 0\nready_tasks: 0\nactive_plans: 0\nrecent_finished_tasks: 0\nrecent_finished_plans: 0\n\n## Refs\nregistry_ref: .ultrawork/tasks.json\ntask_cursor: —\nplans_ref: .ultrawork/plans.json\nplan_cursor: —\nfinished_task_limit: 5\nfinished_plan_limit: 5\n", "utf-8");
      }
      assertSafeProjectFile(root, PLANS_DIR, TASKS_JSON);
      if (!existsSync(TASKS_JSON)) {
        const emptyReg = runtime.createEmptyTasksRegistry(runtime.getCurrentProject(context));
        writeFileSync(TASKS_JSON, JSON.stringify(emptyReg, null, 2), "utf-8");
      }
    } catch (e: any) {
      runtime.debugLog(`lazyEnsure failed: ${e.message}`);
      throw new RegistryIOError("MEMORY_IO_ERROR", `lazyEnsure failed: ${e.message}`);
    }
  }

  /**
   * 讀取 tasks.json registry：
   *   - `createIfMissing=true` 時先 `lazyEnsure(context)`
   *   - 缺檔 → 回傳 `createEmptyTasksRegistry(project)`
   *   - 讀取失敗 → throw `RegistryIOError("REGISTRY_READ_ERROR")`
   *   - JSON parse 失敗 → throw `RegistryIOError("REGISTRY_CORRUPT")`；
   *     回傳空 registry 會讓後續寫回把使用者任務歷史整個沖掉，必須
   *     fail closed。
   *   - 正常 → `normalizeTasksRegistry(JSON.parse(...), project, protectedTaskIds)`
   *
   * `protectedTaskIds`：
   *   透傳至 `normalizeTasksRegistry` → `pruneTasksRegistryLeaf`，讓
   *   active plan 仍參照的 finished task 豁免 `FINISHED_TASK_LIMIT`。
   *   預設 `undefined` → 自動從 active plans 推導（與 writeRegistry 一致）。
   *
   * `inMemoryRegistry`：可選傳入
   *   即將被寫入的 in-memory TasksRegistry（包含尚未落盤的 candidate /
   *   restored deps）。computeProtectedTaskIds 會把這個 registry 中的 active
   *   task `dependsOn` 指向的 terminal deps 加入 protected set，確保
   *   `pruneTasksRegistryLeaf` 在寫入階段保留這些 freshly-restored
   *   finished dep。本參數僅供 writeRegistry 自己從 `registry` 參數透傳；
   *   外部 caller 不需手動指定。
   *
   * `project` 透過 `runtime.getCurrentProject(context)` 取得，由
   * `runtime.createEmptyTasksRegistry` closure wrapper 對應
   * `project = getCurrentProject()` 預設值語意。
   */
  function readRegistry(
    context?: ToolContext,
    createIfMissing: boolean = false,
    protectedTaskIds?: ReadonlySet<string>,
    inMemoryRegistry?: TasksRegistry,
  ): TasksRegistry {
    const root = runtime.resolveProjectRoot(context);
    const { PLANS_DIR } = runtime.getPaths(context);
    if (createIfMissing) {
      lazyEnsure(context); // Lazy ensure on first read
    }
    const project = runtime.getCurrentProject(context);
    const { TASKS_JSON } = runtime.getPaths(context);
    if (!createIfMissing) assertSafeProjectFile(root, PLANS_DIR, TASKS_JSON);
    if (!existsSync(TASKS_JSON)) {
      return runtime.createEmptyTasksRegistry(project);
    }
    let raw: string;
    try {
      raw = readFileSync(TASKS_JSON, "utf-8");
    } catch {
      throw new RegistryIOError("REGISTRY_READ_ERROR", `Cannot read tasks.json: ${TASKS_JSON}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RegistryIOError("REGISTRY_CORRUPT", `tasks.json is not valid JSON: ${TASKS_JSON}`);
    }
    // Invariant：若 caller 沒指定 protectedTaskIds，
    // 自動從 active plans 推導（與 writeRegistry 一致）。這確保 read path
    // （如 task-state-sync 寫入後立即 read 用於 updateStateMd）不會把剛保護
    // 的 finished task 在第二次 prune 時誤刪。
    const effectiveProtection = protectedTaskIds ?? computeProtectedTaskIds(context, inMemoryRegistry);
    return runtime.normalizeTasksRegistry(parsed, project, effectiveProtection);
  }

  /**
   * 計算 finished task 的 protection 集合。
   *
   *   - 步驟 1（plan 引用掃描）：掃所有 non-finished plan 的 `taskIds` /
   *     `dependencyGraph.nodes` / `dependencyGraph.edges`，把對應 task IDs
   *     標記為 protected，避免被 `FINISHED_TASK_LIMIT` prune 掉。
   *   - 步驟 2（dependsOn 掃描，為修正 P1 regression 而補）：
   *     額外掃 active task 的 `dependsOn`：若某 active task 同專案且其 dependsOn
   *     指向「現存、同專案且 terminal（finished）」的 task，則該終端 task 必須
   *     也加入 protected，否則當 active plan 已 finished / 不存在，而下游
   *     dependsOn 仍 active 時，FINISHED_TASK_LIMIT 會把上游 finished dep
   *     prune 掉，造成 plan-next / state-projection 永久將下游 task 視為
   *     blocked（missing dependency）。
   *
   * 掃描同時接受可選的 `inMemoryRegistry`：當 `writeRegistry` 收到的
   * in-memory `registry` 參數含有剛被 plan-task-link 還原（restore）的
   * finished dep 時，protection 必須能在同一輪 write 內涵蓋它們，否則
   * `normalizeTasksRegistry` 的 prune 仍會把它們丟掉。inMemoryRegistry
   * 提供的是「即將落盤的 state 快照」，比 disk 更接近 write 時的真實
   * 引用關係。
   *
   * 掃描刻意直接讀 raw tasks.json（`readFileSync` + `JSON.parse`），不透過
   * `readRegistry`，避免遞迴（readRegistry 內部會呼叫本 helper）。
   *
   * 設計約束：
   *   - 只保護「現存、同專案且 terminal」的 dep refs；非 terminal (active)
   *     dep 因為仍會被 active-first 邏輯保留，無需額外保護。
   *   - `blockedBy` 不影響 plan-next 的 ready 判定，不納入本 P1 修復範圍。
   *   - helper 失敗時（unsafe root / 缺檔）靜默降級為僅步驟 1，原 prune
   *     行為仍生效。
   *   - 例外：plans.json 存在但損壞／不可讀（`RegistryIOError` code
   *     `REGISTRY_CORRUPT` / `REGISTRY_READ_ERROR`）時 fail closed 重拋，
   *     不降級。否則 writeRegistry 會拿著不完整的 protected 集合去 prune
   *     tasks.json，把 active plan 仍參照的 finished task 永久刪掉。
   */
  function computeProtectedTaskIds(
    context?: ToolContext,
    inMemoryRegistry?: TasksRegistry,
  ): ReadonlySet<string> {
    const set = new Set<string>();
    try {
      const plansReg = readPlansRegistry(context, false);
      for (const plan of Object.values(plansReg.plans)) {
        if (isFinishedPlanState(plan.state)) continue;
        for (const tid of plan.taskIds || []) set.add(tid);
        for (const node of plan.dependencyGraph?.nodes || []) {
          if (node.taskId) set.add(node.taskId);
        }
        for (const edge of plan.dependencyGraph?.edges || []) {
          if (edge.source) set.add(edge.source);
          if (edge.target) set.add(edge.target);
        }
      }
    } catch (err) {
      // plans.json 存在但損壞／不可讀 → fail closed 重拋，附上可操作的修復指引。
      // 缺檔（正常情形）由 readPlansRegistry 回傳空 registry，不會進到這裡。
      if (
        err instanceof RegistryIOError &&
        (err.code === "REGISTRY_CORRUPT" || err.code === "REGISTRY_READ_ERROR")
      ) {
        throw new RegistryIOError(
          err.code,
          `${err.message} — 修復：從 git 歷史還原 plans.json，或刪除該檔讓 runtime 以空 registry 重建；` +
            "修好前所有 task 寫入都會被拒絕，以免 prune 掉 active plan 仍參照的 task。",
        );
      }
      runtime.debugLog(`computeProtectedTaskIds: failed to read plans registry: ${(err as Error)?.message || err}`);
    }

    // 步驟 2a：掃 in-memory registry（writeRegistry 透傳的 registry 參數）。
    // 對於 active task 的 dependsOn 指向 terminal dep 的情況，把 dep 加
    // 入 protected。inMemoryRegistry 是寫入前的快照，可包含 plan-task-link
    // 剛 restore 的 finished dep（dep-a 從 disk 消失、由 candidate/write 即時
    // 補回 in-memory 內），所以這一層檢查能涵蓋 disk 還看不到的 restored deps。
    if (inMemoryRegistry && typeof inMemoryRegistry === "object" && inMemoryRegistry.tasks) {
      try {
        const project = runtime.getCurrentProject(context);
        for (const candidate of Object.values(inMemoryRegistry.tasks)) {
          if (!candidate || !candidate.taskId) continue;
          if (isFinishedTaskState(String(candidate.state || ""))) continue;
          if (candidate.projectId && project.projectId && candidate.projectId !== project.projectId) continue;
          const deps = Array.isArray(candidate.dependsOn) ? candidate.dependsOn : [];
          for (const depIdRaw of deps) {
            if (typeof depIdRaw !== "string" || !depIdRaw) continue;
            const dep = inMemoryRegistry.tasks[depIdRaw];
            if (!dep) continue;
            if (dep.projectId && project.projectId && dep.projectId !== project.projectId) continue;
            if (isFinishedTaskState(String(dep.state || ""))) {
              set.add(depIdRaw);
            }
          }
        }
      } catch (err) {
        runtime.debugLog(`computeProtectedTaskIds: in-memory scan failed: ${(err as Error)?.message || err}`);
      }
    }

    // 步驟 2b：直接讀 raw tasks.json（disk）並掃 active task 的 dependsOn；
    // 跳過 readRegistry 以避免遛歸。涵蓋 disk 上已有的 active dependent refs。
    try {
      const project = runtime.getCurrentProject(context);
      const { TASKS_JSON, PLANS_DIR } = runtime.getPaths(context);
      assertSafeProjectFile(runtime.resolveProjectRoot(context), PLANS_DIR, TASKS_JSON);
      if (!existsSync(TASKS_JSON)) return set;
      const raw = JSON.parse(readFileSync(TASKS_JSON, "utf-8"));
      const tasks = raw && typeof raw === "object" && raw.tasks && typeof raw.tasks === "object"
        ? raw.tasks as Record<string, Record<string, unknown>>
        : null;
      if (!tasks) return set;
      for (const candidate of Object.values(tasks)) {
        if (!candidate || typeof candidate !== "object") continue;
        const taskId = typeof candidate.taskId === "string" ? candidate.taskId.trim() : "";
        if (!taskId) continue;
        // 只考慮 active task（finished 不會被 scan 為 downstream）
        if (isFinishedTaskState(String(candidate.state || ""))) continue;
        // 跨專案 guard：只取當前專案的 task
        if (candidate.projectId && project.projectId && String(candidate.projectId) !== project.projectId) continue;
        const deps = Array.isArray(candidate.dependsOn) ? candidate.dependsOn : [];
        for (const depIdRaw of deps) {
          if (typeof depIdRaw !== "string" || !depIdRaw) continue;
          // Disk 上若已被 prune 移除，這裡就跳過；writeRegistry 透傳的
          // inMemoryRegistry（步驟 2a）仍能涵蓋此類 freshly-restored deps。
          const dep = tasks[depIdRaw];
          if (!dep) continue;
          // 跨專案 dep 不納入保護（避免其他專案 task 撐大本專案的 prune 豁免）
          if (dep.projectId && project.projectId && String(dep.projectId) !== project.projectId) continue;
          // 只保護現存且 terminal 的 dep；active dep 由 active-first 邏輯保留。
          if (isFinishedTaskState(String(dep.state || ""))) {
            set.add(depIdRaw);
          }
        }
      }
    } catch (err) {
      runtime.debugLog(`computeProtectedTaskIds: dep scan failed, falling back to 步驟 1（plan 引用掃描）: ${(err as Error)?.message || err}`);
    }
    return set;
  }

  function mergeTaskRegistryDelta(current: TasksRegistry, candidate: TasksRegistry): TasksRegistry {
    const tasks = { ...current.tasks };
    for (const [taskId, value] of Object.entries(candidate.tasks)) {
      if (JSON.stringify(tasks[taskId]) !== JSON.stringify(value)) tasks[taskId] = value;
    }
    const active = new Set(current.activeTaskIds.filter((id) => tasks[id] && !isFinishedTaskState(tasks[id]!.state)));
    for (const [id, value] of Object.entries(candidate.tasks)) {
      if (isFinishedTaskState(value.state)) active.delete(id);
      else if (Object.prototype.hasOwnProperty.call(candidate.tasks, id)) active.add(id);
    }
    const activeTaskIds = [...active];
    return {
      ...current,
      tasks,
      activeTaskIds,
      taskCursor: candidate.taskCursor && activeTaskIds.includes(candidate.taskCursor)
        ? candidate.taskCursor
        : current.taskCursor && activeTaskIds.includes(current.taskCursor) ? current.taskCursor : activeTaskIds[0] ?? null,
    };
  }

  function mergePlanRegistryDelta(current: PlansRegistry, candidate: PlansRegistry): PlansRegistry {
    const plans = { ...current.plans };
    for (const [planId, value] of Object.entries(candidate.plans)) {
      if (JSON.stringify(plans[planId]) !== JSON.stringify(value)) plans[planId] = value;
    }
    const active = new Set(current.activePlanIds.filter((id) => plans[id] && !isFinishedPlanState(plans[id]!.state)));
    for (const [id, value] of Object.entries(candidate.plans)) {
      if (isFinishedPlanState(value.state)) active.delete(id);
      else if (Object.prototype.hasOwnProperty.call(candidate.plans, id)) active.add(id);
    }
    const activePlanIds = [...active];
    return {
      ...current,
      plans,
      activePlanIds,
      planCursor: candidate.planCursor && activePlanIds.includes(candidate.planCursor)
        ? candidate.planCursor
        : current.planCursor && activePlanIds.includes(current.planCursor) ? current.planCursor : activePlanIds[0] ?? null,
    };
  }

  // ─── 單一 commit 管線（tasks／plans／transact 共用） ──────────
  //
  // 不變條件：tasks.json／plans.json 的任何落盤（writeRegistry／
  // writePlansRegistry／transactRegistries commit）都走同一組 stage，
  // 順序固定為 protection → tombstone → normalize → prune →
  // dangling-cleanup → content-cleanup。任一寫入點繞過任一 stage，
  // 都會重現「保留上限丟掉仍被引用的 task」或「tombstone 語意遺失」。
  // transact 的 draft 在同一個 registry.lock 臨界區內讀出並寫回，
  // 不需要 merge-delta（draft 本來就是臨界區內的新鮮狀態）。

  /**
   * 對給定的 plans 物件掃出 protection 參照（未終態 plan 的
   * taskIds／dependencyGraph nodes／edges）。與 computeProtectedTaskIds
   * 的保護規則相同，只是掃的對象是傳入的 in-memory plans 而非磁碟；
   * transact commit 用它把 draft 內的新連結納入保護（磁碟 plans 此時還是舊的）。
   */
  function collectPlanReferencedTaskIds(plans: PlansRegistry): Set<string> {
    const set = new Set<string>();
    for (const plan of Object.values(plans.plans)) {
      if (isFinishedPlanState(plan.state)) continue;
      for (const tid of plan.taskIds || []) set.add(tid);
      for (const node of plan.dependencyGraph?.nodes || []) {
        if (node.taskId) set.add(node.taskId);
      }
      for (const edge of plan.dependencyGraph?.edges || []) {
        if (edge.source) set.add(edge.source);
        if (edge.target) set.add(edge.target);
      }
    }
    return set;
  }

  /**
   * Tasks commit stages：protection（磁碟 plans＋in-memory tasks＋
   * in-memory plans 三源聯集）→ tombstone safety net（記進傳入的 plans
   * 物件）→ normalize＋prune。回傳正規化結果、保護集合與是否有新 tombstone。
   */
  function applyTasksCommitStages(
    tasksCandidate: TasksRegistry,
    plansForTombstone: PlansRegistry,
    context?: ToolContext,
    includeDiskProtection: boolean = true,
  ): { normalizedTasks: TasksRegistry; protectedTaskIds: ReadonlySet<string>; tombstoneModified: boolean } {
    // Invariant：磁碟 plans 掃出的保護集合，與呼叫端傳入的 in-memory
    // plans 掃出的參照取聯集。transact 的 draft plans 可能含有磁碟還看不到
    // 的新連結（例如剛建立的 active plan），只掃磁碟會漏保護。
    const diskProtection = includeDiskProtection ? computeProtectedTaskIds(context, tasksCandidate) : new Set<string>();
    const draftRefs = collectPlanReferencedTaskIds(plansForTombstone);
    const protectedTaskIds = new Set<string>([...diskProtection, ...draftRefs]);
    // Completion tombstone safety net：只處理「未被保護且即將被 prune」的
    // terminal task＋planId；既有 protected task 不需 tombstone（仍留於 tasks.json）。
    let tombstoneModified = false;
    for (const task of Object.values(tasksCandidate.tasks || {})) {
      if (!task || !task.planId) continue;
      if (!isFinishedTaskState(String(task.state || ""))) continue;
      if (protectedTaskIds.has(task.taskId)) continue;
      const plan = plansForTombstone.plans[task.planId];
      if (!plan) continue;
      const written = recordCompletionTombstone(
        plan,
        task.taskId,
        task.state as "COMPLETED" | "FAILED" | "CANCELLED",
        task.updatedAt || new Date().toISOString(),
      );
      if (written) tombstoneModified = true;
    }
    const normalizedTasks = runtime.normalizeTasksRegistry(
      tasksCandidate,
      runtime.getCurrentProject(context),
      protectedTaskIds,
    );
    return { normalizedTasks, protectedTaskIds, tombstoneModified };
  }

  /**
   * Plans commit stages：normalize → prune → dangling edge/node cleanup →
   * 被 prune plan 的 content 刪除＋關聯 finished task 的 ref 清理。
   * `taskRegistry` 必須是呼叫端即將落盤的同一個 tasks 物件（cleanup 會直接
   * 改它的 refs）；content 刪除與 writePlansRegistry 舊行為同順序（先於 JSON 落盤）。
   */
  function applyPlansCommitStages(
    plansCandidate: PlansRegistry,
    taskRegistry: TasksRegistry,
    context: ToolContext | undefined,
    root: string,
    plansDir: string,
  ): { prunedPlans: PlansRegistry; removedPlanIds: string[]; contentPathsToDelete: string[] } {
    const normalizedRegistry = normalizePlansRegistry(plansCandidate, runtime.getCurrentProject(context));
    const prunedRegistry = prunePlansRegistry(normalizedRegistry);

    // Prune cleanup: find removed plans (finished plans beyond limit)
    const removedPlanIds = Object.keys(normalizedRegistry.plans).filter(
      (planId) => !prunedRegistry.plans[planId]
    );
    const contentPathsToDelete = new Set<string>();
    const survivingPlans = Object.values(prunedRegistry.plans);
    const survivingContentPaths = new Set<string>();
    for (const surviving of survivingPlans) {
      if (surviving.contentRef) {
        const refPath = bestEffortContentPath(
          surviving.contentRef,
          root,
          plansDir,
          { owner: "plan", id: surviving.planId, field: "contentRef" },
          runtime.debugLog,
        );
        if (refPath) survivingContentPaths.add(pathIdentityKey(refPath));
      }
      if (surviving.contentPath) {
        // `contentPath` 是絕對路徑欄位（不走 contentRef 的前綴規則），所以維持原本
        // 的 `assertSafePlansPath` + `resolve` 語意，只把「解析不到」從 throw 改成跳過。
        try {
          assertSafePlansPath(surviving.contentPath, plansDir);
          survivingContentPaths.add(pathIdentityKey(resolve(surviving.contentPath)));
        } catch (error) {
          runtime.debugLog(
            `Skipped unresolvable contentPath (plan ${surviving.planId}): ${surviving.contentPath} (${(error as Error).message})`,
          );
        }
      }
    }
    const queueContentDelete = (path: string, reason: string): void => {
      if (survivingContentPaths.has(pathIdentityKey(path))) {
        runtime.debugLog(`Prune cleanup skipped ${path}: ${reason} resolves to a surviving plan content path`);
        return;
      }
      contentPathsToDelete.add(path);
    };

    // ✨  — Dangling edge cleanup pass
    // 對於保留的 plan（不論 active 或 finished），清除指向不存在 task 的
    // `dependencyGraph.edges` / `nodes`。動機：
    //   - 當 finished task 被 `pruneTasksRegistryLeaf` 從 tasks.json 移除後，
    //     保留的 plan 內的 edges 仍指向這些已 prune 的 task，
    //     導致 plan-status `collectPlanInconsistencies` 大量回報
    //     DANGLING_EDGE_SOURCE / DANGLING_EDGE_TARGET 的 projection noise。
    //   - 在 write-time 自動清理可讓 plans.json 維持 self-consistent，並讓
    //     plan-status 的 inconsistencies 自然清掉這些 noise 項目。
    // 注意：被 prune 掉的 plan 整個物件已從 `prunedRegistry.plans` 移除，
    // 所以這裡只需清理保留的 plan；不需再處理 `removedPlanIds`。
    let danglingEdgeCleanupCount = 0;
    let danglingNodeCleanupCount = 0;
    for (const plan of Object.values(prunedRegistry.plans)) {
      // Invariant：dangling cleanup 需考慮
      // plan.completionTombstones。tombstoned task 不算 dangling（語意仍存活）。
      const tombstoneIds = plan.completionTombstones ? Object.keys(plan.completionTombstones) : [];
      const validTaskIds = new Set([
        ...Object.keys(taskRegistry.tasks),
        ...tombstoneIds,
      ]);

      const originalEdgeCount = plan.dependencyGraph.edges.length;
      plan.dependencyGraph.edges = plan.dependencyGraph.edges.filter(
        (edge) => validTaskIds.has(edge.source) && validTaskIds.has(edge.target)
      );
      const removedEdges = originalEdgeCount - plan.dependencyGraph.edges.length;

      const originalNodeCount = plan.dependencyGraph.nodes.length;
      plan.dependencyGraph.nodes = plan.dependencyGraph.nodes.filter(
        (node) => validTaskIds.has(node.taskId)
      );
      const removedNodes = originalNodeCount - plan.dependencyGraph.nodes.length;

      if (removedEdges > 0 || removedNodes > 0) {
        runtime.debugLog(
          `Dangling cleanup: plan ${plan.planId} removed ${removedEdges} edges / ${removedNodes} nodes`,
        );
        danglingEdgeCleanupCount += removedEdges;
        danglingNodeCleanupCount += removedNodes;
      }
    }
    if (danglingEdgeCleanupCount > 0 || danglingNodeCleanupCount > 0) {
      runtime.debugLog(
        `Dangling cleanup summary: total ${danglingEdgeCleanupCount} edges + ${danglingNodeCleanupCount} nodes removed across ${Object.keys(prunedRegistry.plans).length} kept plans`,
      );
    }

    // Cleanup content files for removed plans
    for (const planId of removedPlanIds) {
      const plan = normalizedRegistry.plans[planId];
      runtime.debugLog(`Prune cleanup: removing plan content for ${planId}`);

      // Check for active section-mode tasks that depend on this plan's content file
      const activeSectionTasks = Object.values(taskRegistry.tasks).filter(
        (task) => task.planId === planId && !isFinishedTaskState(task.state) && taskDependsOnPlanSection(task, planId)
      );

      // If active section-mode tasks exist, DO NOT delete plan content file
      if (activeSectionTasks.length > 0) {
        const taskIds = activeSectionTasks.map((t) => t.taskId).join(", ");
        runtime.debugLog(`Prune cleanup: SKIP deleting plan ${planId} content file - active section-mode tasks depend on it: [${taskIds}]`);
        // Don't delete plan content - keep it for active tasks
        // Still process task cleanup for the active tasks (but they keep refs per existing logic)
        for (const task of activeSectionTasks) {
          runtime.debugLog(`Prune cleanup: active task ${task.taskId} in section mode retains contentRef to pruned plan ${planId}`);
        }
        // Still need to update task refs? No - per existing logic: active tasks keep refs
        // Continue to next plan in loop (skip deletion for this plan)
      } else {
        // No active section tasks - safe to delete plan content file
        runtime.debugLog(`Prune cleanup: no active section tasks dependent on plan ${planId} - safe to delete content`);

        if (plan.contentRef) {
          const refPath = bestEffortContentPath(
            plan.contentRef,
            root,
            plansDir,
            { owner: "plan", id: planId, field: "contentRef" },
            runtime.debugLog,
          );
          if (refPath) queueContentDelete(refPath, "contentRef");
        } else if (plan.contentPath) {
          try {
            assertSafePlansPath(plan.contentPath, plansDir);
            queueContentDelete(resolve(plan.contentPath), "contentPath");
          } catch (error) {
            runtime.debugLog(
              `Skipped unresolvable contentPath (pruned plan ${planId}): ${plan.contentPath} (${(error as Error).message})`,
            );
          }
        } else {
          const fixedPath = planContentPath(planId, plansDir);
          const fixedNameCollides = survivingPlans.some(
            (surviving) => samePathIdentity(
              planContentPath(surviving.planId, plansDir),
              fixedPath,
            ),
          );
          if (fixedNameCollides) {
            runtime.debugLog(`Prune cleanup skipped ${fixedPath}: sanitized filename collides with a surviving plan`);
          } else if (!survivingContentPaths.has(pathIdentityKey(fixedPath))) {
            contentPathsToDelete.add(fixedPath);
          }
        }
      }

      // Cleanup task content files linked to this plan
      // Only cleanup FINISHED tasks - active tasks keep their content refs
      for (const task of Object.values(taskRegistry.tasks)) {
        if (task.planId === planId) {
          if (!isFinishedTaskState(task.state)) {
            // Active task: do NOT delete file or clear refs - just log registry inconsistency
            runtime.debugLog(`Prune cleanup: skip active task ${task.taskId} (state=${task.state}) - registry inconsistency, plan ${planId} was pruned`);
            continue;
          }
          // Finished task: safe to cleanup
          if (task.taskContentPath) {
            const taskPath = bestEffortContentPath(
              task.taskContentPath,
              root,
              plansDir,
              { owner: "task", id: task.taskId, field: "taskContentPath" },
              runtime.debugLog,
            );
            if (taskPath) queueContentDelete(taskPath, "taskContentPath");
            // 解析不到就不排刪除（目標在內容庫外，守衛本來也不准刪），但引用照清：
            // 這是既有行為（`taskContentPath` 在這個分支本來就會被清成 undefined），
            // 而留著一筆用不了的引用只會讓 doctor 之外的地方再炸一次。
            task.taskContentPath = undefined;
          }
          // Clear section refs
          if (task.contentRef && task.contentRef.includes(planId)) {
            task.contentRef = undefined;
          }
          task.taskContentMode = undefined;
        }
      }
    }

    return { prunedPlans: prunedRegistry, removedPlanIds, contentPathsToDelete: [...contentPathsToDelete] };
  }

  /**
   * 寫入 tasks.json registry：
   *   - 不安全 root → throw `Cannot write registry to unsafe root: ...`
   *   - `lazyEnsure(context)`
   *   - `ensureDir(MEMORY_DIR, context)`
   *   - 讀取 plans registry，計算 active plan 仍參照的 finished task IDs
   *     ，傳遞給
   *     `normalizeTasksRegistry` 作為 `protectedTaskIds`，避免
   *     `FINISHED_TASK_LIMIT` prune 把 active plan linked 的 completed
   *     task 移除，造成 plan.taskIds 與 tasks.json 不對稱。
   *   - **completion tombstone safety net**：
   *     對即將被 prune 的 terminal task（有 planId 且未受保護），先在
   *     對應 Plan 的 `completionTombstones` 記錄 `{ state, finishedAt }`，
   *     再將 plans.json 原子寫入，最後才 prune tasks.json。確保下游
   *     plan-next / plan-status / validate 等 consumer 即使 task 已從
   *     tasks.json 移除，仍可從 tombstone 還原依賴語意。
   *   - `normalizeTasksRegistry(registry, getCurrentProject(context), protectedTaskIds)`
   *   - `atomicWriteFile(TASKS_JSON, ...)`
   */
  async function writeRegistry(registry: TasksRegistry, context?: ToolContext): Promise<void> {
    const root = runtime.resolveProjectRoot(context);
    if (runtime.isUnsafeRoot(root)) {
      throw new Error(`Cannot write registry to unsafe root: ${root}`);
    }
    lazyEnsure(context);
    const { MEMORY_DIR, TASKS_JSON, PLANS_JSON, PLANS_DIR } = runtime.getPaths(context);
    const lockDir = join(MEMORY_DIR, "cache", "locks");
    const lockPath = join(lockDir, "registry.lock");
    assertSafeProjectFile(root, PLANS_DIR, lockPath);
    ensureDir(lockDir, context);
    return withRegistryLock(lockPath, async () => {
    registry = mergeTaskRegistryDelta(readRegistry(context, false), registry);
    // 單一 commit 管線：protection＋tombstone＋normalize＋prune 與
    // transactRegistries commit 同一個 stage 實作（applyTasksCommitStages）。
    const plansRegForTombstone = readPlansRegistry(context, false);
    const { normalizedTasks, tombstoneModified } = applyTasksCommitStages(registry, plansRegForTombstone, context);
    if (tombstoneModified) {
      // 局部 safety net：避免 writeRegistry 再呼叫 writePlansRegistry 造成遞迴。
      // 這不是完整雙檔交易，也不是所有工具的提交路徑；它只補寫已正規化
      // registry 物件的 completionTombstones 欄位。跨檔原子提交請使用 transactRegistries。
      assertSafeProjectFile(root, PLANS_DIR, PLANS_JSON);
      atomicWriteFile(PLANS_JSON, JSON.stringify(plansRegForTombstone, null, 2));
    }
    assertSafeProjectFile(root, PLANS_DIR, TASKS_JSON);
    atomicWriteFile(TASKS_JSON, JSON.stringify(normalizedTasks, null, 2));
    });
  }

  /**
   * 讀取 plans.json registry：對應 `readRegistry` 的 plans 對應版本。
   * 讀取失敗 → `REGISTRY_READ_ERROR`；JSON parse 失敗 → `REGISTRY_CORRUPT`。
   */
  function readPlansRegistry(context?: ToolContext, createIfMissing: boolean = false): PlansRegistry {
    const root = runtime.resolveProjectRoot(context);
    const { PLANS_DIR } = runtime.getPaths(context);
    if (createIfMissing) {
      lazyEnsure(context);
    }
    const project = runtime.getCurrentProject(context);
    const { PLANS_JSON } = runtime.getPaths(context);
    assertSafeProjectFile(root, PLANS_DIR, PLANS_JSON);
    if (!existsSync(PLANS_JSON)) {
      return createEmptyPlansRegistry(project);
    }
    let raw: string;
    try {
      raw = readFileSync(PLANS_JSON, "utf-8");
    } catch {
      throw new RegistryIOError("REGISTRY_READ_ERROR", `Cannot read plans.json: ${PLANS_JSON}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RegistryIOError("REGISTRY_CORRUPT", `plans.json is not valid JSON: ${PLANS_JSON}`);
    }
    return normalizePlansRegistry(parsed, project);
  }

  /**
   * 寫入 plans.json registry（含 prune cleanup）：
   *   - 不安全 root → throw `Cannot write plans registry to unsafe root: ...`
   *   - `lazyEnsure(context)`
   *   - `ensureDir(MEMORY_DIR, context)`
   *   - `normalizePlansRegistry` → `prunePlansRegistry`
   *   - **Dangling edge cleanup pass**：
   *     對保留的 plan（不論是否為 finished）清除指向不存在 task 的
   *     `dependencyGraph.edges` / `nodes`，降低 plan-status 的
   *     DANGLING_EDGE projection noise。
   *   - 對每個被 prune 掉的 plan：
   *       · 刪除 plan content file（若 active section-mode task 依賴則 SKIP）
   *       · 對每個 linked task：finished task 清理 contentPath / contentRef
   *   - `atomicWriteFile(PLANS_JSON, ...)`
   *   - 若有 task 被清理 → `writeRegistry(taskRegistry, context)`
   *
   * 注意：prune cleanup 內仍呼叫同 runtime 的 `readRegistry` / `writeRegistry`
   * 而非直接讀寫檔案，以確保 closure wrapper 預設值語意一致。
   */
  async function writePlansRegistry(registry: PlansRegistry, context?: ToolContext): Promise<void> {
    const root = runtime.resolveProjectRoot(context);
    if (runtime.isUnsafeRoot(root)) {
      throw new Error(`Cannot write plans registry to unsafe root: ${root}`);
    }
    lazyEnsure(context);
    const { MEMORY_DIR, PLANS_JSON, PLANS_DIR } = runtime.getPaths(context);
    const lockDir = join(MEMORY_DIR, "cache", "locks");
    const lockPath = join(lockDir, "registry.lock");
    assertSafeProjectFile(root, PLANS_DIR, lockPath);
    ensureDir(lockDir, context);
    return withRegistryLock(lockPath, async () => {
    registry = mergePlanRegistryDelta(readPlansRegistry(context, false), registry);
    const { TASKS_JSON } = runtime.getPaths(context);
    assertSafeProjectFile(root, PLANS_DIR, TASKS_JSON);
    assertSafeProjectFile(root, PLANS_DIR, PLANS_JSON);
    const taskSnapshot = existsSync(TASKS_JSON) ? readFileSync(TASKS_JSON, "utf8") : null;
    const planSnapshot = existsSync(PLANS_JSON) ? readFileSync(PLANS_JSON, "utf8") : null;
    const restore = (path: string, snapshot: string | Buffer | null): void => {
      if (snapshot === null) {
        assertSafeProjectFile(root, PLANS_DIR, path);
        if (existsSync(path)) unlinkSync(path);
      } else if (Buffer.isBuffer(snapshot)) {
        restoreBytesAtomic(path, snapshot, () => assertSafeProjectFile(root, PLANS_DIR, path));
      } else {
        assertSafeProjectFile(root, PLANS_DIR, path);
        atomicWriteFile(path, snapshot);
      }
    };
    let contentSnapshots = new Map<string, Buffer | null>();
    const restoreContent = (): void => {
      for (const [path, snapshot] of contentSnapshots) restore(path, snapshot);
    };
    try {
    // 單一 commit 管線：normalize→prune→dangling→content-cleanup 與
    // transactRegistries commit 同一個 stage 實作（applyPlansCommitStages）。
     const rawTasks = JSON.parse(readFileSync(TASKS_JSON, "utf8")) as { tasks?: Record<string, unknown> };
    const rawTaskIds = Object.keys(rawTasks.tasks ?? {});
    const taskRegistry = readRegistry(context, false, new Set(rawTaskIds));
    const { prunedPlans, contentPathsToDelete } = applyPlansCommitStages(registry, taskRegistry, context, root, PLANS_DIR);
    const { normalizedTasks } = applyTasksCommitStages(taskRegistry, prunedPlans, context, false);
    contentSnapshots = new Map(contentPathsToDelete.map((path) => {
      assertSafeContentPath(root, PLANS_DIR, path);
      return [path, existsSync(path) ? readFileSync(path) : null] as [string, Buffer | null];
    }));

    writeFile(PLANS_JSON, JSON.stringify(prunedPlans, null, 2));
    // writePlansRegistry 也走完整 tasks commit stage，確保被 prune 的
    // finished task 先補進保留 plan 的 completionTombstones，再寫 tasks.json。
    writeFile(TASKS_JSON, JSON.stringify(normalizedTasks, null, 2));
    for (const path of contentPathsToDelete) {
      assertSafeContentPath(root, PLANS_DIR, path);
      deleteContent(path, PLANS_DIR, root);
    }
    } catch (error) {
      try {
        restoreContent();
        restore(TASKS_JSON, taskSnapshot);
        restore(PLANS_JSON, planSnapshot);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Plans registry transaction rollback failed.");
      }
      throw error;
    }
    });
  }

  // spread base 確保 RuntimeBaseContext 方法（getCurrentProject 等）
  // 也附掛於回傳的 RegistryRuntimeContext 上，使 state-projection / 更新紀錄 validator
  // 不需再向下取 base runtime。
  async function transactRegistries<T>(
    context: ToolContext | undefined,
    operation: RegistryTransactionOperation<T>,
  ): Promise<T> {
    const root = runtime.resolveProjectRoot(context);
    if (runtime.isUnsafeRoot(root)) {
      throw new Error(`Cannot transact registries at unsafe root: ${root}`);
    }
    lazyEnsure(context);
    const { MEMORY_DIR, TASKS_JSON, PLANS_JSON, PLANS_DIR } = runtime.getPaths(context);
    const lockDir = join(MEMORY_DIR, "cache", "locks");
    const lockPath = join(lockDir, "registry.lock");
    assertSafeProjectFile(root, PLANS_DIR, lockPath);
    ensureDir(lockDir, context);
    return withRegistryLock(lockPath, async () => {
      assertSafeProjectFile(root, PLANS_DIR, TASKS_JSON);
      assertSafeProjectFile(root, PLANS_DIR, PLANS_JSON);
      const taskSnapshot = existsSync(TASKS_JSON) ? readFileSync(TASKS_JSON, "utf8") : null;
      const planSnapshot = existsSync(PLANS_JSON) ? readFileSync(PLANS_JSON, "utf8") : null;
      const draft: RegistryTransactionDraft = {
        tasks: readRegistry(context, false),
        plans: readPlansRegistry(context, false),
      };
      let shouldCommit = false;
      const result = await operation(draft, { commit: () => { shouldCommit = true; } });
      if (!shouldCommit) return result;

      // 單一 commit 管線：與 writeRegistry／writePlansRegistry 相同的
      // protection → tombstone → normalize → prune → dangling →
      // content-cleanup stages，只是輸入改為 transaction draft。
      // draft 在同一個臨界區內讀出，不需要 merge-delta。
      const restore = (path: string, snapshot: string | Buffer | null): void => {
        if (snapshot === null) {
          assertSafeProjectFile(root, PLANS_DIR, path);
          if (existsSync(path)) unlinkSync(path);
        } else if (Buffer.isBuffer(snapshot)) {
          restoreBytesAtomic(path, snapshot, () => assertSafeProjectFile(root, PLANS_DIR, path));
        } else {
          assertSafeProjectFile(root, PLANS_DIR, path);
          atomicWriteFile(path, snapshot);
        }
      };
      let contentSnapshots = new Map<string, Buffer | null>();
      const restoreContent = (): void => {
        for (const [path, snapshot] of contentSnapshots) restore(path, snapshot);
      };
      try {
        const { normalizedTasks, protectedTaskIds } = applyTasksCommitStages(draft.tasks, draft.plans, context);
        const { prunedPlans, contentPathsToDelete } = applyPlansCommitStages(draft.plans, normalizedTasks, context, root, PLANS_DIR);
        contentSnapshots = new Map(contentPathsToDelete.map((path) => {
       assertSafeContentPath(root, PLANS_DIR, path);
       return [path, existsSync(path) ? readFileSync(path) : null] as [string, Buffer | null];
     }));
        // plans stages 的 ref 清理只動 content 欄位；以同一保護集合重整 tasks，
        // 與 writePlansRegistry 的落盤後寫回同語意（此處保護集合一致，不會誤剪）。
        const finalTasks = runtime.normalizeTasksRegistry(
          normalizedTasks,
          runtime.getCurrentProject(context),
          protectedTaskIds,
        );
        assertSafeProjectFile(root, PLANS_DIR, TASKS_JSON);
        writeFile(TASKS_JSON, JSON.stringify(finalTasks, null, 2));
        assertSafeProjectFile(root, PLANS_DIR, PLANS_JSON);
        writeFile(PLANS_JSON, JSON.stringify(prunedPlans, null, 2));
        for (const path of contentPathsToDelete) {
       assertSafeContentPath(root, PLANS_DIR, path);
       deleteContent(path, PLANS_DIR, root);
     }
      } catch (error) {
        try {
          restoreContent();
          restore(TASKS_JSON, taskSnapshot);
          restore(PLANS_JSON, planSnapshot);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Registry transaction failed and rollback could not restore both files.",
          );
        }
        throw error;
      }
      return result;
    });
  }

  return {
    ...runtime,
    ensureDir,
    lazyEnsure,
    readRegistry,
    writeRegistry,
    readPlansRegistry,
    writePlansRegistry,
    transactRegistries,
  };
}
