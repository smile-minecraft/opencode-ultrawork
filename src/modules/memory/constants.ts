/**
 * memory 模組的預算：內建預設值與分層設定形狀（企劃書 `docs/memory-redesign.md` 第 4.5 節）。
 *
 * 超過上限一律拒絕並說明，永不自動截斷使用者內容；唯一的例外是 context 注入：
 * 注入時超過預算會截斷並附說明，因為那只是展示，原檔不受影響。
 * 下面的常數是「沒寫設定時的預設值」：各層的實際上限走 `memory.budget.{global,project}`
 * 設定，`global` 只採全域設定檔、`project` 兩層都能寫。數值要調整時先問使用者，
 * 不要為了讓寫入通過而放寬。
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
/** 每層主題數上限；0 表示不限制（維持不設限時的現行行為）。 */
export const MAX_TOPICS = 0;
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

/**
 * 單一記憶層的預算（設定 `memory.budget.global`／`memory.budget.project` 的形狀）。
 *
 * `maxTopics` 是唯一可以為 0 的欄位（0＝不限制）；其餘都要是正整數。
 * 只有「預算類」開放設定：搜尋筆數、extract 上限、過時天數、log 大小維持程式常數。
 */
export interface MemoryLayerBudget {
  indexCharLimit: number;
  topicCharLimit: number;
  descriptionCharLimit: number;
  maxTopics: number;
  pinnedLimit: number;
  pinnedInjectBudget: number;
  noteCharLimit: number;
}

/** 兩層各自的預算：`global` 只採全域設定檔，`project` 兩層都能寫。 */
export interface MemoryBudgets {
  global: MemoryLayerBudget;
  project: MemoryLayerBudget;
}

/** 沒寫設定時的每層預算（值與上面的常數一致）。 */
export const DEFAULT_MEMORY_BUDGET: MemoryLayerBudget = {
  indexCharLimit: INDEX_CHAR_LIMIT,
  topicCharLimit: TOPIC_CHAR_LIMIT,
  descriptionCharLimit: DESCRIPTION_CHAR_LIMIT,
  maxTopics: MAX_TOPICS,
  pinnedLimit: PINNED_LIMIT,
  pinnedInjectBudget: PINNED_INJECT_BUDGET,
  noteCharLimit: NOTE_CHAR_LIMIT,
};

/** 每層一份新的預設預算（呼叫端各自修改不互相影響）。 */
export function defaultMemoryBudgets(): MemoryBudgets {
  return { global: { ...DEFAULT_MEMORY_BUDGET }, project: { ...DEFAULT_MEMORY_BUDGET } };
}

/**
 * 取出某一層的預算：缺層、缺欄位或值不合法時退回預設，不讓壞值流進模組。
 *
 * 縱深防護：設定載入時已經驗證過一次，這裡再擋一次手刻 `MemoryToolDeps`
 *（例如測試）帶進來的壞值。
 */
export function budgetForLayer(budgets: MemoryBudgets | undefined, layer: "project" | "global"): MemoryLayerBudget {
  const fallback = DEFAULT_MEMORY_BUDGET;
  const raw = (budgets as Record<string, unknown> | undefined)?.[layer];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...fallback };
  const record = raw as Record<string, unknown>;
  const pick = (key: keyof MemoryLayerBudget, allowZero: boolean): number => {
    const value = record[key];
    if (typeof value !== "number" || !Number.isInteger(value)) return fallback[key];
    if (value < 0 || (value === 0 && !allowZero)) return fallback[key];
    return value;
  };
  return {
    indexCharLimit: pick("indexCharLimit", false),
    topicCharLimit: pick("topicCharLimit", false),
    descriptionCharLimit: pick("descriptionCharLimit", false),
    maxTopics: pick("maxTopics", true),
    pinnedLimit: pick("pinnedLimit", false),
    pinnedInjectBudget: pick("pinnedInjectBudget", false),
    noteCharLimit: pick("noteCharLimit", false),
  };
}
