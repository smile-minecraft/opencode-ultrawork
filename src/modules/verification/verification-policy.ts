/**
 * verification_run 授權角色的單一定義位置。
 *
 * 這是兩層防護的其中一層：agent 權限設定是第一層，這裡的 runtime 檢查是
 * 第二層（即使第一層被繞過仍擋得住）。兩層不是重複定義——移掉任一層都等於少一道。
 *
 * 限制：純常數 / pure module，不引入 IO 或 runtime helper。
 */

export const VERIFICATION_RUN_ALLOWED_AGENTS = ["momus"] as const;

export function isVerificationRunAllowedAgent(agent: string | undefined): boolean {
  return typeof agent === "string"
    && (VERIFICATION_RUN_ALLOWED_AGENTS as readonly string[]).includes(agent);
}
