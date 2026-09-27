/**
 * 7 個記憶工具共用的依賴、權限檢查與錯誤處理（企劃書第 7 節）。
 */

import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../../kit/define-tool.ts";
import { jsonResult } from "../../../kit/json.ts";
import { budgetForLayer, type MemoryBudgets, type MemoryLayerBudget } from "../constants.ts";
import { MemoryError, memoryLayers, type MemoryLayer } from "../layers.ts";

/** 記憶工具需要的最小任務形狀；完整欄位由 workflow 的註冊檔提供。 */
export interface MemoryTask {
  taskId: string;
  state: string;
  risk?: string;
  archivingAt?: string;
  title?: string;
  [key: string]: unknown;
}

export interface TaskMaterials {
  task: MemoryTask;
  content?: string;
  plan?: unknown;
  warnings?: string[];
}

export interface MemoryToolDeps {
  /** 本次工具呼叫的專案根目錄（工作階段位置）。 */
  resolveRoot: (context: ToolExecutionContext) => Promise<string>;
  /** 全域設定資料夾。 */
  globalRoot: string;
  /** 允許寫記憶的 agent（設定 `memory.writerAgents`）。 */
  writerAgents: readonly string[];
  /**
   * 兩層各自的預算（設定 `memory.budget`，註冊時從合併後的設定快照）。
   * 不給時用內建預設（舊的呼叫端照常運作）。
   */
  budgets?: MemoryBudgets;
  /** 第一次存取某個根目錄時觸發舊資料遷移；測試可以不給。 */
  ensureMigrated?: (root: string) => Promise<unknown>;
  /** 讀取目前專案的任務與相關材料；任務不存在或不屬於目前專案時回 null。 */
  taskMaterials: (taskId: string, root: string, context: ToolExecutionContext) => Promise<TaskMaterials | null>;
}

export const layerSchema = z.enum(["project", "global"]);
export const allLayersSchema = z.enum(["project", "global", "all"]);

/**
 * 取出某一層的預算：設定沒給或值壞掉時退回內建預設（見 `budgetForLayer`）。
 *
 * 每個使用端都走這裡拿「它這一層」對應的預算：寫入檢查、筆記、extract、
 * maintain、快照注入、診斷回報各自按解析到的層取值，不共用單一上限。
 */
export function budgetForDepsLayer(deps: MemoryToolDeps, layer: "project" | "global"): MemoryLayerBudget {
  return budgetForLayer(deps.budgets, layer);
}

/**
 * writer 專用功能的權限檢查。身分取自工具執行 context 的 `agent`；
 * 拿不到 agent 時一律當成非 writer（fail closed）。
 */
export function requireWriter(deps: MemoryToolDeps, context: ToolExecutionContext): void {
  if (!context.agent || !deps.writerAgents.includes(context.agent)) {
    throw new MemoryError("WRITER_REQUIRED", "這個操作只限 memorizer，請派 memorizer 處理記憶寫入或整理。");
  }
}

/**
 * 解析本次呼叫要用的層，並在第一次存取時觸發遷移。
 * 兩層是同一個資料夾時只有一層，`layer` 參數兩個值都指向它。
 */
export async function resolveLayers(
  deps: MemoryToolDeps,
  context: ToolExecutionContext,
  selected: "project" | "global" | "all" = "all",
): Promise<MemoryLayer[]> {
  const root = await deps.resolveRoot(context);
  const layers = memoryLayers(root, deps.globalRoot);
  await deps.ensureMigrated?.(root);
  if (layers.length === 1 || selected === "all") return layers;
  return layers.filter((layer) => layer.layer === selected);
}

/** log 紀錄的呼叫者身分欄位。 */
export function identity(context: ToolExecutionContext): { agent: string | null; sessionID: string | null } {
  return { agent: context.agent ?? null, sessionID: context.sessionID ?? null };
}

/**
 * 包一層錯誤處理的 defineTool：`MemoryError` 轉成結構化錯誤；寫入鎖忙碌照原樣拋出，
 * 交給 defineTool 的共用重試說明；其他例外（多半是路徑守衛擋下 symlink）一律回
 * `MEMORY_IO_ERROR`，不把內部路徑細節丟給模型。
 */
export function memoryTool<T>(
  name: string,
  description: string,
  schema: z.ZodType<T>,
  run: (input: T, context: ToolExecutionContext) => Promise<unknown>,
) {
  return defineTool({
    name,
    description,
    inputSchema: schema,
    async execute(input, context) {
      try {
        return jsonResult(await run(input, context));
      } catch (error) {
        if (error instanceof MemoryError) {
          return jsonResult({ ok: false, code: error.code, error: error.message, ...error.details });
        }
        if ((error as { code?: string }).code === "CONTENT_LOCK_BUSY") throw error;
        return jsonResult({
          ok: false,
          code: "MEMORY_IO_ERROR",
          error: "記憶路徑不安全或無法存取，請檢查目錄、權限與符號連結。",
        });
      }
    },
  });
}
