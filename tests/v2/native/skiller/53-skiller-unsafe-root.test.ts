/**
 * 53 — skiller 路徑守衛的 unsafe root 檢查。
 *
 * 判定與 kit 守衛一致（`/`、`""`、`"."`、`".."`、`/Users`、`/Volumes` 的
 * lexical＋realpath 檢查，無法確認時 fail closed），外加家目錄本身也算 unsafe；
 * 讀寫一視同仁（preview／scan 等唯讀路徑同樣拒絕）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestWorkspace } from "./_harness.ts";
import {
  agentHasPersonalAskRoute,
  applyAgentSkillRouting,
  assertSafeSkillerPath,
  ensureScopedFixedRoot,
  isUnsafeSkillerRoot,
  prevalidateTargetAgents,
  previewAgentSkillRouting,
  type SkillerDeps,
} from "../../../../src/modules/skiller/skiller-common.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function depsFor(projectRoot: string, extra?: Partial<SkillerDeps>): SkillerDeps {
  return { resolveProjectRoot: () => projectRoot, ...extra };
}

describe("53 - isUnsafeSkillerRoot 判定", () => {
  test("系統根與關鍵目錄是 unsafe", () => {
    expect(isUnsafeSkillerRoot("/")).toBe(true);
    expect(isUnsafeSkillerRoot("")).toBe(true);
    expect(isUnsafeSkillerRoot("/Users")).toBe(true);
    expect(isUnsafeSkillerRoot("/Volumes")).toBe(true);
  });

  test("家目錄本身是 unsafe，家目錄下的一般子目錄不是", () => {
    expect(isUnsafeSkillerRoot(homedir())).toBe(true);
    expect(isUnsafeSkillerRoot(join(homedir(), ".config", "opencode"))).toBe(false);
  });

  test("暫存測試目錄不是 unsafe", () => {
    const dir = mkdtempSync(join(tmpdir(), "skiller-unsafe-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(isUnsafeSkillerRoot(dir)).toBe(false);
  });
});

describe("53 - fixed root 拒絕 unsafe", () => {
  test("personal scope 的家目錄與 / 被拒", () => {
    const ws = createTestWorkspace();
    try {
      const deps = depsFor(ws.root);
      expect(ensureScopedFixedRoot(homedir(), "personal", deps).ok).toBe(false);
      expect(ensureScopedFixedRoot("/", "personal", deps).ok).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("project scope 的 project root 是 / 時被拒", () => {
    const deps = depsFor("/");
    expect(ensureScopedFixedRoot("/.opencode/skills", "project", deps).ok).toBe(false);
  });

  test("assertSafeSkillerPath 拒絕 unsafe 目標", () => {
    expect(() => assertSafeSkillerPath("/")).toThrow();
    expect(() => assertSafeSkillerPath(homedir())).toThrow();
  });
});

describe("53 - agents 路由讀寫一視同仁", () => {
  test("prevalidate 在 unsafe agentsRoot 回報拒絕", () => {
    const r = prevalidateTargetAgents("/", ["build"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unsafe/i);
  });

  test("apply 在 unsafe agentsRoot 回報 failed（含 unsafe 說明）", () => {
    const results = applyAgentSkillRouting("/", "api-design", "insert", ["build"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((entry) => entry.status === "failed")).toBe(true);
    expect(JSON.stringify(results)).toMatch(/unsafe/i);
  });

  test("preview 在 unsafe agentsRoot 回報 failed（含 unsafe 說明）", () => {
    const planned = previewAgentSkillRouting("/", "api-design", "insert", ["build"]);
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every((entry) => entry.planned === "failed")).toBe(true);
    expect(JSON.stringify(planned)).toMatch(/unsafe/i);
  });

  test("agentHasPersonalAskRoute：unsafe projectRoot 直接回 false（不 fallback）", () => {
    const ws = createTestWorkspace();
    try {
      const dir = mkdtempSync(join(tmpdir(), "skiller-unsafe-route-"));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      writeFileSync(
        join(dir, "build.md"),
        `---\ndescription: test agent\nmode: subagent\npermission:\n  skill:\n    personal-*: ask\n---\n\nbody\n`,
        "utf-8",
      );
      const deps = depsFor("/", { roots: { agentsRoot: dir } });
      // 修正前：project 讀 ENOENT 後 fallback 到全域路由，回 true。
      expect(agentHasPersonalAskRoute("/", "build", deps)).toBe(false);
    } finally {
      ws.cleanup();
    }
  });
});
