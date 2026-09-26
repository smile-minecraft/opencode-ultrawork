/** change-scope-check 的 runtime 授權角色單一定義位置。 */
export const CHANGE_SCOPE_CHECK_ALLOWED_AGENTS = ["build", "ultra"] as const;

export function isChangeScopeCheckAllowedAgent(agent: string | undefined): boolean {
  return typeof agent === "string"
    && (CHANGE_SCOPE_CHECK_ALLOWED_AGENTS as readonly string[]).includes(agent);
}
