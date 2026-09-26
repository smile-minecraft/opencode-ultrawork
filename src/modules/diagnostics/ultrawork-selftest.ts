/**
 * `ultrawork_selftest`：以最小參數實際呼叫診斷工具，量時間與失敗原因。
 *
 * 凍結介面（與舊版一致）：
 *   - 名稱 `ultrawork_selftest`；參數 `{ timeoutMs?: number, toolNames?: string[] }`。
 *   - 回傳外框走 `jsonResult`，`data` 內含 `ok / totalMs / perToolTimeoutMs /
 *     overallTimeoutMs / passCount / failCount / skipCount / notCovered[] /
 *     results[] / humanSummary`。
 *   - `results[]` 元素形狀 `{ tool, status, elapsedMs, error?, resultKeys? }`，
 *     `status` ∈ `pass | fail | skip`。
 *
 * 與舊版的落差（V2 拿不到跨模組工具定義）：
 *   舊版由 registry 注入完整 toolMap，所以能 smoke 全部 48 個工具。V2 的
 *   `ModuleRuntime` 沒有跨模組工具登錄清單，`defineTool` 只知道自己模組內的
 *   6 個。因此：
 *   - 預設清單是診斷模組自己擁有的 6 個工具。
 *   - 呼叫端指定的工具若不在這 6 個裡 → 明確列為 `skip` 並附原因，
 *     **不默默省略**，也不假裝通過。
 *   - `SKIP_TOOLS`（會寫檔的工具）在 V2 真的生效：舊版只在 `pickMinimalArgs`
 *     裡留註解說「caller 端攔截」，實際上沒攔；V2 直接標 skip 並附原因。
 *
 * 唯讀：只呼叫診斷模組自己的唯讀工具，本身不寫任何檔案。
 */

import { z } from "zod";
import { defineTool, type DefinedTool } from "../../kit/define-tool.ts";
import { jsonResult } from "../../kit/json.ts";
import type { DiagnosticsDeps } from "./deps.ts";
import { DIAGNOSTICS_TOOL_NAMES, SELF_DIAGNOSTIC_TOOL_NAMES } from "./inventory.ts";

/**
 * 自我診斷三工具：selftest 必須跳過，否則會遞迴觸發自己／health check／manifest。
 * 與舊版 `SELF_DIAGNOSTIC_TOOLS` 同一份集合。
 */
const SELF_DIAGNOSTIC_TOOLS: ReadonlySet<string> = new Set(SELF_DIAGNOSTIC_TOOL_NAMES);

export function isSelfDiagnostic(toolName: string): boolean {
  return SELF_DIAGNOSTIC_TOOLS.has(toolName);
}

/**
 * 會寫入檔案的工具（沿用舊版 `SKIP_TOOLS` 的名單）。
 * selftest 不應該污染測試 workspace，所以這些明確標 skip 並附原因。
 */
const SKIP_TOOLS: ReadonlySet<string> = new Set([
  "project-memory-update",
  "project-memory-rewrite",
  "plan-content-create",
  "plan-content-update",
  "plan-content-delete",
  "task-content-create",
  "task-content-update",
  "memory-receipt-create",
  "comment_signal_baseline",
  "comment_signal_suppress",
]);

export const __ultraworkSelftestInternals = {
  SELF_DIAGNOSTIC_TOOLS,
  SKIP_TOOLS,
} as const;

export type SelftestStatus = "pass" | "fail" | "skip" | "timeout";

export interface SelftestResultItem {
  tool: string;
  status: SelftestStatus;
  elapsedMs: number;
  /** 失敗或略過的原因摘要（最多 200 字）。 */
  error?: string;
  /** 工具回傳 JSON 的頂層 key（前 8 個）。 */
  resultKeys?: string[];
}

const DEFAULT_PER_TOOL_TIMEOUT_MS = 5_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 30_000;

