/**
 * memory 模組常數：數值與舊外掛 core/constants 逐字一致。
 */

export const PROJECT_MD_HARD_LIMIT = 7000;
export const PROJECT_MD_LIMIT = PROJECT_MD_HARD_LIMIT;
export const STATE_MD_LIMIT = 3000;
export const BOOTSTRAP_FULL_SOFT_BUDGET = 10_000;
export const PROJECT_MD_NEAR_LIMIT_RATIO = 0.8;

/** receipts/ 保留上限：超過時直接刪除最舊，不歸檔。 */
export const RECEIPT_RETENTION_LIMIT = 50;

/** 收據 ID 前綴：create 以 `receipt-{taskId}` 作為檔名基底。 */
export const RECEIPT_ID_PREFIX = "receipt-";

/** project.md update／rewrite 共用的寫入鎖檔名。 */
export const PROJECT_MEMORY_LOCK = ".project-memory.lock";
