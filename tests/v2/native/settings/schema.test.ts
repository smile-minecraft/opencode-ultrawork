import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, MODULE_KEYS } from "../../../../src/settings/defaults.ts";
import { parseJsonc, stripJsoncComments } from "../../../../src/settings/jsonc.ts";
import {
  REPO_ROOT,
  collectKeywords,
  readSchema,
  resolveRef,
  validate,
  type JsonValue,
  type Schema,
} from "./mini-json-schema.ts";

/**
 * 設定 JSON Schema 的 gate。
 *
 * `schema/ultrawork.schema.json` 是給 `ultrawork.jsonc` 用的公開介面：編輯器
 * 靠它做自動完成與錯誤提示，使用者靠它知道有哪些欄位。它是純手寫的資料檔，
 * 沒有辦法靠型別檢查跟著 `DEFAULT_SETTINGS` 一起演化，所以這裡把它釘住：
 *
 *   1. Schema 只用底下明列的關鍵字子集（迷你驗證器只認那些）。
 *   2. 欄位集合、`type`、`enum` 與每個 `default` 都要等於 `DEFAULT_SETTINGS`。
 *   3. `DEFAULT_SETTINGS` 本身通過 schema。
 *   4. `examples/ultrawork.jsonc` 通過 schema。
 *   5. 壞掉的範例被拒絕（多餘的模組開關、錯的型別、錯的 enum、未知欄位）。
 *
 * README 裡那份設定範例由同目錄的 `readme-example.test.ts` 另行把關，兩邊共用
 * `./mini-json-schema.ts` 的驗證器。
 */

const EXAMPLE_PATH = join(REPO_ROOT, "examples", "ultrawork.jsonc");

function readExampleText(): string {
  return readFileSync(EXAMPLE_PATH, "utf-8");
}

function readExample(): unknown {
  return parseJsonc(readExampleText());
}

