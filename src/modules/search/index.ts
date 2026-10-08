/**
 * search 模組：peek_file、grep_context。
 *
 * 開關開啟時註冊兩個唯讀搜尋工具；關閉時完全不碰宿主。
 * 工具定義在宿主註冊前先建好，保持同步、可重播、無副作用。
 */

import type { ToolExecutionContext } from "../../kit/define-tool.ts";
import type { HostRegistration } from "../../host.ts";
import type { ModuleDefinition, ModuleRuntime } from "../types.ts";
import { createGrepContextTool } from "./grep-context.ts";
import { createPeekFileTool } from "./peek-file.ts";
import { resolveWorktreeRoot } from "./search-utils.ts";

export const searchModule: ModuleDefinition = {
  key: "search",
  register: (runtime: ModuleRuntime): Promise<HostRegistration> => {
    const resolveRoot = (toolCtx: ToolExecutionContext): Promise<string> =>
      resolveWorktreeRoot(runtime.host, toolCtx);
    const peekFileTool = createPeekFileTool(resolveRoot);
    const grepContextTool = createGrepContextTool(resolveRoot, runtime.host.capabilities.process);
    return runtime.host.tools.install([peekFileTool, grepContextTool]);
  },
};
