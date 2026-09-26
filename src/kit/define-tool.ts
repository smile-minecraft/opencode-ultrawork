/**
 * 工具定義：zod schema 轉 JSON Schema 交給 editor.add，execute 內再 safeParse。
 *
 * V2 轉 schema 時用 instanceof 判斷 zod，外掛自帶的 zod 可能判斷失敗，
 * 所以 input 固定傳 toJSONSchema 的結果；options 固定 codemode false，
 * 讓工具直接出現在清單，不被收進 execute。
 */

import { z } from "zod";
import { jsonError } from "./json.ts";

/** V2 工具執行時拿到的 context 最小形狀。 */
export interface ToolExecutionContext {
  readonly sessionID: string;
  readonly agent?: string;
  readonly messageID?: string;
  readonly id?: string;
  readonly signal?: AbortSignal;
  readonly progress?: (update: unknown) => Promise<void>;
  [key: string]: unknown;
}

export interface ToolExecutionResult {
  content: string;
}

export interface DefineToolInput<TInput> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput, context: ToolExecutionContext) => Promise<ToolExecutionResult | string>;
}

export interface DefinedTool {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options: { codemode: false };
  execute: (raw: unknown, context: ToolExecutionContext) => Promise<ToolExecutionResult>;
}

export function defineTool<TInput>(definition: DefineToolInput<TInput>): DefinedTool {
  const input = z.toJSONSchema(definition.inputSchema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return {
    name: definition.name,
    description: definition.description,
    input,
    options: { codemode: false },
    execute: async (raw: unknown, context: ToolExecutionContext) => {
      const parsed = definition.inputSchema.safeParse(raw);
      if (!parsed.success) {
        return { content: jsonError("INVALID_INPUT", `輸入驗證失敗：${parsed.error.message}`) };
      }
      const result = await definition.execute(parsed.data, context);
      return typeof result === "string" ? { content: result } : result;
    },
  };
}
