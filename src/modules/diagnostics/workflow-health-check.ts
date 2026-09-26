/**
 * `workflow_health_check`：doctor 的檢查點加上健康訊號（快照時效、抑制數、
 * hook 覆蓋、工具清單自洽性），並用 `overallStatus` 聚合。
 *
 * 凍結介面（與舊版一致）：
 *   - 名稱 `workflow_health_check`；參數 `{ includeBaselineCheck?: boolean }`（預設 true）。
 *   - 回傳外框走 `jsonResult`，`data` 內含 `ok / overallStatus / checks[] /
 *     warnings[] / debug{} / memory_budget{} / plan_registry_health{} /
 *     health_signals{} / humanSummary`。
 *   - `compareToolNameSets` 仍是匯出的純函式，規則逐字沿用（任一來源缺漏 →
 *     `skipped=true`、`match=false`，絕不會永遠 true）。
 *
 * 與舊版的兩處刻意落差：
 *   1. 「實際工具集合」改由 `ctx.tool.list()` 提供（V2 平台真的有登錄清單），
 *      收斂到宣告屬於本外掛的工具名；取不到時該項標 skipped 並在 details 寫明。
 *   2. 「預期集合」只含**啟用中**模組的工具：V2 可以逐一關閉模組，關閉的模組
 *      不會註冊工具，若仍拿全部 48 個當預期，每次關模組都會長期誤報不一致。
 *
 * 唯讀：只讀檔案與 registry。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineTool } from "../../kit/define-tool.ts";
import { jsonResult } from "../../kit/json.ts";
import {
  BASELINE_FILENAME,
  SUPPRESSIONS_FILENAME,
  readBaseline,
  readSuppressionStore,
  resolveMemoryDir,
  type CommentSignalBaseline,
  type CommentSignalSuppressionStore,
} from "../comment-signal/index.ts";
import { moduleEnabled, type DiagnosticsDeps } from "./deps.ts";
import {
  HOOK_NAMES,
  TOOL_MODULES,
  type HookName,
} from "./inventory.ts";
import {
  collectContentStoreMarker,
  collectMemoryBudget,
  memoryWriterConfigCheck,
  collectMissingContentRef,
  collectPlanRegistryHealth,
  collectStateProjectionDivergence,
  countByStatus,
  emptyMemoryBudget,
  emptyPlanRegistryHealth,
  readPlansForDiagnostics,
  readTasksForDiagnostics,
  resolveCurrentTaskId,
  type CheckItem,
  type MemoryBudget,
  type PlanRegistryHealth,
} from "./shared.ts";

/** 快照超過這個小時數就算過期（一週）。 */
const BASELINE_STALE_HOURS = 24 * 7;

export interface ToolCountComparison {
  expected: number | null;
  actual: number;
  match: boolean;
  skipped: boolean;
}

/**
 * 比較「預期工具名單」與「實際工具名單」。
 *
 *   - 兩者皆空 → skipped、match=false。
 *   - 任一方缺漏 → skipped、match=false（避免誤報永遠 true）。
 *   - 長度相同但內容不同 → match=false（排序後逐項比）。
 */
export function compareToolNameSets(
  expected: readonly string[] | undefined,
  actual: readonly string[] | undefined,
): ToolCountComparison {
  const expectedArr = expected ?? [];
  const actualArr = actual ?? [];
  if (expectedArr.length === 0 && actualArr.length === 0) {
    return { expected: null, actual: 0, match: false, skipped: true };
  }
  if (expectedArr.length === 0 || actualArr.length === 0) {
    return {
      expected: expectedArr.length > 0 ? expectedArr.length : null,
      actual: actualArr.length,
      match: false,
      skipped: true,
    };
  }
  if (expectedArr.length !== actualArr.length) {
    return { expected: expectedArr.length, actual: actualArr.length, match: false, skipped: false };
  }
  const sortedExpected = [...expectedArr].sort();
  const sortedActual = [...actualArr].sort();
  return {
    expected: expectedArr.length,
    actual: actualArr.length,
    match: sortedExpected.every((name, index) => name === sortedActual[index]),
    skipped: false,
  };
}

