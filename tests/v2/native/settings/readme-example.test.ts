/**
 * README 設定範例的防漂移 gate。
 *
 * 使用者多半是從 npm 頁面讀這份 README，看到的是這裡貼的範例，不是
 * `examples/ultrawork.jsonc`。所以 README 那份範例也必須真的能通過
 * `schema/ultrawork.schema.json`——否則 schema 改了、範例沒跟著改，就會有人
 * 照著貼不進去的設定除錯，而沒有任何自動檢查擋下來。
 *
 * 這裡做的事：從 README 抽出「設定」章節裡的 ```jsonc 區塊，用與執行時相同的
 * `parseJsonc` 解析，再對 schema 驗證。章節邊界是 H2 標題，所以「安裝」章節裡
 * 那些 `opencode.jsonc` 的寫法不會被誤認成 ultrawork 設定。
 *
 * 不變條件：只有 `ultrawork.jsonc` 的範例可以放在「設定」章節；`opencode.jsonc`
 * 的寫法放在「安裝」章節，否則會因為多出 `plugins` 欄位而被這裡擋下。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonc } from "../../../../src/settings/jsonc.ts";
import { REPO_ROOT, readSchema, validate, type JsonValue } from "./mini-json-schema.ts";

const README_PATH = join(REPO_ROOT, "README.md");

/** 取出一個 H2 章節的內容（到下一個 H2 標題或文件結尾為止）。 */
function readSection(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start === -1) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("## ")) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** 取出章節內所有 ```jsonc 圍欄區塊的內容。 */
function extractJsoncBlocks(section: string): string[] {
  return [...section.matchAll(/^```jsonc[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)].map(
    (match) => match[1] ?? "",
  );
}

/** 解析失敗時回報是第幾個區塊，讓失敗訊息直接指到 README 的位置。 */
function parseBlocks(blocks: string[]): { parsed: JsonValue[]; failures: string[] } {
  const parsed: JsonValue[] = [];
  const failures: string[] = [];
  blocks.forEach((text, index) => {
    try {
      parsed.push(parseJsonc(text) as JsonValue);
    } catch (error) {
      parsed.push(null);
      failures.push(`第 ${index + 1} 個 jsonc 區塊解析失敗：${(error as Error).message}`);
    }
  });
  return { parsed, failures };
}

describe("README 的設定範例", () => {
  const schema = readSchema();
  const blocks = extractJsoncBlocks(readSection(readFileSync(README_PATH, "utf-8"), "設定"));

  test("設定章節裡有 jsonc 範例可以驗", () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  test("每個 jsonc 區塊都是可解析的 JSONC", () => {
    expect(parseBlocks(blocks).failures).toEqual([]);
  });

  test("每個 jsonc 區塊都通過 ultrawork 設定 schema", () => {
    const { parsed, failures } = parseBlocks(blocks);
    const invalid: string[] = [];
    parsed.forEach((value, index) => {
      const errors = validate(value, schema);
      if (errors.length > 0) {
        invalid.push(`第 ${index + 1} 個 jsonc 區塊：\n${errors.join("\n")}`);
      }
    });
    expect([...failures, ...invalid]).toEqual([]);
  });

  test("範例的 $schema 等於 schema 檔自己的 $id", () => {
    const { parsed, failures } = parseBlocks(blocks);
    const wrong: string[] = [];
    parsed.forEach((value, index) => {
      const declared = (value as Record<string, JsonValue> | null)?.$schema;
      if (declared !== schema.$id) {
        wrong.push(`第 ${index + 1} 個 jsonc 區塊的 $schema 是 ${JSON.stringify(declared)}`);
      }
    });
    expect([...failures, ...wrong]).toEqual([]);
  });
});
