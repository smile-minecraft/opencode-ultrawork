import type { Host } from "../../../host.ts";
import type { UltraworkSettings } from "../../../settings/defaults.ts";
import { isModuleEnabled } from "../../registry.ts";
import { aggregateCommentSignalGate, describeGateBlock } from "../../comment-signal/completion-gate.ts";
import type { KeyValueStorage } from "../../../state/store.ts";
import type { ProjectBinding, Task, TasksRegistry } from "../core/types.ts";
import { createEmptyTasksRegistryLeaf, normalizeTasksRegistryLeaf } from "../registry/task-registry.ts";
import { createRuntimeContext, type FullUltraworkRuntimeContext } from "./context-builder.ts";
import type { RegistryIOOptions } from "./registry-io.ts";
import { createSessionBindingStore, type SessionBindingStore } from "./session-binding.ts";

export function createWorkflowRuntime(
  host: Host,
  settings: UltraworkSettings,
  registryIO?: RegistryIOOptions,
): FullUltraworkRuntimeContext & { sessionBindings: SessionBindingStore } {
  const projectRoot = host.roots.projectDirectory ?? host.roots.instanceDirectory;
  const input: Parameters<typeof createRuntimeContext>[0]["input"] = {
    ...(projectRoot ? { directory: projectRoot } : {}),
  };
  const options = { projectRoot };
  const globalMemoryRoot = host.roots.globalConfigDirectory;
  const writerAgents = [...settings.memory.writerAgents];
  let runtime!: FullUltraworkRuntimeContext;

  const createEmptyTasksRegistry = (project?: ProjectBinding): TasksRegistry =>
    createEmptyTasksRegistryLeaf(project ?? runtime.getCurrentProject());
  const normalizeTasksRegistry = (
    raw: unknown,
    project?: ProjectBinding,
    protectedTaskIds: ReadonlySet<string> = new Set(),
  ): TasksRegistry => normalizeTasksRegistryLeaf(raw, project ?? runtime.getCurrentProject(), protectedTaskIds);

  runtime = createRuntimeContext({
    input,
    options,
    registryIO,
    writerAgents,
    globalMemoryRoot,
    createEmptyTasksRegistry,
    normalizeTasksRegistry,
  });
  const storage = host.storage as KeyValueStorage;
  const sessionBindings = createSessionBindingStore(storage);
  // 開關一律走 registry 的單一判斷（只有 boolean false 算關）：
  // 直接用 truthy 的話，0／"" 這類非預期值會跟 registry 結論相反。
  const memoryRequired =
    isModuleEnabled(settings, "memory") && settings.workflow.completion.requireMemoryDisposition;

  runtime.memoryDispositionRequired = memoryRequired;

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

  return Object.assign(runtime, { sessionBindings });
}
