import type { ModuleDefinition, ModuleRuntime, Registration } from "../types.ts";
import { SessionStateStore } from "../../state/store.ts";
import { createWorkflowRuntime } from "./runtime/v2-runtime.ts";
import { createWorkOrderStore } from "./tools/work-order-store.ts";
import { createEscalationTracker } from "./gates/escalation.ts";
import {
  EVIDENCE_PACK_GATED_SUBAGENTS,
  EVIDENCE_PACK_SECTION_NUMBERS,
  EVIDENCE_PACK_SECTIONS,
  formatEvidencePackErrors,
  normalizeHeadingLevels,
  validateEvidencePack,
} from "./gates/evidence-pack.ts";
import { formatEscalationRejection } from "./gates/escalation.ts";
import { clearSessionBinding, isSessionTaskBound } from "./runtime/session-binding.ts";
import { createTaskStateSyncTool } from "./tools/task-state-sync.ts";
import { createTaskContentReadTool, createTaskContentUpdateTool } from "./tools/task-content.ts";
import { createPlanStateSyncTool } from "./tools/plan-state-sync.ts";
import { createPlanTaskLinkTool } from "./tools/plan-task-link.ts";
import { createPlanStatusTool } from "./tools/plan-status.ts";
import { createPlanNextTool } from "./tools/plan-next.ts";
import { createPlanProgressReconcileTool } from "./tools/plan-progress-reconcile.ts";
import {
  createPlanContentCreateTool,
  createPlanContentDeleteTool,
  createPlanContentReadTool,
  createPlanContentUpdateTool,
} from "./tools/plan-content.ts";
import { createWorkOrderBuildTool } from "./tools/work-order-build.ts";

const TOOL_DEFINITION_MARKER = "<!-- uw-task-evidence-pack-guidance -->";

export function buildUltraworkStableContext(project: { projectId: string; projectPath: string }): string {
  return [
    "",
    "",
    "[ULTRAWORK CONTEXT]",
    `project: ${project.projectId} (${project.projectPath})`,
    "refs: tasks=.ultrawork/tasks.json, plans=.ultrawork/plans.json, state=.ultrawork/state.md",
  ].join("\n");
}

export function buildSubagentEvidencePackGuidance(): string {
  const headings = EVIDENCE_PACK_SECTIONS.map(
    (name, index) => `- ### ${EVIDENCE_PACK_SECTION_NUMBERS[index]}. ${name}`,
  );
  return [
    TOOL_DEFINITION_MARKER,
    "",
    "## 實作說明七節固定格式（subagent prompt 指引）",
    "",
    "派遣給 `implementer`、`debugger` 或 `ultra-coder` 的 subagent prompt，必須含下列七個 H3 標題，依序、每節非空、不可重複：",
    "",
    ...headings,
    "",
    "- 缺漏、空節、重複、順序錯、名稱或序號錯誤都會被擋下。",
    "- `### 6. Acceptance Criteria` 必須含至少一個 `- [ ]` 或 `- [x]` checkbox。",
    "- heading 層級混用時會在派發前自動改成 H3；其他錯誤不會自動猜測。",
    "- 用 `work-order-build` 組裝時，prompt 只填它回傳的 `work-order:<id>`，派發前會自動換回全文。",
  ].join("\n");
}

