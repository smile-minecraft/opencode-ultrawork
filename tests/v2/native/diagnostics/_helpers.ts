import { renderTopic, listTopics, sha256 } from "../../../../src/modules/memory/topic.ts";
import { memoryLayer, memoryPath } from "../../../../src/modules/memory/layers.ts";
import { renderIndex } from "../../../../src/modules/memory/index-render.ts";
import { entryHash } from "../../../../src/modules/memory/log.ts";
/**
 * diagnostics 測試的共用 harness。
 *
 * 形狀比照 `tests/v2/native/workflow/_helpers.ts`：用假 V2 context 註冊模組，
 * 讓測試能直接呼叫註冊進去的工具。
 */

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModuleDefinition, ModuleRuntime } from "../../../../src/modules/types.ts";
import { DEFAULT_SETTINGS, type UltraworkSettings } from "../../../../src/settings/defaults.ts";
import { diagnosticsModule } from "../../../../src/modules/diagnostics/index.ts";
import { MODULE_KEYS } from "../../../../src/settings/defaults.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../../_fake-v2-context.ts";

export interface SetupDiagnosticsOptions {
  /** 載入前就存在的工具（例如平台內建的 subagent）。 */
  tools?: Array<{ id: string; description: string }>;
  /**
   * 除了診斷模組之外，還要**真的註冊**的模組。
   *
   * 為什麼需要這個參數：`workflow_health_check` 會拿「settings 裡開啟的模組
   * 應有工具」跟「平台實際註冊的工具」比對。若只把模組開關打開卻不註冊它的
   * 工具，預期集合就會比實際集合大，測試會靠著「宣稱開啟」假裝集合一致。
   * 開啟 commentSignal 的測試就必須真的把 `commentSignalModule` 一起註冊。
   */
  extraModules?: readonly ModuleDefinition[];
  /** 全域設定資料夾（`ctx.options.globalDir`）；不給就用 fake context 的隔離暫存目錄。 */
  globalDir?: string;
}

export async function setupDiagnostics(
  root: string,
  settings: UltraworkSettings = DEFAULT_SETTINGS,
  options: SetupDiagnosticsOptions = {},
) {
  const fake = createFakeV2Context({
    directory: root,
    sessionDirectory: root,
    tools: options.tools ?? [],
    ...(options.globalDir !== undefined ? { options: { globalDir: options.globalDir } } : {}),
  });
  const runtime: ModuleRuntime = { ctx: fake.ctx, settings };
  const modules: ModuleDefinition[] = [diagnosticsModule, ...(options.extraModules ?? [])];
  const registrations = [];
  for (const module of modules) {
    // 與 registry.ts 的 `isModuleEnabled` 同一規則：明確 false 才跳過。
    const switches = settings.modules as Record<string, unknown>;
    if (switches[module.key] === false) continue;
    registrations.push(await module.register(runtime));
  }
  return { ...fake, registrations, registration: registrations[0] };
}

/** 完整外框（ok／code／summary／nextAction／data），用來斷言回傳形狀。 */
export async function callEnvelope(
  fake: Awaited<ReturnType<typeof setupDiagnostics>>,
  name: string,
  input: Record<string, unknown> = {},
  sessionID = "s1",
): Promise<Record<string, any>> {
  const result = await fake.added.get(name).execute(input, fakeV2ToolContext(sessionID));
  return JSON.parse(result.content);
}

/**
 * 呼叫工具並回傳結果；`data` 內的欄位以 non-enumerable getter 掛到外層。
 *
 * 這是舊版 harness `parseToolResult` 的同一個做法：外框欄位（`ok`／`code`／
 * `summary`／`nextAction`／`data`）維持可直接斷言，`data` 內的 payload 也能
 * 用 `result.blocks` 這種扁平寫法讀，且不影響 `Object.keys(result)`。
 */
