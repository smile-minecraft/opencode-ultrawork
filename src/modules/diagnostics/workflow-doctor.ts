/**
 * `workflow_doctor`：唯讀整合診斷。
 *
 * 凍結介面（與舊版一致）：
 *   - 名稱 `workflow_doctor`；參數 `{}`（無參數）。
 *   - 回傳外框走 `jsonResult`，`data` 內含 `ok / checks[] / warnings[] /
 *     debug{} / memory_budget{} / plan_registry_health{}`。
 *
 * V2 行為落差（主動處理，不是照抄）：
 *   1. 第一個檢查在舊版是「Legacy memory tools disabled」，靠 V1 closure 的
 *      `memorySystemEnabled` env 旗標（預設 false）判斷。V2 沒有那個旗標，
 *      改成以 settings 的 memory 模組開關判斷，檢查名改為 `Memory Module Switch`
 *      —— 意圖保留（確認記憶體子系統的啟用狀態是已知的），比對依據換掉。
 *   2. `readInconsistentMarker` 舊版單參數只收 plans 目錄；V2 是雙參數
 *      `(projectRoot, plansDir)`，少了 projectRoot 就沒辦法做路徑守衛。
 *   3. `checks[].status` 新增 `skipped`：workflow／comment-signal 模組關閉，
 *      或 plans 目錄不存在時，對應檢查標成 skipped 並附原因。
 *   4. 新增 `Legacy .opencode Data Migration` 檢查：`.opencode` 舊資料還在、
 *      但搬遷還不能算完成時標 warn —— 標記檔不存在，或標記在而 `.ultrawork` 的
 *      位置沒通過安全檢查。搬移未完成不改變 `ok`，
 *      外掛本來就照新位置運作，這裡只負責把沒搬完講清楚 —— 診斷得出是被安全檢查
 *      擋下（`.opencode`／`.ultrawork` 是 symlink）時連原因與排除方式一起講。
 *   5. 新增 `Content Ref Path Integrity` 檢查與 `content_ref_issues` 欄位：逐項
 *      驗證註冊檔裡每個 `contentRef`（計畫與任務）與 `taskContentPath`，判定走讀寫
 *      工具同一個 `inspectContentRef`。嚴重度分兩級，界線與 `collectMissingContentRef`
 *      的活躍語意一致：
 *        · `legacy-prefix` / `outside-store` / `not-a-file` —— 引用永遠指向不到正文
 *          （守衛擋下，或目標是目錄／型態讀不到），不看項目狀態一律 failed。
 *        · `missing-file` —— 引用格式沒問題、缺的只是正文。**活躍**（非 COMPLETED／
 *          FAILED／CANCELLED）項目 failed 並讓 `ok=false`；已終態維持 warn，因為正文
 *          被清掉、引用留著是常見狀態，不該擋人。
 *
 * 唯讀：只讀檔案與 registry；不建立、不清除任何檔案（含不一致標記）。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineTool } from "../../kit/define-tool.ts";
import { jsonResult } from "../../kit/json.ts";
import { inspectProjectMigration } from "../../migrate/index.ts";
import type { MigrationStateReport } from "../../migrate/index.ts";
import type { InconsistentMarker } from "../workflow/index.ts";
import { moduleEnabled, type DiagnosticsDeps } from "./deps.ts";
import {
  collectContentRefIntegrity,
  collectContentStoreMarker,
  collectMemoryBudget,
  memoryWriterConfigCheck,
  collectMissingContentRef,
  collectPlanRegistryHealth,
  collectStateProjectionDivergence,
  collectUltraworkGitTracking,
  checkUltraworkGitignore,
  emptyMemoryBudget,
  emptyPlanRegistryHealth,
  isSameAsGlobalConfigDir,
  isSharedGlobalLayerEntry,
  readPlansForDiagnostics,
  readTasksForDiagnostics,
  resolveCurrentTaskId,
  type CheckItem,
  type ContentRefIssue,
  type MemoryBudget,
  type PlanRegistryHealth,
} from "./shared.ts";

export function createWorkflowDoctorTool(deps: DiagnosticsDeps) {
  return defineTool({
    name: "workflow_doctor",
    description:
      "唯讀檢查 Agent 設定、工具和工作流程整合，並提示專案記憶過大、缺少計畫內容或資料索引不一致等問題。",
    inputSchema: z.object({}),
    execute: async (_input, context) => {
      const paths = deps.runtime.getPaths(context);
      const workflowEnabled = moduleEnabled(deps.settings, "workflow");
      const memoryEnabled = moduleEnabled(deps.settings, "memory");

      const checks: CheckItem[] = [];
      const warnings: string[] = [];
      let diagnosisOk = true;
      const check = (name: string, passed: boolean, details: string): void => {
        checks.push({ name, status: passed ? "passed" : "failed", details });
        if (!passed) diagnosisOk = false;
      };
      // 被依賴模組關閉或資料不可得時：不假裝通過也不判失敗，直接標 skipped 並附原因。
      const skip = (name: string, reason: string): void => {
        checks.push({ name, status: "skipped", details: reason });
      };

      const diagnosis: {
        ok: boolean;
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
        content_store_inconsistent?: InconsistentMarker;
        content_ref_issues: ContentRefIssue[];
      } = {
        ok: true,
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
        content_ref_issues: [],
      };

      // ── 模組開關：記憶體子系統是否啟用 ──
      // 舊版這裡斷言「舊版 long_memory_* 工具已停用」，靠 V1 的 env 旗標。
      // V2 沒有等價物，改成回報 memory 模組開關的實際狀態。
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

      // ── 資料層讀取 ──
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

      // ── 記憶體預算 ──
      const budget = collectMemoryBudget(paths, deps.globalConfigDir);
      diagnosis.memory_budget = budget.memory_budget;
      warnings.push(...budget.warnings);
      diagnosis.checks.push(...budget.checks);
      diagnosis.checks.push(memoryWriterConfigCheck(deps.settings.memory.writerAgents));

      // ── 進行中計畫的 contentRef 缺漏 ──
      if (plansReason) {
        skip("Plan Content Ref Coverage", plansReason);
      } else {
        const contentRef = collectMissingContentRef(plansRegistry);
        diagnosis.memory_budget.missing_content_ref_plan_count = contentRef.count;
        if (contentRef.count > 0) {
          diagnosis.memory_budget.missing_content_ref_status = "warn";
          warnings.push(...contentRef.warnings);
        }
      }

      // ── 註冊檔裡每一個參照的可用性（與讀寫工具同一套路徑守衛）──
      // 位置緊接在缺漏檢查之後：兩者講同一個主題（引用），但分開報。缺漏是
      // 「欄位不存在、沒東西可讀」；這裡是「欄位在、但指向用不了的位置」，會擋住
      // 讀寫工具。合併成一個檢查會讓「缺參照」看起來像故障，所以另立一項。
      if (plansReason || tasksReason) {
        skip("Content Ref Path Integrity", plansReason ?? tasksReason!);
      } else {
        const integrity = collectContentRefIntegrity(paths, plansRegistry, registry);
        diagnosis.content_ref_issues = integrity.issues;
        for (const issue of integrity.issues) {
          warnings.push(`[content-ref] ${issue.repair}`);
        }
        if (integrity.blocking.length > 0) {
          check(
            "Content Ref Path Integrity",
            false,
            describeBlockingRefIssues(integrity.blocking),
          );
          diagnosisOk = false;
        } else if (integrity.issues.length > 0) {
          // 只剩「已終態項目的正文不見」：引用格式沒問題、也不擋任何寫入，
          // 而且正文被清掉、引用留著是常見狀態，所以是 warn 而不讓 ok 變 false。
          checks.push({
            name: "Content Ref Path Integrity",
            status: "warn",
            details:
              `有 ${integrity.issues.length} 個引用指向的正文檔不存在，但持有者都已封存／完成` +
              `（常見狀態，不擋操作）：${describeRefIssues(integrity.issues)}。` +
              `要恢復正文用 plan-content-create 重新建立。`,
          });
        } else {
          check("Content Ref Path Integrity", true, "註冊檔裡每個 contentRef / taskContentPath 都指向內容庫內的普通檔");
        }
      }

      // ── 進行中任務有效性 + state.md ↔ tasks.json 對不上 ──
      if (tasksReason) {
        skip("Active Task", tasksReason);
      } else {
        const currentTaskId = resolveCurrentTaskId(registry);
        if (!currentTaskId) {
          check("Active Task", true, "沒有進行中的任務（閒置）");
        } else {
          const task = registry.tasks[currentTaskId];
          if (!task) {
            check("Active Task Existence", false, `游標或進行中清單指向任務 ${currentTaskId}，但註冊檔裡找不到它`);
          } else {
            const hasFields = Boolean(
              task.taskId && task.owner && task.priority && task.projectId && task.projectPath,
            );
            check(
              "Active Task Validity",
              hasFields,
              `任務 ${currentTaskId} 必要欄位齊全度：${!!task.taskId}/${!!task.owner}/${!!task.priority}/${!!task.projectId}/${!!task.projectPath}`,
            );
            const divergence = collectStateProjectionDivergence(paths, registry);
            if (divergence.stateMdMissing) {
              skip("State Projection Consistency", "state.md 不存在，無法比對游標投影。");
            } else if (divergence.divergence) {
              warnings.push(...divergence.warnings);
              diagnosis.memory_budget.registry_projection_divergence = true;
              diagnosis.memory_budget.registry_projection_status = "warn";
            }
          }
        }
      }

      // ── 計畫註冊檔健康 ──
      if (plansReason) {
        skip("Plan Registry Health", plansReason);
      } else {
        const planHealth = collectPlanRegistryHealth(plansRegistry, registry);
        const health = planHealth.health!;
        diagnosis.plan_registry_health = health;
        if (health.error_count > 0) {
          check(
            "Plan Registry Health",
            false,
            `計畫註冊檔有 ${health.error_count} 個錯誤 / ${health.warn_count} 個警示（詳見 plan_registry_health.issues）`,
          );
          for (const issue of health.issues.filter((i) => i.severity === "error").slice(0, 5)) {
            warnings.push(`[plan-registry] ${issue.message}`);
          }
          diagnosisOk = false;
        } else if (health.warn_count > 0) {
          check("Plan Registry Health", true, `計畫註冊檔有 ${health.warn_count} 個警示（沒有錯誤）`);
          for (const issue of health.issues.filter((i) => i.severity === "warn").slice(0, 5)) {
            warnings.push(`[plan-registry] ${issue.message}`);
          }
        } else {
          check("Plan Registry Health", true, "計畫註冊檔沒有問題");
        }
      }

      // ── 內容庫不一致標記（只診斷、不清除、不復原） ──
      const markerOutcome = collectContentStoreMarker(paths);
      if (markerOutcome.unavailableReason) {
        skip("Content Store Consistency", markerOutcome.unavailableReason);
      } else if (markerOutcome.marker) {
        const marker = markerOutcome.marker;
        diagnosis.content_store_inconsistent = marker;
        check(
          "Content Store Consistency",
          false,
          `.content-store-inconsistent 存在（op=${marker.op} at=${marker.at}）。所有 content 寫入工具 fail-closed。人工核對 filesWritten / filesPending，修好後用 plan-content-read({clearInconsistent:true}) 清除。doctor 不清除、不復原。`,
        );
        warnings.push(`[content-store] 待修復：${JSON.stringify(marker.detail)}`);
        diagnosisOk = false;
      } else {
        check("Content Store Consistency", true, "無 .content-store-inconsistent marker");
      }

      // ── 舊資料搬遷狀態（.opencode/ → .ultrawork/）──
      // 搬遷失敗時外掛照常用新位置運作，所以只在這裡 warn，不影響 ok。
      const migration = inspectProjectMigration(paths.PROJECT_ROOT);
      if (migration.pending) {
        checks.push({
          name: "Legacy .opencode Data Migration",
          status: "warn",
          details: `${migrationPendingHeadline(migration)}${migrationReasonHint(migration)}`,
        });
        warnings.push(migrationWarning(migration));
      } else {
        checks.push({
          name: "Legacy .opencode Data Migration",
          status: "passed",
          details: migration.markerExists
            ? "已完成搬遷；舊資料以 .migrated- 改名形式保留在 .opencode/"
            : "沒有待搬遷的 .opencode 舊資料",
        });
      }

      // ── `.ultrawork/` 版控衛生：.gitignore 必要行、被追蹤的檔案、設定檔豁免 ──
      // 三種都是 warn（不影響 ok，外掛照常運作）；插件只提示，絕不改使用者的版控。
      // 全域層不建 `.gitignore`、插件不插手使用者的全域政策，這裡只看專案層。
      // 專案根目錄就是全域設定資料夾時，兩層共用同一個 `.ultrawork/`：全域層的檔案
      // 要不要進版控是使用者的全域政策，不算專案資料外洩。
      const sharedWithGlobal = isSameAsGlobalConfigDir(paths.PROJECT_ROOT, deps.globalConfigDir);
      collectUltraworkGitignoreCheck(paths.PROJECT_ROOT, sharedWithGlobal, checks, warnings);
      collectUltraworkGitTrackingCheck(paths.PROJECT_ROOT, sharedWithGlobal, checks, warnings);

      // workflow 模組關閉時，註冊檔來源的檢查沒有資料來源可診斷。
      if (!workflowEnabled) {
        warnings.push(
          "workflow 模組已關閉；任務／計畫註冊檔不會被本外掛更新，註冊檔相關的檢查結果只反映磁碟現況。",
        );
      }

      diagnosis.ok = diagnosisOk;
      return jsonResult(diagnosis);
    },
  });
}

/** 引用問題的短標籤（`details` 裡用；完整修法在 `warnings` 與 `content_ref_issues`）。 */
function describeRefIssue(issue: ContentRefIssue): string {
  return `${issue.owner === "plan" ? "計畫" : "任務"} ${issue.id} 的 ${issue.field}（${issue.ref}）`;
}

