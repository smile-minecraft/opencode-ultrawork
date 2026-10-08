import type { DefinedTool, ToolExecutionContext } from "./kit/define-tool.ts";
import type { HostProcess } from "./kit/process-runner.ts";
import type { KeyValueStorage, SessionEvent } from "./state/store.ts";

export interface HostRegistration {
  dispose(): Promise<void> | void;
}

export interface HostRoots {
  readonly instanceDirectory?: string;
  readonly projectDirectory?: string;
  readonly projectId?: string;
  readonly globalConfigDirectory: string;
}

export interface HostSession {
  readonly id?: string;
  readonly agent?: string;
  readonly parentID?: string;
  readonly location?: { readonly directory?: unknown };
}

export interface HostToolEditor {
  add(tool: DefinedTool): void;
  update(name: string, update: (tool: { description?: unknown }) => void): void;
}

export interface HostToolExecutionEvent {
  readonly tool?: unknown;
  readonly input?: unknown;
  readonly sessionID?: unknown;
  readonly status?: unknown;
}

export interface HostSessionContextEvent {
  readonly sessionID: string;
  readonly system?: Array<{ readonly text?: unknown; [key: string]: unknown }>;
}

export interface HostSessionCompactionEvent {
  readonly sessionID: string;
  readonly system?: Array<{ readonly text?: unknown; [key: string]: unknown }>;
}

export interface HostEvent extends SessionEvent {}

export interface AgentRoleFileLookup {
  lookup(agentsRoot: string, name: string): "exists" | "missing" | "unknown";
}

export interface AgentRoleEditor {
  readFile(path: string): string;
  listFiles(directory: string): string[];
  writeFileAtomic(path: string, content: string): void;
}

export interface HostCapabilities {
  readonly agentRoleFiles?: AgentRoleFileLookup;
  readonly agentRoleEditor?: AgentRoleEditor;
  /**
   * 受限程序執行能力：工具邏輯啟動外部程序的唯一通道。
   *
   * 宿主不提供時，工具必須明確拒絕（或降級並明列原因），不得直接啟動程序。
   * 授權、命令與參數政策仍由核心各模組保留，能力只負責執行機制。
   */
  readonly process?: HostProcess;
}

export interface Host {
  readonly roots: HostRoots;
  readonly storage: KeyValueStorage;
  readonly capabilities: HostCapabilities;
  readonly tools: {
    install(
      definitions: readonly DefinedTool[],
      update?: (editor: HostToolEditor) => void,
    ): Promise<HostRegistration>;
    hook(
      phase: "execute.before" | "execute.after",
      callback: (event: HostToolExecutionEvent) => Promise<void> | void,
    ): Promise<HostRegistration>;
    list(): Promise<readonly { id: string }[] | null>;
  };
  readonly sessions: {
    hook(
      phase: "context" | "compaction",
      callback: (event: HostSessionContextEvent | HostSessionCompactionEvent) => Promise<void> | void,
    ): Promise<HostRegistration>;
    get(sessionID: string): Promise<HostSession | null>;
  };
  readonly events: {
    subscribe(options: { signal?: AbortSignal }): AsyncIterable<HostEvent> | Promise<AsyncIterable<HostEvent>>;
  };
}

/** 只接受宿主在工具執行時提供的身分，不從工具輸入推導。 */
export function trustedExecutionContext(context: unknown): ToolExecutionContext {
  if (typeof context !== "object" || context === null) {
    throw new Error("宿主未提供可信的工具執行 context");
  }
  const raw = context as Record<string, unknown>;
  if (typeof raw.sessionID !== "string" || raw.sessionID.length === 0) {
    throw new Error("宿主未提供可信的工作階段身分");
  }
  const { agent, ...executionFields } = raw;
  return {
    ...executionFields,
    sessionID: raw.sessionID,
    ...(typeof agent === "string" ? { agent } : {}),
  } as ToolExecutionContext;
}
