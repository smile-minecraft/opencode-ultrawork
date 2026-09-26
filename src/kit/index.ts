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
  isSensitivePath,
  isUnsafeRoot,
  resolveInsideWorktree,
} from "./path-guard.ts";
export {
  CONTENT_LOCK_STALE_SECONDS,
  ContentLockBusyError,
  contentLockBusyGuidance,
  diagnoseContentWriteLock,
  diagnoseReclaimTicket,
  reclaimTicketPathFor,
  releaseStaleContentWriteLock,
  withContentWriteLock,
  type ContentWriteLockOptions,
  type LockPayload,
  type ReclaimTicketReadOps,
  type ReclaimTicketStatus,
  type StaleLockRelease,
  type WriteLockReclaimHooks,
} from "./write-lock.ts";
