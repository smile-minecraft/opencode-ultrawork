/**
 * commentSignal 模組：7 個 comment_signal_* 工具＋AI_DO_NOT_EDIT:P0 阻斷。
 *
 * 開關開啟時註冊 7 個工具、`execute.before`／`execute.after` hook，
 * 以及 session.created／session.updated 的父子對應事件迴圈；
 * 關閉時完全不碰 ctx。工具定義在 transform 外先建好，
 * transform 回呼只做 editor.add，保持同步、可重播、無副作用；
 * 回傳的註冊由外掛卸載時 dispose（工具、hook、事件迴圈都不再存在）。
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { resolveDirectoryCandidates, resolveSessionDirectory } from "./session-root.ts";
import { CommentSignalStore, STATE_LOCK_FILENAME } from "./state.ts";
import { assertSafeLockPath, resolveCanonicalInsideWorktree } from "./containment.ts";
import type { ModuleDefinition, ModuleRuntime, Registration } from "../types.ts";
import { createCommentSignalBaselineTool, createCommentSignalOnlyNewTool, createCommentSignalSuppressTool } from "./baseline-tools.ts";
import { inspectDirectoryListing, isScannableExplicitPath, listDirectoryFiles, toPolicyRelativePath } from "./file-scan.ts";
import {
  FILE_MODIFYING_TOOLS,
  extractFilePathsFromArgs,
  isMarkdownPath,
  makeGuardAfterEdit,
  makeGuardBeforeEdit,
} from "./hook-adapter.ts";
import { createCommentSignalCheckTool } from "./tool-check.ts";
import type { CommentSignalToolDeps } from "./tool-deps.ts";
import { createCommentSignalExplainTool } from "./tool-explain.ts";
import { createCommentSignalPolicyTool } from "./tool-policy.ts";
import { createCommentSignalTouchedReportTool } from "./tool-touched-report.ts";

function buildDeps(ctx: Plugin.Context, store: CommentSignalStore): CommentSignalToolDeps {
  const sourceResolver = (worktree: string, filePath: string): string | null => {
    // lexical＋canonical 雙層 containment：symlink 逃逸直接丟錯（fail closed）。
    const absolute = resolveCanonicalInsideWorktree(filePath, worktree);
    try {
      return readFileSync(absolute, "utf-8");
    } catch {
      return null;
    }
  };
  const directoryResolver = (worktree: string, dirPath: string): string[] | null => {
    resolveCanonicalInsideWorktree(dirPath, worktree);
    return listDirectoryFiles(worktree, dirPath);
  };
  const directoryInspector = (worktree: string, dirPath: string): string | null => {
    resolveCanonicalInsideWorktree(dirPath, worktree);
    return inspectDirectoryListing(worktree, dirPath);
  };
  return {
    sourceResolver,
    directoryResolver,
    directoryInspector,
    store,
    resolveRoot: (toolCtx) => resolveSessionDirectory(ctx, toolCtx),
  };
}

interface SessionEventData {
  sessionID?: unknown;
  parentID?: unknown;
}

/** 模組自己的事件迴圈：父子對應註冊＋刪除清理；abort 時結束。 */
async function watchCommentSignalEvents(
  ctx: Pick<Plugin.Context, "event">,
  store: CommentSignalStore,
  signal: AbortSignal,
): Promise<void> {
  try {
    for await (const event of ctx.event.subscribe({ signal })) {
      const type = (event as { type?: unknown }).type;
      const data = (event as { data?: unknown }).data as SessionEventData | null | undefined;
      if (type === "session.created" || type === "session.updated") {
        const sessionID = data?.sessionID;
        const parentID = data?.parentID;
        if (typeof sessionID === "string" && typeof parentID === "string" && parentID.trim()) {
          await store.registerSessionParent(sessionID, parentID);
        }
        continue;
      }
      if (type === "session.deleted") {
        const sessionID = data?.sessionID;
        if (typeof sessionID === "string") await store.clearSession(sessionID);
      }
    }
  } catch {
    // 中止或連線中斷時結束迴圈，不影響外掛其他部分。
  }
}

