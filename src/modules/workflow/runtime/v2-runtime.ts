import type { Plugin } from "@opencode/plugin";
import type { UltraworkSettings } from "../../../settings/defaults.ts";
import { validateReceiptForCompletion } from "../../memory/index.ts";
import type { KeyValueStorage } from "../../../state/store.ts";
import type { ProjectBinding, Task, TasksRegistry } from "../core/types.ts";
import { createEmptyTasksRegistryLeaf, normalizeTasksRegistryLeaf } from "../registry/task-registry.ts";
import { createRuntimeContext, type FullUltraworkRuntimeContext } from "./context-builder.ts";
import type { RegistryIOOptions } from "./registry-io.ts";
import { configureSessionBindingStore } from "./session-binding.ts";

export function createWorkflowRuntime(
  ctx: Plugin.Context,
  settings: UltraworkSettings,
  registryIO?: RegistryIOOptions,
): FullUltraworkRuntimeContext {
  const input = { directory: ctx.location.project?.directory ?? ctx.location.directory } as unknown as Parameters<typeof createRuntimeContext>[0]["input"];
  const options = { projectRoot: ctx.location.project?.directory ?? ctx.location.directory };
  let runtime!: FullUltraworkRuntimeContext;

  const createEmptyTasksRegistry = (project?: ProjectBinding): TasksRegistry =>
    createEmptyTasksRegistryLeaf(project ?? runtime.getCurrentProject());
  const normalizeTasksRegistry = (
    raw: unknown,
    project?: ProjectBinding,
    protectedTaskIds: ReadonlySet<string> = new Set(),
  ): TasksRegistry => normalizeTasksRegistryLeaf(raw, project ?? runtime.getCurrentProject(), protectedTaskIds);

  runtime = createRuntimeContext({ input, options, registryIO, createEmptyTasksRegistry, normalizeTasksRegistry });
  const storage = ctx.storage as KeyValueStorage;
  configureSessionBindingStore(storage);
  const memoryRequired = settings.modules.memory && settings.workflow.completion.requireMemoryReceipt;

  runtime.memoryReceiptRequired = memoryRequired;
  runtime.validateMemoryReceiptForTask = (receiptId, task, project, context) => {
    if (!memoryRequired) {
      return {
        ok: true,
        receipt: {
          taskId: task.taskId,
          projectId: project.projectId,
          projectPath: project.projectPath,
          status: "disabled",
          createdAt: new Date().toISOString(),
          zeroExtractionReason: "memory 模組未啟用",
        },
      };
    }
    const root = runtime.resolveProjectRoot(context);
    return validateReceiptForCompletion(root, receiptId, { taskId: task.taskId }, project);
  };

  runtime.validateCommentSignalForCompletion = async (sessionID) => {
    if (!settings.modules.commentSignal) return { ok: true, status: "disabled" };
    const id = sessionID?.trim();
    if (!id) return { ok: true, status: "not-reported" };
    const value = await storage.get(`session/${id}/comment-signal`) as { lastReport?: { shouldBlockCompletion?: unknown } } | undefined;
    const report = value?.lastReport;
    if (!report || typeof report.shouldBlockCompletion !== "boolean") {
      return { ok: true, status: "not-reported" };
    }
    if (report.shouldBlockCompletion) {
      return {
        ok: false,
        code: "COMMENT_SIGNAL_BLOCKED",
        error: "Comment Signal 發現尚未排除的註解必要檢查問題，不能完成任務。",
      };
    }
    return { ok: true, status: "passed" };
  };

  return runtime;
}