export const workflowModule: ModuleDefinition = {
  key: "workflow",
  register: async (runtime: ModuleRuntime): Promise<Registration> => {
    const workflow = createWorkflowRuntime(runtime.ctx, runtime.settings);
    const workOrders = createWorkOrderStore(runtime.ctx.storage);
    const escalation = createEscalationTracker(runtime.ctx.storage, async (sessionID) => {
      try {
        const session = await runtime.ctx.session.get({ sessionID }) as {
          parentID?: unknown;
          agent?: unknown;
        } | null;
        if (typeof session?.parentID !== "string") return null;
        return {
          parentID: session.parentID,
          agent: typeof session.agent === "string" ? session.agent : null,
        };
      } catch {
        return null;
      }
    });

    const tools = {
      "task-state-sync": createTaskStateSyncTool(workflow),
      "task-content-read": createTaskContentReadTool(workflow),
      "task-content-update": createTaskContentUpdateTool(workflow),
      "plan-state-sync": createPlanStateSyncTool(workflow),
      "plan-task-link": createPlanTaskLinkTool(workflow),
      "plan-status": createPlanStatusTool(workflow),
      "plan-next": createPlanNextTool(workflow),
      "plan-progress-reconcile": createPlanProgressReconcileTool(workflow),
      "plan-content-create": createPlanContentCreateTool(workflow),
      "plan-content-read": createPlanContentReadTool(workflow),
      "plan-content-update": createPlanContentUpdateTool(workflow),
      "plan-content-delete": createPlanContentDeleteTool(workflow),
      "work-order-build": createWorkOrderBuildTool(workflow, workOrders),
    };
    const guidance = buildSubagentEvidencePackGuidance();
    const toolRegistration = await runtime.ctx.tool.transform((editor) => {
      for (const tool of Object.values(tools)) {
        editor.add(tool as never);
      }
      editor.update("subagent", (tool) => {
        if (!String(tool.description ?? "").includes(TOOL_DEFINITION_MARKER)) {
          tool.description = `${tool.description ?? ""}\n\n${guidance}`;
        }
      });
    });

    const beforeRegistration = await runtime.ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "subagent") return;
      const input = event.input as Record<string, unknown> | null | undefined;
      if (!input) return;
      const resolution = await workOrders.resolve(input.prompt, event.sessionID);
      if (resolution.kind === "resolved") input.prompt = resolution.prompt;
      else if (resolution.kind === "malformed") {
        throw new Error("subagent 的 prompt 夾帶了工作說明代號和其他文字。prompt 只能是 work-order-build 回傳的 workOrderRef 原文；要補內容請重新組裝。");
      } else if (resolution.kind === "not-found") {
        throw new Error(`找不到工作說明 ${resolution.id}：可能工作階段已不存在或已超過 24 小時。請重新呼叫 work-order-build 取得新的 workOrderRef。`);
      } else if (resolution.kind === "wrong-session") {
        throw new Error(`工作說明 ${resolution.id} 是在其他工作階段組裝的，不能在這裡派遣。請在目前的工作階段重新呼叫 work-order-build。`);
      }

      const agent = typeof input.agent === "string" ? input.agent : "";
      if (!(EVIDENCE_PACK_GATED_SUBAGENTS as readonly string[]).includes(agent)) return;
      let prompt: unknown = input.prompt;
      if (typeof prompt === "string" && prompt.length > 0) {
        const normalized = normalizeHeadingLevels(prompt);
        if (typeof normalized === "string" && normalized !== prompt && validateEvidencePack(normalized).valid) {
          input.prompt = normalized;
          prompt = normalized;
        }
      }
      const validation = validateEvidencePack(prompt);
      if (!validation.valid) throw new Error(formatEvidencePackErrors(validation, agent));
      if (agent === "ultra-coder") {
        const verdict = await escalation.verify(event.sessionID, prompt as string);
        if (!verdict.ok) throw new Error(formatEscalationRejection(verdict));
      }
    });

    const contextRegistration = await runtime.ctx.session.hook("context", async (event) => {
      let directory: string = runtime.ctx.location.project?.directory ?? runtime.ctx.location.directory;
      try {
        const session = await runtime.ctx.session.get({ sessionID: event.sessionID });
        const value = (session as { location?: { directory?: unknown } } | null)?.location?.directory;
        if (typeof value === "string" && value) directory = value;
      } catch {
        // 保留外掛實例位置。
      }
      const projectId = runtime.ctx.location.project?.id || directory;
      const text = buildUltraworkStableContext({ projectId, projectPath: directory });
      if (Array.isArray(event.system) && !event.system.some((part) => String(part?.text ?? "").includes("[ULTRAWORK CONTEXT]"))) {
        event.system.push({ type: "text", text });
      }
    });

    const compactionRegistration = await runtime.ctx.session.hook("compaction", async (event) => {
      if (!(await isSessionTaskBound(event.sessionID))) return;
      if (Array.isArray(event.system)) {
        event.system.push({ type: "text", text: "壓縮這段對話前，先確認目前 Task 的狀態已經同步。" });
      }
    });

    const abort = new AbortController();
    const sessions = new SessionStateStore(runtime.ctx.storage);
    void (async () => {
      const events = await runtime.ctx.event.subscribe({ signal: abort.signal });
      for await (const event of events) {
        const data = event.data as {
          sessionID?: unknown;
          parentID?: unknown;
          agent?: unknown;
        } | null;
        const sessionID = typeof data?.sessionID === "string" ? data.sessionID : null;
        if (!sessionID) continue;
        const eventType = String(event.type);
        if (eventType === "session.created" || eventType === "session.updated") {
          let agent = data?.agent;
          if (typeof agent !== "string") {
            try {
              const session = await runtime.ctx.session.get({ sessionID }) as { agent?: unknown } | null;
              if (typeof session?.agent === "string") agent = session.agent;
            } catch {
              agent = null;
            }
          }
          if (data?.parentID !== undefined) await escalation.record(sessionID, data.parentID, agent);
        } else if (event.type === "session.deleted") {
          await sessions.clearSession(sessionID);
          await workOrders.clearSession(sessionID);
          await clearSessionBinding(sessionID);
        }
      }
    })().catch(() => {
      // 事件訂閱失效不影響工具與其他 hook；下一次重載會重新訂閱。
    });

    return {
      dispose: async () => {
        abort.abort();
        await compactionRegistration.dispose();
        await contextRegistration.dispose();
        await beforeRegistration.dispose();
        await toolRegistration.dispose();
      },
    };
  },
};

// ─── 附加式匯出（diagnostics 模組的唯讀診斷需要） ──────────────
//
// 診斷模組只讀 `.ultrawork/` 資料層，必須跟 workflow 寫入端用同一組路徑解析
// 與同一份 registry 讀取語意，否則 doctor 會診斷到別的目錄。這裡只把既有
// 函式與型別再匯出一次，不改任何行為。

export { getPathsForRoot, type Paths } from "./runtime/context.ts";
export { createWorkflowRuntime } from "./runtime/v2-runtime.ts";
export type {
  FullUltraworkRuntimeContext,
  RuntimeBaseContext,
} from "./runtime/context-builder.ts";
export type { RegistryRuntimeContext } from "./runtime/registry-io.ts";
export { inspectPlanRegistry } from "./registry/plan-completion.ts";
export type { PlanRegistryHealthIssue, PlanRegistryHealthReport } from "./registry/plan-completion.ts";
export { readInconsistentMarker } from "./content/content-store.ts";
export type { InconsistentMarker } from "./content/content-store.ts";
export { splitFrontmatter, isFinishedPlanState, isFinishedTaskState } from "./core/helpers.ts";
export { FINISHED_PLAN_LIMIT, FINISHED_TASK_LIMIT } from "./core/constants.ts";
export type { PlansRegistry, ProjectBinding, TasksRegistry } from "./core/types.ts";