export function createUltraworkSelftestTool(
  deps: DiagnosticsDeps,
  toolMap: Readonly<Record<string, DefinedTool>>,
) {
  return defineTool({
    name: "ultrawork_selftest",
    description:
      "依序執行公開工具的基本檢查並量測時間。預設整體 30 秒、每個工具最多 5 秒，供外掛更新後快速確認。",
    inputSchema: z.object({
      timeoutMs: z.number().int().optional(),
      toolNames: z.array(z.string()).optional(),
    }),
    execute: async (input, context) => {
      const start = Date.now();
      const overallBudget = Math.max(1000, input.timeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS);
      const perToolTimeout = Math.min(DEFAULT_PER_TOOL_TIMEOUT_MS, overallBudget);

      // 呼叫端給子集時，仍自動帶入自我診斷三工具（以 skip 呈現），
      // 讓 results 永遠反映「這支工具會跳過自己」這件事。
      const defaultToolNames = DIAGNOSTICS_TOOL_NAMES;
      const callerTargets =
        input.toolNames && input.toolNames.length > 0 ? input.toolNames : defaultToolNames;
      const seen = new Set<string>();
      const targets: string[] = [];
      for (const name of callerTargets) {
        if (seen.has(name)) continue;
        seen.add(name);
        targets.push(name);
      }
      for (const name of SELF_DIAGNOSTIC_TOOLS) {
        if (seen.has(name)) continue;
        seen.add(name);
        targets.push(name);
      }

      const results: SelftestResultItem[] = [];
      const covered = new Set<string>();
      let passCount = 0;
      let failCount = 0;
      let skipCount = 0;

      for (const name of targets) {
        // 1) 自我診斷三工具：跳過以避免遞迴。
        if (isSelfDiagnostic(name)) {
          results.push({
            tool: name,
            status: "skip",
            elapsedMs: 0,
            error: "self_diagnostic category: 已跳過以避免自我參照",
          });
          skipCount += 1;
          continue;
        }
        // 2) 會寫檔的工具：跳過以免污染 workspace。
        if (SKIP_TOOLS.has(name)) {
          results.push({
            tool: name,
            status: "skip",
            elapsedMs: 0,
            error: "會寫入檔案的工具：selftest 不呼叫，避免留下副作用",
          });
          skipCount += 1;
          continue;
        }
        // 3) 整體預算用完就停止實際呼叫。
        if (Date.now() - start > overallBudget) {
          results.push({
            tool: name,
            status: "skip",
            elapsedMs: 0,
            error: `已用盡整體預算（${overallBudget}ms），略過`,
          });
          skipCount += 1;
          continue;
        }
        // 4) V2 沒有跨模組工具登錄清單：取不到定義就明確標 skip 並說明原因。
        const def = toolMap[name];
        if (!def) {
          results.push({
            tool: name,
            status: "skip",
            elapsedMs: 0,
            error:
              "V2 的 ModuleRuntime 沒有跨模組工具登錄清單，只能實際呼叫診斷模組自己擁有的工具；這支工具不在診斷模組內。",
          });
          skipCount += 1;
          continue;
        }

        covered.add(name);
        const t0 = Date.now();
        let status: SelftestStatus = "pass";
        let error: string | undefined;
        let resultKeys: string[] | undefined;
        try {
          const raw = await runWithTimeout(
            Promise.resolve(def.execute(pickMinimalArgs(name), context)),
            perToolTimeout,
          );
          try {
            const parsed = JSON.parse(raw.content) as unknown;
            if (parsed && typeof parsed === "object") resultKeys = Object.keys(parsed).slice(0, 8);
          } catch {
            // 非 JSON 也算通過：selftest 重點在不 throw，不在回傳內容。
          }
        } catch (e) {
          status = /timeout after/.test((e as Error).message) ? "timeout" : "fail";
          const message = (e as Error)?.message ?? String(e);
          error = message.length > 200 ? `${message.slice(0, 200)}…` : message;
        }
        const elapsedMs = Date.now() - t0;
        if (status === "pass") {
          passCount += 1;
        } else {
          failCount += 1;
        }
        results.push({ tool: name, status, elapsedMs, error, resultKeys });
      }

      const notCovered = defaultToolNames.filter((name) => !covered.has(name));
      const totalMs = Date.now() - start;
      const ok = failCount === 0;
      return jsonResult({
        ok,
        totalMs,
        perToolTimeoutMs: perToolTimeout,
        overallTimeoutMs: overallBudget,
        passCount,
        failCount,
        skipCount,
        notCovered,
        results,
        humanSummary: [
          `Ultrawork Selftest：${ok ? "通過" : "失敗"}`,
          `- totalMs=${totalMs} (budget=${overallBudget})`,
          `- pass=${passCount}, fail=${failCount}, skip=${skipCount}, notCovered=${notCovered.length}`,
          `- covered tools: ${results.length}`,
        ].join("\n"),
      });
    },
  });
}

/** 依工具性質選最小有效參數，避免大量 IO。 */
function pickMinimalArgs(name: string): unknown {
  switch (name) {
    case "workflow_bootstrap":
      return { mode: "minimal" };
    case "workflow_doctor":
    case "workflow_l1_check":
      return {};
    case "workflow_health_check":
      return { includeBaselineCheck: false };
    case "tool_hook_manifest":
      return {};
    default:
      return {};
  }
}

/** 逾時保護：超時以 `timeout after Nms` 拒絕。 */
async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
