/**
 * `workflow_l1_check`：專案記憶大小健康檢查與 token 效率診斷。
 *
 * 凍結介面（與舊版一致）：
 *   - 名稱 `workflow_l1_check`；參數 `{}`（無參數）。
 *   - 回傳外框走 `jsonResult`，`data` 內含 `ok / blocks[] / warnings[] /
 *     suggestions[] / token_efficiency{}`。
 *   - frontmatter `limit` 無效時回 `ok:false` + `code:"CONFIGURATION_ERROR"`。
 *
 * 與舊版的來源差異：`parseFrontmatterBlock` 早期放在已停用並刪除的 legacy 記憶
 * 後端，現在由 memory 模組提供（`src/modules/memory/frontmatter.ts`）。
 * 解析器本身逐字沿用，行為與錯誤碼不變。
 *
 * 唯讀：只讀檔案與 registry。
 */

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { defineTool } from "../../kit/define-tool.ts";
import { jsonResult } from "../../kit/json.ts";
import {
  BOOTSTRAP_FULL_SOFT_BUDGET,
  PROJECT_MD_HARD_LIMIT,
  STATE_MD_LIMIT,
  getProjectMdCurrentSections,
  getProjectMdNearLimitThreshold,
  getProjectMdOverLimitHint,
  parseFrontmatterBlock,
  resolveProjectMdPolicyFromContent,
  splitFrontmatter,
} from "../memory/index.ts";
import type { DiagnosticsDeps } from "./deps.ts";
import { fileSize, readPlansForDiagnostics, readTasksForDiagnostics } from "./shared.ts";

interface L1Block {
  name: string;
  size: number;
  limit: number;
  effectiveLimit: number;
  hardLimit: number;
  status: string;
  suggestion: string;
  over_by?: number;
  current_sections?: ReturnType<typeof getProjectMdCurrentSections>;
  hint?: string;
}

