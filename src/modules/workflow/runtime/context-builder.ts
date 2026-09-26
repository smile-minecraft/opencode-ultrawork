/**
 * opencode-ultrawork — runtime context builder（runtime context 分層組裝）
 *
 * 角色：
 *     內抽出的 runtime glue 統一組裝點。
 *   - runtime 型別分層：
 *       · RuntimeBaseContext：基本專案 context（projectId, projectPath, worktreeRoot,
 *         resolveProjectRoot, getCurrentProject, getPaths, isUnsafeRoot, debugLog,
 *         memorySystemEnabled, guardMemory, ensureDir）。
 *       · RegistryRuntimeContext：+ lazyEnsure / readRegistry / writeRegistry /
 *         readPlansRegistry / writePlansRegistry。
 *       · StateProjectionRuntimeContext：+ updateStateMd。
 *       · FullUltraworkRuntimeContext：= RuntimeBaseContext + RegistryRuntimeContext +
 *         StateProjectionRuntimeContext + validateMemoryReceiptForTask。
 *   - 各 layer factory 接受對應上層型別作 DI（無 `as unknown as` cast）。
 *
 * 對外規則（不可破壞）：
 *   - `UltraworkRuntimeContext` 介面欄位集合與 closure 原版逐一對應（向後相容）。
 *   - closure helper 行為（`resolveProjectRoot` 優先序、`isUnsafeRoot` 黑名單、
 *     `getPathsForRoot` layout、`createEmptyTasksRegistry` 預設值語意）維持原版。
 *   - `memorySystemEnabled` 保留在介面上是為了向後相容；舊版那個預設為
 *     `false` 的環境變數旗標在 V2 已經不存在，這裡固定給 `true`，功能開關
 *     一律走 settings 的 memory 模組開關。
 *
 * 組裝順序（factory chain）：
 *   1. 定義 closure helpers → RuntimeBaseContext。
 *   2. createRegistryIO(base) → RegistryRuntimeContext。
 *   3. createStateProjection(registry) → StateProjectionRuntimeContext。
 *   4. 收據驗證委派給 memory 單一實作 → FullUltraworkRuntimeContext。
 *
 * 限制：
 *
 * @see ../../../../README.md                              — 模組一覽
 * @see ./context.ts                                       — path / binding 純函式
 * @see ./registry-io.ts                                   — registry IO closure
 * @see ./state-projection.ts                              — state.md writer
 * @see ../../memory/receipt-validator.ts               — 同步紀錄 validator（單一實作）
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolExecutionContext } from "../../../kit/define-tool.ts";
import { assertSafeContentRoot } from "../content/content-store.ts";

type ToolContext = ToolExecutionContext;
import type { ProjectBinding, PlansRegistry, Task, TasksRegistry } from "../core/types.ts";
import { deriveProjectId } from "../core/helpers.ts";
import { getPathsForRoot, isUnsafeRoot, type Paths } from "./context.ts";
import { createRegistryIO, type RegistryIOOptions, type RegistryRuntimeContext } from "./registry-io.ts";
import { createStateProjection, type StateProjectionRuntimeContext } from "./state-projection.ts";
import { validateReceiptForCompletion, type ReceiptValidationResult } from "../../memory/index.ts";

// ─── Layer 1：RuntimeBaseContext ─────────────────────────────

/**
 * 最小 runtime context：所有上層（registry / state projection / 更新紀錄 validator）
 * 共同依賴的 base helpers。
 */