export const commentSignalModule: ModuleDefinition = {
  key: "commentSignal",
  register: async (runtime: ModuleRuntime): Promise<Registration> => {
    const ctx = runtime.ctx;
    const store = new CommentSignalStore(ctx.storage, {
      // 跨行程序列化：鎖檔放 `.ultrawork/cache/locks/`，基底依序嘗試
      // 工作階段位置 → 專案位置 → 外掛實例位置（第一個建得起鎖目錄者）。
      // 全失敗回 null（withFileLock 轉安全預設＋警告，不寫入）。
      resolveLockDir: async (sessionID) => {
        let candidates: string[] = [];
        try {
          candidates = await resolveDirectoryCandidates(ctx, { sessionID });
        } catch {
          return null;
        }
        for (const base of candidates) {
          try {
            const lockDir = join(base, ".ultrawork", "cache", "locks");
            const lockPath = join(lockDir, STATE_LOCK_FILENAME);
            assertSafeLockPath(lockDir, lockPath);
            mkdirSync(lockDir, { recursive: true });
            return lockDir;
          } catch {
            // 此候選不可寫，試下一個。
          }
        }
        return null;
      },
    });
    const deps = buildDeps(ctx, store);

    const guardBeforeEdit = makeGuardBeforeEdit({
      sourceResolver: deps.sourceResolver,
      recordWarning: (sessionID, warning) => store.recordWarning(sessionID, warning).then(() => undefined),
      recordLastReport: (sessionID, report) =>
        store.recordLastReport(sessionID, report as never).then(() => undefined),
    });
    const guardAfterEdit = makeGuardAfterEdit({
      sourceResolver: deps.sourceResolver,
      recordWarning: (sessionID, warning) => store.recordWarning(sessionID, warning).then(() => undefined),
      recordLastReport: (sessionID, report) =>
        store.recordLastReport(sessionID, report as never).then(() => undefined),
    });

    // 工具定義在 transform 外先建好；回呼只做 editor.add。
    const checkTool = createCommentSignalCheckTool(deps);
    const policyTool = createCommentSignalPolicyTool(deps);
    const touchedReportTool = createCommentSignalTouchedReportTool(deps);
    const explainTool = createCommentSignalExplainTool(deps);
    const baselineTool = createCommentSignalBaselineTool(deps);
    const suppressTool = createCommentSignalSuppressTool(deps);
    const onlyNewTool = createCommentSignalOnlyNewTool(deps);

    const transformRegistration = await ctx.tool.transform((editor) => {
      editor.add(checkTool as never);
      editor.add(policyTool as never);
      editor.add(touchedReportTool as never);
      editor.add(explainTool as never);
      editor.add(baselineTool as never);
      editor.add(suppressTool as never);
      editor.add(onlyNewTool as never);
    });

    const beforeRegistration = await ctx.tool.hook("execute.before", async (event) => {
      const toolName = (event as { tool?: unknown }).tool;
      if (typeof toolName !== "string" || !FILE_MODIFYING_TOOLS.includes(toolName)) return;
      const sessionID = (event as { sessionID?: unknown }).sessionID;
      if (typeof sessionID !== "string" || !sessionID) return;
      const filePaths = extractFilePathsFromArgs((event as { input?: unknown }).input);
      if (filePaths.length === 0) {
        // 抽不到目標路徑＝異常 args（edit／write 缺 path、patch 缺／壞 patchText）：
        // 靜默放行等於跳過修改前檢查，改 fail closed 直接阻斷。
        throw new Error(
          `Comment Signal guard: ${toolName} 未提供可解析的檔案路徑（input 缺少 path／patchText），已阻斷執行以避免跳過修改前檢查。`,
        );
      }
      const worktree = await resolveSessionDirectory(ctx, { sessionID });
      for (const filePath of filePaths) {
        if (isMarkdownPath(filePath)) continue;
        // 跟掃描政策一致：敏感／dotfile／不支援副檔名不讀不查（跳過，不 throw）。
        // 路徑先 canonical 化再判定（symlink 別名現形）。
        if (!isScannableExplicitPath(toPolicyRelativePath(worktree, filePath))) continue;
        // 越界路徑直接丟錯（lexical＋canonical 雙層，跟舊版雙重保險一致，fail closed）。
        resolveCanonicalInsideWorktree(filePath, worktree);
        await guardBeforeEdit(sessionID, filePath, worktree);
      }
    });

    const afterRegistration = await ctx.tool.hook("execute.after", async (event) => {
      const shaped = event as { status?: unknown; tool?: unknown; sessionID?: unknown; input?: unknown };
      if (shaped.status !== "completed") return;
      if (typeof shaped.tool !== "string" || !FILE_MODIFYING_TOOLS.includes(shaped.tool)) return;
      if (typeof shaped.sessionID !== "string" || !shaped.sessionID) return;
      const filePaths = extractFilePathsFromArgs(shaped.input);
      if (filePaths.length === 0) return;
      const worktree = await resolveSessionDirectory(ctx, { sessionID: shaped.sessionID });
      for (const filePath of filePaths) {
        if (isMarkdownPath(filePath)) continue;
        // 跟掃描政策一致：敏感／dotfile／不支援副檔名不記錄、不讀（跳過）。
        // 路徑先 canonical 化再判定（symlink 別名現形）。
        if (!isScannableExplicitPath(toPolicyRelativePath(worktree, filePath))) continue;
        try {
          // canonical containment：symlink 逃逸不記錄、不掃（跟 before 一致）。
          resolveCanonicalInsideWorktree(filePath, worktree);
          await store.recordModifiedFile(shaped.sessionID, filePath);
          await guardAfterEdit(shaped.sessionID, filePath, worktree);
        } catch {
          // 單檔失敗不影響其他檔案（跟舊版一致）。
        }
      }
    });

    const controller = new AbortController();
    const eventLoop = watchCommentSignalEvents(ctx, store, controller.signal);

    return {
      dispose: async () => {
        controller.abort();
        await eventLoop;
        await afterRegistration.dispose();
        await beforeRegistration.dispose();
        await transformRegistration.dispose();
      },
    };
  },
};

// ─── 附加式匯出（diagnostics 模組的唯讀健康訊號需要） ────────────
//
// workflow_health_check 要讀問題快照與屏蔽清單算健康訊號。comment-signal 開關
// 關閉時診斷端會自行把這些檢查標成 skipped，這裡只把既有讀取函式與檔名常數
// 再匯出一次，不改任何行為。

export { readBaseline, readSuppressionStore } from "./baseline.ts";
export type { CommentSignalBaseline, CommentSignalSuppressionStore } from "./baseline.ts";
export { BASELINE_FILENAME, SUPPRESSIONS_FILENAME, resolveMemoryDir } from "./baseline-tools.ts";
