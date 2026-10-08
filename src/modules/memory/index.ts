/**
 * memory 模組：兩層記憶（全域與專案）的 7 個工具與 context 注入。
 *
 * 設計依據：`docs/memory-redesign.md`。
 * - 工具：memory-search、memory-read、memory-note（所有 agent）；memory-task-close
 *   （所有 agent，但 recorded 與高風險任務限 writer）；memory-extract、memory-write、
 *   memory-maintain（限 `memory.writerAgents` 授權者）。權限在工具內強制檢查。
 * - context 注入：每個工作階段開場算一次快照，之後固定不變（見 `snapshot.ts`）。
 * - 結案檢查的驗證邏輯在 `disposition.ts`，由 workflow 的 task-state-sync 呼叫。
 *
 * 開關關閉時完全不碰宿主（`registerModules` 不會呼叫本檔）。
 */

import { ensureMemoryStoreMigrated } from "../../migrate/memory-store.ts";
import type { ModuleDefinition } from "../types.ts";
import { createWorkflowRuntime } from "../workflow/runtime/v2-runtime.ts";
import { createTaskContentReadTool } from "../workflow/tools/task-content.ts";
import { memoryLayers } from "./layers.ts";
import { budgetForLayer } from "./constants.ts";
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
    const { host, settings } = runtime;
    const globalRoot = host.roots.globalConfigDirectory;

    const deps: MemoryToolDeps = {
      globalRoot,
      writerAgents: [...settings.memory.writerAgents],
      // 手刻的 settings（例如測試）可能缺 budget：走 budgetForLayer 退回預設，
      // 與其他使用端同一條邊界（見 constants.ts 的說明）。
      budgets: {
        global: { ...budgetForLayer(settings.memory.budget, "global") },
        project: { ...budgetForLayer(settings.memory.budget, "project") },
      },
      resolveRoot: (context) => resolveSessionDirectory(host, context),
      ensureMigrated: ensureMemoryStoreMigrated,
      async taskMaterials(taskId, root, context): Promise<TaskMaterials | null> {
        // 以工作階段位置建立 workflow runtime：subagent 可能在跟外掛實例不同的專案裡工作，
        // 用外掛實例的位置會讀到別的專案的任務。
        const localHost = {
          ...host,
          roots: { ...host.roots, projectDirectory: root },
        };
        const workflow = createWorkflowRuntime(localHost, settings);
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
    const toolRegistration = await host.tools.install(tools);
    if (!settings.memory.inject) return toolRegistration;

    const snapshot = createMemorySnapshotStore(host.storage);
    const contextRegistration = await host.sessions.hook("context", async (event) => {
      if (!Array.isArray(event.system)) return;
      if (event.system.some((part) => String(part?.text ?? "").includes(MEMORY_MARKER))) return;
      try {
        const root = await resolveSessionDirectory(host, { sessionID: event.sessionID });
        const layers = memoryLayers(root, globalRoot);
        const text = await snapshot(event.sessionID, async () => {
          // 舊專案第一次開工作階段就先遷移；遷移失敗時只注入全域層，不擋工作階段。
          const migrated = await ensureMemoryStoreMigrated(root);
          return renderMemorySnapshot(
            migrated ? layers : layers.filter((layer) => layer.layer !== "project"),
            deps.budgets,
            deps.writerAgents,
          );
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
