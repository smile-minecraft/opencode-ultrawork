import { jsonResult } from "../../../kit/json.ts";
/**
 * opencode-ultrawork — plan-state-sync tool factory
 *
 * 角色：
 *   - 對應 專案記憶 plan state machine（DRAFT → CLARIFYING → PLANNED → IN_PROGRESS
 *     → BLOCKED / REVIEWING / ARCHIVING → COMPLETED / CANCELLED）。
 *   - 每個 event 分支皆同步 plans.json + state.md（透過 `updateStateMd` 拉
 *     latest task registry snapshot）。
 *
 * 對外規則（不可破壞）：
 *   - factory 簽名：`createPlanStateSyncTool(runtime)`。
 *   - tool name：`plan-state-sync`。
 *   - `args` schema 保留既有欄位，並以專用 event 管理障礙與終態。
 *   - event `create` 必填 planId / title；plan 已存在時回 `ok:false`。
 *   - 其餘 event（transition / complete / cancel / fail / block）若 plan 缺失回 `ok:false`。
 *   - 錯誤訊息（`error`）是給人讀的台灣繁中，可以改寫；機器要判讀的是 `code`
 *     欄位，每個失敗分支都帶一個：`PLAN_ID_REQUIRED` / `TITLE_REQUIRED` /
 *     `PLAN_ALREADY_EXISTS` / `PLAN_NOT_FOUND` / `INVALID_INITIAL_STATE` /
 *     `TRANSITION_STATE_REQUIRED` / `STATE_MISMATCH` / `TERMINAL_STATE_CONFLICT` /
 *     `DEDICATED_EVENT_REQUIRED` / `INVALID_TRANSITION` / `ACTIVE_LINKED_TASKS` /
 *     `REASON_REQUIRED` / `CROSS_PROJECT` / `UNKNOWN_EVENT`。這些值不可改。
 *   - state machine 透過 `VALID_PLAN_TRANSITIONS[prevState]` 控管，
 *     ARCHIVING → COMPLETED 為唯一允許的 complete 路徑；finished 狀態不可改寫，
 *     僅允許相同專用 event 冪等重送。
 *
 * 限制：
 *   - 所有 IO 透過注入的 `UltraworkRuntimeContext`。
 *
 * @see ../../../../README.md                                     — 模組一覽
 * @see ../runtime/context-builder.ts                              — runtime 介面
 */

import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../../kit/define-tool.ts";
type ToolContext = ToolExecutionContext;
import type { Plan } from "../core/types.ts";
import { PLAN_HISTORY_LIMIT, VALID_PLAN_TRANSITIONS } from "../core/constants.ts";
import { sameProject, isFinishedPlanState, uniq, deriveProjectId } from "../core/helpers.ts";
import { findActiveLinkedTaskIds } from "../registry/plan-completion.ts";
import { resolve } from "node:path";
import type { UltraworkRuntimeContext } from "../runtime/context-builder.ts";

/**
 * 組出 plan 狀態機完整轉換表（由 `VALID_PLAN_TRANSITIONS` 產生），
 * 加上 BLOCKED/COMPLETED/FAILED/CANCELLED 必須走專用 event、resume 繞表、
 * REVIEWING→ARCHIVING 與 complete/cancel/fail 會被進行中關聯任務擋下等表外規則。
 */
function buildPlanStateMachineDescription(): string {
  const lines: string[] = [];
  lines.push("更新計畫狀態與 plans.json；支援建立、轉換、完成、取消、失敗、暫停、復原（resume）和查詢。");
  lines.push("");
  lines.push("狀態機（合法轉換；終態後不可再轉換）：");
  for (const [from, targets] of Object.entries(VALID_PLAN_TRANSITIONS)) {
    lines.push(`  ${from} → ${targets.length ? targets.join(" / ") : "（終態，無轉換）"}`);
  }
  lines.push("");
  lines.push("表外規則：");
  lines.push("  · BLOCKED / COMPLETED / FAILED / CANCELLED 都必須走專用 event，不能用 transition。");
  lines.push("    - 走到 BLOCKED → 改用 event:\"block\"，並填 reason。");
  lines.push("    - 走到 COMPLETED → 改用 event:\"complete\"（無需額外參數）。");
  lines.push("    - 走到 FAILED → 改用 event:\"fail\"，並填 reason。");
  lines.push("    - 走到 CANCELLED → 改用 event:\"cancel\"，並填 reason。");
  lines.push("  · resume 是 ARCHIVING → IN_PROGRESS，繞過轉換表；必須填 reason。");
  lines.push("  · REVIEWING → ARCHIVING、complete、cancel、fail 都會被進行中的關聯任務擋下（ACTIVE_LINKED_TASKS），先把任務做完或解除關聯。");
  return lines.join("\n");
}

