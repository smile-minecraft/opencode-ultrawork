import type { ModuleRuntime } from "../../../../src/modules/types.ts";
import { DEFAULT_SETTINGS, type UltraworkSettings } from "../../../../src/settings/defaults.ts";
import { workflowModule } from "../../../../src/modules/workflow/index.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../../_fake-v2-context.ts";

export async function setupWorkflow(
  root: string,
  settings: UltraworkSettings = DEFAULT_SETTINGS,
  options: {
    tools?: Array<{ id: string; description: string }>;
    events?: ReadonlyArray<{ type: string; data: unknown }>;
    prepareStorage?: (storage: any) => Promise<void>;
  } = {},
) {
  const fake = createFakeV2Context({
    directory: root,
    sessionDirectory: root,
    tools: options.tools ?? [{ id: "subagent", description: "派遣子代理" }],
  });
  if (options.prepareStorage) await options.prepareStorage(fake.ctx.storage);
  fake.events.push(...(options.events ?? []));
  const runtime: ModuleRuntime = { ctx: fake.ctx, settings };
  const registration = await workflowModule.register(runtime);
  await Promise.resolve();
  return { ...fake, registration };
}

export async function callTool(
  fake: Awaited<ReturnType<typeof setupWorkflow>>,
  name: string,
  input: Record<string, unknown>,
  sessionID = "s1",
): Promise<any> {
  const result = await fake.added.get(name).execute(input, fakeV2ToolContext(sessionID));
  return JSON.parse(result.content);
}

export function validWorkOrder() {
  return {
    taskIdentity: "Task T1；Project P1",
    objective: "讓行為可觀察且可驗證。",
    knownEvidence: "已確認舊版契約與現有測試。",
    constraints: "只改授權範圍。",
    tddRequirements: "先建立失敗測試，再做最小實作。",
    acceptanceCriteria: ["目標測試通過"],
    requiredReturn: "回傳變更、證據與風險。",
  };
}
