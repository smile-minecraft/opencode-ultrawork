/**
 * change-scope-check 的 runtime 授權角色單一定義位置。
 *
 * 清單可用設定覆寫（verification.scopeCheckAllowedAgents），預設等於下方的常數；
 * 設定給了非預期的值一律退回預設（由設定驗證層保證，這裡再擋一次是縱深）。
 */

import type { UltraworkSettings } from "../../settings/defaults.ts";
import { asStringList } from "../../settings/validate.ts";

export const CHANGE_SCOPE_CHECK_ALLOWED_AGENTS = ["build", "ultra"] as const;

/** 從設定解出實際生效的授權清單；沒寫或寫壞都退回內建預設。 */
export function resolveChangeScopeCheckAllowedAgents(
  settings: UltraworkSettings | undefined,
): readonly string[] {
  return asStringList(settings?.verification?.scopeCheckAllowedAgents)
    ?? [...CHANGE_SCOPE_CHECK_ALLOWED_AGENTS];
}

export function isChangeScopeCheckAllowedAgent(
  agent: string | undefined,
  allowedAgents: readonly string[] = CHANGE_SCOPE_CHECK_ALLOWED_AGENTS,
): boolean {
  return typeof agent === "string"
    && (allowedAgents as readonly string[]).includes(agent);
}
