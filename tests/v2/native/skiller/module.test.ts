import { describe, expect, test } from "bun:test";
import { setupUltrawork } from "../../../../src/index.ts";
import { skillerModule } from "../../../../src/modules/skiller/index.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../../_fake-v2-context.ts";

const EXPECTED_SKILLER_TOOLS = [
  "skiller-scan",
  "skiller-validate",
  "skiller-draft",
  "skiller-draft-read",
  "skiller-draft-update",
  "skiller-draft-delete",
  "skiller-promote",
  "skiller-retire",
  "skiller-restore",
  "skiller-import",
  "skiller-policy-update",
];

describe("skiller 原生模組註冊", () => {
  test("模組開啟時註冊 11 個 skiller 工具", async () => {
    const fake = createFakeV2Context({ directory: "/tmp/skiller-project" });
    await skillerModule.register({
      ctx: fake.ctx,
      settings: {
        modules: { skiller: true },
        skiller: { personalSkillRoot: "/tmp/skills", agentsDir: "/tmp/agents" },
        skills: { catalog: "index" },
        workflow: { completion: { requireMemoryDisposition: true } },
      },
    } as never);

    expect([...fake.added.keys()].sort()).toEqual(EXPECTED_SKILLER_TOOLS.sort());
    for (const definition of fake.added.values()) {
      expect(definition.options).toEqual({ codemode: false });
      expect(typeof definition.execute).toBe("function");
    }
    expect(fakeV2ToolContext).toBeDefined();
  });

  test("模組關閉時不註冊任何 skiller 工具", async () => {
    const fake = createFakeV2Context({ directory: "/tmp/skiller-project" });
    await setupUltrawork(fake.ctx, {
      modules: [skillerModule],
      settings: { modules: { skiller: false } },
    });

    expect(fake.added.size).toBe(0);
    expect([...fake.added.keys()].some((name) => name.startsWith("skiller-"))).toBe(false);
  });
});