/** 短標籤清單，超過五筆就截斷並註明總數（doctor 的 details 有長度上限的顧慮）。 */
function describeRefIssues(issues: readonly ContentRefIssue[]): string {
  const shown = issues.slice(0, 5).map(describeRefIssue).join("；");
  return issues.length > 5 ? `${shown}（等 ${issues.length} 筆）` : shown;
}

/**
 * failed 的 details：依「為什麼不能用」分成兩組分開講。
 *
 * 分組不是排版偏好 —— 三種缺陷的修法完全不同（改前綴 / 改路徑 / 重新建立），
 * 混成一句會讓使用者不知道要動哪裡；`missing-file` 那組還多一個前提：只有活躍項目
 * 才會被算成問題，已終態的不在這裡。
 */
function describeBlockingRefIssues(blocking: readonly ContentRefIssue[]): string {
  const outsideStore = blocking.filter(
    (issue) => issue.kind === "legacy-prefix" || issue.kind === "outside-store",
  );
  const notAFile = blocking.filter((issue) => issue.kind === "not-a-file");
  const activeMissing = blocking.filter((issue) => issue.kind === "missing-file");
  const parts: string[] = [];
  if (outsideStore.length > 0) {
    parts.push(
      `${outsideStore.length} 個指向內容庫之外的位置，讀寫工具會被它們擋下：${describeRefIssues(outsideStore)}`,
    );
  }
  if (notAFile.length > 0) {
    parts.push(`${notAFile.length} 個指向的不是普通檔（目錄或讀不到型態），正文讀不到：${describeRefIssues(notAFile)}`);
  }
  if (activeMissing.length > 0) {
    parts.push(
      `${activeMissing.length} 個進行中／活躍項目的正文檔不存在（引用在庫內、缺的只是正文）：` +
        `${describeRefIssues(activeMissing)}`,
    );
  }
  return `註冊檔有 ${blocking.length} 個引用用不了 —— ${parts.join("；")}。` +
    `逐項清單與修法在 content_ref_issues / warnings。`;
}