export async function callTool(
  fake: Awaited<ReturnType<typeof setupDiagnostics>>,
  name: string,
  input: Record<string, unknown> = {},
  sessionID = "s1",
): Promise<any> {
  const parsed = await callEnvelope(fake, name, input, sessionID);
  if (parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
    for (const [key, value] of Object.entries(parsed.data)) {
      if (!(key in parsed)) {
        Object.defineProperty(parsed, key, { configurable: true, enumerable: false, value });
      }
    }
  }
  return parsed;
}

/** 建立 `.ultrawork/` 並寫入指定檔案（回傳寫入後的絕對路徑）。 */
export function writeMemoryFile(root: string, name: string, content: string): string {
  const dir = join(root, ".ultrawork");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

/** 建立 `.ultrawork/plans/`（內容庫診斷需要目錄存在）。 */
export function makePlansDir(root: string): string {
  const dir = join(root, ".ultrawork", "plans");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface TaskFixtureOptions {
  taskId: string;
  /** 任填一個非空值 → 這個狀態；`null` → 不放 `state` 欄位。 */
  state?: string | null;
  title?: string;
  owner?: string;
  priority?: string;
  planId?: string;
  /** 游標指向的任務；不給就用 taskId。 */
  cursor?: string | null;
  /** 任填一個非空值 → section 錨點參照（值可能是壞的舊前綴）。 */
  contentRef?: string;
  /** 任填一個非空值 → file mode 的專用內容檔路徑。 */
  taskContentPath?: string;
  /** 任填一個非空值 → file mode。 */
  taskContentMode?: string;
}

/** 寫一份最小可用的 tasks.json（單一進行中任務）。 */
export function writeTasksRegistry(root: string, options: TaskFixtureOptions): void {
  const projectPath = root;
  const projectId = root.split("/").pop()!.toLowerCase();
  const task = {
    taskId: options.taskId,
    projectId,
    projectPath,
    title: options.title ?? "測試任務",
    // `state: null` 明確表示「不要有這個欄位」；其他情況沿用預設的進行中。
    ...(options.state === null ? {} : { state: options.state ?? "IN_PROGRESS" }),
    owner: options.owner ?? "ultra",
    priority: options.priority ?? "P0",
    updatedAt: new Date().toISOString(),
    history: [],
    ...(options.planId ? { planId: options.planId } : {}),
    ...(options.contentRef ? { contentRef: options.contentRef } : {}),
    ...(options.taskContentPath ? { taskContentPath: options.taskContentPath } : {}),
    ...(options.taskContentMode ? { taskContentMode: options.taskContentMode } : {}),
  };
  writeMemoryFile(
    root,
    "tasks.json",
    JSON.stringify(
      {
        version: "1",
        projectId,
        projectPath,
        activeTaskIds: [options.taskId],
        taskCursor: options.cursor === undefined ? options.taskId : options.cursor,
        tasks: { [options.taskId]: task },
      },
      null,
      2,
    ),
  );
}

export interface PlanFixtureOptions {
  planId: string;
  state?: string;
  title?: string;
  owner?: string;
  taskIds?: string[];
  finishedTaskIds?: string[];
  completionTombstones?: Record<string, { state: string; finishedAt: string }>;
  contentRef?: string;
  active?: boolean;
}

/** 寫一份最小可用的 plans.json。 */
export function writePlansRegistry(root: string, options: PlanFixtureOptions): void {
  const projectPath = root;
  const projectId = root.split("/").pop()!.toLowerCase();
  const planId = options.planId;
  const plan = {
    planId,
    projectId,
    projectPath,
    title: options.title ?? "測試計畫",
    state: options.state ?? "IN_PROGRESS",
    owner: options.owner ?? "ultra",
    priority: "P0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    taskIds: options.taskIds ?? [],
    finishedTaskIds: options.finishedTaskIds ?? [],
    dependencyGraph: { nodes: [], edges: [] },
    history: [],
    ...(options.completionTombstones ? { completionTombstones: options.completionTombstones } : {}),
    ...(options.contentRef ? { contentRef: options.contentRef } : {}),
  };
  writeMemoryFile(
    root,
    "plans.json",
    JSON.stringify(
      {
        version: "1",
        projectId,
        projectPath,
        activePlanIds: options.active === false ? [] : [planId],
        planCursor: planId,
        plans: { [planId]: plan },
      },
      null,
      2,
    ),
  );
}

/** 寫一份 state.md 游標投影。 */
export function writeStateMd(root: string, state: string, taskId: string): void {
  writeMemoryFile(
    root,
    "state.md",
    `---\nlabel: state\nlimit: 3000\n---\n# Project State\n\nstate: ${state}\ntask_id: ${taskId}\nowner: ultra\npriority: P0\ncurrent_plan: —\n`,
  );
}

/**
 * 只有診斷開啟的設定。
 *
 * 假 context 只註冊診斷模組，所以要讓「預期工具集合 == 實際工具集合」，
 * 其他模組必須在 settings 裡關掉。要開啟某個模組時，呼叫端必須同時用
 * `extraModules` 把它真的註冊進去（見 `SetupDiagnosticsOptions`）。
 */
export function diagnosticsOnlySettings(...alsoEnabled: string[]): UltraworkSettings {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const on = new Set(["diagnostics", ...alsoEnabled]);
  for (const key of MODULE_KEYS) settings.modules[key] = on.has(key);
  return settings;
}

/**
 * 建立一份「健康但空」的 workspace：`lazyEnsure` 會產出的骨架內容。
 * 診斷工具有多項存在性檢查，沒這些檔案時 doctor／health_check 會如實回報
 * 失敗（那是正確行為，不是 bug），所以健康情境要先鋪好骨架。
 */
export function writeMinimalWorkspace(root: string): void {
  makePlansDir(root);
  writeMemoryTopic(root, "專案測試知識");
  writeMemoryFile(
    root,
    "state.md",
    "---\nlabel: state\nlimit: 3000\nread_only: false\n---\n# Project State\n\nstate: IDLE\ntask_id: —\nowner: —\npriority: —\ncurrent_plan: —\n\n## Refs\nregistry_ref: .ultrawork/tasks.json\nplans_ref: .ultrawork/plans.json\n",
  );
  const projectPath = root;
  const projectId = root.split("/").pop()!.toLowerCase();
  writeMemoryFile(
    root,
    "tasks.json",
    JSON.stringify(
      { version: "1", projectId, projectPath, activeTaskIds: [], taskCursor: null, tasks: {} },
      null,
      2,
    ),
  );
  writeMemoryFile(
    root,
    "plans.json",
    JSON.stringify(
      { version: "1", projectId, projectPath, activePlanIds: [], planCursor: null, plans: {} },
      null,
      2,
    ),
  );
}

/** 遞迴列出所有檔案的相對路徑與大小；用來證明診斷工具沒有落檔。 */
export function fileSnapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else out.push(`${rel}:${statSync(join(dir, entry.name)).size}`);
    }
  };
  walk(root, "");
  return out.sort();
}