/**
 * plan_state_sync tool factory。
 *
 *   `UltraworkRuntimeContext` 實例。
 */
export function createPlanStateSyncTool(runtime: UltraworkRuntimeContext) {
  return defineTool({
    name: "plan-state-sync",
    description: buildPlanStateMachineDescription(),
    inputSchema: z.object({
      event: z.enum(["create", "transition", "complete", "cancel", "fail", "block", "status", "resume"]),
      planId: z.string().optional(),
      title: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      owner: z.string().optional(),
      priority: z.string().optional(),
      reason: z.string().optional(),
      projectId: z.string().optional(),
      projectPath: z.string().optional(),
    }),
    async execute({ event, planId, title, from, to, owner, priority, reason, projectId, projectPath }, context) {
      const currentProject = runtime.getCurrentProject(context);
      const timestamp = new Date().toISOString();
      if (event === "status") {
        const registry = runtime.readPlansRegistry(context, false);
        return jsonResult({ ok: true, registry }, null, 2);
      }
      const result = await runtime.transactRegistries(context, ({ tasks: taskRegistry, plans: registry }, control) => {

      if (projectId || projectPath) {
        const requestedProjectPath = projectPath ? resolve(projectPath) : currentProject.projectPath;
        const requestedProject = {
          projectId: projectId?.trim() || deriveProjectId(requestedProjectPath),
          projectPath: requestedProjectPath,
        };
        if (!sameProject(requestedProject, currentProject)) {
          return jsonResult({ ok: false, code: "CROSS_PROJECT", error: `跨專案的計畫操作被擋下。目前的專案是 ${currentProject.projectId}（${currentProject.projectPath}）。` });
        }
      }

      const plan = planId ? registry.plans[planId] : null;

      if (event === "create") {
        if (!planId) return jsonResult({ ok: false, code: "PLAN_ID_REQUIRED", error: "建立計畫需要 planId" });
        if (!title?.trim()) return jsonResult({ ok: false, code: "TITLE_REQUIRED", error: "建立計畫需要 title" });
        if (plan) return jsonResult({ ok: false, code: "PLAN_ALREADY_EXISTS", error: `計畫 ${planId} 已經存在` });
        if (to && to !== "DRAFT") {
          return jsonResult({ ok: false, code: "INVALID_INITIAL_STATE", error: "計畫建立時的初始狀態只能是 DRAFT" });
        }
        const newPlan: Plan = {
          planId,
          projectId: currentProject.projectId,
          projectPath: currentProject.projectPath,
          title: title.trim(),
          state: "DRAFT",
          owner: owner || "—",
          priority: priority || "—",
          createdAt: timestamp,
          updatedAt: timestamp,
          taskIds: [],
          finishedTaskIds: [],
          dependencyGraph: { nodes: [], edges: [] },
          history: [`| ${timestamp} | (NEW) → DRAFT | ${owner || "—"} | 建立 Plan |`].slice(-PLAN_HISTORY_LIMIT),
        };
        registry.plans[planId] = newPlan;
        registry.activePlanIds = uniq([...registry.activePlanIds, planId]);
        registry.planCursor = planId;
        control.commit();
        return jsonResult({ ok: true, planId, state: newPlan.state, createdAt: timestamp, project: currentProject }, null, 2);
      }

      if (!plan) return jsonResult({ ok: false, code: "PLAN_NOT_FOUND", error: `找不到計畫 ${planId}` });
      const prevState = plan.state;

      if (event === "transition") {
        if (!from) return jsonResult({ ok: false, code: "TRANSITION_STATE_REQUIRED", error: "狀態轉換需要 from" });
        if (!to) return jsonResult({ ok: false, code: "TRANSITION_STATE_REQUIRED", error: "狀態轉換需要 to" });
        // STATE_MISMATCH 同時帶上合法目標清單（由目前狀態查 VALID_PLAN_TRANSITIONS）。
        const allowedFromState = VALID_PLAN_TRANSITIONS[prevState] || [];
        const allowedLabel = allowedFromState.length
          ? `可以轉到：${allowedFromState.join(", ")}。`
          : "目前狀態無合法轉換，必須走專用 event。";
        if (prevState !== from) {
          return jsonResult({
            ok: false,
            code: "STATE_MISMATCH",
            error: `計畫目前的狀態是 ${prevState}，但 from 指定的是 ${from}，對不上。${allowedLabel}`,
          });
        }
        if (isFinishedPlanState(prevState)) {
          return jsonResult({ ok: false, code: "TERMINAL_STATE_CONFLICT", error: `計畫已經在終態 ${prevState}，不能再轉換` });
        }
        // dedicated event 檢查：先看目標狀態是否可從目前狀態到達。
        // 不可達 → INVALID_TRANSITION（附合法清單）；可達 → DEDICATED_EVENT_REQUIRED
        // 並帶上對應 event 名 + 需要的參數。
        if (["BLOCKED", "COMPLETED", "FAILED", "CANCELLED"].includes(to)) {
          if (!allowedFromState.includes(to)) {
            return jsonResult({
              ok: false,
              code: "INVALID_TRANSITION",
              error: `不允許的轉換：${prevState} → ${to}。${allowedLabel}`,
            });
          }
          const hint = to === "BLOCKED"
            ? `改用 event:"block"，並填 reason 才能轉到 BLOCKED。`
            : to === "COMPLETED"
              ? `改用 event:"complete"（無需額外參數），但會被進行中關聯任務擋下（ACTIVE_LINKED_TASKS）。`
              : to === "FAILED"
                ? `改用 event:"fail"，並填 reason 才能標記為 FAILED。`
                : `改用 event:"cancel"，並填 reason 才能取消計畫。`;
          return jsonResult({
            ok: false,
            code: "DEDICATED_EVENT_REQUIRED",
            error: `要轉到 ${to} 得用 plan-state-sync 對應的專用 event（${hint}）`,
          });
        }
        const allowed = VALID_PLAN_TRANSITIONS[prevState] || [];
        if (!allowed.includes(to)) return jsonResult({ ok: false, code: "INVALID_TRANSITION", error: `不允許的轉換：${prevState} → ${to}。${allowedLabel}` });
        if (prevState === "REVIEWING" && to === "ARCHIVING") {
          const taskReg = taskRegistry;
          const activeLinked = findActiveLinkedTaskIds(plan, taskReg);
          if (activeLinked.length > 0) {
            return jsonResult({
              ok: false,
              code: "ACTIVE_LINKED_TASKS",
              error: `計畫還有 ${activeLinked.length} 個進行中的關聯任務（${activeLinked.join(", ")}），不能封存。先把這些任務做完或解除關聯。`,
            });
          }
        }
        plan.state = to;
        plan.updatedAt = timestamp;
        plan.history.push(`| ${timestamp} | ${from} → ${to} | ${owner || "—"} | 狀態轉換 |`);
        plan.history = plan.history.slice(-PLAN_HISTORY_LIMIT);
        control.commit();
        return jsonResult({ ok: true, planId, state: plan.state, updatedAt: timestamp, project: currentProject }, null, 2);
      } else if (event === "complete") {
        if (prevState === "COMPLETED") {
          return jsonResult({ ok: true, planId, state: "COMPLETED", updatedAt: plan.updatedAt, message: "計畫已經完成" }, null, 2);
        }
        if (isFinishedPlanState(prevState)) {
          return jsonResult({ ok: false, code: "TERMINAL_STATE_CONFLICT", error: `計畫已經在終態 ${prevState}，不能再完成` });
        }
        const allowed = VALID_PLAN_TRANSITIONS[prevState] || [];
        if (!allowed.includes("COMPLETED")) return jsonResult({ ok: false, code: "INVALID_TRANSITION", error: `不允許的轉換：${prevState} → COMPLETED。計畫要先進到 ARCHIVING 才能完成。` });
        const taskReg = taskRegistry;
        const activeLinked = findActiveLinkedTaskIds(plan, taskReg);
        if (activeLinked.length > 0) {
          return jsonResult({
            ok: false,
            code: "ACTIVE_LINKED_TASKS",
            error: `計畫還有 ${activeLinked.length} 個進行中的關聯任務（${activeLinked.join(", ")}），不能完成。先把這些任務做完或解除關聯。`,
          });
        }
        plan.state = "COMPLETED";
        plan.updatedAt = timestamp;
        plan.history.push(`| ${timestamp} | ${prevState} → COMPLETED | ${owner || "—"} | 完成 Plan |`);
        plan.history = plan.history.slice(-PLAN_HISTORY_LIMIT);
        registry.activePlanIds = registry.activePlanIds.filter(id => id !== planId);
        if (registry.planCursor === planId) registry.planCursor = registry.activePlanIds.length > 0 ? registry.activePlanIds[0] : null;
        control.commit();
        return jsonResult({ ok: true, planId, state: "COMPLETED", updatedAt: timestamp, project: currentProject }, null, 2);
      } else if (event === "cancel") {
        if (prevState === "CANCELLED") {
          return jsonResult({ ok: true, planId, state: "CANCELLED", updatedAt: plan.updatedAt, message: "計畫已經取消" }, null, 2);
        }
        if (isFinishedPlanState(prevState)) {
          return jsonResult({ ok: false, code: "TERMINAL_STATE_CONFLICT", error: `計畫已經在終態 ${prevState}，不能取消` });
        }
        if (!reason?.trim()) return jsonResult({ ok: false, code: "REASON_REQUIRED", error: "取消計畫需要填 reason" });
        const allowed = VALID_PLAN_TRANSITIONS[prevState] || [];
        if (!allowed.includes("CANCELLED")) return jsonResult({ ok: false, code: "INVALID_TRANSITION", error: `狀態 ${prevState} 的計畫不能取消` });
        //  — invariant（與 complete 對稱）：
        // cancel Plan 時若仍有 active linked task，視為 invariant 破口，必須被拒絕。
        const taskReg = taskRegistry;
        const activeLinked = findActiveLinkedTaskIds(plan, taskReg);
        if (activeLinked.length > 0) {
          return jsonResult({
            ok: false,
            code: "ACTIVE_LINKED_TASKS",
            error: `計畫還有 ${activeLinked.length} 個進行中的關聯任務（${activeLinked.join(", ")}），不能取消。先把這些任務做完或解除關聯。`,
          });
        }
        plan.state = "CANCELLED";
        plan.updatedAt = timestamp;
        plan.history.push(`| ${timestamp} | ${prevState} → CANCELLED | ${owner || "—"} | ${reason.trim()} |`);
        plan.history = plan.history.slice(-PLAN_HISTORY_LIMIT);
        registry.activePlanIds = registry.activePlanIds.filter(id => id !== planId);
        if (registry.planCursor === planId) registry.planCursor = registry.activePlanIds.length > 0 ? registry.activePlanIds[0] : null;
        control.commit();
        return jsonResult({ ok: true, planId, state: "CANCELLED", updatedAt: timestamp, project: currentProject }, null, 2);
      } else if (event === "fail") {
        if (prevState === "FAILED") {
          return jsonResult({ ok: true, planId, state: "FAILED", updatedAt: plan.updatedAt, message: "計畫已經標記為失敗" }, null, 2);
        }
        if (isFinishedPlanState(prevState)) {
          return jsonResult({ ok: false, code: "TERMINAL_STATE_CONFLICT", error: `計畫已經在終態 ${prevState}，不能標記為失敗` });
        }
        if (!reason?.trim()) return jsonResult({ ok: false, code: "REASON_REQUIRED", error: "標記計畫失敗需要填 reason" });
        const allowed = VALID_PLAN_TRANSITIONS[prevState] || [];
        if (!allowed.includes("FAILED")) return jsonResult({ ok: false, code: "INVALID_TRANSITION", error: `狀態 ${prevState} 的計畫不能標記為失敗` });
        const taskReg = taskRegistry;
        const activeLinked = findActiveLinkedTaskIds(plan, taskReg);
        if (activeLinked.length > 0) {
          return jsonResult({
            ok: false,
            code: "ACTIVE_LINKED_TASKS",
            error: `計畫還有 ${activeLinked.length} 個進行中的關聯任務（${activeLinked.join(", ")}），不能標記為失敗。先把這些任務做完或解除關聯。`,
          });
        }
        plan.state = "FAILED";
        plan.updatedAt = timestamp;
        plan.history.push(`| ${timestamp} | ${prevState} → FAILED | ${owner || "—"} | ${reason.trim()} |`);
        plan.history = plan.history.slice(-PLAN_HISTORY_LIMIT);
        registry.activePlanIds = registry.activePlanIds.filter(id => id !== planId);
        if (registry.planCursor === planId) registry.planCursor = registry.activePlanIds[0] ?? null;
        control.commit();
        return jsonResult({ ok: true, planId, state: "FAILED", updatedAt: timestamp, project: currentProject }, null, 2);
      } else if (event === "block") {
        if (!reason?.trim()) return jsonResult({ ok: false, code: "REASON_REQUIRED", error: "暫停計畫需要填 reason" });
        const allowed = VALID_PLAN_TRANSITIONS[prevState] || [];
        if (!allowed.includes("BLOCKED")) return jsonResult({ ok: false, code: "INVALID_TRANSITION", error: `狀態 ${prevState} 的計畫不能暫停` });
        plan.state = "BLOCKED";
        plan.updatedAt = timestamp;
        plan.history.push(`| ${timestamp} | ${prevState} → BLOCKED | ${owner || "—"} | ${reason.trim()} |`);
        plan.history = plan.history.slice(-PLAN_HISTORY_LIMIT);
        control.commit();
        return jsonResult({ ok: true, planId, state: "BLOCKED", updatedAt: timestamp, project: currentProject }, null, 2);
      } else if (event === "resume") {
        if (isFinishedPlanState(prevState)) {
          return jsonResult({ ok: false, code: "TERMINAL_STATE_CONFLICT", error: `計畫已經在終態 ${prevState}，不能復原` });
        }
        if (from !== undefined && from !== "ARCHIVING") {
          return jsonResult({ ok: false, code: "INVALID_TRANSITION", error: `復原的來源必須是 ARCHIVING，不能是 ${from}` });
        }
        if (to !== undefined && to !== "IN_PROGRESS") {
          return jsonResult({ ok: false, code: "INVALID_TRANSITION", error: `復原的目標必須是 IN_PROGRESS，不能是 ${to}` });
        }
        if (prevState !== "ARCHIVING") {
          return jsonResult({ ok: false, code: "INVALID_TRANSITION", error: `只有 ARCHIVING 的計畫可以復原，目前是 ${prevState}` });
        }
        if (!reason?.trim()) return jsonResult({ ok: false, code: "REASON_REQUIRED", error: "復原計畫需要填 reason" });
        plan.state = "IN_PROGRESS";
        plan.updatedAt = timestamp;
        plan.history.push(`| ${timestamp} | ARCHIVING → IN_PROGRESS | ${owner || "—"} | ${reason.trim()} |`);
        plan.history = plan.history.slice(-PLAN_HISTORY_LIMIT);
        registry.activePlanIds = uniq([...registry.activePlanIds, planId!]);
        if (!registry.planCursor) registry.planCursor = planId!;
        control.commit();
        return jsonResult({ ok: true, planId, state: plan.state, updatedAt: timestamp, project: currentProject }, null, 2);
      }

      return jsonResult({ ok: false, code: "UNKNOWN_EVENT", error: `不認得的 event：${event}` });
      });
      await runtime.updateStateMd(runtime.readRegistry(context), context);
      return result;
    }
  });
}
