/**
 * 測試用的假 OpenCode V2 外掛 context。
 *
 * 只實作 `src/**` 工具與 hook 實際會用到的 domain，並把所有註冊記下來，
 * 讓測試能直接呼叫註冊進去的 hook 與工具。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Callback = (event: any) => Promise<void> | void;

/**
 * 行程內共用的假全域設定目錄；建立一次後重用。
 *
 * 測試沒給 `globalDir` 時，`setupUltrawork` 會一路回退到 `~/.config/opencode`，
 * 於是搬遷會動到開發者機器上的真實設定。給它一個暫存目錄就切斷了這條路。
 */
let sharedGlobalDir: string | undefined;

export function fakeGlobalDir(): string {
  sharedGlobalDir ??= mkdtempSync(join(tmpdir(), "uw-fake-global-"));
  return sharedGlobalDir;
}

/**
 * 組出 `ctx.options`：呼叫端有給 `globalDir` 就原樣用，沒給就補上暫存目錄。
 *
 * 補的 `globalDir` 是**可見的一般屬性**，不是藏起來的預設。隔離是安全預設，
 * 必須連展開（`{ ...ctx.options }`）與序列化都帶得走 —— 看不見的屬性會在任何人
 * 做展開或複製時被靜默丟掉，於是 `setupUltrawork` 照解析順序往後掉，最後寫到
 * 開發者機器的真實 `~/.config/opencode`。
 */
function buildOptions(provided: Record<string, unknown> | undefined): Record<string, unknown> {
  if (typeof provided?.globalDir === "string" && provided.globalDir.trim() !== "") return provided;
  return { ...(provided ?? {}), globalDir: fakeGlobalDir() };
}

export interface FakeV2ContextOptions {
  /** 外掛所在目錄，也是 location.project.directory。 */
  directory?: string;
  /** ctx.session.get 回傳的 location.directory；預設同 directory。 */
  sessionDirectory?: string;
  /** 外掛載入前就存在的工具（例如內建的 subagent）。 */
  tools?: Array<{ id: string; description: string }>;
  options?: Record<string, unknown>;
}

export function createFakeV2Context(options: FakeV2ContextOptions = {}) {
  const directory = options.directory ?? "/work/project";
  const toolHooks = new Map<string, Callback>();
  const sessionHooks = new Map<string, Callback>();
  const added = new Map<string, any>();
  const registry = new Map<string, any>((options.tools ?? []).map((item) => [item.id, { ...item }]));
  const events: Array<{ type: string; data: unknown }> = [];
  const store = new Map<string, unknown>();
  const registration = { dispose: async () => {} };
  const ctx = {
    location: {
      directory,
      project: { id: "p1", directory, canonical: directory },
    },
    options: buildOptions(options.options),
    session: {
      async get({ sessionID }: { sessionID: string }) {
        return {
          id: sessionID,
          parentID: sessionID === "child" ? "parent" : undefined,
          agent: sessionID === "child" ? "implementer" : "build",
          title: "修 bug",
          location: { directory: options.sessionDirectory ?? directory },
        };
      },
      async hook(name: string, callback: Callback) {
        sessionHooks.set(name, callback);
        return registration;
      },
    },
    tool: {
      async transform(callback: (editor: any) => void) {
        callback({
          add: (definition: any) => {
            added.set(definition.name, definition);
            registry.set(definition.name, { id: definition.name, description: definition.description });
          },
          update: (id: string, update: (item: any) => void) => {
            const item = registry.get(id);
            if (item) update(item);
          },
        });
        return registration;
      },
      async hook(name: string, callback: Callback) {
        toolHooks.set(name, callback);
        return registration;
      },
      async list() {
        return [...registry.values()];
      },
    },
    event: {
      async *subscribe(subscribeOptions?: { signal?: AbortSignal }) {
        const signal = subscribeOptions?.signal;
        for (const event of events) {
          if (signal?.aborted) return;
          yield event;
        }
        if (signal && !signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      },
    },
    storage: {
      async get(key: string) {
        return store.get(key) as any;
      },
      async set(key: string, value: unknown) {
        store.set(key, value);
      },
      async remove(key: string) {
        store.delete(key);
      },
      async scan(scanOptions: { prefix: string; after?: string; limit?: number }) {
        const keys = [...store.keys()].filter((key) => key.startsWith(scanOptions.prefix)).sort();
        let start = 0;
        if (scanOptions.after !== undefined) {
          const index = keys.findIndex((key) => key > scanOptions.after!);
          start = index === -1 ? keys.length : index;
        }
        const sliced =
          scanOptions.limit === undefined ? keys.slice(start) : keys.slice(start, start + scanOptions.limit);
        const entries = sliced.map((key) => ({ key, value: store.get(key) }));
        if (start + sliced.length < keys.length) return { entries, next: sliced[sliced.length - 1] };
        return { entries };
      },
    },
  };
  return { ctx: ctx as any, toolHooks, sessionHooks, added, registry, events, store };
}

/** V2 工具執行時拿到的 context。 */
export function fakeV2ToolContext(sessionID = "s1") {
  return {
    sessionID,
    agent: "build",
    messageID: "m1",
    id: "call1",
    signal: new AbortController().signal,
    progress: async () => {},
  };
}
