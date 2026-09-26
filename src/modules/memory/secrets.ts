/**
 * 疑似 secret 偵測：寫入主題與筆記前檢查，命中就拒絕。
 *
 * 只抓格式明確、誤判少的樣式（私鑰、常見平台 token、雲端存取金鑰、
 * `password=...` 這類賦值）。錯誤訊息不得回顯命中的內容本身。
 */

const SECRET_PATTERN = new RegExp(
  [
    String.raw`-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----`,
    String.raw`\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[0-9A-Z]{16})\b`,
    String.raw`(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[a-zA-Z0-9+/=_-]{16,}`,
  ].join("|"),
  "i",
);

export function containsSecret(text: string): boolean {
  return SECRET_PATTERN.test(text);
}
