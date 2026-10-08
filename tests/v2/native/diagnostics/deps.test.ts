import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createDiagnosticsDeps } from "../../../../src/modules/diagnostics/deps.ts";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
import { expandHome, resolveAgentsRoot } from "../../../../src/settings/paths.ts";
import { createFakeV2Context } from "../../_fake-v2-context.ts";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-diagnostics-deps-"));
  roots.push(root);
  return root;
}

describe("診斷依賴的平台工具清單收斂", () => {
  test("只收斂本外掛宣告的工具名，平台內建工具被排除", async () => {
    const root = await tempRoot();
    const fake = createFakeV2Context({
      directory: root,
      sessionDirectory: root,
      tools: [
        { id: "subagent", description: "派遣子代理" },
        { id: "workflow_bootstrap", description: "讀取專案記憶與任務摘要" },
      ],
    });
    const deps = createDiagnosticsDeps(fake.host, DEFAULT_SETTINGS);
    expect(await deps.listRegisteredToolNames()).toEqual(["workflow_bootstrap"]);
    await rm(root, { recursive: true, force: true });
  });

  test("id 是 Object.prototype 繼承名稱的平台工具不算本外掛工具", async () => {
    const root = await tempRoot();
    // `TOOL_MODULES` 是普通物件，繼承 `Object.prototype`；用 `in` 過濾時
    // `constructor`／`toString` 這類 id 會被誤判成本外掛工具，污染工具清單自洽性比對。
    const fake = createFakeV2Context({
      directory: root,
      sessionDirectory: root,
      tools: [
        { id: "constructor", description: "平台內建" },
        { id: "toString", description: "平台內建" },
        { id: "workflow_doctor", description: "診斷" },
      ],
    });
    const deps = createDiagnosticsDeps(fake.host, DEFAULT_SETTINGS);
    expect(await deps.listRegisteredToolNames()).toEqual(["workflow_doctor"]);
    await rm(root, { recursive: true, force: true });
  });

  test("宿主沒提供實際工具清單時回 null", async () => {
    const root = await tempRoot();
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    const withoutList = {
      ...fake.host,
      tools: { ...fake.host.tools, list: async () => null },
    };
    const deps = createDiagnosticsDeps(withoutList, DEFAULT_SETTINGS);
    expect(await deps.listRegisteredToolNames()).toBeNull();
    await rm(root, { recursive: true, force: true });
  });
});

describe("診斷依賴的角色檔查詢", () => {
  test("auto 與自訂 agentsDir 都解析到對應目錄並唯讀辨認角色檔", async () => {
    const globalDir = await tempRoot();
    const autoRoot = join(globalDir, "agents");
    const customRoot = join(globalDir, "custom-agents");
    await mkdir(autoRoot, { recursive: true });
    await mkdir(customRoot, { recursive: true });
    await writeFile(join(autoRoot, "reviewer.md"), "role");
    await writeFile(join(customRoot, "builder.md"), "role");

    const autoFake = createFakeV2Context({
      directory: globalDir,
      sessionDirectory: globalDir,
      options: { globalDir },
    });
    const autoDeps = createDiagnosticsDeps(autoFake.host, structuredClone(DEFAULT_SETTINGS));
    expect(autoDeps.agentRoleFiles?.agentsRoot).toBe(autoRoot);
    expect(autoDeps.agentRoleFiles?.lookup("reviewer")).toBe("exists");
    expect(autoDeps.agentRoleFiles?.lookup("missing")).toBe("missing");

    const customSettings = structuredClone(DEFAULT_SETTINGS);
    customSettings.skiller.agentsDir = customRoot;
    const customFake = createFakeV2Context({
      directory: globalDir,
      sessionDirectory: globalDir,
      options: { globalDir },
    });
    const customDeps = createDiagnosticsDeps(customFake.host, customSettings);
    expect(customDeps.agentRoleFiles?.agentsRoot).toBe(customRoot);
    expect(customDeps.agentRoleFiles?.lookup("builder")).toBe("exists");
    expect(resolveAgentsRoot("auto", globalDir)).toBe(autoRoot);
    expect(resolveAgentsRoot(customRoot, globalDir)).toBe(customRoot);
    expect(expandHome(`~${sep}agents`, globalDir)).toBe(join(globalDir, "agents"));

    await rm(globalDir, { recursive: true, force: true });
  });

  test("不安全的 agentsRoot 與路徑逃逸名稱回 unknown", async () => {
    const root = await tempRoot();
    const fake = createFakeV2Context({
      directory: root,
      sessionDirectory: root,
      options: { globalDir: root },
    });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.skiller.agentsDir = "/";
    const deps = createDiagnosticsDeps(fake.host, settings);

    expect(deps.agentRoleFiles?.lookup("reviewer")).toBe("unknown");
    expect(deps.agentRoleFiles?.lookup("../outside")).toBe("unknown");

    settings.skiller.agentsDir = join(root, "missing-agents-root");
    const missingRootDeps = createDiagnosticsDeps(fake.host, settings);
    expect(missingRootDeps.agentRoleFiles?.lookup("reviewer")).toBe("unknown");
    await rm(root, { recursive: true, force: true });
  });
});
