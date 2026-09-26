/** 共用工具箱的公開介面。 */

export { atomicWriteFile, atomicWriteFileWithOps, type AtomicWriteOps } from "./atomic-write.ts";
export {
  defineTool,
  type DefinedTool,
  type DefineToolInput,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "./define-tool.ts";
export { jsonError, jsonResult, type ToolResponse } from "./json.ts";
export { formatNumberedLines, truncateLine, type NumberedLine } from "./lines.ts";
export {
  AssertPathOutsideWorktree,
  assertContainedPath,
  assertSafeWorktreePath,
  isInsideWorktree,
  resolveInsideWorktree,
} from "./path-guard.ts";
export {
  ContentLockBusyError,
  diagnoseContentWriteLock,
  withContentWriteLock,
} from "./write-lock.ts";
