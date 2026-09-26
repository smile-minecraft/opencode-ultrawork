/**
 * commentSignal 工具：comment_signal_explain。
 *
 * 接受 `{ tag?, filePath?, line? }`，回傳 tag 說明或指定行註解的診斷。
 * 行為、args、回傳欄位跟舊版一致，差別只有外殼（defineTool＋zod）、
 * 位置走工作階段解析。錯誤碼與訊息逐字。
 */

import { z } from "zod";
import { defineTool } from "../../kit/define-tool.ts";
import { jsonResult } from "../../kit/json.ts";
import { isScannableExplicitPath, isSensitivePath, toPolicyRelativePath } from "./file-scan.ts";
import type { CommentSignalToolDeps } from "./tool-deps.ts";

const explainInputSchema = z.object({
  tag: z.string().optional(),
  filePath: z.string().optional(),
  line: z.number().optional(),
});

type ExplainArgs = z.infer<typeof explainInputSchema>;

interface TagExplanation {
  ok: true;
  /** 詢問模式：tag / file。 */
  mode: "tag" | "file";
  tag?: string;
  kind?: "descriptive" | "functional";
  filePath?: string;
  line?: number;
  raw?: string;
  explanation: string;
  examples: string[];
  diagnosis?: string;
}

interface ExplainError {
  ok: false;
  error: string;
  hint: string;
}

export const TAG_EXPLANATIONS: Record<string, { kind: "descriptive" | "functional"; explanation: string; examples: string[] }> = {
  // 說明型
  "目的": {
    kind: "descriptive",
    explanation: "說明此區塊 / 函式 / 模組的存在目的（為何存在、解決什麼問題）。說明型 tag 不需 severity。",
    examples: [
      "// [目的] 提供 plugin entry point 與 DI 組裝。",
    ],
  },
  "原因": {
    kind: "descriptive",
    explanation: "說明當前設計 / 行為背後的歷史或技術原因（為何這樣寫、避開什麼坑）。",
    examples: ["// [原因] 早期 closure 簡化，現在仍需保持向後相容。"],
  },
  "限制": {
    kind: "descriptive",
    explanation: "說明此區塊在現階段的邊界條件、不可做的事、或已知 trade-off。",
    examples: ["// [限制] 不可在 Bun runtime 之外的環境執行。"],
  },
  "範例": {
    kind: "descriptive",
    explanation: "註解內含可被驗證 / 測試的範例輸入輸出。",
    examples: ["// [範例] add(2,3) → 5。"],
  },
  "AI脈絡": {
    kind: "descriptive",
    explanation: "提供 AI agent / reviewer 可長期成立的技術脈絡，不記錄任務或代理執行歷史。",
    examples: ["// [AI脈絡] 此解析層保持純函式邊界，避免 plugin runtime 依賴滲入。"],
  },
  // 工作流
  "TODO": {
    kind: "functional",
    explanation: "待辦工作項。必須標 severity，並說明要做什麼與預期影響。",
    examples: [
      "// [TODO:P2] 之後補上單元測試，預期覆蓋正常路徑與兩個 boundary。",
      "// [TODO:P1 owner=@build] 之後改成 lazyEnsure 避免 cold start 卡住。",
    ],
  },
  "FIXME": {
    kind: "functional",
    explanation: "已知問題需修。P0/P1 必須有 issue metadata。",
    examples: ["// [FIXME:P1 owner=@x issue=#391] 修正 race condition。"],
  },
  // 風險
  "WARNING": {
    kind: "functional",
    explanation: "通用警示。P0/P1 必須含違反後果，否則觸發 MISSING_REASON warning。",
    examples: ["// [WARNING:P1] 此函式會 lock 全域，否則將造成並發 race。"],
  },
  "DANGER": {
    kind: "functional",
    explanation: "高風險操作（資料刪除、不可逆動作）。會被列入 highRisk 提醒。",
    examples: ["// [DANGER:P0 owner=@ops] rm -rf 整個 build/，否則會誤刪用戶資料。"],
  },
  "SECURITY": {
    kind: "functional",
    explanation: "安全敏感註解（token、權限、auth）。P0 必須含 owner 與違反後果。",
    examples: ["// [SECURITY:P0 owner=@auth issue=#391] 不要將 token 寫入 log，否則會洩漏。"],
  },
  "PRIVACY": {
    kind: "functional",
    explanation: "個資 / 隱私註解（PII、用戶資料）。",
    examples: ["// [PRIVACY:P0 owner=@auth] 不可將 PII 寫入 telemetry。"],
  },
  "DATA": {
    kind: "functional",
    explanation: "資料完整性 / migration 風險。",
    examples: ["// [DATA:P1] 此欄位移除會破壞舊版 client 解析。"],
  },
  // AI 專用
  "AI_TRAP": {
    kind: "functional",
    explanation: "AI 容易踩坑的陷阱（看似可改但有副作用）。",
    examples: ["// [AI_TRAP:P1 owner=@build] 不要把 closure state 寫進 module-level 常數。"],
  },
  "AI_DO_NOT_EDIT": {
    kind: "functional",
    explanation: "禁止 AI 自動改寫（自動產生、合約、敏感檔）。P0 會 throw 阻斷。",
    examples: ["// [AI_DO_NOT_EDIT:P0] 此檔由 codegen 自動產生，禁止人工修改。"],
  },
};

