/**
 * 設定合併：內建預設 → 全域 → 專案。
 *
 * 物件深層合併，純量與陣列整個覆寫。覆寫層不是普通物件時整層忽略。
 */

/** 普通物件判斷（合併與驗證共用）：陣列、null、class 實例都不算。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 深層合併，右邊優先；陣列與純量整個取代。 */
export function mergeSettings<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return base;
  const current = (isPlainObject(base) ? base : {}) as Record<string, unknown>;
  const result: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(override)) {
    const existing = current[key];
    result[key] = isPlainObject(value) && isPlainObject(existing) ? mergeSettings(existing, value) : value;
  }
  return result as T;
}