/**
 * `.ultrawork/.gitignore` 檢查：(a) 缺必要行 `*`、(c) 設定檔仍被豁免。
 *
 * 模板只有 `*` 一行；既有檔案永遠不自動改寫，想跟新模板一致就手動刪行。
 * 任一情況都是 warn（不影響診斷 ok），兩種可同時成立。
 */
function collectUltraworkGitignoreCheck(
  projectRoot: string,
  sharedWithGlobal: boolean,
  checks: CheckItem[],
  warnings: string[],
): void {
  const health = checkUltraworkGitignore(projectRoot);
  const problems: string[] = [];
  if (!health.hasRequiredLine) {
    const missing = health.content === undefined
      ? ".ultrawork/.gitignore 不存在"
      : ".ultrawork/.gitignore 缺少必要行 `*`";
    problems.push(
      `${missing}：.ultrawork/ 的內容可能被送進版控。模板只有 \`*\` 一行（全部忽略）；` +
        `插件不會自動改寫既有檔案，請手動補上。`,
    );
    warnings.push(`[gitignore] ${missing}，.ultrawork/ 的內容可能被送進版控（必要行 \`*\` 缺失）。`);
  }
  // 同資料夾時 ultrawork.jsonc 也是全域設定檔，豁免它是使用者的全域版控政策。
  if (health.exemptsSettingsFile && !sharedWithGlobal) {
    problems.push(
      "專案設定檔 ultrawork.jsonc 仍被豁免（`!ultrawork.jsonc` 還在）：它不會被忽略，" +
        "可能被送進版控。想跟新模板（只有 `*` 一行）一致就手動刪掉那行豁免；插件不會自動改。",
    );
    warnings.push("[gitignore] 專案設定檔 ultrawork.jsonc 仍被豁免，可能被送進版控。");
  }
  checks.push({
    name: "Ultrawork Gitignore",
    status: problems.length > 0 ? "warn" : "passed",
    details: problems.length > 0
      ? problems.join("；")
      : ".ultrawork/.gitignore 有必要行 `*`，且專案設定檔沒有被豁免",
  });
}

