/** 設定合併：內建預設 → 全域 → 專案；深層合併；純量與陣列整個覆寫；壞檔退回預設。 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../../../src/settings/defaults.ts";
import { parseJsonc } from "../../../src/settings/jsonc.ts";
import { loadSettings } from "../../../src/settings/load.ts";
import { mergeSettings } from "../../../src/settings/merge.ts";

function reader(files: Record<string, string>) {
  return (path: string) => files[path];
}

describe("設定合併", () => {
  test("沒有任何設定檔時用內建預設", () => {
    const result = loadSettings({ readFile: reader({}), globalDir: "/g", projectDir: "/p" });
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.warnings).toEqual([]);
  });

  test("全域覆寫只改指定的欄位", () => {
    const result = loadSettings({
      readFile: reader({ "/g/.ultrawork/ultrawork.jsonc": `{"modules": {"memory": false}}` }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.modules.memory).toBe(false);
    expect(result.settings.modules.search).toBe(true);
  });

  test("專案覆寫優先於全域，物件深層合併", () => {
    const result = loadSettings({
      readFile: reader({
        "/g/.ultrawork/ultrawork.jsonc": `{"workflow": {"completion": {"requireMemoryReceipt": false}}}`,
        "/p/.ultrawork/ultrawork.jsonc": `{"modules": {"search": false}}`,
      }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.modules.search).toBe(false);
    expect(result.settings.workflow.completion.requireMemoryReceipt).toBe(false);
    expect(result.settings.skills.catalog).toBe(DEFAULT_SETTINGS.skills.catalog);
  });

  test("純量與陣列整個覆寫，不逐項合併", () => {
    const merged = mergeSettings(
      { ...DEFAULT_SETTINGS, skills: { catalog: "index" as const }, extra: { list: [1, 2] } } as any,
      { extra: { list: [3] } } as any,
    );
    expect((merged as any).extra.list).toEqual([3]);
  });

  test("JSONC 註解可以解析，字串內的 // 不誤判", () => {
    const parsed = parseJsonc(`{
      // 整行註解
      "a": "http://example.com/x", /* 尾註解 */
      "b": 1 // 行尾註解
    }`);
    expect(parsed).toEqual({ a: "http://example.com/x", b: 1 });
  });

  test("格式錯誤的設定檔忽略該層並回報警告", () => {
    const result = loadSettings({
      readFile: reader({ "/g/.ultrawork/ultrawork.jsonc": `{"modules": {` }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("/g/.ultrawork/ultrawork.jsonc");
  });

  test("缺檔與目錄當檔都視為沒有設定，不警告", () => {
    const result = loadSettings({
      readFile: () => {
        throw new Error("EISDIR");
      },
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.warnings).toEqual([]);
  });

  test("專案檔壞掉只忽略該層，保留全域已套用的覆寫", () => {
    const result = loadSettings({
      readFile: reader({
        "/g/.ultrawork/ultrawork.jsonc": `{"modules": {"memory": false}}`,
        "/p/.ultrawork/ultrawork.jsonc": `{"modules": {`,
      }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.modules.memory).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("/p/.ultrawork/ultrawork.jsonc");
  });
});
