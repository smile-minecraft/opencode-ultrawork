/**
 * 合成宿主設定一致性與缺能力拒絕矩陣。
 *
 * - 同一份設定在兩個獨立宿主得到相同工具集合／開關結論。
 * - 授權清單（空 vs 有值）在合成宿主與 OpenCode 宿主上的判定一致。
 * - 缺席的能力必須明確拒絕（錯誤碼一致），不得靜默成功。
 */

import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../../src/settings/defaults.ts";
import { EXPECTED_TOOL_NAMES } from "../../../src/modules/diagnostics/index.ts";
import { verificationModule } from "../../../src/modules/verification/index.ts";
import { memoryWriterPolicyText } from "../../../src/modules/memory/writer-policy.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../_fake-v2-context.ts";
import {
  createSyntheticHost,
  invokeSynthetic,
  makeSyntheticRoots,
  makeSyntheticRoleEditor,
  makeSyntheticRoleLookup,
  registerSynthetic,
} from "./_synthetic-host.ts";

function settingsWithVerification(runAllowedAgents: string[], scopeCheckAllowedAgents: string[]) {
  return {
    ...DEFAULT_SETTINGS,
    verification: { runAllowedAgents, scopeCheckAllowedAgents },
  };
}

function skillerIsolatedSettings(globalDirectory: string) {
  return {
    ...DEFAULT_SETTINGS,
    skiller: {
      personalSkillRoot: join(globalDirectory, "skills"),
      agentsDir: join(globalDirectory, "agents"),
    },
  };
}

async function executeOpenCodeVerificationTool(
  projectDirectory: string,
  settings: ReturnType<typeof settingsWithVerification>,
  name: string,
  input: Record<string, unknown>,
  agent?: string,
): Promise<any> {
  const fake = createFakeV2Context({ directory: projectDirectory, sessionDirectory: projectDirectory });
  await verificationModule.register({ host: fake.host, settings });
  const definition = fake.added.get(name);
  if (!definition) throw new Error(`工具未組裝：${name}`);
  return JSON.parse((await definition.execute(input, { ...fakeV2ToolContext(), agent })).content);
}