/**
 * 被版控追蹤的 `.ultrawork/` 檔案檢查：(b) 含已追蹤的 `ultrawork.jsonc`。
 *
 * 唯讀的 `git ls-files`；查不到（不是 git repo、沒有 git）就標 skipped。
 * 只提示用 `git rm --cached` 取消追蹤，絕不動使用者的版控。
 *
 * 專案根目錄就是全域設定資料夾時，全域層的檔案（`SHARED_GLOBAL_LAYER_ENTRIES`）
 * 不列入警告，只在 details 註明排除了哪些；專案層的工作流資料照常警告。
 */
function collectUltraworkGitTrackingCheck(
  projectRoot: string,
  sharedWithGlobal: boolean,
  checks: CheckItem[],
  warnings: string[],
): void {
  const health = collectUltraworkGitTracking(projectRoot);
  if (health.tracked === null) {
    checks.push({
      name: "Ultrawork Git Tracking",
      status: "skipped",
      details: `無法列出被追蹤的檔案（${health.unavailableReason ?? "git 不可用"}），未檢查 .ultrawork/ 是否被版控追蹤。`,
    });
    return;
  }
  const globalLayer = sharedWithGlobal ? health.tracked.filter(isSharedGlobalLayerEntry) : [];
  const tracked = sharedWithGlobal ? health.tracked.filter((entry) => !isSharedGlobalLayerEntry(entry)) : health.tracked;
  const globalNote = globalLayer.length > 0
    ? `；專案根目錄同時是全域設定資料夾，${globalLayer.length} 個全域層檔案（${globalLayer.join("、")}）` +
      "由你的全域版控政策決定，不列入檢查"
    : "";
  if (tracked.length === 0) {
    checks.push({
      name: "Ultrawork Git Tracking",
      status: "passed",
      details: `沒有 .ultrawork/ 內的${globalLayer.length > 0 ? "專案資料" : "檔案"}被版控追蹤${globalNote}`,
    });
    return;
  }
  const shown = tracked.slice(0, 10).join("、");
  const suffix = tracked.length > 10 ? `等 ${tracked.length} 個` : "";
  checks.push({
    name: "Ultrawork Git Tracking",
    status: "warn",
    details:
      `${tracked.length} 個 .ultrawork/ 內的檔案正被版控追蹤（${shown}${suffix}）：` +
      `本機工作流狀態不該進版控。用 git rm --cached 取消追蹤（插件不會動你的版控）${globalNote}。`,
  });
  warnings.push(
    `[tracking] ${tracked.length} 個 .ultrawork/ 檔案被版控追蹤（${shown}${suffix}），請用 git rm --cached 取消追蹤。`,
  );
}

