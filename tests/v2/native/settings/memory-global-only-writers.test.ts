/**
 * memory 寫入者只認全域層：memory.writerAgents 的專案層設定必須被忽略並警告。
 *
 * 背景：writerAgents 決定誰能寫全域記憶（理由同 skiller 的寫入位置），只能由
 * 全域層決定；clone 來的 repo 自帶的專案層設定不得改寫全域寫入者名單。
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
import { loadSettings } from "../../../../src/settings/load.ts";

function reader(files: Record<string, string>) {
  return (path: string) => files[path];
}

describe("memory 寫入者只採全域層", () => {
  test("專案層的 writerAgents 被忽略並警告，全域層的值保留", () => {
    const result = loadSettings({
      readFile: reader({
        "/g/.ultrawork/ultrawork.jsonc": `{"memory": {"writerAgents": ["global-writer"]}}`,
        "/p/.ultrawork/ultrawork.jsonc": `{"memory": {"writerAgents": ["project-writer"]}}`,
      }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.memory.writerAgents).toEqual(["global-writer"]);
    expect(
      result.warnings.some((w) => w.includes("memory.writerAgents") && w.includes("/p/.ultrawork/ultrawork.jsonc")),
    ).toBe(true);
  });

  test("沒有全域檔時專案層的值仍被忽略，退回內建預設並警告", () => {
    const result = loadSettings({
      readFile: reader({
        "/p/.ultrawork/ultrawork.jsonc": `{"memory": {"writerAgents": ["project-writer"]}}`,
      }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.memory.writerAgents).toEqual(DEFAULT_SETTINGS.memory.writerAgents);
    expect(result.warnings.some((w) => w.includes("memory.writerAgents"))).toBe(true);
  });

  test("全域層照常生效且不產生這類警告", () => {
    const result = loadSettings({
      readFile: reader({
        "/g/.ultrawork/ultrawork.jsonc": `{"memory": {"writerAgents": ["global-writer"]}}`,
      }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.memory.writerAgents).toEqual(["global-writer"]);
    expect(result.warnings.some((w) => w.includes("memory.writerAgents"))).toBe(false);
  });

  test("專案層的其他 memory key 照常合併，不受影響", () => {
    const result = loadSettings({
      readFile: reader({
        "/g/.ultrawork/ultrawork.jsonc": `{"memory": {"writerAgents": ["global-writer"]}}`,
        "/p/.ultrawork/ultrawork.jsonc": `{"memory": {"inject": false}}`,
      }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.memory.inject).toBe(false);
    expect(result.settings.memory.writerAgents).toEqual(["global-writer"]);
  });
});
