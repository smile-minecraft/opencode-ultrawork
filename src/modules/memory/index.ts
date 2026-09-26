/**
 * memory 模組：兩層記憶（全域與專案）的 7 個工具與 context 注入。
 *
 * 設計依據：`docs/memory-redesign.md`。
 * - 工具：memory-search、memory-read、memory-note（所有 agent）；memory-task-close
 *   （所有 agent，但 recorded 與高風險任務限 writer）；memory-extract、memory-write、
 *   memory-maintain（限 writer，預設 memorizer）。權限在工具內強制檢查。
 * - context 注入：每個工作階段開場算一次快照，之後固定不變（見 `snapshot.ts`）。
 * - 結案檢查的驗證邏輯在 `disposition.ts`，由 workflow 的 task-state-sync 呼叫。
 *
 * 開關關閉時完全不碰 ctx（`registerModules` 不會呼叫本檔）。
 */

import { homedir } from "node:os";
import { ensureMemoryStoreMigrated } from "../../migrate/memory-store.ts";
import { resolveGlobalConfigDir } from "../../settings/paths.ts";
import type { ModuleDefinition } from "../types.ts";
import { createWorkflowRuntime } from "../workflow/runtime/v2-runtime.ts";
import { createTaskContentReadTool } from "../workflow/tools/task-content.ts";
import { memoryLayers } from "./layers.ts";
import { resolveSessionDirectory } from "./session-root.ts";
import { createMemorySnapshotStore, MEMORY_MARKER, renderMemorySnapshot } from "./snapshot.ts";
import { createMemoryExtractTool } from "./tools/memory-extract.ts";
import { createMemoryMaintainTool } from "./tools/memory-maintain.ts";
import { createMemoryNoteTool } from "./tools/memory-note.ts";
import { createMemoryReadTool } from "./tools/memory-read.ts";
import { createMemorySearchTool } from "./tools/memory-search.ts";
import { createMemoryTaskCloseTool } from "./tools/memory-task-close.ts";
import { createMemoryWriteTool } from "./tools/memory-write.ts";
import type { MemoryToolDeps, TaskMaterials } from "./tools/shared.ts";

export const memoryModule: ModuleDefinition = {
  key: "memory",
  async register(runtime) {
    const { ctx, settings } = runtime;
    // 全域設定資料夾的解析規則與外掛入口、skiller 相同：ctx.options.globalDir 優先。
    const options = (ctx.options ?? {}) as Record<string, unknown>;
    const globalRoot =
      typeof options.globalDir === "string"
        ? options.globalDir
        : resolveGlobalConfigDir(process.env as Record<string, string | undefined>, homedir());

    const deps: MemoryToolDeps = {
      globalRoot,
      writerAgents: [...settings.memory.writerAgents],
      resolveRoot: (context) => resolveSessionDirectory(ctx, context),
      ensureMigrated: ensureMemoryStoreMigrated,
      async taskMaterials(taskId, root, context): Promise<TaskMaterials | null> {
        // 以工作階段位置建立 workflow runtime：subagent 可能在跟外掛實例不同的專案裡工作，
        // 用外掛實例的位置會讀到別的專案的任務。
        const project = ctx.location.project ? { ...ctx.location.project, directory: root } : undefined;
        const localCtx = Object.assign(Object.create(ctx), {
          location: { ...ctx.location, directory: root, ...(project ? { project } : {}) },
        });
        const workflow = createWorkflowRuntime(localCtx, settings);
        const registry = workflow.readRegistry(context, false);
        const task = registry.tasks[taskId];
        if (!task || task.projectPath !== registry.projectPath || task.projectId !== registry.projectId) return null;

        // 任務內容走 workflow 既有的讀取工具，沿用它的路徑守衛與 section／file 模式判斷。
        const readContent = createTaskContentReadTool(workflow);
        const contentResult = JSON.parse((await readContent.execute({ taskId }, context)).content);
        const candidate = contentResult.data?.content ?? contentResult.data?.sectionContent;
        const content = typeof candidate === "string" ? candidate : "";

        const plan = task.planId ? workflow.readPlansRegistry(context, false).plans[task.planId] : undefined;
        let section: unknown;
        if (plan) {
          const sectionResult = JSON.parse((await readContent.execute({ taskId, source: "section" }, context)).content);
          section = sectionResult.data?.sectionContent;
        }
        return {
          task: { ...task },
          content,
          plan: plan ? { title: plan.title, state: plan.state, section } : undefined,
          warnings: contentResult.ok ? [] : [contentResult.summary],
        };
      },
    };

    const tools = [
      createMemorySearchTool(deps),
      createMemoryReadTool(deps),
      createMemoryNoteTool(deps),
      createMemoryExtractTool(deps),
      createMemoryWriteTool(deps),
      createMemoryMaintainTool(deps),
      createMemoryTaskCloseTool(deps),
    ];
    const toolRegistration = await ctx.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool as never);
    });
    if (!settings.memory.inject) return toolRegistration;

    const snapshot = createMemorySnapshotStore(ctx.storage);
    const contextRegistration = await ctx.session.hook("context", async (event) => {
      if (!Array.isArray(event.system)) return;
      if (event.system.some((part) => String(part?.text ?? "").includes(MEMORY_MARKER))) return;
      try {
        const root = await resolveSessionDirectory(ctx, { sessionID: event.sessionID });
        const layers = memoryLayers(root, globalRoot);
        const text = await snapshot(event.sessionID, async () => {
          // 舊專案第一次開工作階段就先遷移；遷移失敗時只注入全域層，不擋工作階段。
          const migrated = await ensureMemoryStoreMigrated(root);
          return renderMemorySnapshot(migrated ? layers : layers.filter((layer) => layer.layer !== "project"));
        });
        event.system.push({ type: "text", text });
      } catch {
        // unsafe root 或記憶讀不到時不注入；記憶只是輔助，不能讓請求失敗。
      }
    });

    return {
      async dispose() {
        await contextRegistration.dispose();
        await toolRegistration.dispose();
      },
    };
  },
};

export { resolveSessionDirectory, type MemoryRootResolver } from "./session-root.ts";