export const FALLBACK_FUNCTIONAL_EXAMPLE = "// [TAG:P2|P1|P0] 繁體中文說明 + 違反後果（P0/P1 必填）。";

/**
 * 建立 `comment_signal_explain` 工具定義（transform 外先建好，無副作用）。
 * 接受 `{ tag?, filePath?, line? }`，回傳 tag 說明或指定行註解的診斷。
 * 至少須提供 `tag` 或 (`filePath`＋`line`) 其中之一；皆未提供時回 ok:false。
 */
export function createCommentSignalExplainTool(deps: CommentSignalToolDeps) {
  return defineTool({
    name: "comment_signal_explain",
    description:
      "解釋 Comment Signal tag 語意，或診斷指定 filePath:line 的註解問題。給主要 agent 自我學習與修正時使用，避免依賴記憶。",
    inputSchema: explainInputSchema,
    execute: async (args: ExplainArgs, toolCtx) => {
      // 未提供任何查詢參數
      if (!args.tag && !(args.filePath && typeof args.line === "number")) {
        const err: ExplainError = {
          ok: false,
          error: "must provide either { tag } or { filePath, line }",
          hint: "範例：comment_signal_explain({ tag: 'SECURITY' }) 或 comment_signal_explain({ filePath: 'src/a.ts', line: 12 })。",
        };
        return jsonResult(err);
      }

      // 模式一：以 tag 查詢
      if (args.tag) {
        const tag = args.tag;
        const entry = TAG_EXPLANATIONS[tag];
        if (entry) {
          const out: TagExplanation = {
            ok: true,
            mode: "tag",
            tag,
            kind: entry.kind,
            explanation: entry.explanation,
            examples: entry.examples,
          };
          return jsonResult(out, null, 2);
        }
        // 未知 tag：給高層次提示
        const out: TagExplanation = {
          ok: true,
          mode: "tag",
          tag,
          explanation: `未知或非白名單 tag「${tag}」。合法 tag 為：${Object.keys(TAG_EXPLANATIONS).join(", ")}。`,
          examples: [FALLBACK_FUNCTIONAL_EXAMPLE],
        };
        return jsonResult(out, null, 2);
      }

      // 模式二：以 filePath＋line 查詢
      const { filePath, line } = args as { filePath: string; line: number };
      const worktree = await deps.resolveRoot(toolCtx);
      // 跟目錄掃描一致：dotfile／不支援副檔名／敏感路徑不讀檔，直接回結構化錯誤。
      // 路徑先 canonical 化再判定（symlink 別名現形）；錯誤訊息維持字面路徑。
      const policyRel = toPolicyRelativePath(worktree, filePath);
      if (!isScannableExplicitPath(policyRel)) {
        const sensitive = isSensitivePath(policyRel);
        const err: ExplainError = sensitive
          ? {
              ok: false,
              error: `refusing sensitive path: ${filePath}`,
              hint: "敏感檔案不讀取、不診斷；請改用目前專案內的非敏感文字檔案。",
            }
          : {
              ok: false,
              error: `unsupported path: ${filePath}`,
              hint: "僅支援目錄掃描認可的文字副檔名（且排除隱藏檔）；請確認路徑。",
            };
        return jsonResult(err);
      }
      const source = deps.sourceResolver(worktree, filePath);
      if (source === null) {
        const err: ExplainError = {
          ok: false,
          error: `cannot read file: ${filePath}`,
          hint: "請確認檔案存在且可讀，或使用相對 worktree 的路徑。",
        };
        return jsonResult(err);
      }
      const lines = source.replace(/\r\n/g, "\n").split("\n");
      if (line < 1 || line > lines.length) {
        const err: ExplainError = {
          ok: false,
          error: `line ${line} out of range (1..${lines.length})`,
          hint: `請使用 1-based line number，檔案共 ${lines.length} 行。`,
        };
        return jsonResult(err);
      }
      const raw = lines[line - 1];
      const diagnosis = diagnoseRawLine(raw);
      const out: TagExplanation = {
        ok: true,
        mode: "file",
        filePath,
        line,
        raw,
        explanation: diagnosis.summary,
        examples: diagnosis.examples,
        diagnosis: diagnosis.detail,
      };
      return jsonResult(out, null, 2);
    },
  });
}

