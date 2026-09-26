/**
 * verification 模組：verification_run、change-scope-check。
 *
 * 開關開啟時註冊兩個工具；關閉時完全不碰 ctx。
 * 工具定義在 transform 外先建好，transform 回呼只做 editor.add，
 * 保持同步、可重播、無副作用；回傳的註冊由外掛卸載時 dispose。
 */

import type { ModuleDefinition, ModuleRuntime, Registration } from "../types.ts";
import { createChangeScopeCheckTool } from "./change-scope-check.ts";
import { createVerificationRunTool } from "./verification-run.ts";

export const verificationModule: ModuleDefinition = {
  key: "verification",
  register: (runtime: ModuleRuntime): Promise<Registration> => {
    const verificationRunTool = createVerificationRunTool(runtime.ctx);
    const changeScopeCheckTool = createChangeScopeCheckTool(runtime.ctx);
    return runtime.ctx.tool.transform((editor) => {
      editor.add(verificationRunTool as never);
      editor.add(changeScopeCheckTool as never);
    });
  },
};
