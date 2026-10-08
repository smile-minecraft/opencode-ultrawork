/**
 * 企劃指定九匯出的名稱、位置與參數相容。
 *
 * 每個匯出都以原路徑 import，斷言存在、可呼叫（或常數值）與最小行為。
 * 既有測試已覆蓋深層行為者，這裡只驗相容表面，不重複深層案例。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../../../src/settings/load.ts";
import { DEFAULT_SETTINGS } from "../../../src/settings/defaults.ts";
import { resolveVerificationRunAllowedAgents } from "../../../src/modules/verification/verification-policy.ts";
import { resolveChangeScopeCheckAllowedAgents } from "../../../src/modules/verification/scope-check-policy.ts";
import { searchSkills, type SkillEntry } from "../../../src/modules/skills/skill-catalog.ts";
import {
  PERSONAL_PINS_SCHEMA_VERSION,
  insertAgentSkillAllow,
  loadPersonalPins,
  removeAgentSkillLine,
  resolvePersonalPinsPath,
  type SkillerDeps,
} from "../../../src/modules/skiller/skiller-common.ts";

/** V1 形狀的最小 agent 檔（沿用 49 號測試的排版結構）。 */
const V1_AGENT = `---\ndescription: test agent\nmode: subagent\npermission:\n  skill:\n    "*": deny\n    project-*: ask\n---\n\nbody\n`;

/** V2 形狀的最小 agent 檔（沿用 50 號測試的排版結構）。 */
const V2_AGENT = `---\ndescription: test agent\nmode: subagent\npermissions:\n  - action: skill\n    resource: "*"\n    effect: deny\n  - action: skill\n    resource: personal-*\n    effect: ask\n---\n\nbody\n`;

function fakeDeps(overrides: Partial<SkillerDeps> = {}): SkillerDeps {
  return {
    resolveProjectRoot: () => "/無關/專案根",
    ...overrides,
  };
}

describe("企劃指定九匯出相容", () => {
  test("loadSettings：無層級時回預設；注入層級可覆寫", () => {
    const bare = loadSettings();
    expect(bare.settings).toEqual(DEFAULT_SETTINGS);
    expect(Array.isArray(bare.warnings)).toBe(true);

    const overridden = loadSettings({
      readFile: (path) => (path.includes("global") ? `{"verification": {"runAllowedAgents": ["momus"]}}` : undefined),
      globalDir: join(tmpdir(), "uw-compat-global"),
      projectDir: join(tmpdir(), "uw-compat-project"),
    });
    expect(overridden.settings.verification.runAllowedAgents).toEqual(["momus"]);
  });

  test("resolveVerificationRunAllowedAgents：缺席回空清單，有值回原清單", () => {
    expect(resolveVerificationRunAllowedAgents(undefined)).toEqual([]);
    expect(
      resolveVerificationRunAllowedAgents({
        ...DEFAULT_SETTINGS,
        verification: { runAllowedAgents: ["momus"], scopeCheckAllowedAgents: [] },
      }),
    ).toEqual(["momus"]);
  });

  test("resolveChangeScopeCheckAllowedAgents：缺席回空清單，有值回原清單", () => {
    expect(resolveChangeScopeCheckAllowedAgents(undefined)).toEqual([]);
    expect(
      resolveChangeScopeCheckAllowedAgents({
        ...DEFAULT_SETTINGS,
        verification: { runAllowedAgents: [], scopeCheckAllowedAgents: ["build"] },
      }),
    ).toEqual(["build"]);
  });

  test("searchSkills：空查詢回空陣列；命中依分數排序", () => {
    const skills: SkillEntry[] = [
      { name: "api-design", description: "設計對外介面" },
      { name: "unrelated", description: "完全無關的敘述" },
    ];
    expect(searchSkills(skills, "")).toEqual([]);
    expect(searchSkills(skills, "   ")).toEqual([]);
    const hits = searchSkills(skills, "api-design");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.name).toBe("api-design");
    expect(typeof hits[0]!.score).toBe("number");
    // 無關項目不得混入。
    expect(hits.some((hit) => hit.name === "unrelated")).toBe(false);
  });

  test("insertAgentSkillAllow／removeAgentSkillLine：V1 與 V2 皆可插入再移除", () => {
    for (const raw of [V1_AGENT, V2_AGENT]) {
      const inserted = insertAgentSkillAllow(raw, "subject-skill");
      expect(["inserted", "already-present"]).toContain(inserted.status);
      expect(typeof inserted.content).toBe("string");

      const again = insertAgentSkillAllow(inserted.content!, "subject-skill");
      expect(again.status).toBe("already-present");

      const removed = removeAgentSkillLine(inserted.content!, "subject-skill");
      expect(removed.status).toBe("removed");
      expect(removeAgentSkillLine(removed.content!, "subject-skill").status).toBe("absent");
    }
  });

  test("PERSONAL_PINS_SCHEMA_VERSION 為 1；loadPersonalPins 缺檔 fail closed", () => {
    expect(PERSONAL_PINS_SCHEMA_VERSION).toBe(1);
    const missing = loadPersonalPins(join(tmpdir(), "uw-compat-一定不存在的 pins.json"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("REGISTRY_UNAVAILABLE");
  });

  test("loadPersonalPins：合法 registry 讀回；版本不符拒絕", () => {
    const dir = mkdtempSync(join(tmpdir(), "uw-compat-pins-"));
    try {
      const pinsPath = join(dir, "skills-personal.json");
      const digest = "a".repeat(64);
      writeFileSync(
        pinsPath,
        JSON.stringify({
          schemaVersion: 1,
          pins: {
            "personal-demo": {
              name: "personal-demo",
              digest,
              targetAgentGroups: ["implementation"],
              resolvedTargetAgents: ["build"],
              status: "active",
              promotedAt: "2026-10-01T00:00:00.000Z",
            },
          },
        }),
      );
      const loaded = loadPersonalPins(pinsPath);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) expect(loaded.pins.pins["personal-demo"]?.digest).toBe(digest);

      writeFileSync(pinsPath, JSON.stringify({ schemaVersion: 999, pins: {} }));
      const rejected = loadPersonalPins(pinsPath);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.code).toBe("REGISTRY_SCHEMA_UNSUPPORTED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolvePersonalPinsPath：測試注入優先，否則回固定預設", () => {
    const custom = join(tmpdir(), "uw-compat-custom-pins.json");
    expect(resolvePersonalPinsPath(fakeDeps({ roots: { personalPinsPath: custom } }), null)).toBe(custom);
    const fallback = resolvePersonalPinsPath(fakeDeps(), null);
    expect(typeof fallback).toBe("string");
    expect(fallback.endsWith("skills-personal.json")).toBe(true);
  });
});