/**
 * 寫一個專案層記憶主題，連同索引與一筆 reseal 紀錄：
 * 讓 doctor 的紀錄完整性檢查把這個 fixture 視為「經由工具寫入」的正常狀態。
 */
export function writeMemoryTopic(root: string, body: string, description = "測試主題", topic = "fixture"): string {
  const layer = memoryLayer(root);
  mkdirSync(memoryPath(layer, "topics"), { recursive: true });
  const at = new Date().toISOString();
  const raw = renderTopic(
    { title: topic, description, type: "reference", pinned: false, source: "manual", created: at, updated: at, verified_at: at },
    body,
  );
  writeFileSync(memoryPath(layer, "topics", `${topic}.md`), raw);
  writeFileSync(memoryPath(layer, "MEMORY.md"), renderIndex(listTopics(layer), layer.layer));
  const entry = {
    seq: 1,
    at,
    kind: "reseal" as const,
    agent: "memorizer",
    sessionID: null,
    prevHash: "genesis",
    reason: "測試初始快照",
    shas: Object.fromEntries(listTopics(layer).map((item) => [item.topic, item.sha256])),
  };
  writeFileSync(memoryPath(layer, "log.jsonl"), `${JSON.stringify({ ...entry, hash: entryHash(entry) })}\n`);
  return raw;
}
