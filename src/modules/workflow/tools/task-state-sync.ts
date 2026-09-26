import { jsonResult } from "../../../kit/json.ts";
/**
 * opencode-ultrawork — task-state-sync tool factory
 *
 * 角色：
 *   - 對應 專案記憶 task state machine（NEW → PLANNED → IN_PROGRESS / BLOCKED /
 *     ARCHIVING → COMPLETED）與 專案記憶更新階段 memory 更新紀錄 gate。
 *
 * 對外規則（不可破壞）：
 *   - factory 簽名：`createTaskStateSyncTool(runtime)`。
 *   - tool name：`task-state-sync`（plugin tool registry key）。
 *   - `args` schema 保留既有欄位並以專用 event 管理終態（description / event / taskId /
 *     title / from / to / owner / priority / reason / projectId / projectPath /
 *     risk / verdict / reviewer / note / acceptance / verbose）。
 *   - 各 event 分支（create / transition / complete / cancel / fail / block / review /
 *     status）的回傳 JSON 形狀必須與原 closure 版本一致；`warnings` 為選填欄位，
 *     只在有提醒時出現，不影響既有欄位。
 *   - `status` 的預設回應改為投影（`projection: "summary"`）：`registry` 的鍵與
 *     巢狀結構不變、任務一筆不少，只是每筆 Task 少了 `history` 與重複的
 *     `projectId` / `projectPath`。`verbose: true` 回未經投影的完整 registry
 *     （`projection: "full"`）。投影只影響模型看到的 context；狀態機與閘門
 *     一律直接讀正式 registry。見 ./context-projection.ts。
 *   - 錯誤訊息（`error`）是給人讀的台灣繁中，可以改寫；機器要判讀的是 `code`
 *     欄位，每個失敗分支都帶一個：`TASK_ID_REQUIRED` / `TASK_ALREADY_EXISTS` /
 *     `TITLE_REQUIRED` / `INITIAL_STATE_REQUIRED` / `INVALID_INITIAL_STATE` /
 *     `OWNER_REQUIRED` / `PRIORITY_REQUIRED` / `TASK_NOT_FOUND` /
 *     `TRANSITION_STATE_REQUIRED` / `STATE_MISMATCH` / `TERMINAL_STATE_CONFLICT` /
 *     `DEDICATED_EVENT_REQUIRED` / `INVALID_TRANSITION` / `MEMORY_DISPOSITION_REQUIRED` /
 *     記憶處置驗證的錯誤碼（見 `memory/disposition.ts`）/ `REASON_REQUIRED` / `CROSS_PROJECT` /
 *     `REVIEW_REQUIRED` / `REVIEW_VERDICT_INVALID` / `REVIEW_NOTE_REQUIRED` /
 *     `ACCEPTANCE_REQUIRED`。這些值不可改。
 *
 * 審查閘門（v4.2，v4.3 改為主防線設在 ARCHIVING 之前）：
 *   - 風險採申報制：`create` 或 `transition` 帶 `risk:"high"` 才會啟用閘門。
 *     只認 `"high"`，其餘值一律忽略，而且沒有降級路徑——申報之後不能撤回，
 *     否則主代理只要在結案前一步降級就能把閘門關掉。
 *   - 主防線在 `REVIEWING → ARCHIVING` 這個 transition 本身：申報為高風險
 *     的任務，沒有 `approve` / `concerns` 的審查紀錄就進不了 `ARCHIVING`，
 *     擋下時回 `REVIEW_REQUIRED`。這條線不能省——`ARCHIVING` 只能走向
 *     `COMPLETED` / `FAILED` / `CANCELLED`，沒有回 `REVIEWING` 補審查的
 *     路；只在 `complete` 才擋的話，沒審查的任務會卡死在 `ARCHIVING`
 *     裡出不來，唯一的出路是拿 `fail`/`cancel` 放棄掉。
 *   - `complete` 前的審查檢查是防禦線，不是主防線：涵蓋任務跳過
 *     `ARCHIVING`、直接從其他狀態呼叫 `complete` 的情況；正常路徑下走
 *     不到這裡。`reject` 或沒有紀錄都算沒過關，低風險任務不受影響。
 *   - `review` event 除了 `REVIEWING`，也接受 `ARCHIVING`：這是救援用的
 *     例外，補的是 v4.2（閘門只設在 complete）留下的舊資料——那個版本
 *     沒有主防線，任務有可能已經卡在 `ARCHIVING` 又缺審查，而 `ARCHIVING`
 *     沒有回 `REVIEWING` 的路。若 `review` 只認 `REVIEWING`，這種任務會
 *     連官方補救的管道都沒有，逼人去手改 tasks.json（違反不能覆寫任務
 *     註冊檔案的規則）。正常流程請在 `REVIEWING` 送審，不要靠這條例外。
 *   - 高風險任務的申報、審查結論、降級企圖與收尾都會寫進
 *     `.ultrawork/audit.jsonl`（只增不改）。寫入失敗採 fail-open，
 *     但會在 `warnings` 講出來，不靜默。
 *   - 缺項一次列齊，並以 `blockedBy` 陣列結構化回報（值：`review` /
 *     `memory` / `state`），呼叫端不必解析中文訊息就知道還缺什麼。
 *   - `complete` 的主要錯誤碼優先序：審查 → 記憶處置 → 狀態。審查排最前面
 *     是因為補救成本差很多——補狀態和補記憶處置都是機械性動作，補審查要跑一整輪
 *     獨立審查。既有情境的錯誤碼不受影響：低風險任務的審查檢查恆為通過，
 *     所以「只缺記憶處置」仍然回 `MEMORY_DISPOSITION_REQUIRED`。
 *
 * 驗收閘門（v4.4）：
 *   - 任務上的 `acceptanceCriteria` 原本寫得進去卻沒有任何地方會檢查，
 *     填了一整串條件、一項都沒做到，照樣結案成功。現在 `complete` 會要求
 *     逐項回報：`acceptance` 參數的每個 `criterion` 要與任務上的條件逐字
 *     相同，而且全部 `met: true` 才放行。
 *   - **沒填驗收條件的任務完全不受影響**。這個閘門擋的是「填了卻沒人看」，
 *     不是強迫每個任務都先寫驗收條件，否則既有任務會一次全部卡住。
 *   - 擋在 `complete` 而不是 ARCHIVING 之前：審查缺席是死路（ARCHIVING 沒有
 *     回 REVIEWING 的路），所以要提前擋；驗收回報則是呼叫端當下就給得出來
 *     的參數，補一次再送即可，不會卡死。
 *   - 通過之後把結論寫進 `task.acceptanceResults`，保留結案當下那一版條件。
 *
 * 限制：
 *   - 所有 IO 透過注入的 `UltraworkRuntimeContext`（含 read/write/update
 *     registry helpers）進行；不直接讀寫 fs。
 *
 * @see ../../../../README.md                                     — 模組一覽
 * @see ../runtime/context-builder.ts                              — runtime 介面
 */

