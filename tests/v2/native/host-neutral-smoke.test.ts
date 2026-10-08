import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host, HostRegistration, HostToolEditor } from "../../../src/host.ts";
import type { DefinedTool } from "../../../src/kit/define-tool.ts";
import { createHostProcess } from "../../../src/kit/process-runner.ts";
import { BUILTIN_MODULES } from "../../../src/modules/index.ts";
import { registerModules } from "../../../src/modules/registry.ts";
import { EXPECTED_TOOL_NAMES } from "../../../src/modules/diagnostics/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/settings/defaults.ts";

interface SmokeHost {
  host: Host;
  definitions: Map<string, DefinedTool>;
}

function createSmokeHost(projectDirectory: string, globalConfigDirectory: string): SmokeHost {
  const values = new Map<string, unknown>();
  const definitions = new Map<string, DefinedTool>();
  const toolInfos = new Map<string, { id: string; description: string }>([
    ["subagent", { id: "subagent", description: "派遣子代理" }],
  ]);
  const registration = (): HostRegistration => ({ dispose() {} });
  const host: Host = {
    roots: {
      instanceDirectory: projectDirectory,
      projectDirectory,
      projectId: projectDirectory,
      globalConfigDirectory,
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
    // 受限程序經宿主能力：煙霧宿主提供機制服務的真實作。
    capabilities: { process: createHostProcess() },
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
        return { id: sessionID, location: { directory: projectDirectory } };
      },
    },
    events: {
      async *subscribe() {},
    },
  };
  return { host, definitions };
}

async function invoke(host: SmokeHost, name: string, input: Record<string, unknown> = {}, sessionID = "smoke-session") {
  const definition = host.definitions.get(name);
  if (!definition) throw new Error(`工具未組裝：${name}`);
  const result = await definition.execute(input, { sessionID, agent: "build" });
  return JSON.parse(result.content);
}

describe("第二宿主最小煙霧測試", () => {
  test("核心組裝 49 個工具、執行代表工具且不同宿主資料互不影響", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "uw-host-a-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "uw-host-b-"));
    const firstGlobal = join(firstRoot, "global");
    const secondGlobal = join(secondRoot, "global");
    await Promise.all([
      mkdir(join(firstRoot, "src"), { recursive: true }),
      mkdir(join(secondRoot, "src"), { recursive: true }),
      mkdir(firstGlobal, { recursive: true }),
      mkdir(secondGlobal, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(firstRoot, "src", "evidence.txt"), "host-a-search-marker\n"),
      writeFile(join(secondRoot, "src", "evidence.txt"), "host-b-search-marker\n"),
    ]);

    const first = createSmokeHost(firstRoot, firstGlobal);
    const second = createSmokeHost(secondRoot, secondGlobal);
    const registrations: HostRegistration[] = [];
    try {
      registrations.push(...await registerModules({ host: first.host, settings: DEFAULT_SETTINGS }, BUILTIN_MODULES));
      registrations.push(...await registerModules({ host: second.host, settings: DEFAULT_SETTINGS }, BUILTIN_MODULES));

      const expected = [...EXPECTED_TOOL_NAMES].sort();
      expect(expected).toHaveLength(49);
      expect([...first.definitions.keys()].sort()).toEqual(expected);
      expect([...second.definitions.keys()].sort()).toEqual(expected);

      const search = await invoke(first, "grep_context", {
        pattern: "host-a-search-marker",
        target: "src/evidence.txt",
        mode: "literal",
      });
      expect(search.ok).toBe(true);
      expect(JSON.stringify(search)).toContain("host-a-search-marker");

      const task = await invoke(first, "task-state-sync", {
        event: "create",
        taskId: "host-a-only",
        to: "NEW",
        title: "宿主 A 的任務",
        owner: "ultra",
        priority: "normal",
      });
      expect(task.ok).toBe(true);
      const otherHostTasks = await invoke(second, "task-state-sync", { event: "status" });
      expect(JSON.stringify(otherHostTasks)).not.toContain("host-a-only");

      const workOrder = await invoke(first, "work-order-build", {
        taskIdentity: "smoke task；smoke project",
        objective: "檢查宿主 storage 隔離。",
        knownEvidence: "兩個宿主使用不同 storage。",
        constraints: "不使用平台適配器。",
        tddRequirements: "以工具執行確認行為。",
        acceptanceCriteria: ["建立獨立工作說明"],
        requiredReturn: "回報工具執行結果。",
      });
      expect(workOrder.ok).toBe(true);
      expect((await first.host.storage.scan({ prefix: "session/smoke-session/work-order/" })).entries.length).toBe(1);
      expect((await second.host.storage.scan({ prefix: "session/smoke-session/work-order/" })).entries).toEqual([]);

      const manifest = await invoke(second, "tool_hook_manifest");
      expect(manifest.ok).toBe(true);

      const unsupported = await invoke(second, "skiller-retire", {
        scope: "managed",
        mode: "apply",
      });
      expect(unsupported).toMatchObject({ ok: false, code: "HOST_CAPABILITY_UNAVAILABLE" });
    } finally {
      for (const item of registrations.reverse()) await item.dispose();
      await Promise.all([
        rm(firstRoot, { recursive: true, force: true }),
        rm(secondRoot, { recursive: true, force: true }),
      ]);
    }
  });
});
