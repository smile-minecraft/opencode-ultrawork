/** skiller 原生工廠測試的暫存 workspace 與 V2 工具轉接器。 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupUltrawork } from "../../../../src/index.ts";
import { skillerModule } from "../../../../src/modules/skiller/index.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../../_fake-v2-context.ts";
import type { SkillerDeps } from "../../../../src/modules/skiller/skiller-common.ts";

export interface TestWorkspace {
  root: string;
  memoryDir: string;
  tasksJson: string;
  plansJson: string;
  receiptsDir: string;
  stateMd: string;
  projectMd: string;
  cleanup(): void;
}

export const EXPECTED_TOOL_NAMES = [
  "skiller-scan", "skiller-validate", "skiller-draft", "skiller-draft-read",
  "skiller-draft-update", "skiller-draft-delete", "skiller-promote", "skiller-retire",
  "skiller-restore", "skiller-import", "skiller-policy-update",
] as const;

export function createTestWorkspace(prefix = "skiller-native-test-"): TestWorkspace {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const memoryDir = join(root, ".opencode", "memory");
  mkdirSync(memoryDir, { recursive: true });
  const tasksJson = join(memoryDir, "tasks.json");
  const plansJson = join(memoryDir, "plans.json");
  const receiptsDir = join(memoryDir, "receipts");
  const stateMd = join(memoryDir, "state.md");
  const projectMd = join(memoryDir, "project.md");
  mkdirSync(receiptsDir, { recursive: true });
  writeFileSync(tasksJson, "{}", "utf-8");
  writeFileSync(plansJson, "{}", "utf-8");
  writeFileSync(stateMd, "", "utf-8");
  writeFileSync(projectMd, "", "utf-8");
  return { root, memoryDir, tasksJson, plansJson, receiptsDir, stateMd, projectMd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function createFakeContext(directory: string) {
  return { ...fakeV2ToolContext(), directory, worktree: directory };
}

export function parseToolResult(raw: unknown): { ok: boolean; error?: string; [key: string]: any } {
  const content = typeof raw === "string" ? raw : (raw as { content?: string })?.content;
  try {
    const parsed = JSON.parse(content ?? "");
    if (parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
      for (const [key, value] of Object.entries(parsed.data)) {
        if (!(key in parsed)) Object.defineProperty(parsed, key, { enumerable: false, value });
      }
    }
    if (parsed.ok === false && typeof parsed.summary === "string" && !("error" in parsed)) {
      Object.defineProperty(parsed, "error", { enumerable: false, value: parsed.summary });
    }
    return parsed;
  } catch {
    return { ok: false, error: `non-JSON tool result: ${String(content).slice(0, 200)}` };
  }
}

interface NativeTool {
  description: string;
  input: Record<string, unknown>;
  execute(input: unknown, context: unknown): Promise<unknown>;
}

export async function loadPlugin(workspace: TestWorkspace) {
  const fake = createFakeV2Context({
    directory: workspace.root,
    options: { globalDir: join(workspace.root, "global") },
  });
  const cleanup = await setupUltrawork(fake.ctx, { modules: [skillerModule], projectDir: workspace.root, globalDir: join(workspace.root, "global") });
  const tool = (name: string) => {
    const definition = fake.added.get(name) as NativeTool | undefined;
    if (!definition) throw new Error(`Tool not found: ${name}`);
    return {
      description: definition.description,
      args: definition.input,
      execute: (input: unknown, context: unknown) => definition.execute(input, context),
    };
  };
  return { hooks: { tool: Object.fromEntries([...fake.added.keys()].map((name) => [name, tool(name)])) }, tool, cleanup };
}

export type { SkillerDeps };