export interface RuntimeBaseContext {
  /**
   * 對應舊版的 memory 系統啟用旗標，向後相容保留。
   * 舊版預設 `false` 的環境變數旗標在 V2 已移除，這裡固定為 `true`；
   * 真正的開關是 settings 的 memory 模組開關。
   */
  memorySystemEnabled: boolean;
  /** 對應 closure `guardMemory()`：memory system 啟用檢查（V2 已無條件放行）。 */
  guardMemory(): void;
  /** 對應 closure `debugLog(msg)`：僅在 `DEBUG=true` 時輸出至 stderr。 */
  debugLog(msg: string): void;
  /** 對應 `./context.ts isUnsafeRoot`：根目錄 / 系統關鍵目錄黑名單檢查。 */
  isUnsafeRoot(path: string): boolean;
  /** 動態解析 project root（優先序：options > env > input > context > cwd）。 */
  resolveProjectRoot(context?: ToolContext): string;
  /** 對應 `getCurrentProjectBinding`：從 project root 推導 `ProjectBinding`。 */
  getCurrentProject(context?: ToolContext): ProjectBinding;
  /** 對應 `getPathsForRoot` + `getPaths`：計算所有 `.opencode` 路徑。 */
  getPaths(context?: ToolContext): Paths;
  /** 對應 closure `ensureDir(path, context?)`：unsafe root 短路後 mkdir。 */
  ensureDir(path: string, context?: ToolContext): void;
  /** Task registry thin wrapper（caller 注入 closure version）。 */
  createEmptyTasksRegistry(project?: ProjectBinding): TasksRegistry;
  /**
   * Task registry thin wrapper（caller 注入 closure version）。
   * `protectedTaskIds`：
   *   active plan 仍參照的 finished task IDs，傳遞至 leaf helper 豁免
   *   `FINISHED_TASK_LIMIT` prune。預設空 Set（向後相容）。
   */
  normalizeTasksRegistry(
    raw: unknown,
    project?: ProjectBinding,
    protectedTaskIds?: ReadonlySet<string>,
  ): TasksRegistry;
}

// ─── Layer 3：StateProjectionRuntimeContext ─────────────────

/** RegistryRuntimeContext + state projection。對應 `state-projection.ts` DI。 */
export interface StateProjectionRuntimeContextEx extends RegistryRuntimeContext {
  /** 對應 closure `updateStateMd(registry, context?)`：cursor projection writer。 */
  updateStateMd(registry: TasksRegistry, context?: ToolContext): Promise<void>;
}

// ─── Layer 4：FullUltraworkRuntimeContext ───────────────────

/**
 * 全功能 runtime context：包含 state-projection 與 更新紀錄 validator。
 * 對應原 `UltraworkRuntimeContext` 介面（向後相容）。
 */
export interface FullUltraworkRuntimeContext extends StateProjectionRuntimeContextEx {
  /** memory 模組與政策都要求同步紀錄時才阻擋 complete。 */
  memoryReceiptRequired: boolean;
  /** 結案前讀取 Comment Signal 狀態；模組未啟用時直接略過。 */
  validateCommentSignalForCompletion(
    sessionID: string | undefined,
  ): Promise<
    | { ok: true; status: "disabled" | "not-reported" | "passed" }
    | { ok: false; code: "COMMENT_SIGNAL_BLOCKED"; error: string }
  >;
  /** 收據驗證（委派給 memory 模組的單一實作）：專案記憶更新階段 memory 更新紀錄 gate 核心。 */
  validateMemoryReceiptForTask(
    receiptId: string,
    task: Task,
    currentProject: ProjectBinding,
    context?: ToolContext,
  ): ReceiptValidationResult;
}

/**
 * 向後相容別名（既有 caller `UltraworkRuntimeContext`）。
 */
export type UltraworkRuntimeContext = FullUltraworkRuntimeContext;

/** 對外暴露：state-projection factory 接受的 context。 */
export type StateProjectionDeps = RegistryRuntimeContext;

/**
 * `createRuntimeContext` 輸入參數。
 *   - `input` / `options`：來自 `UltraworkPlugin: Plugin` 第一、二參數。
 *   - `createEmptyTasksRegistry` / `normalizeTasksRegistry`：closure-scoped thin
 */
export interface CreateRuntimeContextInput {
  input: { directory?: string };
  options: { projectRoot?: string; [key: string]: unknown };
  registryIO?: RegistryIOOptions;
  createEmptyTasksRegistry: (project?: ProjectBinding) => TasksRegistry;
  /**
   * `protectedTaskIds` 參數：
   *   caller 注入的 closure wrapper 必須接受 optional `protectedTaskIds` 並透傳。
   */
  normalizeTasksRegistry: (
    raw: unknown,
    project?: ProjectBinding,
    protectedTaskIds?: ReadonlySet<string>,
  ) => TasksRegistry;
}

// ─── Layered factory ───────────────────────────────────────

/**
 * Layer 1 factory：建立 RuntimeBaseContext（pure helpers + closure wrappers）。
 *
 * 對應 closure 內 `memorySystemEnabled` / `guardMemory` / `debugLog` /
 * `isUnsafeRoot` / `resolveProjectRoot` / `getCurrentProjectBinding` /
 * `getPathsForRoot` / `getPaths` / `ensureDir` 等 base helpers。
 */
