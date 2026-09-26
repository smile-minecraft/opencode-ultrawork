/**
 * memory 模組的預算常數（企劃書 `docs/memory-redesign.md` 第 4.5 節）。
 *
 * 超過上限一律拒絕並說明，永不自動截斷使用者內容；唯一的例外是 context 注入：
 * 注入時超過預算會截斷並附說明，因為那只是展示，原檔不受影響。
 * 數值要調整時先問使用者，不要為了讓寫入通過而放寬。
 */

/** 每層索引 `MEMORY.md` 的字元上限；寫入後會超過就拒絕。 */
export const INDEX_CHAR_LIMIT = 3000;
/** 每個主題檔（含 frontmatter）的字元上限。 */
export const TOPIC_CHAR_LIMIT = 4000;
/** `description` 的字元上限：索引一行一個主題，太長會吃掉索引預算。 */
export const DESCRIPTION_CHAR_LIMIT = 120;
/** 每層 pinned 主題數上限。 */
export const PINNED_LIMIT = 3;
/** 每層注入 pinned 正文的總字元預算。 */
export const PINNED_INJECT_BUDGET = 2500;
/** 單筆 `memory-note` 的字元上限。 */
export const NOTE_CHAR_LIMIT = 1000;
/** `memory-extract` 回傳任務內容的上限，超過截斷並註明。 */
export const EXTRACT_CONTENT_LIMIT = 12000;
/** `memory-search` 預設與最大回傳筆數。 */
export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 20;
/** `verified_at`（空字串時看 `updated`）超過這麼多天，列為可能過時。 */
export const STALE_DAYS = 90;
/** 超過這麼多天沒被讀（從未讀過的以 `created` 起算），列為可汰除候選。 */
export const UNUSED_DAYS = 60;
/** log 超過這個大小時 doctor 提醒；log 永不截斷，輪替不在本次範圍。 */
export const LOG_WARN_BYTES = 5 * 1024 * 1024;