export interface HealthSignals {
  baseline_state: "missing" | "stale" | "fresh" | "skipped";
  baseline_age_hours?: number;
  suppressions_total: number;
  suppressions_high_risk_count: number;
  hook_coverage: Record<HookName, boolean>;
  tool_count_expected: number | null;
  tool_count_actual: number;
  tool_count_match: boolean;
}

export function createWorkflowHealthCheckTool(deps: DiagnosticsDeps) {
  return defineTool({
    name: "workflow_health_check",
    description:
      "檢查 Agent 設定、專案記憶、資料索引、Comment Signal、外掛 hook 與工具清單，整理目前需要處理的問題。",
    inputSchema: z.object({
      includeBaselineCheck: z.boolean().optional(),
    }),
    execute: async (input, context) => {
      const paths = deps.runtime.getPaths(context);
      const includeBaseline = input.includeBaselineCheck !== false;
      const memoryEnabled = moduleEnabled(deps.settings, "memory");
      const commentSignalEnabled = moduleEnabled(deps.settings, "commentSignal");

      const checks: CheckItem[] = [];
      const warnings: string[] = [];
      let resultOk = true;
      const check = (
        name: string,
        passed: boolean,
        details: string,
        warnOnly = false,
      ): void => {
        checks.push({ name, status: warnOnly ? "warn" : passed ? "passed" : "failed", details });
        if (!passed && !warnOnly) resultOk = false;
      };
      const skip = (name: string, reason: string): void => {
        checks.push({ name, status: "skipped", details: reason });
      };

      const result: {
        ok: boolean;
        overallStatus: "healthy" | "degraded" | "failed";
        checks: CheckItem[];
        warnings: string[];
        debug: {
          projectId: string;
          projectRoot: string;
          MEMORY_DIR: string;
          STATE_MD: string;
          TASKS_JSON: string;
        };
        memory_budget: MemoryBudget;
        plan_registry_health: PlanRegistryHealth;
        health_signals: HealthSignals;
        humanSummary: string;
        code?: string;
      } = {
        ok: true,
        overallStatus: "healthy",
        checks,
        warnings,
        debug: {
          projectId: paths.PROJECT_ID,
          projectRoot: paths.PROJECT_ROOT,
          MEMORY_DIR: paths.MEMORY_DIR,
          STATE_MD: paths.STATE_MD,
          TASKS_JSON: paths.TASKS_JSON,
        },
        memory_budget: emptyMemoryBudget(),
        plan_registry_health: emptyPlanRegistryHealth(),
        health_signals: {
          baseline_state: includeBaseline ? "missing" : "skipped",
          suppressions_total: 0,
          suppressions_high_risk_count: 0,
          hook_coverage: hookCoverage(deps),
          tool_count_expected: null,
          tool_count_actual: 0,
          tool_count_match: false,
        },
        humanSummary: "",
      };

      // ── 模組開關（取代舊版沒有等價物的 memorySystemEnabled env 旗標）──
      check(
        "Memory Module Switch",
        true,
        memoryEnabled
          ? "memory 模組已啟用（兩層記憶與結案處置由 memory 模組管理）"
          : "memory 模組已關閉（兩層記憶與結案處置不由本外掛維護）",
      );
      if (!memoryEnabled) {
        warnings.push(
          "memory 模組已關閉；兩層記憶與結案處置不由本外掛維護，下面的檔案大小檢查可能找不到資料。",
        );
      }

      const { registry, reason: tasksReason, project } = readTasksForDiagnostics(deps, context);
      const { plans: plansRegistry, reason: plansReason } = readPlansForDiagnostics(deps, context);

      check("Memory Directory Resolution", existsSync(paths.MEMORY_DIR), `解析到：${paths.MEMORY_DIR}`);
      if (tasksReason) {
        skip("Tasks Registry Project Binding", tasksReason);
      } else {
        check(
          "Tasks Registry Project Binding",
          registry.projectId === project.projectId && registry.projectPath === paths.PROJECT_ROOT,
          `註冊檔綁定到 ${registry.projectId}（${registry.projectPath}）`,
        );
      }
      check("state.md exists", existsSync(join(paths.MEMORY_DIR, "state.md")), paths.STATE_MD);
      check("tasks.json exists", existsSync(paths.TASKS_JSON), paths.TASKS_JSON);

      // ── 記憶體預算（與 doctor 共用同一份收集邏輯）──
      const budget = collectMemoryBudget(paths, deps.globalConfigDir);
      result.memory_budget = budget.memory_budget;
      warnings.push(...budget.warnings);
      result.checks.push(...budget.checks);
      result.checks.push(memoryWriterConfigCheck(deps.settings.memory.writerAgents));

      if (plansReason) {
        skip("Plan Content Ref Coverage", plansReason);
      } else {
        const contentRef = collectMissingContentRef(plansRegistry);
        result.memory_budget.missing_content_ref_plan_count = contentRef.count;
        if (contentRef.count > 0) {
          result.memory_budget.missing_content_ref_status = "warn";
          warnings.push(...contentRef.warnings);
        }
      }

      // ── 進行中任務有效性 + 投影對不上 ──
      if (tasksReason) {
        skip("Active Task", tasksReason);
      } else {
        const currentTaskId = resolveCurrentTaskId(registry);
        if (currentTaskId) {
          const task = registry.tasks[currentTaskId];
          if (task) {
            const hasFields = Boolean(
              task.taskId && task.owner && task.priority && task.projectId && task.projectPath,
            );
            check("Active Task Validity", hasFields, `任務 ${currentTaskId} 必要欄位齊全`);
            const divergence = collectStateProjectionDivergence(paths, registry);
            if (divergence.stateMdMissing) {
              skip("State Projection Consistency", "state.md 不存在，無法比對游標投影。");
            } else if (divergence.divergence) {
              warnings.push(...divergence.warnings);
              result.memory_budget.registry_projection_divergence = true;
              result.memory_budget.registry_projection_status = "warn";
            }
          }
        }
      }

      // ── 健康訊號：Comment Signal 問題快照 ──
      if (!includeBaseline) {
        result.health_signals.baseline_state = "skipped";
      } else if (!commentSignalEnabled) {
        result.health_signals.baseline_state = "skipped";
        skip("Comment Signal Snapshot Exists", "comment-signal 模組已關閉，問題快照不會被本外掛維護。");
      } else {
        const baselinePath = join(resolveMemoryDir(paths.PROJECT_ROOT), BASELINE_FILENAME);
        const baseline: CommentSignalBaseline | null = readBaseline(baselinePath);
        if (!baseline) {
          result.health_signals.baseline_state = "missing";
          // first-run 友善：缺失不算 fail，以 warn 提示。
          check("Comment Signal Snapshot Exists", false, `找不到 ${baselinePath}`, true);
          warnings.push("Comment Signal 目前問題快照缺失：請呼叫 comment_signal_baseline 建立。");
        } else {
          const ageHours = (Date.now() - new Date(baseline.createdAt).getTime()) / (1000 * 60 * 60);
          result.health_signals.baseline_age_hours = ageHours;
          if (ageHours > BASELINE_STALE_HOURS) {
            result.health_signals.baseline_state = "stale";
            check(
              "Comment Signal Baseline Fresh",
              false,
              `問題快照已建立 ${(ageHours / 24).toFixed(1)} 天（超過 ${BASELINE_STALE_HOURS / 24} 天）`,
              true,
            );
            warnings.push(
              `Comment Signal 目前問題快照已 ${(ageHours / 24).toFixed(1)} 天未更新，建議重建。`,
            );
          } else {
            result.health_signals.baseline_state = "fresh";
            check("Comment Signal Baseline Fresh", true, `問題快照建立於 ${ageHours.toFixed(1)} 小時前`);
          }
        }
      }

      // ── 健康訊號：屏蔽清單 ──
      if (!commentSignalEnabled) {
        skip("Comment Signal Suppression Store", "comment-signal 模組已關閉，屏蔽清單不會被本外掛維護。");
      } else {
        const supPath = join(resolveMemoryDir(paths.PROJECT_ROOT), SUPPRESSIONS_FILENAME);
        const supStore: CommentSignalSuppressionStore | null = readSuppressionStore(supPath);
        // 檔案不存在時 readSuppressionStore 回空 store；只有壞檔才回 null。
        if (supStore === null) {
          check("Comment Signal Suppression Store", false, `屏蔽清單損壞：${supPath}`, true);
          warnings.push("Comment Signal 的屏蔽清單損壞，請檢查 comment-signal-suppressions.json。");
        } else {
          result.health_signals.suppressions_total = supStore.suppressions.length;
          // 抑制結構只記 severity，因此以 severity=blocking 視為高風險（保守策略）。
          const highRisk = supStore.suppressions.filter((s) => s.severity === "blocking");
          result.health_signals.suppressions_high_risk_count = highRisk.length;
          if (highRisk.length > 0) {
            check(
              "Comment Signal High-Risk Suppressions",
              false,
              `${highRisk.length} 個高風險問題被屏蔽（需要人工稽核）`,
              true,
            );
            warnings.push(`${highRisk.length} 個高風險問題被屏蔽；請定期稽核。`);
          }
        }
      }

      // ── 健康訊號：工具清單自洽性 ──
      const actualToolNames = await deps.listRegisteredToolNames();
      const expectedToolNames = Object.entries(TOOL_MODULES)
        .filter(([, moduleKey]) => moduleEnabled(deps.settings, moduleKey))
        .map(([name]) => name);
      const comparison = compareToolNameSets(expectedToolNames, actualToolNames ?? undefined);
      result.health_signals.tool_count_expected = comparison.expected;
      result.health_signals.tool_count_actual = comparison.actual;
      result.health_signals.tool_count_match = comparison.match;
      if (actualToolNames === null) {
        // 平台沒給清單 → 這一項根本沒辦法比，必須標 skipped 並寫明原因；
        // 標成 warn 等於宣稱「比過了但有瑕疵」，那是不實的。
        skip("Tool Manifest Self-Consistency", "平台未提供實際註冊工具清單（ctx.tool.list 不可用），略過比對");
        warnings.push(
          "無法取得平台實際註冊的工具清單，工具清單自洽性這項檢查已略過；請用 tool_hook_manifest 人工核對。",
        );
      } else {
        const toolCountMsg = comparison.skipped
          ? `預期 ${comparison.expected ?? "?"} 個、實際 ${comparison.actual} 個，略過比對（來源資料不足）`
          : `預期 ${comparison.expected} 個、實際 ${comparison.actual} 個，一致=${comparison.match}`;
        check("Tool Manifest Self-Consistency", comparison.match, toolCountMsg, comparison.skipped);
      }

      // ── 計畫註冊檔健康 ──
      if (plansReason) {
        skip("Plan Registry Health", plansReason);
      } else {
        const health = collectPlanRegistryHealth(plansRegistry, registry).health!;
        result.plan_registry_health = health;
        if (health.error_count > 0) {
          check(
            "Plan Registry Health",
            false,
            `計畫註冊檔有 ${health.error_count} 個錯誤 / ${health.warn_count} 個警示`,
          );
          for (const issue of health.issues.filter((i) => i.severity === "error").slice(0, 5)) {
            warnings.push(`[plan-registry] ${issue.message}`);
          }
          resultOk = false;
        } else if (health.warn_count > 0) {
          check("Plan Registry Health", true, `計畫註冊檔有 ${health.warn_count} 個警示（沒有錯誤）`, true);
          for (const issue of health.issues.filter((i) => i.severity === "warn").slice(0, 5)) {
            warnings.push(`[plan-registry] ${issue.message}`);
          }
        } else {
          check("Plan Registry Health", true, "計畫註冊檔沒有問題");
        }
      }

      // ── 內容庫一致性 ──
      const markerOutcome = collectContentStoreMarker(paths);
      if (markerOutcome.unavailableReason) {
        skip("Content Store Consistency", markerOutcome.unavailableReason);
      } else if (markerOutcome.marker) {
        check(
          "Content Store Consistency",
          false,
          `.content-store-inconsistent 存在（op=${markerOutcome.marker.op} at=${markerOutcome.marker.at}）。`,
        );
        resultOk = false;
      } else {
        check("Content Store Consistency", true, "無 .content-store-inconsistent marker");
      }

      // ── overallStatus 聚合 ──
      // failed（任一非 warn 檢查失敗）→ degraded（有 warn）→ healthy。
      // 只有 warn 時維持 ok=true 不翻轉；overallStatus 獨立標示可觀察退化。
      const counts = countByStatus(checks);
      if (!resultOk) {
        result.overallStatus = "failed";
      } else if (counts.warn > 0 || result.plan_registry_health.warn_count > 0) {
        result.overallStatus = "degraded";
      } else {
        result.overallStatus = "healthy";
      }
      result.ok = resultOk;

      const baselineLabel =
        result.health_signals.baseline_state === "fresh"
          ? "最新"
          : result.health_signals.baseline_state === "stale"
            ? "已過期"
            : result.health_signals.baseline_state === "missing"
              ? "尚未建立"
              : "已略過";
      const prh = result.plan_registry_health;
      result.humanSummary = [
        `Workflow 健康檢查：整體狀態 ${result.overallStatus}（${resultOk ? "通過" : "未通過"}）`,
        `- 檢查項目：通過 ${counts.passed}、警示 ${counts.warn}、略過 ${counts.skipped}、未通過 ${counts.failed}`,
        `- 另有 ${warnings.length} 則警告`,
        `- Comment Signal 問題快照：${baselineLabel}`,
        `- 屏蔽清單：${result.health_signals.suppressions_total} 筆，其中高風險 ${result.health_signals.suppressions_high_risk_count} 筆`,
        `- 工具數：預期 ${result.health_signals.tool_count_expected ?? "?"} 個、實際 ${result.health_signals.tool_count_actual} 個`,
        `- 計畫註冊檔：${prh.ok ? "正常" : "有問題"}，錯誤 ${prh.error_count} 個、警示 ${prh.warn_count} 個`,
      ].join("\n");

      return jsonResult(result);
    },
  });
}