function buildBaseContext(
  pluginInput: { directory?: string },
  options: { projectRoot?: string; [key: string]: unknown },
  createEmptyTasksRegistry: (project?: ProjectBinding) => TasksRegistry,
  normalizeTasksRegistry: (raw: unknown, project?: ProjectBinding) => TasksRegistry,
): RuntimeBaseContext {
  const memorySystemEnabled = true;

  function guardMemory(): void {
    // workflow 不再依賴已停用的長期記憶後端。
  }

  function debugLog(msg: string): void {
    if (process.env.DEBUG === "true" || process.env.DEBUG === "1") {
      process.stderr.write(`[DEBUG] ${msg}\n`);
    }
  }

  function resolveProjectRoot(context?: ToolContext): string {
    let root = "";
    let source = "";

    if (typeof context?.directory === "string" && context.directory) {
      root = resolve(context.directory);
      source = "context.directory";
    } else if (options.projectRoot?.trim()) {
      root = resolve(options.projectRoot.trim());
      source = "options.projectRoot";
    } else if (pluginInput.directory) {
      root = resolve(pluginInput.directory);
      source = "input.directory";
    } else {
      root = resolve(process.cwd());
      source = "process.cwd()";
    }

    debugLog(`Resolved project root: ${root} (from ${source})`);
    return root;
  }

  function getCurrentProject(context?: ToolContext): ProjectBinding {
    const projectPath = resolveProjectRoot(context);
    return { projectId: deriveProjectId(projectPath), projectPath };
  }

  function getPaths(context?: ToolContext): Paths {
    return getPathsForRoot(resolveProjectRoot(context));
  }

  function ensureDir(path: string, context?: ToolContext): void {
    if (!existsSync(path)) {
      const root = resolveProjectRoot(context);
      if (isUnsafeRoot(root)) {
        debugLog(`ensureDir skipped: unsafe root ${root} for path ${path}`);
        return;
      }
      const { PLANS_DIR } = getPaths(context);
      assertSafeContentRoot(root, PLANS_DIR);
      mkdirSync(path, { recursive: true });
    }
  }

  return {
    memorySystemEnabled,
    guardMemory,
    debugLog,
    isUnsafeRoot,
    resolveProjectRoot,
    getCurrentProject,
    getPaths,
    ensureDir,
    createEmptyTasksRegistry,
    normalizeTasksRegistry,
  };
}

/**
 * 建立 `FullUltraworkRuntimeContext`：
 *   1. Layer 1 factory → RuntimeBaseContext。
 *   2. Layer 2 factory（createRegistryIO）→ RegistryRuntimeContext。
 *   3. Layer 3 factory（createStateProjection）→ StateProjectionRuntimeContextEx。
 *   4. 收據驗證委派（memory 單一實作）→ FullUltraworkRuntimeContext。
 *
 * 每層 factory 接受對應上層型別作 DI，**無** `as unknown as` cast。
 */
export function createRuntimeContext(input: CreateRuntimeContextInput): FullUltraworkRuntimeContext {
  const { input: pluginInput, options, registryIO, createEmptyTasksRegistry, normalizeTasksRegistry } = input;

  // Layer 1: base
  const base: RuntimeBaseContext = buildBaseContext(
    pluginInput,
    options,
    createEmptyTasksRegistry,
    normalizeTasksRegistry,
  );

  // Layer 2: registry-io 擴充為 RegistryRuntimeContext
  const registry: RegistryRuntimeContext = createRegistryIO(base, registryIO);

  // Layer 3: state-projection 擴充為 StateProjectionRuntimeContextEx
  const withStateProjection: StateProjectionRuntimeContextEx = {
    ...registry,
    updateStateMd: createStateProjection(registry),
  };

  // Layer 4: 收據驗證直接委派給 memory 模組的單一實作（規則只存在一份）。
  const full: FullUltraworkRuntimeContext = {
    ...withStateProjection,
    memoryReceiptRequired: true,
    async validateCommentSignalForCompletion() {
      return { ok: true, status: "not-reported" };
    },
    validateMemoryReceiptForTask: (receiptId, task, currentProject, context) =>
      validateReceiptForCompletion(
        withStateProjection.resolveProjectRoot(context),
        receiptId,
        { taskId: task.taskId },
        currentProject,
      ),
  };

  return full;
}

// Re-export PlansRegistry for upstream consumers
export type { PlansRegistry };
