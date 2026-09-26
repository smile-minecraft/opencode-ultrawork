/**
 * skiller 寫入位置只認全域層：skiller.agentsDir 與 skiller.personalSkillRoot
 * 的專案層設定必須被忽略並警告。
 *
 * 背景：clone 一份帶 .ultrawork/ultrawork.jsonc 的 repo 就能把 skill 寫入與
 * 角色檔改寫導到任意路徑；這兩個 key 決定「寫到專案外哪裡」，只能由全域層決定。
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
import { loadSettings } from "../../../../src/settings/load.ts";

function reader(files: Record<string, string>) {
  return (path: string) => files[path];
}

describe("skiller 寫入位置只採全域層", () => {
  test("專案層的 agentsDir 被忽略並警告，全域層的值保留", () => {
    const result = loadSettings({
      readFile: reader({
        "/g/.ultrawork/ultrawork.jsonc": `{"skiller": {"agentsDir": "/g-agents"}}`,
        "/p/.ultrawork/ultrawork.jsonc": `{"skiller": {"agentsDir": "/p-agents"}}`,
      }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.skiller.agentsDir).toBe("/g-agents");
    expect(result.warnings.some((w) => w.includes("skiller.agentsDir") && w.includes("/p/.ultrawork/ultrawork.jsonc"))).toBe(true);
  });

  test("專案層的 personalSkillRoot 被忽略並警告，全域層的值保留", () => {
    const result = loadSettings({
      readFile: reader({
        "/g/.ultrawork/ultrawork.jsonc": `{"skiller": {"personalSkillRoot": "/g-skills"}}`,
        "/p/.ultrawork/ultrawork.jsonc": `{"skiller": {"personalSkillRoot": "/p-skills"}}`,
      }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.skiller.personalSkillRoot).toBe("/g-skills");
    expect(result.warnings.some((w) => w.includes("skiller.personalSkillRoot") && w.includes("/p/.ultrawork/ultrawork.jsonc"))).toBe(true);
  });

  test("沒有全域檔時專案層的值仍被忽略，退回內建預設並警告", () => {
    const result = loadSettings({
      readFile: reader({
        "/p/.ultrawork/ultrawork.jsonc": `{"skiller": {"agentsDir": "/p-agents", "personalSkillRoot": "/p-skills"}}`,
      }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.skiller.agentsDir).toBe(DEFAULT_SETTINGS.skiller.agentsDir);
    expect(result.settings.skiller.personalSkillRoot).toBe(DEFAULT_SETTINGS.skiller.personalSkillRoot);
    expect(result.warnings.filter((w) => w.includes("skiller.")).length).toBeGreaterThanOrEqual(2);
  });

  test("全域層照常生效且不產生這類警告", () => {
    const result = loadSettings({
      readFile: reader({
        "/g/.ultrawork/ultrawork.jsonc": `{"skiller": {"agentsDir": "/g-agents"}}`,
      }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.skiller.agentsDir).toBe("/g-agents");
    expect(result.warnings.some((w) => w.includes("skiller.agentsDir"))).toBe(false);
  });

  test("專案層的其他 key 照常合併，不受影響", () => {
    const result = loadSettings({
      readFile: reader({
        "/g/.ultrawork/ultrawork.jsonc": `{"skiller": {"agentsDir": "/g-agents"}}`,
        "/p/.ultrawork/ultrawork.jsonc": `{"modules": {"search": false}}`,
      }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.modules.search).toBe(false);
    expect(result.settings.skiller.agentsDir).toBe("/g-agents");
  });
});
