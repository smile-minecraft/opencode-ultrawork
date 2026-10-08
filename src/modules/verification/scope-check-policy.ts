/**
 * change-scope-check 的 runtime 授權角色單一定義位置。
 *
 * 清單由設定指定（verification.scopeCheckAllowedAgents）；未設定或值無效時保持空清單，
 * 確保授權解析不會引入固定角色 fallback。
 */

import type { UltraworkSettings } from "../../settings/defaults.ts";
import { asStringList } from "../../settings/validate.ts";

/** 從設定解出實際生效的授權清單；沒寫或寫壞都維持空清單。 */
export function resolveChangeScopeCheckAllowedAgents(
  settings: UltraworkSettings | undefined,
): readonly string[] {
  return asStringList(settings?.verification?.scopeCheckAllowedAgents)
    ?? [];
}

export function isChangeScopeCheckAllowedAgent(
  agent: string | undefined,
  allowedAgents: readonly string[],
): boolean {
  return typeof agent === "string"
    && allowedAgents.includes(agent);
}
