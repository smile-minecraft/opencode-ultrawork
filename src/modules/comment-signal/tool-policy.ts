/**
 * commentSignal 工具：comment_signal_policy。
 *
 * 回傳精簡 policy summary 給主要 agent 自我診斷，不暴露完整 policy 物件。
 * 行為跟舊版一致，差別只有外殼（defineTool＋zod）。
 */

import { z } from "zod";
import { defineTool } from "../../kit/define-tool.ts";
import { jsonResult } from "../../kit/json.ts";
import { defaultCommentSignalPolicy } from "./policy.ts";
import type { CommentSignalPolicy } from "./types.ts";
import type { CommentSignalToolDeps } from "./tool-deps.ts";

/**
 * `comment_signal_policy` 工具回傳的 summary 結構。
 * 僅給主要 agent 自我診斷用途，不回傳完整 policy 物件（避免 prompt 膨脹）。
 */
interface PolicySummary {
  ok: true;
  descriptiveTags: string[];
  functionalTags: string[];
  severities: string[];
  metadataKeys: string[];
  blockingViolationCodes: string[];
  highRiskTags: string[];
  highRiskSeverities: string[];
  requireOwnerForP0: boolean;
  requireIssueForFixmeHighSeverity: boolean;
  minBodyLength: number;
  /** 常見錯誤示範（給主要 agent 自我診斷的精簡提示）。 */
  commonMistakes: string[];
  humanSummary: string;
}

export const COMMON_MISTAKES: string[] = [
  "[TODO] 補測試（缺 severity）→ 改為 [TODO:P2] 之後補單元測試。",
  "[WARN:P1] 注意這裡（未知 tag）→ 改為 [WARNING:P1] 太空泛，需補具體違反後果。",
  "[TODO:P2] fix later（無中文）→ 改為 [TODO:P2] 之後處理，並說明預期影響。",
  "[SECURITY:P0] 不要記錄 token（缺 owner / 缺後果）→ 改為 [SECURITY:P0 owner=@auth] 不要將 token 寫入 log，否則會洩漏。",
  "TODO fix later（未格式化）→ 改為 [TODO:P2] 之後處理。",
  "// plan parser-v2-compatibility（含工作流 ID）→ ID 移回固定格式文件，註解只保留持久技術理由。",
];

/** 建立 `comment_signal_policy` 工具定義（transform 外先建好，無副作用）。 */
export function createCommentSignalPolicyTool(_deps: CommentSignalToolDeps) {
  return defineTool({
    name: "comment_signal_policy",
    description:
      "回傳 Comment Signal policy 摘要：descriptive tags、functional tags、severity、metadata keys、障礙代碼、highRisk tags/severities、常見錯誤示範。給主要 agent 自我診斷用，不含完整規格 raw dump 以避免 prompt 膨脹。",
    inputSchema: z.object({}),
    execute: async () => {
      const p: CommentSignalPolicy = defaultCommentSignalPolicy;
      const summary: PolicySummary = {
        ok: true,
        descriptiveTags: [...p.descriptiveTags],
        functionalTags: [...p.functionalTags],
        severities: [...p.severities],
        metadataKeys: [...p.metadataKeys],
        blockingViolationCodes: [...p.blockingViolationCodes],
        highRiskTags: [...p.highRiskTags],
        highRiskSeverities: [...p.highRiskSeverities],
        requireOwnerForP0: p.requireOwnerForP0,
        requireIssueForFixmeHighSeverity: p.requireIssueForFixmeHighSeverity,
        minBodyLength: p.minBodyLength,
        commonMistakes: COMMON_MISTAKES,
        humanSummary: renderPolicyHumanSummary(p),
      };
      return jsonResult(summary, null, 2);
    },
  });
}

function renderPolicyHumanSummary(p: CommentSignalPolicy): string {
  const lines: string[] = [];
  lines.push("Comment Signal Policy 摘要");
  lines.push(`- 說明型 tag：${p.descriptiveTags.length} 個（[目的] / [原因] / [限制] / [範例] / [AI脈絡]）。`);
  lines.push(`- 功能型 tag：${p.functionalTags.length} 個，分工作流 / 風險 / 工程 / 架構 / AI 專用 5 群。`);
  lines.push(`- severity：${p.severities.join(", ")}。`);
  lines.push(`- 會形成障礙的 violation codes：${p.blockingViolationCodes.join(", ")}。`);
  lines.push(`- 高風險 tag × severity：${p.highRiskTags.join(", ")} × ${p.highRiskSeverities.join(", ")}。`);
  lines.push("- P0 functional 必須有 owner；FIXME:P0/P1 必須有 issue。");
  lines.push("- 最短 body 長度：4 字元；中文偵測 regex：CJK U+4E00–U+9FFF。");
  return lines.join("\n");
}
