/**
 * 迷你 JSON Schema 驗證器，供設定相關的 gate 共用。
 *
 * `schema/ultrawork.schema.json` 是給 `ultrawork.jsonc` 用的公開介面，但它是純手寫
 * 的資料檔，沒有辦法靠型別檢查跟著 `DEFAULT_SETTINGS` 一起演化。這個驗證器就是
 * 為了讓測試能在執行期真的驗它，而不是只看它是合法的 JSON。
 *
 * 只支援 `KEYWORD_SHAPES` 明列的關鍵字子集。這是刻意的：不支援的關鍵字一律回報，
 * 才不會出現「驗證器靜默忽略某個關鍵字，於是該擋的沒擋」的情況。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
export const SCHEMA_PATH = join(REPO_ROOT, "schema", "ultrawork.schema.json");

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Schema = { [keyword: string]: JsonValue };

/** 關鍵字的值該是什麼形狀；`schema`／`schemaMap` 的值會被繼續走訪。 */
type KeywordShape =
  | "string"
  | "boolean"
  | "annotation"
  | "stringArray"
  | "types"
  | "schema"
  | "schemaMap";

/**
 * 迷你驗證器支援的關鍵字，以及每個關鍵字的值形狀。
 *
 * 這張表同時是「schema 只准用這個子集」的契約：不在表裡的關鍵字一律視為
 * 不支援，測試會紅。
 */
const KEYWORD_SHAPES: Record<string, KeywordShape> = {
  $schema: "string",
  $id: "string",
  $comment: "string",
  $ref: "string",
  title: "string",
  description: "string",
  type: "types",
  enum: "annotation",
  default: "annotation",
  required: "stringArray",
  additionalProperties: "boolean",
  $defs: "schemaMap",
  properties: "schemaMap",
  items: "schema",
  minLength: "annotation",
};

/** JSON Schema 的 `type` 對應的 JS typeof；object / array 另處理。 */
const JS_TYPE_OF: Record<string, (value: JsonValue) => boolean> = {
  null: (value) => value === null,
  boolean: (value) => typeof value === "boolean",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  integer: (value) => typeof value === "number" && Number.isInteger(value),
  string: (value) => typeof value === "string",
  array: (value) => Array.isArray(value),
  object: (value) => typeof value === "object" && value !== null && !Array.isArray(value),
};

function typeNames(type: JsonValue): string[] {
  return (Array.isArray(type) ? type : [type]).map((name) => {
    if (typeof name !== "string" || !(name in JS_TYPE_OF)) {
      throw new Error(`schema 的 type 用了不支援的值：${JSON.stringify(name)}`);
    }
    return name;
  });
}

/**
 * 依關鍵字形狀走訪整棵 schema，回報不符合契約的關鍵字。
 *
 * 走訪是照關鍵字的語意遞迴的（`properties` 的每個值是子 schema，不是關鍵字），
 * 所以不會把欄位名稱誤認成關鍵字。
 */
export function collectKeywords(node: JsonValue, seen: Set<string>, pointer: string): void {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    seen.add(`${pointer} 不是 schema 物件`);
    return;
  }
  for (const [keyword, value] of Object.entries(node)) {
    const shape = KEYWORD_SHAPES[keyword];
    if (shape === undefined) {
      seen.add(`${pointer}/${keyword} 是不支援的關鍵字`);
      continue;
    }
    if (shape === "schema") collectKeywords(value, seen, `${pointer}/${keyword}`);
    if (shape === "schemaMap") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        seen.add(`${pointer}/${keyword} 要放「名稱 → 子 schema」的物件`);
        continue;
      }
      for (const [name, child] of Object.entries(value)) {
        collectKeywords(child, seen, `${pointer}/${keyword}/${name}`);
      }
    }
  }
}

export function resolveRef(root: Schema, ref: JsonValue): Schema {
  if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) {
    throw new Error(`只支援 #/$defs/ 開頭的本機 $ref，收到：${JSON.stringify(ref)}`);
  }
  const name = ref.slice("#/$defs/".length);
  const target = (root["$defs"] as Record<string, JsonValue> | undefined)?.[name];
  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    throw new Error(`$ref 指向的定義不存在：${ref}`);
  }
  return target as Schema;
}

/** 對一組欄位套用 `properties` / `required` / `additionalProperties`。 */
function validateObject(
  value: Record<string, JsonValue>,
  schema: Schema,
  root: Schema,
  pointer: string,
  errors: string[],
): void {
  const required = schema.required;
  if (Array.isArray(required)) {
    for (const name of required) {
      if (typeof name === "string" && !(name in value)) {
        errors.push(`${pointer} 缺少必填欄位 ${name}`);
      }
    }
  }
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(value)) {
      if (!(name in properties)) errors.push(`${pointer} 出現 schema 沒定義的欄位 ${name}`);
    }
  }
  for (const [name, child] of Object.entries(properties)) {
    if (name in value) errors.push(...validate(value[name], child, root, `${pointer}/${name}`));
  }
}

/** 迷你 JSON Schema 驗證器：只支援 KEYWORD_SHAPES 裡的關鍵字。回傳錯誤訊息陣列。 */
export function validate(
  value: JsonValue,
  schema: Schema,
  root: Schema = schema,
  pointer = "",
): string[] {
  const errors: string[] = [];
  if (typeof schema["$ref"] === "string") {
    errors.push(...validate(value, resolveRef(root, schema["$ref"]), root, pointer));
  }
  if (schema.type !== undefined) {
    const names = typeNames(schema.type);
    if (!names.some((name) => JS_TYPE_OF[name]!(value))) {
      errors.push(`${pointer} 的型別要是 ${names.join(" | ")}，實際是 ${JSON.stringify(value)}`);
      return errors;
    }
  }
  if (Array.isArray(schema.enum)) {
    const allowed = (schema.enum as JsonValue[]).map((item) => JSON.stringify(item));
    if (!allowed.includes(JSON.stringify(value))) {
      errors.push(`${pointer} 只能是 ${allowed.join(" | ")}，實際是 ${JSON.stringify(value)}`);
    }
  }
  if (typeof value === "string" && typeof schema.minLength === "number" && [...value].length < schema.minLength) errors.push(`${pointer} 字串太短`);
  if (Array.isArray(value) && schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) value.forEach((item,index)=>errors.push(...validate(item,schema.items as Schema,root,`${pointer}/${index}`)));
  if (JS_TYPE_OF.object!(value)) {
    validateObject(value as Record<string, JsonValue>, schema, root, pointer, errors);
  }
  return errors;
}

/** 讀出 `schema/ultrawork.schema.json`。 */
export function readSchema(): Schema {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf-8")) as Schema;
}
