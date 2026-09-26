/**
 * comment-signal 原生測試共用 helper。
 *
 * 用 setupUltrawork(fake.ctx, { modules: [commentSignalModule] }) 註冊模組，
 * 從 fake.added 取工具執行；workspace 在 os.tmpdir() 下建立。
 * store 跟工具共用同一份 fake.storage，所以測試可直接寫入
 * modifiedFiles／parent 對應再呼叫工具驗證。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupUltrawork } from "../../../../src/index.ts";
import { commentSignalModule } from "../../../../src/modules/comment-signal/index.ts";
import { CommentSignalStore } from "../../../../src/modules/comment-signal/state.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../../_fake-v2-context.ts";

export function createWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "uw-comment-signal-"));
  return {
    root,
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // 清理失敗不擋測試結果
      }
    },
  };
}

export interface CommentSignalFixture {
  fake: ReturnType<typeof createFakeV2Context>;
  cleanup: () => Promise<void>;
  tools: Record<string, any>;
  store: CommentSignalStore;
}

export async function setupCommentSignal(directory: string): Promise<CommentSignalFixture> {
  const fake = createFakeV2Context({ directory });
  const cleanup = await setupUltrawork(fake.ctx, { modules: [commentSignalModule] });
  const tools: Record<string, any> = Object.fromEntries([...fake.added.entries()]);
  const store = new CommentSignalStore(fake.ctx.storage as never);
  return { fake, cleanup, tools, store };
}

export function expectToolsRegistered(tools: Record<string, any>): void {
  for (const name of [
    "comment_signal_check",
    "comment_signal_policy",
    "comment_signal_touched_report",
    "comment_signal_explain",
    "comment_signal_baseline",
    "comment_signal_suppress",
    "comment_signal_only_new",
  ]) {
    if (!tools[name]) throw new Error(`commentSignal 工具沒有註冊：${name}`);
  }
}

/** 把工具執行結果（{ content } JSON 外框）攤平成舊測試的斷言形狀。 */
export function parse(result: { content: string }): any {
  const parsed = JSON.parse(result.content) as Record<string, unknown>;
  if (parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
    for (const [key, value] of Object.entries(parsed.data)) {
      if (!(key in parsed)) {
        Object.defineProperty(parsed, key, { configurable: true, enumerable: false, value });
      }
    }
    if (parsed.ok === false && typeof parsed.summary === "string" && !("error" in parsed)) {
      Object.defineProperty(parsed, "error", { configurable: true, enumerable: false, value: parsed.summary });
    }
  }
  return parsed;
}

export async function run(tool: any, args: Record<string, unknown>, sessionID = "s1"): Promise<any> {
  return parse(await tool.execute(args, fakeV2ToolContext(sessionID)));
}

/** 在測試 workspace 內寫檔（自動建中間目錄）。 */
export async function writeSource(root: string, relativePath: string, body: string): Promise<void> {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const parts = relativePath.split("/");
  if (parts.length > 1) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, relativePath), body, "utf-8");
}
