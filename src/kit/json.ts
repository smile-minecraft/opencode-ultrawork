/**
 * 工具回傳外框：成功固定 ok／summary／data，失敗再加 code／nextAction。
 *
 * 跟舊外掛同一套形狀，使用者的角色提示詞依賴這些欄位。
 * 邏輯逐條對齊舊版 search-tool-utils，不得簡化：
 * - 物件沒寫 `ok: true` 就算失敗（反直覺但刻意：舊呼叫點都明確帶 ok，
 *   寬鬆判定會把髒資料當成功吞掉，之後別改回去）。
 * - 成功摘要依序取 summary 參數 → humanSummary → message → 預設句。
 */

export interface ToolResponse<T = unknown> {
  ok: boolean;
  code?: string;
  summary: string;
  nextAction?: string;
  data: T;
}

/**
 * 把工具吐出的英文 error 轉成中文放進 `summary`。
 *
 * 服務還沒在來源改成中文的工具；已經講中文的來源不會命中這些 pattern。
 */
const ERROR_REPLACEMENTS: Array<[RegExp, string]> = [
  [/^Target not found:/, "找不到指定位置："],
  [/^Expected a file:/, "指定位置不是檔案："],
  [/^Refusing to read binary file:/, "為了安全起見，不讀取二進位檔案："],
  [/^Refusing to search binary file:/, "為了安全起見，不搜尋二進位檔案："],
  [/^Target must stay inside the active worktree$/, "指定路徑必須位於目前專案內。"],
  [/^Target resolves outside the active worktree$/, "指定路徑解析後超出目前專案範圍。"],
  [/^Worktree does not exist:/, "目前專案位置不存在："],
  [/^Refusing to read sensitive path:/, "為了安全起見，拒絕讀取敏感檔案："],
  [/^Refusing to use unsafe project root as search root$/, "專案根目錄不安全，不能當搜尋起點。"],
  [/^Search was aborted$/, "搜尋已取消。"],
  [/^Search exceeded 10 seconds$/, "搜尋超過 10 秒，已停止。"],
];

function naturalizeMessage(message: string): string {
  for (const [pattern, replacement] of ERROR_REPLACEMENTS) {
    if (pattern.test(message)) return message.replace(pattern, replacement);
  }
  return message
    .replace(/^must provide either (.+)$/i, "請提供以下其中一種輸入：$1")
    .replace(/^cannot read file:/i, "無法讀取檔案：")
    .replace(/^line (.+) out of range/i, "行號超出範圍：$1")
    .replace(/^Either (.+) is required$/i, "以下至少需要提供一項：$1")
    .replace(/^(.+) required$/i, "$1 為必填")
    .replace(/^Use /g, "請使用 ")
    .replace(/^Run /g, "請先執行 ")
    .replace(/must not be empty/g, "不可為空")
    .replace(/must be an integer between/g, "必須是介於")
    .replace(/required/g, "為必填")
    .replace(/not found/gi, "找不到")
    .replace(/Invalid transition/gi, "狀態變更不正確")
    .replace(/Cannot /g, "無法")
    .replace(/requires /g, "需要 ");
}

function defaultNextAction(code: string | undefined): string {
  if (code?.startsWith("INVALID_") || code?.endsWith("_REQUIRED") || code === "EMPTY_PATTERN") {
    return "請修正輸入欄位後再試一次。";
  }
  if (code === "FILE_NOT_FOUND" || code === "WORKTREE_NOT_FOUND") {
    return "請確認路徑與目前專案位置後再試一次。";
  }
  if (code === "PATH_OUTSIDE_WORKTREE" || code === "SENSITIVE_PATH" || code === "BINARY_FILE") {
    return "請改用目前專案內的非敏感文字檔案。";
  }
  if (code === "TERMINAL_STATE_CONFLICT" || code === "INVALID_TRANSITION") {
    return "請先讀取目前狀態，再使用符合狀態的操作。";
  }
  return "請根據上面的說明處理後再試一次。";
}

/**
 * 沒有明確 `code` 時，從英文 error 字串猜一個。這是保險，不是主要途徑——
 * 每個失敗分支都應該自己帶 `code`，真的漏了至少還有這層。
 */
function inferErrorCode(message: string | undefined): string | undefined {
  if (!message) return undefined;
  if (/cross-project/i.test(message)) return "CROSS_PROJECT_OPERATION";
  if (/not found/i.test(message)) return "NOT_FOUND";
  if (/already exists/i.test(message)) return "ALREADY_EXISTS";
  if (/required/i.test(message)) return "REQUIRED_INPUT";
  return undefined;
}

/**
 * 將工具回覆統一成固定外層；原始資料全部放在 data。
 *
 * 輸出用緊湊 JSON：工具結果會一直留在對話裡，後面每次請求都要重送，
 * 排版用的換行和縮排對模型沒有資訊量，卻要算 token。
 */
export function jsonResult(value: unknown, summary?: string | null, nextAction?: string | number): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const input = value as Record<string, unknown>;
    if (input.summary && input.data && typeof input.summary === "string") {
      return JSON.stringify(input);
    }

    const ok = input.ok === true;
    const code =
      typeof input.code === "string"
        ? input.code
        : (inferErrorCode(typeof input.error === "string" ? input.error : undefined) ?? (!ok ? "TOOL_ERROR" : undefined));
    const error = typeof input.error === "string" ? input.error : undefined;
    const { ok: _ok, code: _code, error: _error, ...payload } = input;
    const response: ToolResponse = {
      ok,
      ...(code ? { code } : {}),
      summary:
        summary ??
        (ok
          ? typeof input.humanSummary === "string"
            ? input.humanSummary
            : typeof input.message === "string"
              ? input.message
              : "操作已完成。"
          : `目前無法完成：${naturalizeMessage(error ?? "發生未預期的錯誤。")}`),
      ...(!ok
        ? { nextAction: typeof nextAction === "string" ? nextAction : defaultNextAction(code) }
        : typeof nextAction === "string"
          ? { nextAction }
          : {}),
      data: error ? { ...payload, error } : payload,
    };
    return JSON.stringify(response);
  }

  return JSON.stringify({
    ok: true,
    summary: summary ?? "操作已完成。",
    ...(typeof nextAction === "string" ? { nextAction } : {}),
    data: value,
  });
}

/** 失敗回傳的捷徑。 */
export function jsonError(code: string, error: string, nextAction?: string): string {
  return jsonResult({ ok: false, code, error }, undefined, nextAction);
}