export function createWorkflowL1CheckTool(deps: DiagnosticsDeps) {
  return defineTool({
    name: "workflow_l1_check",
    description:
      "檢查專案記憶大小是否超過限制，並提供 token 使用量與各種讀取模式的大小估算。",
    inputSchema: z.object({}),
    execute: async (_input, context) => {
      const paths = deps.runtime.getPaths(context);
      const report: {
        ok: boolean;
        code?: string;
        error?: string;
        blocks: L1Block[];
        warnings: string[];
        suggestions: string[];
        token_efficiency: Record<string, unknown>;
      } = { ok: true, blocks: [], warnings: [], suggestions: [], token_efficiency: {} };
      const configurationErrors: string[] = [];

      const checkFile = (name: string, path: string, defaultLimit: number): void => {
        if (!existsSync(path)) return;
        const content = readFileSync(path, "utf-8");
        let effectiveLimit = defaultLimit;
        let hardLimit = defaultLimit;
        if (name === "project.md") {
          // project.md 走 memory 模組的 frontmatter 政策（limit 只能收緊）。
          const policy = resolveProjectMdPolicyFromContent(content);
          hardLimit = policy.hardLimit;
          if (!policy.isValid) {
            configurationErrors.push(policy.configurationError!);
            report.warnings.push(
              `project.md 的 frontmatter limit 無效（${policy.rawLimit ?? "unknown"}）：${policy.configurationError}`,
            );
            report.suggestions.push(
              `把 project.md 的 limit frontmatter 改成一個 1..${hardLimit} 的正整數（不能超過 hard limit ${hardLimit}）。`,
            );
            effectiveLimit = policy.effectiveLimit;
          } else {
            effectiveLimit = policy.effectiveLimit;
          }
        } else {
          const { frontmatter } = splitFrontmatter(content);
          if (frontmatter) {
            const fm = parseFrontmatterBlock(frontmatter);
            if (fm.limit !== undefined) {
              const rawLimit = Array.isArray(fm.limit) ? "" : String(fm.limit).trim();
              const parsed = Number(rawLimit);
              const display = Array.isArray(fm.limit) ? `[${fm.limit.join(", ")}]` : String(fm.limit);
              if (
                rawLimit === "" ||
                !Number.isFinite(parsed) ||
                !Number.isInteger(parsed) ||
                parsed <= 0 ||
                parsed > defaultLimit
              ) {
                const reason =
                  rawLimit === "" || !Number.isFinite(parsed)
                    ? "不是有效數字"
                    : !Number.isInteger(parsed)
                      ? "不是正整數"
                      : parsed <= 0
                        ? "必須 >0"
                        : `超過 hard limit ${defaultLimit}`;
                configurationErrors.push(`${name} 的 frontmatter limit 無效：「${display}」（${reason}）`);
                report.warnings.push(`${name} 的 frontmatter limit 無效（${display}），改用預設值 ${defaultLimit}。`);
                report.suggestions.push(`把 ${name} 的 limit frontmatter 改成一個 1..${defaultLimit} 的正整數。`);
              } else {
                effectiveLimit = parsed;
              }
            }
          }
        }
        const size = content.length;
        const block: L1Block = {
          name,
          size,
          limit: effectiveLimit,
          effectiveLimit,
          hardLimit,
          status: size > effectiveLimit ? "warn" : "ok",
          suggestion: size > effectiveLimit ? `把 ${name} 精簡到 ${effectiveLimit} 字以內。` : "無",
        };
        if (name === "project.md" && size > effectiveLimit) {
          const overBy = size - effectiveLimit;
          const currentSections = getProjectMdCurrentSections(content);
          block.over_by = overBy;
          block.current_sections = currentSections;
          block.hint = getProjectMdOverLimitHint(effectiveLimit, overBy, currentSections);
        }
        report.blocks.push(block);
        if (size > effectiveLimit) {
          report.ok = false;
          report.warnings.push(`${name} 超過大小上限（${size} > ${effectiveLimit}）`);
          if (name === "project.md") {
            report.warnings.push(block.hint!);
          }
        }
      };

      checkFile("project.md", paths.PROJECT_MD, PROJECT_MD_HARD_LIMIT);
      checkFile("state.md", paths.STATE_MD, STATE_MD_LIMIT);

      if (configurationErrors.length > 0) {
        report.ok = false;
        report.code = "CONFIGURATION_ERROR";
        report.error = configurationErrors.join("; ");
      }

      // Token 效率診斷：bootstrap 四種模式的預估輸出大小。
      const projectMdSize = fileSize(paths.PROJECT_MD);
      const stateMdSize = fileSize(paths.STATE_MD);
      const tasksJsonSize = fileSize(paths.TASKS_JSON);
      const plansJsonSize = fileSize(paths.PLANS_JSON);
      const { registry } = readTasksForDiagnostics(deps, context);
      const activeTaskCount = registry.activeTaskIds.length;
      let activePlanCount = 0;
      try {
        activePlanCount = readPlansForDiagnostics(deps, context).plans.activePlanIds.length;
      } catch {
        // plans.json 不可得時不影響其他診斷；計數維持 0。
        activePlanCount = 0;
      }

      // minimal = 0 專案記憶內容（純 cursor summary，< 2KB 結構）
      const minimalChars = 1536;
      const projectChars = projectMdSize + 1536;
      const stateChars = stateMdSize + 1536;
      const fullChars = projectMdSize + stateMdSize + 2048;
      const fullStatus = fullChars > BOOTSTRAP_FULL_SOFT_BUDGET ? "warn" : "ok";

      report.token_efficiency = {
        tasks_json_size: tasksJsonSize,
        plans_json_size: plansJsonSize,
        active_task_count: activeTaskCount,
        active_plan_count: activePlanCount,
        estimated_bootstrap_mode: "minimal",
        state_projection: "cursor",
        bootstrap_mode_estimates: {
          minimal_chars: minimalChars,
          project_chars: projectChars,
          state_chars: stateChars,
          full_chars: fullChars,
          full_soft_budget: BOOTSTRAP_FULL_SOFT_BUDGET,
          full_status: fullStatus,
        },
      };

      // Soft-budget 提示：超過保守閾值就建議瘦身。
      if (stateMdSize > 2500) {
        report.warnings.push(
          `state.md 偏大（${stateMdSize} 字）。可以拿掉 Ready/Blocked 的預覽，或精簡最近完成的項目。`,
        );
        report.suggestions.push("縮小 runtime.updateStateMd() 的預覽大小，或在寫入前移除非進行中的任務。");
      }
      {
        const projContent = existsSync(paths.PROJECT_MD) ? readFileSync(paths.PROJECT_MD, "utf-8") : "";
        const effectiveProjectLimit = projContent
          ? resolveProjectMdPolicyFromContent(projContent).effectiveLimit
          : PROJECT_MD_HARD_LIMIT;
        const nearThreshold = getProjectMdNearLimitThreshold(effectiveProjectLimit);
        if (projectMdSize >= nearThreshold && projectMdSize <= effectiveProjectLimit) {
          report.warnings.push(
            `project.md 快到大小上限了（${projectMdSize}/${effectiveProjectLimit}，閾值 ${nearThreshold}）。bootstrap 的 full 模式成本會很高。`,
          );
          report.suggestions.push("精簡 project.md 的歷史段落，或把冗長的規則移到 .ultrawork/plans/ 的內容檔。");
        }
      }
      if (fullStatus === "warn") {
        report.warnings.push(
          `bootstrap 的 full 模式預估會輸出約 ${fullChars} 字，超過建議上限（${BOOTSTRAP_FULL_SOFT_BUDGET}）。工作階段應該用 mode='minimal'。`,
        );
        report.suggestions.push("做針對性的人工診斷時，用 workflow_bootstrap 的 mode='project' 或 mode='state'，不要用 mode='full'。");
      }
      if (activeTaskCount > 12) {
        report.warnings.push(
          `active_task_count=${activeTaskCount} > 12。workflow_bootstrap 的 minimal 模式成本隨數量線性增加，考慮把沒在動的任務歸檔。`,
        );
        report.suggestions.push("用 task-state-sync 把卡著的 NEW/PLANNED 任務完成或歸檔。");
      }
      if (activePlanCount > 5) {
        report.warnings.push(`active_plan_count=${activePlanCount} > 5。考慮取消多餘的計畫。`);
        report.suggestions.push("檢視進行中的計畫，把沒有進行中任務的取消或完成。");
      }
      if (tasksJsonSize > 50_000) {
        report.warnings.push(
          `tasks.json 很大（${tasksJsonSize} 個字元），registry 可能讓 minimal bootstrap 載入過多內容。`,
        );
        report.suggestions.push("確認 FINISHED_TASK_LIMIT 的清理有在運作，並考慮縮短最近完成任務的保留數量。");
      }

      return jsonResult(report);
    },
  });
}
