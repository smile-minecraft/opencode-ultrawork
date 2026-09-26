/** 全域設定資料夾解析：OPENCODE_CONFIG_DIR → XDG_CONFIG_HOME → ~/.config。 */

import { describe, expect, test } from "bun:test";
import {
  resolveGlobalConfigDir,
  resolveGlobalUltraworkDir,
  resolveProjectUltraworkDir,
} from "../../../src/settings/paths.ts";

describe("全域設定資料夾解析", () => {
  test("OPENCODE_CONFIG_DIR 優先", () => {
    expect(resolveGlobalConfigDir({ OPENCODE_CONFIG_DIR: "/custom/cfg" }, "/home/u")).toBe("/custom/cfg");
  });

  test("沒有 OPENCODE_CONFIG_DIR 時用 XDG_CONFIG_HOME/opencode", () => {
    expect(resolveGlobalConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe("/xdg/opencode");
  });

  test("兩者皆無時退回 ~/.config/opencode", () => {
    expect(resolveGlobalConfigDir({}, "/home/u")).toBe("/home/u/.config/opencode");
  });

  test(".ultrawork 路徑解析", () => {
    expect(resolveGlobalUltraworkDir("/xdg/opencode")).toBe("/xdg/opencode/.ultrawork");
    expect(resolveProjectUltraworkDir("/work/proj")).toBe("/work/proj/.ultrawork");
  });
});
