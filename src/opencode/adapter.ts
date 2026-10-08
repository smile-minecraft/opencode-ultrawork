import type { Plugin } from "@opencode/plugin";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../kit/atomic-write.ts";
import { createHostProcess } from "../kit/process-runner.ts";
import type { AgentRoleEditor, AgentRoleFileLookup, Host, HostEvent, HostRegistration, HostRoots, HostSession, HostToolEditor } from "../host.ts";
import { trustedExecutionContext } from "../host.ts";
import { isUnsafeRoot } from "../kit/path-guard.ts";
import { isSafeAgentRoleName, type AgentRoleFileLookupResult } from "../modules/diagnostics/shared.ts";
import { resolveGlobalConfigDir } from "../settings/paths.ts";

interface SetupRoots {
  globalDirectory?: string;
  projectDirectory?: string;
}

interface NativeToolEditor {
  add(definition: unknown): void;
  update(name: string, callback: (tool: { description?: unknown }) => void): void;
}

interface NativeToolDomain {
  transform(callback: (editor: NativeToolEditor) => void): Promise<HostRegistration>;
  hook(phase: "execute.before" | "execute.after", callback: (event: never) => unknown): Promise<HostRegistration>;
  list?: () => Promise<readonly { id: string }[]>;
}

interface NativeSessionDomain {
  hook(phase: "context" | "compaction", callback: (event: never) => unknown): Promise<HostRegistration>;
  get(options: { sessionID: string }): Promise<unknown>;
}

interface NativeEventDomain {
  subscribe(options: { signal?: AbortSignal }): AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function roleFileLookup(): AgentRoleFileLookup {
  return {
    lookup(agentsRoot, name): AgentRoleFileLookupResult {
      if (!isSafeAgentRoleName(name) || isUnsafeRoot(agentsRoot)) return "unknown";
      let canonicalRoot: string;
      try {
        canonicalRoot = realpathSync(agentsRoot);
      } catch {
        return "unknown";
      }
      try {
        if (!lstatSync(canonicalRoot).isDirectory()) return "unknown";
        const roleFile = lstatSync(join(canonicalRoot, `${name}.md`));
        if (roleFile.isSymbolicLink()) return "unknown";
        return roleFile.isFile() ? "exists" : "missing";
      } catch (error) {
        return (asRecord(error).code === "ENOENT") ? "missing" : "unknown";
      }
    },
  };
}

function openCodeAgentRoleEditor(): AgentRoleEditor {
  return {
    readFile(path) {
      return readFileSync(path, "utf8");
    },
    listFiles(directory) {
      return readdirSync(directory);
    },
    writeFileAtomic(path, content) {
      atomicWriteFile(path, content);
    },
  };
}

export function createOpenCodeHost(ctx: Plugin.Context, overrides: SetupRoots = {}): Host {
  const context = ctx as unknown as {
    location?: { directory?: unknown; project?: { id?: unknown; directory?: unknown } };
    options?: Record<string, unknown>;
    storage: Host["storage"];
    tool: NativeToolDomain;
    session: NativeSessionDomain;
    event: NativeEventDomain;
  };
  const location = context.location ?? {};
  const project = location.project ?? {};
  const options = context.options ?? {};
  const globalConfigDirectory = overrides.globalDirectory
    ?? (typeof options.globalDir === "string" && options.globalDir.trim() ? options.globalDir : undefined)
    ?? resolveGlobalConfigDir(process.env as Record<string, string | undefined>, homedir());
  const instanceDirectory = typeof location.directory === "string" ? location.directory : undefined;
  const projectDirectory = overrides.projectDirectory
    ?? (typeof project.directory === "string" ? project.directory : instanceDirectory);
  const roots: HostRoots = {
    ...(instanceDirectory ? { instanceDirectory } : {}),
    ...(projectDirectory ? { projectDirectory } : {}),
    ...(typeof project.id === "string" ? { projectId: project.id } : {}),
    globalConfigDirectory,
  };
  const tools = context.tool;
  const sessions = context.session;
  const events = context.event;
  const capabilities = {
    agentRoleFiles: roleFileLookup(),
    agentRoleEditor: openCodeAgentRoleEditor(),
    process: createHostProcess(),
  };

  return {
    roots,
    storage: context.storage,
    capabilities,
    tools: {
      install(definitions, update) {
        return tools.transform((nativeEditor) => {
          const editor = nativeEditor as HostToolEditor;
          for (const definition of definitions) {
            nativeEditor.add({
              ...definition,
              execute: (input: unknown, execution: unknown) =>
                definition.execute(input, trustedExecutionContext(execution)),
            });
          }
          update?.(editor);
        });
      },
      hook(phase, callback) {
        return tools.hook(phase, callback as never);
      },
      async list() {
        if (typeof tools.list !== "function") return null;
        try {
          return await tools.list();
        } catch {
          return null;
        }
      },
    },
    sessions: {
      hook(phase, callback) {
        return sessions.hook(phase, callback as never);
      },
      async get(sessionID) {
        return await sessions.get({ sessionID }) as HostSession | null;
      },
    },
    events: {
      subscribe({ signal }) {
        return events.subscribe({ signal }) as AsyncIterable<HostEvent> | Promise<AsyncIterable<HostEvent>>;
      },
    },
  };
}
