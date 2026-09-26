import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerModules } from "../../../../src/modules/registry.ts";
import { diagnosticsModule } from "../../../../src/modules/diagnostics/index.ts";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
import { createFakeV2Context } from "../../_fake-v2-context.ts";

/** 凍結介面：六個工具的名稱與順序。 */
const TOOL_NAMES = [
  "workflow_bootstrap",
  "workflow_l1_check",
  "workflow_doctor",
  "workflow_health_check",
  "tool_hook_manifest",
  "ultrawork_selftest",
] as const;

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-diagnostics-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("diagnostics V2 模組註冊", () => {
  test("註冊 6 個工具，每個都有描述與 execute", async () => {
    const root = await tempRoot();
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    const registration = await diagnosticsModule.register({ ctx: fake.ctx, settings: DEFAULT_SETTINGS });
    expect(registration).toBeDefined();

    expect([...fake.added.keys()].sort()).toEqual([...TOOL_NAMES].sort());
    for (const name of TOOL_NAMES) {
      const tool = fake.added.get(name);
      expect(tool.options).toEqual({ codemode: false });
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.execute).toBe("function");
    }

    await registration?.dispose();
  });

  test("模組關閉時不註冊工具或 hook", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.modules.diagnostics = false;
    const fake = createFakeV2Context({ tools: [{ id: "subagent", description: "派遣子代理" }] });
    const registrations = await registerModules({ ctx: fake.ctx, settings }, [diagnosticsModule]);
    expect(registrations).toEqual([]);
    expect(fake.added.size).toBe(0);
    expect(fake.toolHooks.size).toBe(0);
    expect(fake.sessionHooks.size).toBe(0);
  });

  test("dispose 呼叫不拋錯；模組不持有可殘留的 hook 訂閱", async () => {
    const root = await tempRoot();
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    const registration = await diagnosticsModule.register({ ctx: fake.ctx, settings: DEFAULT_SETTINGS });
    expect(fake.added.size).toBe(6);
    // 可觀察的殘留檢查：diagnostics 只透過 `ctx.tool.transform` 註冊工具，
    // 沒有 event／tool.hook／session.hook 訂閱，也沒有計時器或快取，
    // 所以除了平台清單裡的註冊本身以外沒有東西會留在 process 裡。
    expect(fake.toolHooks.size).toBe(0);
    expect(fake.sessionHooks.size).toBe(0);
    await registration?.dispose();
    // dispose 只還原註冊；已加入的定義由平台清單管理，這裡確認呼叫不拋錯。
    expect(fake.added.size).toBe(6);
  });
});
