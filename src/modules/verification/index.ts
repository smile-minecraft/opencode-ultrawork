/**
 * verification 模組：verification_run、change-scope-check。
 *
 * 開關開啟時註冊兩個工具；關閉時完全不碰宿主。
 * 工具定義在宿主註冊前先建好，保持同步、可重播、無副作用。
 */

import type { HostRegistration } from "../../host.ts";
import type { ModuleDefinition, ModuleRuntime } from "../types.ts";
import { createChangeScopeCheckTool } from "./change-scope-check.ts";
import { resolveChangeScopeCheckAllowedAgents } from "./scope-check-policy.ts";
import { createVerificationRunTool } from "./verification-run.ts";
import { resolveVerificationRunAllowedAgents } from "./verification-policy.ts";

export const verificationModule: ModuleDefinition = {
  key: "verification",
  register: (runtime: ModuleRuntime): Promise<HostRegistration> => {
    // 授權清單由設定解出（沒寫或寫壞都回內建預設）：register 時快照一次，
    // 之後改設定要重載才生效（與模組開關同一語意）。
    const verificationRunTool = createVerificationRunTool(
      runtime.host,
      resolveVerificationRunAllowedAgents(runtime.settings),
    );
    const changeScopeCheckTool = createChangeScopeCheckTool(
      runtime.host,
      resolveChangeScopeCheckAllowedAgents(runtime.settings),
    );
    return runtime.host.tools.install([verificationRunTool, changeScopeCheckTool]);
  },
};