/**
 * pending 的開場白：先講「為什麼還不能算搬完」。
 *
 * 三種組合要講不同的話，混用就會與磁碟現況衝突：
 *
 * - 有舊資料、標記不存在（搬移端最常見的未完成）→ 照實說舊資料還在、`<markerPath>` 不存在。
 * - 有舊資料、標記存在但 `.ultrawork` 沒通過安全檢查 → 那個檔案**就在磁碟上**，
 *   只是搬移端不肯認它是本專案的資料位置（它多半在專案外）。這時說「不存在」是錯的，
 *   會讓使用者去磁碟上找一個明明存在的檔案。
 * - **沒有舊資料** → 不得再主張「舊資料仍存在」：那會產生一個空括號，而且整句
 *   站不住。`legacySources` 為空時仍會 pending，只可能來自「標記存在但位置未通過
 *   安全檢查」（見 `inspectProjectMigration()`），所以這個分支講的是位置，不是資料。
 *
 * 只換開場白；後面的原因與下一步由 `migrationReasonHint()` 負責，三種情境共用。
 */
function migrationPendingHeadline(migration: MigrationStateReport): string {
  if (migration.legacySources.length === 0) {
    return (
      `無法確認 ${migration.markerPath} 是本專案的資料位置（該位置未通過安全檢查）：` +
      `搬遷未完成或失敗。`
    );
  }
  return (
    `.opencode 舊資料仍存在（${migration.legacySources.join("、")}），` +
    `但${migrationMarkerClause(migration)}：搬遷未完成或失敗。`
  );
}

