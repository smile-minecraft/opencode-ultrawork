/**
 * 設定執行期驗證與模組開關單一語意的固定測試。
 *
 * 背景：設定載入只做合併、零型別驗證，無效值會一路流進模組
 * （例如 skiller 給字串會在 expandHome 崩潰）；三處開關判斷語意不一致
 * （registry 用 !== false，workflow 用 truthy，0／"" 兩邊結論相反）。
 */

import { describe, expect, test } from "bun:test";
import { moduleEnabled } from "../../../../src/modules/diagnostics/deps.ts";
import { isModuleEnabled } from "../../../../src/modules/registry.ts";
import { resolveChangeScopeCheckAllowedAgents } from "../../../../src/modules/verification/scope-check-policy.ts";
import { resolveVerificationRunAllowedAgents } from "../../../../src/modules/verification/verification-policy.ts";
import { resolveEvidencePackGatedSubagents } from "../../../../src/modules/workflow/gates/evidence-pack.ts";
import { createWorkflowRuntime } from "../../../../src/modules/workflow/runtime/v2-runtime.ts";
import { DEFAULT_SETTINGS, type UltraworkSettings } from "../../../../src/settings/defaults.ts";
import { loadSettings } from "../../../../src/settings/load.ts";
import { asStringList, sanitizeSettings } from "../../../../src/settings/validate.ts";
import { createFakeV2Context } from "../../_fake-v2-context.ts";

function reader(files: Record<string, string>) {
  return (path: string) => files[path];
}

/** 開關被塞非布林值時的設定（繞過型別，直達執行期語意）。 */
function badSwitchSettings(): UltraworkSettings {
  return {
    ...DEFAULT_SETTINGS,
    modules: {
      ...DEFAULT_SETTINGS.modules,
      memory: 0 as unknown as boolean,
      commentSignal: 0 as unknown as boolean,
    },
  };
}