describe("合成宿主設定一致性", () => {
  test("harness 本身不依賴適配器或平台套件", async () => {
    const source = await readFile(join(process.cwd(), "tests", "v2", "native", "_synthetic-host.ts"), "utf-8");
    expect(source).not.toContain("src/opencode/");
    expect(source).not.toContain("opencode/adapter");
    expect(source).not.toContain("@opencode/plugin");
    expect(source).not.toContain("@opencode/");
  });

  test("同設定在兩個獨立宿主得到相同工具集合", async () => {
    const firstRoots = await makeSyntheticRoots("uw-synth-same-a-");
    const secondRoots = await makeSyntheticRoots("uw-synth-same-b-");
    try {
      const settings = settingsWithVerification(["momus"], ["build"]);
      const first = createSyntheticHost({
        projectDirectory: firstRoots.projectDirectory,
        globalConfigDirectory: firstRoots.globalDirectory,
      });
      const second = createSyntheticHost({
        projectDirectory: secondRoots.projectDirectory,
        globalConfigDirectory: secondRoots.globalDirectory,
      });
      const registrations = [
        ...(await registerSynthetic(first, settings)),
        ...(await registerSynthetic(second, settings)),
      ];
      try {
        const expected = [...EXPECTED_TOOL_NAMES].sort();
        expect([...first.definitions.keys()].sort()).toEqual(expected);
        expect([...second.definitions.keys()].sort()).toEqual(expected);
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await Promise.all([firstRoots.cleanup(), secondRoots.cleanup()]);
    }
  });

  test("關閉模組時兩宿主一致少掉該家族工具", async () => {
    const firstRoots = await makeSyntheticRoots("uw-synth-off-a-");
    const secondRoots = await makeSyntheticRoots("uw-synth-off-b-");
    try {
      const settings = {
        ...settingsWithVerification(["momus"], ["build"]),
        modules: { ...DEFAULT_SETTINGS.modules, diagnostics: false },
      };
      const first = createSyntheticHost({
        projectDirectory: firstRoots.projectDirectory,
        globalConfigDirectory: firstRoots.globalDirectory,
      });
      const second = createSyntheticHost({
        projectDirectory: secondRoots.projectDirectory,
        globalConfigDirectory: secondRoots.globalDirectory,
      });
      const registrations = [
        ...(await registerSynthetic(first, settings)),
        ...(await registerSynthetic(second, settings)),
      ];
      try {
        const firstNames = [...first.definitions.keys()].sort();
        const secondNames = [...second.definitions.keys()].sort();
        expect(firstNames).toEqual(secondNames);
        expect(firstNames).not.toContain("workflow_doctor");
        expect(firstNames).not.toContain("workflow_health_check");
        expect(firstNames).not.toContain("tool_hook_manifest");
        expect(firstNames).toContain("grep_context");
        expect(firstNames).toHaveLength(EXPECTED_TOOL_NAMES.length - 6);
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await Promise.all([firstRoots.cleanup(), secondRoots.cleanup()]);
    }
  });

  test("授權空清單拒絕所有人；有值時兩宿主結論一致且與 OpenCode 宿主相同", async () => {
    const synthRoots = await makeSyntheticRoots("uw-synth-auth-synth-");
    const openRoots = await makeSyntheticRoots("uw-synth-auth-open-");
    try {
      const emptySettings = settingsWithVerification([], []);
      const synth = createSyntheticHost({
        projectDirectory: synthRoots.projectDirectory,
        globalConfigDirectory: synthRoots.globalDirectory,
      });
      const registrations = await registerSynthetic(synth, emptySettings);
      try {
        for (const agent of ["momus", "build"] as const) {
          const result = await invokeSynthetic(
            synth,
            "verification_run",
            { runner: "bun", script: "test:p0" },
            "synthetic-session",
            agent,
          );
          expect(result.ok).toBe(false);
          expect(result.code).toBe("AGENT_NOT_ALLOWED");
        }
        const openDenied = await executeOpenCodeVerificationTool(
          openRoots.projectDirectory,
          emptySettings,
          "verification_run",
          { runner: "bun", script: "test:p0" },
          "momus",
        );
        expect(openDenied.code).toBe("AGENT_NOT_ALLOWED");
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }

      const allowedSettings = settingsWithVerification(["momus"], ["build"]);
      const synthAllowed = createSyntheticHost({
        projectDirectory: synthRoots.projectDirectory,
        globalConfigDirectory: synthRoots.globalDirectory,
      });
      const registrationsAllowed = await registerSynthetic(synthAllowed, allowedSettings);
      try {
        const synthDenied = await invokeSynthetic(
          synthAllowed,
          "verification_run",
          { runner: "bun", script: "test:p0" },
          "synthetic-session",
          "build",
        );
        expect(synthDenied.code).toBe("AGENT_NOT_ALLOWED");
        const openDenied = await executeOpenCodeVerificationTool(
          openRoots.projectDirectory,
          allowedSettings,
          "verification_run",
          { runner: "bun", script: "test:p0" },
          "build",
        );
        expect(openDenied.code).toBe("AGENT_NOT_ALLOWED");

        const synthPassedGate = await invokeSynthetic(
          synthAllowed,
          "verification_run",
          { runner: "no-such-runner", script: "test" },
          "synthetic-session",
          "momus",
        );
        expect(synthPassedGate.code).not.toBe("AGENT_NOT_ALLOWED");
        const openPassedGate = await executeOpenCodeVerificationTool(
          openRoots.projectDirectory,
          allowedSettings,
          "verification_run",
          { runner: "no-such-runner", script: "test" },
          "momus",
        );
        expect(openPassedGate.code).not.toBe("AGENT_NOT_ALLOWED");
        expect(synthPassedGate.code).toBe(openPassedGate.code);
      } finally {
        for (const item of registrationsAllowed.reverse()) await item.dispose();
      }
    } finally {
      await Promise.all([synthRoots.cleanup(), openRoots.cleanup()]);
    }
  });

  test("記憶 writer 政策文字兩宿主一致且反映設定", async () => {
    const firstRoots = await makeSyntheticRoots("uw-synth-writer-a-");
    const secondRoots = await makeSyntheticRoots("uw-synth-writer-b-");
    try {
      const settings = {
        ...settingsWithVerification(["momus"], ["build"]),
        memory: { ...DEFAULT_SETTINGS.memory, writerAgents: ["memorizer"] },
      };
      const first = createSyntheticHost({
        projectDirectory: firstRoots.projectDirectory,
        globalConfigDirectory: firstRoots.globalDirectory,
      });
      const second = createSyntheticHost({
        projectDirectory: secondRoots.projectDirectory,
        globalConfigDirectory: secondRoots.globalDirectory,
      });
      const registrations = [
        ...(await registerSynthetic(first, settings)),
        ...(await registerSynthetic(second, settings)),
      ];
      try {
        expect(first.definitions.get("memory-note")?.description).toBe(
          second.definitions.get("memory-note")?.description,
        );
        expect(first.definitions.get("memory-note")?.description).toContain(
          memoryWriterPolicyText(["memorizer"]),
        );
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await Promise.all([firstRoots.cleanup(), secondRoots.cleanup()]);
    }
  });
});

describe("合成宿主缺能力拒絕矩陣", () => {
  test("角色檔查詢缺席→doctor 該項 skipped；注入後同設定通過且兩宿主互不影響", async () => {
    const withoutRoots = await makeSyntheticRoots("uw-synth-nolookup-");
    const withRoots = await makeSyntheticRoots("uw-synth-withlookup-");
    try {
      const settings = settingsWithVerification(["momus"], ["build"]);
      const agentsDir = join(withRoots.globalDirectory, "agents");
      await mkdir(agentsDir, { recursive: true });
      for (const name of ["momus", "build"]) {
        await writeFile(join(agentsDir, `${name}.md`), `# ${name}\n`, "utf-8");
      }
      const without = createSyntheticHost({
        projectDirectory: withoutRoots.projectDirectory,
        globalConfigDirectory: withoutRoots.globalDirectory,
      });
      const withLookup = createSyntheticHost({
        projectDirectory: withRoots.projectDirectory,
        globalConfigDirectory: withRoots.globalDirectory,
        capabilities: { agentRoleFiles: makeSyntheticRoleLookup() },
      });
      const withSettings = {
        ...settings,
        skiller: { ...DEFAULT_SETTINGS.skiller, agentsDir },
      };
      const registrations = [
        ...(await registerSynthetic(without, withSettings)),
        ...(await registerSynthetic(withLookup, withSettings)),
      ];
      try {
        const skipped = await invokeSynthetic(without, "workflow_doctor", {});
        const skippedCheck = skipped.data.checks.find(
          (check: { name: string }) => check.name === "Agent Role Files",
        );
        expect(skippedCheck.status).toBe("skipped");
        expect(skippedCheck.details).toContain("宿主未提供角色檔查詢能力");

        const passed = await invokeSynthetic(withLookup, "workflow_doctor", {});
        const passedCheck = passed.data.checks.find(
          (check: { name: string }) => check.name === "Agent Role Files",
        );
        expect(passedCheck.status).toBe("passed");

        const stillSkipped = await invokeSynthetic(without, "workflow_doctor", {});
        expect(
          stillSkipped.data.checks.find((check: { name: string }) => check.name === "Agent Role Files").status,
        ).toBe("skipped");
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await Promise.all([withoutRoots.cleanup(), withRoots.cleanup()]);
    }
  });

  test("角色檔改寫缺席→retire 與 promote 明確拒絕且錯誤碼一致；注入後越過能力門", async () => {
    const withoutRoots = await makeSyntheticRoots("uw-synth-noeditor-a-");
    const withRoots = await makeSyntheticRoots("uw-synth-noeditor-b-");
    try {
      const without = createSyntheticHost({
        projectDirectory: withoutRoots.projectDirectory,
        globalConfigDirectory: withoutRoots.globalDirectory,
      });
      const withEditor = createSyntheticHost({
        projectDirectory: withRoots.projectDirectory,
        globalConfigDirectory: withRoots.globalDirectory,
        capabilities: { agentRoleEditor: makeSyntheticRoleEditor() },
      });
      const registrations = [
        ...(await registerSynthetic(without, skillerIsolatedSettings(withoutRoots.globalDirectory))),
        ...(await registerSynthetic(withEditor, skillerIsolatedSettings(withRoots.globalDirectory))),
      ];
      try {
        const retireDenied = await invokeSynthetic(without, "skiller-retire", {
          scope: "managed",
          mode: "apply",
        });
        expect(retireDenied).toMatchObject({ ok: false, code: "HOST_CAPABILITY_UNAVAILABLE" });

        const promoteDenied = await invokeSynthetic(without, "skiller-promote", {
          scope: "managed",
          name: "synth-skill",
          mode: "preview",
          targetAgents: ["no-such-agent"],
        });
        expect(promoteDenied).toMatchObject({ ok: false, code: "HOST_CAPABILITY_UNAVAILABLE" });

        const retirePastGate = await invokeSynthetic(withEditor, "skiller-retire", {
          scope: "managed",
          mode: "apply",
        });
        expect(retirePastGate.ok).toBe(false);
        expect(retirePastGate.code).not.toBe("HOST_CAPABILITY_UNAVAILABLE");

        const promotePastGate = await invokeSynthetic(withEditor, "skiller-promote", {
          scope: "managed",
          name: "synth-skill",
          mode: "preview",
          targetAgents: ["no-such-agent"],
        });
        expect(promotePastGate).toMatchObject({ ok: false, code: "UNKNOWN_AGENT" });
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await Promise.all([withoutRoots.cleanup(), withRoots.cleanup()]);
    }
  });
});

describe("合成宿主邊際情況", () => {
  test("全域目錄不存在時工具仍可執行；storage scan 分頁與真實語意一致", async () => {
    const roots = await makeSyntheticRoots("uw-synth-edge-");
    try {
      const missingGlobal = join(roots.root, "no-such-global");
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: missingGlobal,
      });
      const registrations = await registerSynthetic(synth, settingsWithVerification(["momus"], ["build"]));
      try {
        const manifest = await invokeSynthetic(synth, "tool_hook_manifest", {});
        expect(manifest.ok).toBe(true);

        await synth.host.storage.set("session/s/a", 1);
        await synth.host.storage.set("session/s/b", 2);
        await synth.host.storage.set("session/s/c", 3);
        const firstPage = await synth.host.storage.scan({ prefix: "session/s/", limit: 2 });
        expect(firstPage.entries.map((entry) => entry.key)).toEqual(["session/s/a", "session/s/b"]);
        expect(typeof firstPage.next).toBe("string");
        const secondPage = await synth.host.storage.scan({ prefix: "session/s/", after: firstPage.next, limit: 2 });
        expect(secondPage.entries.map((entry) => entry.key)).toEqual(["session/s/c"]);
        expect(secondPage.next).toBeUndefined();
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });
});
