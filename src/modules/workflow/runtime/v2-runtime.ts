import type { Plugin } from "@opencode/plugin";
import type { UltraworkSettings } from "../../../settings/defaults.ts";
import { isModuleEnabled } from "../../registry.ts";
import { aggregateCommentSignalGate, describeGateBlock } from "../../comment-signal/completion-gate.ts";
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
  // 開關一律走 registry 的單一判斷（只有 boolean false 算關）：
  // 直接用 truthy 的話，0／"" 這類非預期值會跟 registry 結論相反。
  const memoryRequired =
    isModuleEnabled(settings, "memory") && settings.workflow.completion.requireMemoryReceipt;

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
    if (!isModuleEnabled(settings, "commentSignal")) return { ok: true, status: "disabled" };
    const id = sessionID?.trim();
    if (!id) return { ok: true, status: "not-reported" };
    // 聚合判定交給 Comment Signal 模組的單一純函式（comment-signal／
    // state.ts 也走同一支），這裡不複製規則：規則只存在一份，就不會
    // 出現「工具擋了但 gate 放行」或反過來的落差。
    const stored = await storage.get(`session/${id}/comment-signal`);
    const gate = aggregateCommentSignalGate(stored);
    if (gate.status === "blocked") {
      return {
        ok: false,
        code: "COMMENT_SIGNAL_BLOCKED",
        error: describeGateBlock(gate),
      };
    }
    return { ok: true, status: gate.status };
  };

  return runtime;
}