/**
 * hook wiring 狀態：每個 hook 由哪個模組註冊決定。
 * 平台內建的 `tool.definition`（`ctx.tool.transform`）只要診斷模組自己開著就有。
 *
 * 這是**依 `settings.modules` 推導的預估值，不是實際註冊的觀測值**：平台沒有
 * 提供「查詢某個 hook 有沒有真的被註冊」的 API，所以模組開關開著但該模組沒被
 * 載入時會推導出 `true`。回傳欄位與輸出文字維持凍結介面不變，語意落差記在
 * `tests/v2/native/diagnostics/TEST-MAPPING.md`。
 */
function hookCoverage(deps: DiagnosticsDeps): Record<HookName, boolean> {
  const search = moduleEnabled(deps.settings, "search");
  const verification = moduleEnabled(deps.settings, "verification");
  const skills = moduleEnabled(deps.settings, "skills");
  const skiller = moduleEnabled(deps.settings, "skiller");
  const workflow = moduleEnabled(deps.settings, "workflow");
  const commentSignal = moduleEnabled(deps.settings, "commentSignal");
  const diagnostics = moduleEnabled(deps.settings, "diagnostics");
  const anyToolModule =
    search || verification || skills || skiller || workflow || commentSignal || diagnostics;
  return {
    event: search || workflow || commentSignal || skiller,
    "tool.execute.before": workflow || commentSignal,
    "tool.execute.after": commentSignal,
    "experimental.chat.system.transform": skills || workflow,
    "experimental.session.compacting": workflow,
    "tool.definition": anyToolModule,
  };
}