interface DiagnosisResult {
  summary: string;
  detail: string;
  examples: string[];
}

/**
 * 對單行原始註解文字做輕量診斷（不依賴 parser／validator，避免 IO 成本）。
 * 重點：抽出 tag header（若有）、判定語法合法性、給出修正建議。
 */
export function diagnoseRawLine(raw: string): DiagnosisResult {
  const trimmed = raw.trim();
  // 已格式化
  const headerMatch = trimmed.match(/\[([^\]]+)\]/);
  if (headerMatch) {
    const inside = headerMatch[1];
    const parts = inside.split(/\s+/);
    const tag = parts[0]?.split(":")[0] ?? "";
    const sev = parts[0]?.includes(":") ? parts[0].split(":")[1] : null;
    const entry = TAG_EXPLANATIONS[tag];
    if (!entry) {
      return {
        summary: `未知的 tag「${tag}」。`,
        detail: `tag「${tag}」不在合法白名單內，將被 validator 標記 UNKNOWN_TAG（障礙）。`,
        examples: ["// [TODO:P2] 之後處理（請替換為合法 tag）。"],
      };
    }
    if (entry.kind === "functional" && !sev) {
      return {
        summary: `功能型 tag「${tag}」缺少 severity。`,
        detail: `功能型註解必須有 P0/P1/P2/P3，否則觸發 MISSING_SEVERITY（障礙）。`,
        examples: entry.examples,
      };
    }
    if (sev && !["P0", "P1", "P2", "P3"].includes(sev)) {
      return {
        summary: `非法的 severity「${sev}」。`,
        detail: `severity 必須為 P0/P1/P2/P3；其他字串觸發 INVALID_SEVERITY（障礙）。`,
        examples: entry.examples,
      };
    }
    return {
      summary: `tag「${tag}」${sev ? `severity=${sev}` : ""} 格式正確。`,
      detail: `已通過基本格式檢查；後續仍會由 validator 進行 body / metadata / highRisk 完整檢查。`,
      examples: entry.examples,
    };
  }
  // 未格式化：檢查是否含 TODO/FIXME/WARNING 等 keyword
  const kwMatch = trimmed.match(/\b(TODO|FIXME|REVIEW|VERIFY|TEST|WARNING|DANGER|SECURITY|PRIVACY|DATA)\b/i);
  if (kwMatch) {
    return {
      summary: `未格式化的功能型註解（內含 ${kwMatch[1]}）。`,
      detail: `此行看起來像功能性註解但未使用 [TAG:SEVERITY] 格式；會被 validator 標記 UNFORMATTED_FUNCTIONAL_COMMENT（warning）。`,
      examples: [FALLBACK_FUNCTIONAL_EXAMPLE],
    };
  }
  return {
    summary: "此行不含功能型 tag header。",
    detail: "若此行為功能性註解，建議改用 [TAG:P0|P1|P2|P3] 格式；純說明可用 [目的] / [原因] / [限制]。",
    examples: [FALLBACK_FUNCTIONAL_EXAMPLE],
  };
}