describe("設定 JSON Schema", () => {
  const schema = readSchema();

  test("只使用迷你驗證器支援的關鍵字", () => {
    const problems = new Set<string>();
    collectKeywords(schema, problems, "");
    expect([...problems]).toEqual([]);
  });

  test("schema 內的每個 $ref 都指得到實際定義", () => {
    const refs: string[] = [];
    const gather = (node: JsonValue): void => {
      if (Array.isArray(node)) {
        node.forEach(gather);
        return;
      }
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref") refs.push(value as string);
        else gather(value);
      }
    };
    gather(schema);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(() => resolveRef(schema, ref)).not.toThrow();
  });

  test("宣告 draft 2020-12", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(typeof schema.$id).toBe("string");
  });

  test("模組開關的欄位、型別與預設值等於 MODULE_KEYS / DEFAULT_SETTINGS", () => {
    const defs = schema.$defs as Record<string, Schema>;
    const modules = defs.modules.properties as Record<string, Schema>;
    expect(Object.keys(modules).sort()).toEqual([...MODULE_KEYS].sort());
    for (const key of MODULE_KEYS) {
      expect(modules[key]!.type).toBe("boolean");
      expect(modules[key]!.default).toBe(DEFAULT_SETTINGS.modules[key]);
    }
  });

  test("其餘可設欄位與 DEFAULT_SETTINGS 一致", () => {
    const defs = schema.$defs as Record<string, Schema>;
    const skiller = defs.skiller.properties as Record<string, Schema>;
    expect(Object.keys(skiller).sort()).toEqual(Object.keys(DEFAULT_SETTINGS.skiller).sort());
    expect(skiller.personalSkillRoot!.default).toBe(DEFAULT_SETTINGS.skiller.personalSkillRoot);
    expect(skiller.agentsDir!.default).toBe(DEFAULT_SETTINGS.skiller.agentsDir);

    const skills = defs.skills.properties as Record<string, Schema>;
    expect(Object.keys(skills)).toEqual(Object.keys(DEFAULT_SETTINGS.skills));
    expect(skills.catalog!.enum).toEqual(["index", "full"]);
    expect(skills.catalog!.default).toBe(DEFAULT_SETTINGS.skills.catalog);

    const completion = defs.completion.properties as Record<string, Schema>;
    expect(Object.keys(completion)).toEqual(Object.keys(DEFAULT_SETTINGS.workflow.completion));
    expect(completion.requireMemoryReceipt!.default).toBe(
      DEFAULT_SETTINGS.workflow.completion.requireMemoryReceipt,
    );

    const verification = defs.verification.properties as Record<string, Schema>;
    expect(Object.keys(verification).sort()).toEqual(
      Object.keys(DEFAULT_SETTINGS.verification).sort(),
    );
    expect(verification.runAllowedAgents!.type).toBe("array");
    expect(verification.runAllowedAgents!.default).toEqual(
      DEFAULT_SETTINGS.verification.runAllowedAgents,
    );
    expect(verification.scopeCheckAllowedAgents!.type).toBe("array");
    expect(verification.scopeCheckAllowedAgents!.default).toEqual(
      DEFAULT_SETTINGS.verification.scopeCheckAllowedAgents,
    );

    const workflow = defs.workflow.properties as Record<string, Schema>;
    expect(Object.keys(workflow).sort()).toEqual(Object.keys(DEFAULT_SETTINGS.workflow).sort());
    const evidencePack = (resolveRef(schema, "#/$defs/evidencePack").properties ?? {}) as Record<
      string,
      Schema
    >;
    expect(Object.keys(evidencePack)).toEqual(Object.keys(DEFAULT_SETTINGS.workflow.evidencePack));
    expect(evidencePack.gatedSubagents!.type).toBe("array");
    expect(evidencePack.gatedSubagents!.default).toEqual(
      DEFAULT_SETTINGS.workflow.evidencePack.gatedSubagents,
    );
  });

  test("根層欄位就是 modules / skiller / skills / verification / workflow", () => {
    const rootProperties = (schema.properties ?? {}) as Record<string, Schema>;
    expect(Object.keys(rootProperties).sort()).toEqual(
      ["$schema", "modules", "skiller", "skills", "verification", "workflow"],
    );
  });

  test("DEFAULT_SETTINGS 本身通過 schema", () => {
    expect(validate(DEFAULT_SETTINGS as unknown as JsonValue, schema, schema, "")).toEqual([]);
  });

  test("範例 ultrawork.jsonc 通過 schema", () => {
    expect(validate(readExample() as JsonValue, schema, schema, "")).toEqual([]);
  });

  test("範例的 $schema 指向 repo 內的 schema 路徑", () => {
    const example = readExample() as Record<string, JsonValue>;
    expect(example.$schema).toBe(
      "https://raw.githubusercontent.com/smile-minecraft/opencode-ultrawork/main/schema/ultrawork.schema.json",
    );
  });

  test("壞掉的範例被拒絕：模組開關拼錯", () => {
    const errors = validate(
      { modules: { "comment-signal": true } } as unknown as JsonValue,
      schema,
      schema,
      "",
    );
    expect(errors.join("\n")).toContain("comment-signal");
  });

  test("壞掉的範例被拒絕：模組開關型別錯", () => {
    const errors = validate({ modules: { search: "yes" } } as unknown as JsonValue, schema, schema, "");
    expect(errors.join("\n")).toContain("/modules/search 的型別");
  });

  test("壞掉的範例被拒絕：catalog 不在 enum 內", () => {
    const errors = validate({ skills: { catalog: "partial" } } as unknown as JsonValue, schema, schema, "");
    expect(errors.join("\n")).toContain("/skills/catalog 只能是");
  });

  test("壞掉的範例被拒絕：根層出現未知欄位", () => {
    const errors = validate({ memroy: {} } as unknown as JsonValue, schema, schema, "");
    expect(errors.join("\n")).toContain("memroy");
  });

  test("壞掉的範例被拒絕：路徑欄位給成數字", () => {
    const errors = validate(
      { skiller: { personalSkillRoot: 123 } } as unknown as JsonValue,
      schema,
      schema,
      "",
    );
    expect(errors.join("\n")).toContain("/skiller/personalSkillRoot 的型別");
  });

  test("壞掉的範例被拒絕：授權清單給成字串", () => {
    const errors = validate(
      { verification: { runAllowedAgents: "momus" } } as unknown as JsonValue,
      schema,
      schema,
      "",
    );
    expect(errors.join("\n")).toContain("/verification/runAllowedAgents 的型別");
  });

  test("壞掉的範例被拒絕：gatedSubagents 給成數字", () => {
    const errors = validate(
      { workflow: { evidencePack: { gatedSubagents: 0 } } } as unknown as JsonValue,
      schema,
      schema,
      "",
    );
    expect(errors.join("\n")).toContain("/workflow/evidencePack/gatedSubagents 的型別");
  });

  test("部分覆寫也算合法：空物件與單一模組開關", () => {
    expect(validate({} as JsonValue, schema, schema, "")).toEqual([]);
    expect(validate({ modules: { memory: false } } as unknown as JsonValue, schema, schema, "")).toEqual([]);
  });

  test("範例不含 JSONC 註解以外的雜訊，可直接當 JSON 解析", () => {
    expect(() => JSON.parse(stripJsoncComments(readExampleText()))).not.toThrow();
  });
});