describe("設定執行期驗證", () => {
  test("skiller 整段給字串時退回預設並警告", () => {
    const result = loadSettings({
      readFile: reader({ "/p/.ultrawork/ultrawork.jsonc": `{"skiller": "off"}` }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.skiller).toEqual(DEFAULT_SETTINGS.skiller);
    expect(result.warnings.some((line) => line.includes("skiller"))).toBe(true);
  });

  test("workflow 整段給數字時退回預設並警告", () => {
    const result = loadSettings({
      readFile: reader({ "/p/.ultrawork/ultrawork.jsonc": `{"workflow": 0}` }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.workflow).toEqual(DEFAULT_SETTINGS.workflow);
    expect(result.warnings.some((line) => line.includes("workflow"))).toBe(true);
  });

  test("模組開關給非布林值時該開關退回預設並警告", () => {
    const result = loadSettings({
      readFile: reader({ "/p/.ultrawork/ultrawork.jsonc": `{"modules": {"memory": 0}}` }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.modules.memory).toBe(true);
    expect(result.warnings.some((line) => line.includes("memory"))).toBe(true);
  });
});

describe("模組開關單一語意：只有 boolean false 是關", () => {
  test("0／null／字串在 registry 與 diagnostics 都視為開啟", () => {
    for (const value of [0, null, "off", "", 1, true]) {
      const settings = {
        ...DEFAULT_SETTINGS,
        modules: { ...DEFAULT_SETTINGS.modules, memory: value as unknown as boolean },
      };
      expect(isModuleEnabled(settings, "memory")).toBe(true);
      expect(moduleEnabled(settings, "memory")).toBe(true);
    }
  });

  test("明確 false 在兩處都是關", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      modules: { ...DEFAULT_SETTINGS.modules, memory: false },
    };
    expect(isModuleEnabled(settings, "memory")).toBe(false);
    expect(moduleEnabled(settings, "memory")).toBe(false);
  });

  test("workflow 的 memory／commentSignal 開關與 registry 一致", async () => {
    const fake = createFakeV2Context({ directory: "/work/project" });
    const runtime = createWorkflowRuntime(fake.ctx, badSwitchSettings());
    expect(runtime.memoryReceiptRequired).toBe(true);
    const commentSignal = await runtime.validateCommentSignalForCompletion("s1");
    expect(commentSignal.ok).toBe(true);
    if (commentSignal.ok) expect(commentSignal.status).not.toBe("disabled");
  });
});

describe("sanitizeSettings：無效值警告＋退回預設", () => {
  test("0／null／字串的授權清單都退回預設並警告", () => {
    for (const value of [0, null, "momus", [""], [0], {}]) {
      const { settings, warnings } = sanitizeSettings({
        verification: { runAllowedAgents: value },
      });
      expect(settings.verification.runAllowedAgents).toEqual(
        DEFAULT_SETTINGS.verification.runAllowedAgents,
      );
      expect(warnings.some((line) => line.includes("verification.runAllowedAgents"))).toBe(true);
    }
  });

  test("合法覆寫原樣保留，不警告", () => {
    const { settings, warnings } = sanitizeSettings({
      modules: { memory: false },
      verification: {
        runAllowedAgents: ["momus", "arch"],
        scopeCheckAllowedAgents: ["build"],
      },
      workflow: { evidencePack: { gatedSubagents: ["implementer"] } },
    });
    expect(settings.modules.memory).toBe(false);
    expect(settings.verification.runAllowedAgents).toEqual(["momus", "arch"]);
    expect(settings.workflow.evidencePack.gatedSubagents).toEqual(["implementer"]);
    // skills.catalog 等沒寫的欄位維持預設
    expect(settings.skills.catalog).toBe(DEFAULT_SETTINGS.skills.catalog);
    expect(warnings).toEqual([]);
  });

  test("拼錯的 key 會警告並忽略（例如 comment-signal）", () => {
    const { settings, warnings } = sanitizeSettings({
      modules: { "comment-signal": true },
    });
    expect(settings.modules.commentSignal).toBe(true);
    expect(warnings.some((line) => line.includes("comment-signal"))).toBe(true);
  });

  test("$schema 是編輯器提示，安靜丟掉不警告", () => {
    const { settings, warnings } = sanitizeSettings({
      $schema: "https://example.com/schema.json",
      modules: { memory: false },
    });
    expect(settings.modules.memory).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("整份設定不是物件時全部退回預設並警告", () => {
    const { settings, warnings } = sanitizeSettings("off");
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("授權清單回傳拷貝，不沿用輸入陣列", () => {
    const input = ["momus"];
    const { settings } = sanitizeSettings({ verification: { runAllowedAgents: input } });
    expect(settings.verification.runAllowedAgents).toEqual(["momus"]);
    expect(settings.verification.runAllowedAgents).not.toBe(input);
  });
});

describe("asStringList", () => {
  test("非空字串陣列通過，空陣列也算有效（明確清空）", () => {
    expect(asStringList(["a", "b"])).toEqual(["a", "b"]);
    expect(asStringList([])).toEqual([]);
  });

  test("0／null／字串／含空字串與非字串都算無效", () => {
    for (const value of [0, null, "momus", [""], ["ok", 0], [null], {}]) {
      expect(asStringList(value)).toBeUndefined();
    }
  });
});

describe("授權清單解析：預設沿用現值，設定可覆寫", () => {
  test("沒給設定時三份清單都等於內建預設", () => {
    expect(resolveVerificationRunAllowedAgents(undefined)).toEqual(["momus"]);
    expect(resolveChangeScopeCheckAllowedAgents(undefined)).toEqual(["build", "ultra"]);
    expect(resolveEvidencePackGatedSubagents(undefined)).toEqual([
      "implementer",
      "debugger",
      "ultra-coder",
    ]);
  });

  test("設定覆寫生效", () => {
    const settings: UltraworkSettings = {
      ...DEFAULT_SETTINGS,
      verification: {
        runAllowedAgents: ["momus", "arch"],
        scopeCheckAllowedAgents: ["ultra"],
      },
      workflow: {
        ...DEFAULT_SETTINGS.workflow,
        evidencePack: { gatedSubagents: ["implementer"] },
      },
    };
    expect(resolveVerificationRunAllowedAgents(settings)).toEqual(["momus", "arch"]);
    expect(resolveChangeScopeCheckAllowedAgents(settings)).toEqual(["ultra"]);
    expect(resolveEvidencePackGatedSubagents(settings)).toEqual(["implementer"]);
  });

  test("設定寫壞時退回內建預設（縱深：驗證層漏掉也擋得住）", () => {
    const settings = {
      verification: { runAllowedAgents: 0, scopeCheckAllowedAgents: null },
      workflow: { evidencePack: { gatedSubagents: "implementer" } },
    } as unknown as UltraworkSettings;
    expect(resolveVerificationRunAllowedAgents(settings)).toEqual(["momus"]);
    expect(resolveChangeScopeCheckAllowedAgents(settings)).toEqual(["build", "ultra"]);
    expect(resolveEvidencePackGatedSubagents(settings)).toEqual([
      "implementer",
      "debugger",
      "ultra-coder",
    ]);
  });
});
