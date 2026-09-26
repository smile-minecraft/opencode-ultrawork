/**
 * verification_run 授權角色的單一定義位置。
 *
 * 這是兩層防護的其中一層：agent 權限設定是第一層，這裡的 runtime 檢查是
 * 第二層（即使第一層被繞過仍擋得住）。兩層不是重複定義——移掉任一層都等於少一道。
 *
 * 清單可用設定覆寫（verification.runAllowedAgents），預設等於下方的常數；
 * 設定給了非預期的值一律退回預設（由設定驗證層保證，這裡再擋一次是縱深）。
 *
 * 限制：純常數 / pure module，不引入 IO 或 runtime helper。
 */

import type { UltraworkSettings } from "../../settings/defaults.ts";
import { asStringList } from "../../settings/validate.ts";

export const VERIFICATION_RUN_ALLOWED_AGENTS = ["momus"] as const;

/** 從設定解出實際生效的授權清單；沒寫或寫壞都退回內建預設。 */
export function resolveVerificationRunAllowedAgents(
  settings: UltraworkSettings | undefined,
): readonly string[] {
  return asStringList(settings?.verification?.runAllowedAgents) ?? [...VERIFICATION_RUN_ALLOWED_AGENTS];
}

export function isVerificationRunAllowedAgent(
  agent: string | undefined,
  allowedAgents: readonly string[] = VERIFICATION_RUN_ALLOWED_AGENTS,
): boolean {
  return typeof agent === "string"
    && (allowedAgents as readonly string[]).includes(agent);
}
