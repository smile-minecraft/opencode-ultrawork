import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiagnosticsDeps } from "../../../../src/modules/diagnostics/deps.ts";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
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
    const deps = createDiagnosticsDeps(fake.ctx, DEFAULT_SETTINGS);
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
    const deps = createDiagnosticsDeps(fake.ctx, DEFAULT_SETTINGS);
    expect(await deps.listRegisteredToolNames()).toEqual(["workflow_doctor"]);
    await rm(root, { recursive: true, force: true });
  });

  test("平台沒提供 ctx.tool.list 時回 null", async () => {
    const root = await tempRoot();
    const fake = createFakeV2Context({ directory: root, sessionDirectory: root });
    const withoutList = { ...fake.ctx, tool: {} };
    const deps = createDiagnosticsDeps(withoutList as never, DEFAULT_SETTINGS);
    expect(await deps.listRegisteredToolNames()).toBeNull();
    await rm(root, { recursive: true, force: true });
  });
});
