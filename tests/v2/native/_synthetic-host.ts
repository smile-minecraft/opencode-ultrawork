/**
 * 合成宿主 harness：不依賴 OpenCode 適配器的第二宿主。
 *
 * 用途是證明核心只靠宿主介面就能組裝與執行工具：記憶體 storage、
 * 暫存根目錄、可選能力注入（角色檔查詢／改寫）與工具調用輔手。
 * 本檔不得匯入適配器或平台套件，只能碰宿主無關的核心。
 */

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { atomicWriteFile } from "../../../src/kit/atomic-write.ts";
import { createHostProcess, type HostProcess } from "../../../src/kit/process-runner.ts";
import type { Host, HostCapabilities, HostRegistration, HostToolEditor } from "../../../src/host.ts";
import type { DefinedTool } from "../../../src/kit/define-tool.ts";
import { BUILTIN_MODULES } from "../../../src/modules/index.ts";
import { registerModules } from "../../../src/modules/registry.ts";
import { DEFAULT_SETTINGS, type UltraworkSettings } from "../../../src/settings/defaults.ts";
import { SessionStateStore } from "../../../src/state/store.ts";

export interface SyntheticHost {
  readonly host: Host;
  readonly definitions: Map<string, DefinedTool>;
  readonly values: Map<string, unknown>;
}

export interface SyntheticHostOptions {
  readonly projectDirectory: string;
  readonly globalConfigDirectory: string;
  readonly capabilities?: HostCapabilities;
  readonly extraTools?: ReadonlyArray<{ id: string; description: string }>;
}

/** 建一個記憶體 storage＋暫存根的合成宿主；能力預設為空（缺能力拒絕的對照組）。 */
export function createSyntheticHost(options: SyntheticHostOptions): SyntheticHost {
  const values = new Map<string, unknown>();
  const definitions = new Map<string, DefinedTool>();
  const toolInfos = new Map<string, { id: string; description: string }>([
    ["subagent", { id: "subagent", description: "派遣子代理" }],
    ...((options.extraTools ?? []).map((item) => [item.id, item] as const)),
  ]);
  const registration = (): HostRegistration => ({ dispose() {} });
  const host: Host = {
    roots: {
      instanceDirectory: options.projectDirectory,
      projectDirectory: options.projectDirectory,
      projectId: options.projectDirectory,
      globalConfigDirectory: options.globalConfigDirectory,
    },
    storage: {
      async get(key) {
        return values.get(key);
      },
      async set(key, value) {
        values.set(key, value);
      },
      async remove(key) {
        values.delete(key);
      },
      async scan({ prefix, after, limit }) {
        const keys = [...values.keys()].filter((key) => key.startsWith(prefix)).sort();
        const next = after === undefined ? -1 : keys.findIndex((key) => key > after);
        const start = after === undefined ? 0 : next === -1 ? keys.length : next;
        const selected = limit === undefined ? keys.slice(start) : keys.slice(start, start + limit);
        const entries = selected.map((key) => ({ key, value: values.get(key) }));
        return start + selected.length < keys.length
          ? { entries, next: selected[selected.length - 1] }
          : { entries };
      },
    },
    capabilities: options.capabilities ?? {},
    tools: {
      async install(items, update) {
        for (const item of items) {
          definitions.set(item.name, item);
          toolInfos.set(item.name, { id: item.name, description: item.description });
        }
        const editor: HostToolEditor = {
          add(item) {
            definitions.set(item.name, item);
            toolInfos.set(item.name, { id: item.name, description: item.description });
          },
          update(name, callback) {
            const item = toolInfos.get(name);
            if (item) callback(item);
          },
        };
        update?.(editor);
        return {
          dispose() {
            for (const item of items) {
              definitions.delete(item.name);
              toolInfos.delete(item.name);
            }
          },
        };
      },
      async hook() {
        return registration();
      },
      async list() {
        return [...toolInfos.values()];
      },
    },
    sessions: {
      async hook() {
        return registration();
      },
      async get(sessionID) {
        return { id: sessionID, location: { directory: options.projectDirectory } };
      },
    },
    events: {
      async *subscribe() {},
    },
  };
  return { host, definitions, values };
}

/** 真實執行已組裝的工具並解析外框；工具不存在時直接丟錯（不是靜默成功）。 */
export async function invokeSynthetic(
  synth: SyntheticHost,
  name: string,
  input: Record<string, unknown> = {},
  sessionID = "synthetic-session",
  agent = "build",
): Promise<any> {
  const definition = synth.definitions.get(name);
  if (!definition) throw new Error(`工具未組裝：${name}`);
  const result = await definition.execute(input, { sessionID, agent });
  return JSON.parse(result.content);
}

/** 在合成宿主上註冊模組（預設全部內建模組）；回傳註冊把手由呼叫端 dispose。 */
export async function registerSynthetic(
  synth: SyntheticHost,
  settings: UltraworkSettings = DEFAULT_SETTINGS,
  modules = BUILTIN_MODULES,
): Promise<HostRegistration[]> {
  return registerModules({ host: synth.host, settings }, modules);
}

/** 建一組專案根＋全域目錄的暫存根；呼叫端負責清理。 */
export async function makeSyntheticRoots(prefix: string): Promise<{
  readonly root: string;
  readonly projectDirectory: string;
  readonly globalDirectory: string;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const projectDirectory = join(root, "project");
  const globalDirectory = join(root, "global");
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(globalDirectory, { recursive: true });
  return {
    root,
    projectDirectory,
    globalDirectory,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** 以真實檔案系統為底的角色檔查詢能力：只認 `<agentsRoot>/<name>.md` 的一般檔。 */
export function makeSyntheticRoleLookup(): HostCapabilities["agentRoleFiles"] {
  return {
    lookup(agentsRoot: string, name: string): "exists" | "missing" | "unknown" {
      if (!name || name.includes("..") || /[\\/]/.test(name)) return "unknown";
      try {
        const entries = readdirSync(agentsRoot, { withFileTypes: true });
        const hit = entries.find((entry) => entry.name === `${name}.md`);
        if (!hit) return "missing";
        return hit.isFile() ? "exists" : "unknown";
      } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unknown";
      }
    },
  };
}

/** 以真實檔案系統為底的角色檔改寫能力：與正式適配器同一組操作語意。 */
export function makeSyntheticRoleEditor(): NonNullable<HostCapabilities["agentRoleEditor"]> {
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

/** 合成宿主可注入的程序能力：與正式適配器同一份機制服務的真實作。 */
export function makeSyntheticProcess(): NonNullable<HostCapabilities["process"]> {
  const process: HostProcess = createHostProcess();
  return process;
}

/** 替指定工作階段預先記下技能清單，讓 `skill_search` 有東西可查。 */
export async function seedSkillCatalog(
  synth: SyntheticHost,
  sessionID: string,
  skills: ReadonlyArray<{ name: string; description: string }>,
): Promise<void> {
  const store = new SessionStateStore(synth.host.storage);
  await store.setSession(sessionID, "skill-catalog", [...skills]);
}