/**
 * 標記那半句：只在意「標記在不在」與「位置安不安全」的差別。
 *
 * `migrationPendingHeadline()` 在有舊資料時才呼叫它。檔案在、但裡面沒有本層完成
 * 記錄時（共用目錄的另一層標記、空舊標記）不能說「不存在」—— 使用者去磁碟上找，
 * 那個檔案明明就在那裡；要講的是「沒有本層的記錄」。
 */
function migrationMarkerClause(migration: MigrationStateReport): string {
  if (migration.markerExists) {
    return (
      ` ${migration.markerPath} 存在，但 .ultrawork 的位置未通過安全檢查，` +
      `無法確認那是本專案的資料位置`
    );
  }
  if (migration.markerFilePresent) {
    return ` ${migration.markerPath} 存在，但裡面沒有本層的完成記錄`;
  }
  return ` ${migration.markerPath} 不存在`;
}

/**
 * 搬遷 pending 的 console 警告。
 *
 * 跟開場白同一個分界：沒有舊資料時不列舉（會變成沒有主詞的「[migrate]  尚未搬遷到…」，
 * 而且「舊資料仍原地保留」在沒有舊資料時是假的），改講使用者真正要處理的事。
 */
function migrationWarning(migration: MigrationStateReport): string {
  if (migration.legacySources.length === 0) {
    return (
      `[migrate] 無法確認 .ultrawork/ 是本專案的資料位置（搬移路徑未通過安全檢查）；` +
      `外掛目前使用 .ultrawork/，請確認 .ultrawork 不是指向專案外的 symlink。`
    );
  }
  return `[migrate] ${migration.legacySources.join("、")} 尚未搬遷到 .ultrawork/；外掛目前使用 .ultrawork/，舊資料仍原地保留。`;
}

/**
 * 搬遷還在 pending 時，下一句該說什麼。
 *
 * 判斷得出原因是「路徑沒通過安全檢查」時就點名 `.opencode`／`.ultrawork` 的
 * symlink 與排除方式：那種狀態重試再多次也不會自己好，只講「未完成」會讓使用者
 * 一直等。判斷不出原因時維持原本的語意（重試、檔案權限、搬移不刪資料）。
 */
function migrationReasonHint(migration: MigrationStateReport): string {
  if (migration.reason !== "unsafe-path") {
    return (
      "下次啟動 OpenCode 會再試一次；仍失敗請看啟動時的 [ultrawork] 警告，" +
      "確認 .opencode 與 .ultrawork 兩個位置的檔案權限（搬移只複製與改名，不會刪資料）。"
    );
  }
  return (
    "原因是 .opencode 或 .ultrawork 的路徑未通過安全檢查（可能是 symlink）：" +
    `${migration.detail ?? "搬移路徑的父層不在專案內"}。` +
    "要排除請確認這兩個位置不是指向專案外或外部目錄的 symlink，" +
    "或先把舊資料手動複製到 .ultrawork/，下次啟動就會收尾（搬移只複製與改名，不會刪資料）。"
  );
}