import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../../kit/define-tool.ts";
type ToolContext = ToolExecutionContext;
import type { Task, TasksRegistry, PlansRegistry, ProjectBinding } from "../core/types.ts";
import { FINISHED_TASK_LIMIT, TASK_HISTORY_LIMIT, VALID_TRANSITIONS } from "../core/constants.ts";
import { projectTaskMap, type ProjectionMode } from "./context-projection.ts";
import { isFinishedTaskState, sameProject, uniq, deriveProjectId } from "../core/helpers.ts";
import { recordCompletionTombstone } from "../registry/plan-completion.ts";
import { resolve } from "node:path";
import type { UltraworkRuntimeContext } from "../runtime/context-builder.ts";
import { markSessionTaskBound } from "../runtime/session-binding.ts";
import { appendAuditEntry } from "../runtime/audit-log.ts";
import { findTaskDisposition } from "../../memory/disposition.ts";

/**
 * task_state_sync tool factory。
 *
 * 維持 thin glue 角色。factory 接收 closure-scoped runtime context（含
 * `getCurrentProject` / `readRegistry` / `writeRegistry` / `updateStateMd` /
 * `validateMemoryDispositionForTask` 等），回傳 plugin tool definition。
 *
 *   `UltraworkRuntimeContext` 實例。
 */
/**
 * 組出 task 狀態機完整轉換表（由 `VALID_TRANSITIONS` 產生），
 * 加上 BLOCKED/COMPLETED/FAILED/CANCELLED 必須走專用 event 的表外規則、
 * task 沒有 resume 事件等註記，供 description 使用。
 */
function buildTaskStateMachineDescription(): string {
  const lines: string[] = [];
  lines.push("更新任務狀態與 tasks.json；也可查詢、建立、完成、取消、失敗或暫停任務。");
  lines.push("");
  lines.push("狀態機（合法轉換；終態後不可再轉換）：");
  for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
    lines.push(`  ${from} → ${targets.length ? targets.join(" / ") : "（終態，無轉換）"}`);
  }
  lines.push("");
  lines.push("表外規則：");
  lines.push("  · BLOCKED / COMPLETED / FAILED / CANCELLED 都必須走專用 event，不能用 transition。");
  lines.push("    - 走到 BLOCKED → 改用 event:\"block\"，並填 reason。");
  lines.push("    - 走到 COMPLETED → 改用 event:\"complete\"，先用 memory-task-close 記錄處置，且任務必須在 ARCHIVING。");
  lines.push("    - 走到 FAILED → 改用 event:\"fail\"，並填 reason。");
  lines.push("    - 走到 CANCELLED → 改用 event:\"cancel\"，並填 reason。");
  lines.push("  · 任務沒有 resume 事件；ARCHIVING 之後只能走 complete / fail / cancel。");
  lines.push("  · BLOCKED 不會自動解除：必須由主代理明確用 transition，從 BLOCKED → IN_PROGRESS（此 transition 本身不要求 reason）。");
  lines.push("");
  lines.push("風險申報與獨立審查：");
  lines.push("  · 建立任務時，如果說得出這件事壞掉會怎樣，就用 risk:\"high\" 申報高風險；做到一半才發現的，可以在 transition 補報。");
  lines.push("  · 只認 \"high\" 這一個值，而且申報之後不能撤回，也沒有降級的事件。");
  lines.push("  · 申報為高風險的任務，結案前一定要有獨立審查紀錄：任務走到 REVIEWING 之後，用 event:\"review\" 記下審查結論。");
  lines.push("    - review 在 REVIEWING 或 ARCHIVING 都能記；ARCHIVING 是救援用的例外，修回卡在裡面又缺審查的舊資料，正常流程請在 REVIEWING 送審。");
  lines.push("    - 三種結論：approve（同意）、concerns（有疑慮）、reject（不同意），對應 agents/momus.md 的審查結論。");
  lines.push("    - 結論是 concerns 的時候要用 note 寫清楚怎麼處置。");
  lines.push("    - 同意和有疑慮都可以結案，不同意會被擋下；重審以最新一次為準。");
  lines.push("  · 沒審查就轉到 ARCHIVING 會被直接擋下（REVIEW_REQUIRED），不會讓任務先卡進 ARCHIVING 才發現審查沒過——ARCHIVING 之後沒有回 REVIEWING 的路，卡進去就只能放棄。");
  lines.push("  · 低風險任務完全不受這一段影響。");
  lines.push("");
  lines.push("驗收條件：");
  lines.push("  · 任務如果填了 acceptanceCriteria，結案時要用 acceptance 逐項回報：criterion 與任務上的條件逐字相同，met 說明達成與否，evidence 寫憑什麼這樣說。");
  lines.push("  · 每一項都要回報，而且都要 met:true 才能結案；漏報或有未達成會被擋下（ACCEPTANCE_REQUIRED）。");
  lines.push("  · 真的做不到就不要硬結案，改用 fail 或 cancel 並寫清楚原因。");
  lines.push("  · 沒填 acceptanceCriteria 的任務不受這一段影響。");
  return lines.join("\n");
}

