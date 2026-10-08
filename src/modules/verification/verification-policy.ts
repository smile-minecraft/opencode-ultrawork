/**
 * verification_run 授權角色的單一定義位置。
 *
 * 這是兩層防護的其中一層：agent 權限設定是第一層，這裡的 runtime 檢查是
 * 第二層（即使第一層被繞過仍擋得住）。兩層不是重複定義——移掉任一層都等於少一道。
 *
 * 清單由設定指定（verification.runAllowedAgents）；未設定或值無效時保持空清單，
 * 確保授權解析不會引入固定角色 fallback。
 *
 * 限制：純函式 / pure module，不引入 IO 或 runtime helper。
 */

import type { UltraworkSettings } from "../../settings/defaults.ts";
import { asStringList } from "../../settings/validate.ts";

/** 從設定解出實際生效的授權清單；沒寫或寫壞都維持空清單。 */
export function resolveVerificationRunAllowedAgents(
  settings: UltraworkSettings | undefined,
): readonly string[] {
  return asStringList(settings?.verification?.runAllowedAgents) ?? [];
}

export function isVerificationRunAllowedAgent(
  agent: string | undefined,
  allowedAgents: readonly string[],
): boolean {
  return typeof agent === "string"
    && allowedAgents.includes(agent);
}
