/**
 * search 模組：peek_file、grep_context。
 *
 * 開關開啟時註冊兩個唯讀搜尋工具；關閉時完全不碰 ctx。
 * 工具定義在 transform 外先建好，transform 回呼只做 editor.add，
 * 保持同步、可重播、無副作用；回傳的註冊由外掛卸載時 dispose。
 */

import type { ToolExecutionContext } from "../../kit/define-tool.ts";
import type { ModuleDefinition, ModuleRuntime, Registration } from "../types.ts";
import { createGrepContextTool } from "./grep-context.ts";
import { createPeekFileTool } from "./peek-file.ts";
import { resolveWorktreeRoot } from "./search-utils.ts";

export const searchModule: ModuleDefinition = {
  key: "search",
  register: (runtime: ModuleRuntime): Promise<Registration> => {
    const resolveRoot = (toolCtx: ToolExecutionContext): Promise<string> =>
      resolveWorktreeRoot(runtime.ctx, toolCtx);
    const peekFileTool = createPeekFileTool(resolveRoot);
    const grepContextTool = createGrepContextTool(resolveRoot);
    return runtime.ctx.tool.transform((editor) => {
      editor.add(peekFileTool as never);
      editor.add(grepContextTool as never);
    });
  },
};