export function createTaskStateSyncTool(runtime: UltraworkRuntimeContext) {
  return defineTool({
    name: "task-state-sync",
    description: buildTaskStateMachineDescription(),
    inputSchema: z.object({
      event: z.enum(["create", "transition", "complete", "cancel", "fail", "block", "review", "status"]),
      taskId: z.string().optional(),
      title: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      owner: z.string().optional(),
      priority: z.string().optional(),
      reason: z.string().optional(),
      projectId: z.string().optional(),
      projectPath: z.string().optional(),
      risk: z.string().optional(),
      verdict: z.string().optional(),
      reviewer: z.string().optional(),
      note: z.string().optional(),
      acceptance: z
        .array(
          z.object({
            criterion: z.string(),
            met: z.boolean(),
            evidence: z.string().optional(),
          }),
        )
        .optional()
        .describe(
          '只作用於 event:"complete"。任務有驗收條件時必填：逐項回報每一條的結論，criterion 要與任務上的條件逐字相同。',
        ),
      verbose: z.boolean().optional().describe(
        '只作用於 event:"status"。預設回投影：任務一筆不少，但不含 history 與每筆重複的專案身分。要稽核 transition 紀錄或除錯時才傳 true。',
      ),
    }),
    async execute({ event, taskId, title, from, to, owner, priority, reason, projectId, projectPath, risk, verdict, reviewer, note, acceptance, verbose }, context) {
      const currentProject = runtime.getCurrentProject(context);
      // 只認 "high"：申報制的整個強制力來自「不能撤回」，所以這裡不做等級比較，
      // 也不提供任何把 high 清掉的路徑。
      const declaredHighRisk = risk?.trim() === "high";
      // 成功路徑上的提醒，不影響 ok / code；沒有提醒時不會出現在回傳裡。
      const warnings: string[] = [];
      /** 寫一筆稽核紀錄；失敗就把這件事講出來，不靜默吞掉。 */
      const audit = (entry: Parameters<typeof appendAuditEntry>[1]) => {
        if (!appendAuditEntry(runtime, entry, context)) {
          warnings.push("稽核紀錄寫入失敗，這一次的高風險任務動作沒有留下長期紀錄，請檢查 .ultrawork 是否可寫。");
        }
      };
      /**
       * 高風險任務的審查是否過關：非高風險恆為 true；高風險則要求
       * approve 或 concerns 的結論，reject 或沒有紀錄都不算過關。
       *
       * 兩處共用同一份判斷：REVIEWING → ARCHIVING 的轉換閘門（主要防線，
       * 讓沒審查的任務進不了 ARCHIVING，不會卡在裡面出不來——ARCHIVING
       * 唯一能走的路是 COMPLETED / FAILED / CANCELLED，一旦沒審查就卡進去，
       * 既沒有回 REVIEWING 補審查的路，也過不了 complete）與 complete 的
       * 防禦線（涵蓋任務跳過 ARCHIVING、直接從其他狀態呼叫 complete 的情況）。
       */
      const isReviewOk = (t: Task): boolean =>
        t.risk !== "high" || (!!t.review && (t.review.verdict === "approve" || t.review.verdict === "concerns"));
      /** 審查缺項的說明文字，兩處共用同一套措辭。 */
      const reviewBlockedMessage = (t: Task): string =>
        t.review
          ? `這個任務申報為高風險，而目前的審查結論是 ${t.review.verdict}（不同意），不能結案；改完之後回 REVIEWING 重新送審。`
          : "這個任務申報為高風險，結案前必須有獨立審查紀錄；先走到 REVIEWING，再用 event:\"review\" 記下審查結論。";
      /**
       * 驗收檢查：任務自己填的驗收條件，結案時必須逐項交代。
       *
       * 沒填驗收條件的任務完全不受影響（`criteria.length === 0` 直接通過）。
       * 這是刻意的：這個閘門要擋的是「填了條件卻沒人檢查」，不是強迫每個
       * 任務都先寫驗收條件，否則一上線就會把既有任務全部卡住。
       *
       * 為什麼擋在 `complete` 而不是像審查那樣擋在 ARCHIVING 之前：審查要
       * 跑一整輪獨立審查，卡在 ARCHIVING 就等於沒有補救的路；驗收回報是
       * 呼叫端當下就給得出來的參數，被擋下之後補一次參數再送就好，不會
       * 卡死，所以不需要提前到 ARCHIVING。
       */
      const checkAcceptance = (t: Task): { ok: true } | { ok: false; message: string } => {
        const criteria = (t.acceptanceCriteria || []).map((c) => c.trim()).filter(Boolean);
        if (criteria.length === 0) return { ok: true };
        const reported = new Map<string, { met: boolean; evidence?: string }>();
        for (const item of acceptance || []) {
          const criterion = String(item?.criterion || "").trim();
          if (criterion) reported.set(criterion, { met: item?.met === true, evidence: item?.evidence });
        }
        const missing = criteria.filter((c) => !reported.has(c));
        if (missing.length > 0) {
          return {
            ok: false,
            message: `這個任務有 ${criteria.length} 項驗收條件，結案時要逐項回報。還沒回報的：${missing.join("、")}。用 acceptance 參數帶上每一項的 criterion（逐字相同）、met 與證據。`,
          };
        }
        const unmet = criteria.filter((c) => !reported.get(c)!.met);
        if (unmet.length > 0) {
          return {
            ok: false,
            message: `這幾項驗收條件回報為未達成：${unmet.join("、")}。沒達成就不能當成完成——把它做到，或改用 fail / cancel 並寫清楚原因。`,
          };
        }
        return { ok: true };
      };

      // status branch: strict read-only, no side-effects (no lazyEnsure)
      // write branches: create/init via readRegistry(context, true)
      const timestamp = new Date().toISOString();

      if (projectId || projectPath) {
        const requestedProjectPath = projectPath ? resolve(projectPath) : currentProject.projectPath;
        const requestedProject: ProjectBinding = {
          projectId: projectId?.trim() || deriveProjectId(requestedProjectPath),
          projectPath: requestedProjectPath,
        };
        if (!sameProject(requestedProject, currentProject)) {
          return jsonResult({ ok: false, code: "CROSS_PROJECT", error: `跨專案的任務操作被擋下。目前的專案是 ${currentProject.projectId}（${currentProject.projectPath}）。` });
        }
      }

      if (event === "status") {
        // 預設回投影：任務一筆不少，但拿掉 history 與每筆重複的專案身分。
        // 稽核／除錯要完整資料時傳 `verbose: true`。執行期閘門一律直接讀
        // 正式 registry，不依賴這裡的輸出。見 ./context-projection.ts。
        const registry = runtime.readRegistry(context, false);
        const projection: ProjectionMode = verbose === true ? "full" : "summary";
        const viewRegistry = projection === "full"
          ? registry
          : { ...registry, tasks: projectTaskMap(registry.tasks) };
        return jsonResult({
          ok: true,
          registry: viewRegistry,
          project: currentProject,
          finishedTaskLimit: FINISHED_TASK_LIMIT,
          projection,
        });
      }
      if (!taskId) return jsonResult({ ok: false, code: "TASK_ID_REQUIRED", error: "這個操作需要 taskId" });
      const result = await runtime.transactRegistries(context, async ({ tasks: registry, plans: plansRegistry }, control) => {
      let task: Task | undefined = registry.tasks[taskId];

      if (task && !sameProject(task, currentProject)) {
        return jsonResult({ ok: false, code: "CROSS_PROJECT", error: `跨專案的任務操作被擋下：${taskId} 屬於 ${task.projectId}（${task.projectPath}）。` });
      }

      if (event === "create") {
        if (task) return jsonResult({ ok: false, code: "TASK_ALREADY_EXISTS", error: `任務 ${taskId} 已經存在` });
        if (!title?.trim()) return jsonResult({ ok: false, code: "TITLE_REQUIRED", error: "建立任務需要 title" });
        if (!to) return jsonResult({ ok: false, code: "INITIAL_STATE_REQUIRED", error: "建立任務需要 to（初始狀態）" });
        if (to !== "NEW") return jsonResult({ ok: false, code: "INVALID_INITIAL_STATE", error: "任務建立時的初始狀態只能是 NEW" });
        if (!owner) return jsonResult({ ok: false, code: "OWNER_REQUIRED", error: "建立任務需要 owner" });
        if (!priority) return jsonResult({ ok: false, code: "PRIORITY_REQUIRED", error: "建立任務需要 priority" });
        const newTask: Task = {
          taskId,
          projectId: currentProject.projectId,
          projectPath: currentProject.projectPath,
          title: title.trim(),
          state: "NEW",
          owner,
          priority,
          updatedAt: timestamp,
          history: [`| ${timestamp} | (NEW) → NEW | ${owner} | 建立任務${declaredHighRisk ? "（申報為高風險）" : ""} |`].slice(-TASK_HISTORY_LIMIT),
          ...(declaredHighRisk ? { risk: "high" as const } : {}),
        };
        registry.tasks[taskId] = newTask;
        task = newTask;
        if (declaredHighRisk) {
          audit({ event: "risk-declared", taskId, projectId: currentProject.projectId, actor: owner, phase: "create" });
        }
        registry.activeTaskIds = uniq([...registry.activeTaskIds, taskId]);
        registry.taskCursor = taskId;
      } else if (event === "transition") {
        // 必修檢查: task exists, from, to
        if (!task) return jsonResult({ ok: false, code: "TASK_NOT_FOUND", error: `找不到任務 ${taskId}` });
        if (!from) return jsonResult({ ok: false, code: "TRANSITION_STATE_REQUIRED", error: "狀態轉換需要 from" });
        if (!to) return jsonResult({ ok: false, code: "TRANSITION_STATE_REQUIRED", error: "狀態轉換需要 to" });
        // STATE_MISMATCH 同時帶上合法目標清單（由目前狀態查 VALID_TRANSITIONS）。
        const allowedFromState = VALID_TRANSITIONS[task.state] || [];
        const allowedLabel = allowedFromState.length
          ? `可以轉到：${allowedFromState.join(", ")}。`
          : "目前狀態無合法轉換，必須走專用 event。";
        if (task.state !== from) {
          return jsonResult({
            ok: false,
            code: "STATE_MISMATCH",
            error: `任務目前的狀態是「${task.state}」，但 from 指定的是「${from}」，對不上。${allowedLabel}`,
          });
        }
        if (isFinishedTaskState(task.state)) {
          return jsonResult({ ok: false, code: "TERMINAL_STATE_CONFLICT", error: `任務已經在終態 ${task.state}，不能再轉換` });
        }
        // dedicated event 檢查：先看目標狀態是否可從目前狀態到達。
        // 不可達 → INVALID_TRANSITION（順帶給合法清單）；可達 → DEDICATED_EVENT_REQUIRED
        // 並帶上對應 event 名 + 需要的參數。
        if (["BLOCKED", "COMPLETED", "FAILED", "CANCELLED"].includes(to)) {
          if (!allowedFromState.includes(to)) {
            return jsonResult({
              ok: false,
              code: "INVALID_TRANSITION",
              error: `不允許的轉換：${from} → ${to}。${allowedLabel}`,
            });
          }
          const hint = to === "BLOCKED"
            ? `改用 event:"block"，並填 reason 才能轉到 BLOCKED。`
            : to === "COMPLETED"
              ? `改用 event:"complete"，先用 memory-task-close 記錄處置，且任務必須在 ARCHIVING。`
              : to === "FAILED"
                ? `改用 event:"fail"，並填 reason 才能標記為 FAILED。`
                : `改用 event:"cancel"，並填 reason 才能取消任務。`;
          return jsonResult({
            ok: false,
            code: "DEDICATED_EVENT_REQUIRED",
            error: `要轉到 ${to} 得用 task-state-sync 對應的專用 event（${hint}）`,
          });
        }
        const allowed = VALID_TRANSITIONS[from] || [];
        if (!allowed.includes(to)) return jsonResult({ ok: false, code: "INVALID_TRANSITION", error: `不允許的轉換：${from} → ${to}。${allowedLabel}` });
        // 中途補報高風險（升級）。沒有對應的降級分支是刻意的：
        // 允許降級等於在結案前一步開了一道把閘門關掉的後門。
        const upgradedRisk = declaredHighRisk && task.risk !== "high";
        if (upgradedRisk) task.risk = "high";
        // 降級企圖在狀態機裡是靜默忽略的，不記下來就完全查不到。
        const attemptedDowngrade = !!risk?.trim() && !declaredHighRisk && task.risk === "high";
        if (attemptedDowngrade) {
          audit({
            event: "risk-downgrade-blocked",
            taskId,
            projectId: currentProject.projectId,
            actor: owner,
            requestedRisk: risk?.trim(),
          });
        }
        if (upgradedRisk) {
          audit({ event: "risk-declared", taskId, projectId: currentProject.projectId, actor: owner, phase: "transition" });
        }
        // 審過之後退回去改，舊的審查結論就對不上現在的程式碼了。
        // 這裡只打標記，結案時據此提醒，不擋。
        if (to === "IN_PROGRESS" && from === "REVIEWING" && task.review) {
          task.review = { ...task.review, reworkedAfterReview: true };
        }
        // 高風險任務的主要防線：擋在進 ARCHIVING 之前，而不是等進去了才在
        // complete 發現。ARCHIVING 只能走向 COMPLETED / FAILED / CANCELLED，
        // 沒有回 REVIEWING 的路——沒審查就放行進去，等於把任務鎖死在裡面，
        // 唯一的出路是拿 fail/cancel 放棄掉，不能補審查也不能結案。
        if (to === "ARCHIVING" && !isReviewOk(task)) {
          return jsonResult({ ok: false, code: "REVIEW_REQUIRED", blockedBy: ["review"], error: reviewBlockedMessage(task) });
        }
        task.state = to;
        if (to === "ARCHIVING") task.archivingAt = timestamp;
        task.updatedAt = timestamp;
        task.history.push(`| ${timestamp} | ${from} → ${to} | ${owner || "—"} | 狀態轉換${upgradedRisk ? "（補報為高風險）" : ""} |`);
        task.history = task.history.slice(-TASK_HISTORY_LIMIT);
        registry.activeTaskIds = uniq([...registry.activeTaskIds, taskId]);
        //  — 父 Plan auto-promotion：
        // task 進 IN_PROGRESS 時，若所屬 plan.state === "PLANNED"，自動升級為
        // IN_PROGRESS。BLOCKED 不自動解除。
        if (to === "IN_PROGRESS" && task.planId) {
          const planToPromote = plansRegistry.plans[task.planId];
          if (planToPromote && sameProject(planToPromote, currentProject) && planToPromote.state === "PLANNED") {
            const nowIso = new Date().toISOString();
            planToPromote.state = "IN_PROGRESS";
            planToPromote.updatedAt = nowIso;
            planToPromote.history = Array.isArray(planToPromote.history) ? planToPromote.history : [];
            planToPromote.history.push(`| ${nowIso} | PLANNED → IN_PROGRESS | ${owner || "—"} | 關聯任務進入 IN_PROGRESS，計畫自動升級 |`);
            planToPromote.history = planToPromote.history.slice(-3);
          }
        }
      } else if (event === "review") {
        if (!task) return jsonResult({ ok: false, code: "TASK_NOT_FOUND", error: `找不到任務 ${taskId}` });
        // REVIEWING 是正常送審的狀態；ARCHIVING 是救援用的例外——正常路徑下
        // 進不了 ARCHIVING 的任務不會缺審查，但舊版程式碼（v4.2 以前，
        // 閘門只設在 complete）留下的任務資料可能已經卡在 ARCHIVING 又沒有
        // 審查紀錄。那種任務沒有回 REVIEWING 的路，如果 review 只認
        // REVIEWING，就會連官方補救的管道都沒有，逼人去手改 tasks.json。
        // 所以這裡放寬成兩個狀態都接受；不接受任何其他狀態。
        if (task.state !== "REVIEWING" && task.state !== "ARCHIVING") {
          return jsonResult({
            ok: false,
            code: "INVALID_TRANSITION",
            error: `任務目前的狀態是「${task.state}」，要在 REVIEWING 或 ARCHIVING 才能記下審查結論。`,
          });
        }
        const conclusion = verdict?.trim();
        if (conclusion !== "approve" && conclusion !== "concerns" && conclusion !== "reject") {
          return jsonResult({
            ok: false,
            code: "REVIEW_VERDICT_INVALID",
            error: "審查結論只能填 approve（同意）、concerns（有疑慮）或 reject（不同意）。",
          });
        }
        // 「有疑慮」在 agents/momus.md「審查結論」的定義是「主代理必須逐項處置之後再決定怎麼走」，
        // 它能通過結案閘門，所以處置說明一定要留在紀錄裡，否則等於無條件放行。
        if (conclusion === "concerns" && !note?.trim()) {
          return jsonResult({
            ok: false,
            code: "REVIEW_NOTE_REQUIRED",
            error: "審查結論是 concerns（有疑慮）的時候，要用 note 寫下每一項要怎麼處置。",
          });
        }
        const trimmedNote = note?.trim();
        // 重審以最新一次為準：被退回、改完再送審是正常流程，覆寫比拒絕合理。
        task.review = {
          verdict: conclusion,
          reviewer: reviewer?.trim() || owner?.trim() || "—",
          reviewedAt: timestamp,
          reviewedStateUpdatedAt: task.updatedAt,
          ...(trimmedNote ? { note: trimmedNote } : {}),
        };
        task.updatedAt = timestamp;
        task.history.push(`| ${timestamp} | ${task.state}（審查） | ${task.review.reviewer} | 審查結論：${conclusion}${trimmedNote ? `｜${trimmedNote}` : ""} |`);
        task.history = task.history.slice(-TASK_HISTORY_LIMIT);
        // 每一次審查都記，包含被退回與後續重審——被退回過這件事本身就是證據。
        audit({
          event: "review",
          taskId,
          projectId: currentProject.projectId,
          actor: owner,
          verdict: conclusion,
          reviewer: task.review.reviewer,
          ...(trimmedNote ? { note: trimmedNote } : {}),
        });
      } else if (event === "complete") {
        if (!task) return jsonResult({ ok: false, code: "TASK_NOT_FOUND", error: `找不到任務 ${taskId}` });
        if (task.state === "COMPLETED") return jsonResult({ ok: true, taskId, state: "COMPLETED", updatedAt: timestamp, message: "任務已經完成" });
        if (isFinishedTaskState(task.state)) {
          return jsonResult({ ok: false, code: "TERMINAL_STATE_CONFLICT", error: `任務已經在終態 ${task.state}，不能再完成` });
        }
        // 合併狀態與記憶處置檢查：兩個問題同時存在時一次回報，
        // 避免模型先白做一次記憶處置才被告知狀態不對。
        const prevState = task.state;
        const allowed = VALID_TRANSITIONS[prevState] || [];
        const stateOk = allowed.includes("COMPLETED");
        // 這裡只看「有沒有處置」，讓它能跟其他缺項一起回報；完整驗證在合併檢查通過之後。
        // 記憶路徑讀不到（unsafe root、symlink）一律當成沒有處置，不讓工具拋例外。
        const hasDisposition = (): boolean => {
          try {
            return !!findTaskDisposition(runtime.resolveProjectRoot(context), taskId);
          } catch {
            return false;
          }
        };
        const memoryOk = !runtime.memoryDispositionRequired || hasDisposition();
        if (!runtime.memoryDispositionRequired) {
          warnings.push("memory 模組或結案政策未啟用，已略過記憶處置檢查。");
        }
        // 這裡是防禦線，不是主要防線：正常路徑下，沒審查過關的高風險任務在
        // REVIEWING → ARCHIVING 那一步就已經被擋下了，走不到這裡。留著是為了
        // 涵蓋任務跳過 ARCHIVING、直接從其他狀態呼叫 complete 的情況——那種
        // 情況 stateOk 也會是 false，兩個問題會一起列出來。
        const reviewOk = isReviewOk(task);
        const acceptanceCheck = checkAcceptance(task);
        if (!stateOk || !memoryOk || !reviewOk || !acceptanceCheck.ok) {
          const issues: string[] = [];
          if (!stateOk) {
            issues.push(`任務目前狀態 ${prevState}（不是 ARCHIVING），先走到 ARCHIVING 才能完成。`);
          }
          if (!memoryOk) {
            issues.push("task-state-sync 的 complete 需要 memory-task-close 的記憶處置。");
          }
          if (!reviewOk) {
            issues.push(reviewBlockedMessage(task));
          }
          if (!acceptanceCheck.ok) {
            issues.push(acceptanceCheck.message);
          }
          // 優先序：審查 → 驗收 → 記憶處置 → 狀態。愈難補的排愈前面，主代理
          // 才不會把便宜的都補完了才發現真正的障礙。驗收排在記憶處置之前，
          // 是因為「條件沒達成」代表工作還沒做完，補記憶處置沒有意義。
          // 低風險任務的 reviewOk 恆為 true、沒填驗收條件的 acceptanceCheck
          // 恆為 ok，所以既有情境仍然落在原本的錯誤碼上。
          const primaryCode = !reviewOk
            ? "REVIEW_REQUIRED"
            : (!acceptanceCheck.ok
              ? "ACCEPTANCE_REQUIRED"
              : (!memoryOk ? "MEMORY_DISPOSITION_REQUIRED" : "INVALID_TRANSITION"));
          // 結構化缺項：呼叫端不必解析訊息文字就知道還差哪幾項。
          const blockedBy: string[] = [];
          if (!reviewOk) blockedBy.push("review");
          if (!acceptanceCheck.ok) blockedBy.push("acceptance");
          if (!memoryOk) blockedBy.push("memory");
          if (!stateOk) blockedBy.push("state");
          return jsonResult({ ok: false, code: primaryCode, blockedBy, error: issues.join(" ") });
        }
        // 審過之後又退回去改，舊結論審的是舊程式碼。只提醒，不擋。
        if (task.review?.reworkedAfterReview) {
          warnings.push("這個任務在審查通過之後又退回去改過，目前的審查結論對應的是修改前的版本，建議重新送審。");
        }
        let memoryDisposition: { outcome: string | undefined; seq: number } | undefined;
        if (runtime.memoryDispositionRequired) {
          const validation = runtime.validateMemoryDispositionForTask(task, currentProject, context);
          if (!validation.ok) return jsonResult(validation);
          memoryDisposition = { outcome: validation.disposition.outcome, seq: validation.disposition.seq };
        }
        const commentSignalCheck = await runtime.validateCommentSignalForCompletion(context?.sessionID);
        if (!commentSignalCheck.ok) return jsonResult(commentSignalCheck);
        if (commentSignalCheck.status === "disabled") {
          warnings.push("Comment Signal 模組未啟用，已略過註解必要檢查。");
        }
        // 驗收結論留在任務上：條件本身之後可能被改，這份紀錄保留的是結案
        // 當下那一版，讓「當時憑什麼算完成」查得到。
        const acceptedCriteria = (task.acceptanceCriteria || []).map((c) => c.trim()).filter(Boolean);
        if (acceptedCriteria.length > 0) {
          const reported = new Map((acceptance || []).map((item) => [String(item?.criterion || "").trim(), item]));
          task.acceptanceResults = {
            recordedAt: timestamp,
            recordedBy: owner?.trim() || task.owner || "—",
            items: acceptedCriteria.map((criterion) => {
              const item = reported.get(criterion);
              const evidence = typeof item?.evidence === "string" ? item.evidence.trim() : "";
              return { criterion, met: true, ...(evidence ? { evidence } : {}) };
            }),
          };
        }
        task.state = "COMPLETED";
        task.updatedAt = timestamp;
        task.history.push(`| ${timestamp} | ${prevState} → COMPLETED | ${owner || "—"} | 完成任務 | memory=${memoryDisposition ? `${memoryDisposition.outcome}#${memoryDisposition.seq}` : "disabled"} |`);
        task.history = task.history.slice(-TASK_HISTORY_LIMIT);
        if (task.risk === "high") {
          audit({
            event: "terminal",
            taskId,
            projectId: currentProject.projectId,
            actor: owner,
            finalState: "COMPLETED",
            risk: task.risk,
            reviewVerdict: task.review?.verdict,
            staleReview: !!task.review?.reworkedAfterReview,
            memoryDisposition,
          });
        }
        registry.activeTaskIds = registry.activeTaskIds.filter(id => id !== taskId);
        if (registry.taskCursor === taskId) {
          registry.taskCursor = registry.activeTaskIds.length > 0 ? registry.activeTaskIds[0] : null;
        }
        //  — 終態前原子記錄 tombstone。
        if (task.planId) {
          const plan = plansRegistry.plans[task.planId];
          if (plan && sameProject(plan, currentProject)) {
            recordCompletionTombstone(plan, task.taskId, "COMPLETED", timestamp, {
              risk: task.risk,
              reviewVerdict: task.review?.verdict,
            });
            control.commit();
          }
        }
      } else if (event === "cancel" || event === "fail") {
        if (!task) return jsonResult({ ok: false, code: "TASK_NOT_FOUND", error: `找不到任務 ${taskId}` });
        const target = event === "cancel" ? "CANCELLED" : "FAILED";
        const targetLabel = event === "cancel" ? "取消" : "標記為失敗";
        if (task.state === target) {
          return jsonResult({ ok: true, taskId, state: target, updatedAt: task.updatedAt, message: `任務已經${targetLabel}` });
        }
        if (isFinishedTaskState(task.state)) {
          return jsonResult({ ok: false, code: "TERMINAL_STATE_CONFLICT", error: `任務已經在終態 ${task.state}，不能${targetLabel}` });
        }
        if (!reason?.trim()) return jsonResult({ ok: false, code: "REASON_REQUIRED", error: `${event === "cancel" ? "取消任務" : "把任務標記為失敗"}要填 reason` });
        const allowed = VALID_TRANSITIONS[task.state] || [];
        if (!allowed.includes(target)) {
          return jsonResult({ ok: false, code: "INVALID_TRANSITION", error: `不允許的轉換：${task.state} → ${target}` });
        }
        const prevState = task.state;
        task.state = target;
        task.updatedAt = timestamp;
        task.history.push(`| ${timestamp} | ${prevState} → ${target} | ${owner || "—"} | ${reason.trim()} |`);
        task.history = task.history.slice(-TASK_HISTORY_LIMIT);
        // 高風險任務改用 fail / cancel 收尾也要留痕，否則「做完不想審就標記失敗、
        // 再開一個低風險任務重做」會是一條查不到的繞道。
        if (task.risk === "high") {
          audit({
            event: "terminal",
            taskId,
            projectId: currentProject.projectId,
            actor: owner,
            finalState: target,
            risk: task.risk,
            reviewVerdict: task.review?.verdict,
            note: reason.trim(),
          });
        }
        registry.activeTaskIds = registry.activeTaskIds.filter(id => id !== taskId);
        if (registry.taskCursor === taskId) registry.taskCursor = registry.activeTaskIds[0] ?? null;
        if (task.planId) {
          const plan = plansRegistry.plans[task.planId];
          if (plan && sameProject(plan, currentProject)) {
            // cancel / fail 不擋審查，但稽核欄位照寫：否則「高風險任務做完之後
            // 改用 fail 收尾、再開一個低風險任務重做」會變成一條不留痕跡的繞道。
            recordCompletionTombstone(plan, task.taskId, target, timestamp, {
              risk: task.risk,
              reviewVerdict: task.review?.verdict,
            });
            control.commit();
          }
        }
      } else if (event === "block") {
        if (!task) return jsonResult({ ok: false, code: "TASK_NOT_FOUND", error: `找不到任務 ${taskId}` });
        if (!reason?.trim()) return jsonResult({ ok: false, code: "REASON_REQUIRED", error: "暫停任務需要填 reason" });
        const prevState = task.state;
        const allowed = VALID_TRANSITIONS[prevState] || [];
        if (!allowed.includes("BLOCKED")) {
          return jsonResult({ ok: false, code: "INVALID_TRANSITION", error: `不允許的轉換：${prevState} → BLOCKED` });
        }
        task.state = "BLOCKED";
        task.updatedAt = timestamp;
        task.history.push(`| ${timestamp} | ${prevState} → BLOCKED | ${owner || "—"} | ${reason.trim()} |`);
        task.history = task.history.slice(-TASK_HISTORY_LIMIT);
        registry.activeTaskIds = uniq([...registry.activeTaskIds, taskId]);
      } else if (event === "status") {
        return jsonResult({ ok: true, registry });
      }
      control.commit();
      const planSnapshot = readPlanSnapshot(runtime, task, currentProject, context);
      return jsonResult({
        ok: true,
        taskId,
        state: task?.state,
        title: task?.title,
        ...(planSnapshot ? { plan: planSnapshot } : {}),
        updatedAt: timestamp,
        project: currentProject,
        finishedTaskLimit: FINISHED_TASK_LIMIT,
        ...(warnings.length ? { warnings } : {}),
      });
      });
      await markSessionTaskBound(context?.sessionID, taskId);
      await runtime.updateStateMd(runtime.readRegistry(context), context);
      return result;
    }
  });
}

/**
 * 所屬計畫的尾端快照。
 *
 * 為什麼存在：系統提示裡的 `cursor_plan` 已經移除（它會 churn 掉整串對話的
 * prompt cache，見 `registry-hooks.ts` 的 `createChatSystemTransformHook`），
 * 但它帶的資訊仍然要讓模型看得到。這個 helper 把同樣的三個欄位放進
 * `task-state-sync` 寫入分支的回傳值，也就是對話尾端。
 *
 * 規則：
 *   - 任務沒有 `planId`、計畫查不到、或計畫屬於別的專案時回傳 `null`
 *     （呼叫端據此省略 `plan` 欄位，不輸出空物件）。
 *   - 讀不到 plans registry 一律當成沒有計畫：狀態同步不該因為附帶資訊
 *     失敗而失敗。
 *   - 只取 `planId` / `state` / `title` 三個欄位，與原本 `cursor_plan` 一致；
 *     不要順手把 `history` 之類的稽核欄位帶進對話。
 */
function readPlanSnapshot(
  runtime: UltraworkRuntimeContext,
  task: Task | undefined,
  currentProject: ProjectBinding,
  context?: ToolContext,
): { planId: string; state: string; title: string } | null {
  const planId = task?.planId?.trim();
  if (!planId) return null;
  try {
    const plansReg = runtime.readPlansRegistry(context, false);
    const plan = plansReg.plans[planId];
    if (!plan || !sameProject(plan, currentProject)) return null;
    return { planId: plan.planId, state: plan.state, title: plan.title || "Untitled" };
  } catch {
    return null;
  }
}

/**
 * 父 Plan auto-promotion。
 *
 * 規則：
 *   - 當 task 進 IN_PROGRESS 時，若所屬 plan.state === "PLANNED"，自動升級為 IN_PROGRESS。
 *   - BLOCKED 狀態**不**自動解除（必須由主代理顯式 unblock）。
 *   - cross-plan / missing plan / already-IN_PROGRESS / terminal plan 皆 no-op。
 *
 * 回傳更新後的 plans draft，由呼叫端與 tasks draft 一起提交交易。
 */
async function promotePlanToInProgressIfPlanned(
  runtime: UltraworkRuntimeContext,
  planId: string,
  currentProject: ProjectBinding,
  owner: string,
  context?: ToolContext,
): Promise<PlansRegistry | null> {
  try {
    const plansReg = runtime.readPlansRegistry(context, false);
    const plan = plansReg.plans[planId];
    if (!plan) return null;
    if (!sameProject(plan, currentProject)) return null;
    if (plan.state !== "PLANNED") return null;
    const nowIso = new Date().toISOString();
    plan.state = "IN_PROGRESS";
    plan.updatedAt = nowIso;
    plan.history = Array.isArray(plan.history) ? plan.history : [];
    plan.history.push(`| ${nowIso} | PLANNED → IN_PROGRESS | ${owner} | 關聯任務進入 IN_PROGRESS，計畫自動升級 |`);
    plan.history = plan.history.slice(-3);
    return plansReg;
  } catch {
    // best-effort；auto-promotion 失敗不應阻斷 task transition
    return null;
  }
}
