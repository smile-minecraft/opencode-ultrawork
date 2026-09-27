/**
 * 53 — skiller 路徑守衛的 unsafe root 檢查。
 *
 * 判定與 kit 守衛一致（`/`、`""`、`"."`、`".."`、`/Users`、`/Volumes` 的
 * lexical＋realpath 檢查，無法確認時 fail closed），外加家目錄本身也算 unsafe；
 * 讀寫一視同仁（preview／scan 等唯讀路徑同樣拒絕）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

  test("家目錄本身是 unsafe，存在祖先下的一般子目錄不是", () => {
    expect(isUnsafeSkillerRoot(homedir())).toBe(true);
    // 家目錄下的子路徑若不存在（例如 CI 乾淨家目錄的 ~/.config/opencode），
    // 最近的存在祖先就是家目錄本身，會走 fail closed；所以「一般子目錄不是
    // unsafe」改用暫存目錄下實際存在的路徑驗，不依賴執行環境的家目錄內容。
    const dir = mkdtempSync(join(tmpdir(), "skiller-unsafe-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "sub"));
    expect(isUnsafeSkillerRoot(join(dir, "sub"))).toBe(false);
  });

  test("不存在、只能解析到家目錄的路徑判 unsafe（fail closed）", () => {
    // 不存在的子路徑最近的存在祖先就是家目錄本身，無法確認它是獨立存在的
    // 子目錄 → 無法確認 containment，一律判 unsafe。這個語意是刻意的，
    // 不能拿真實家目錄下存在的路徑來反證它。
    expect(isUnsafeSkillerRoot(join(homedir(), ".ultrawork-test-nonexistent-8f3c2a"))).toBe(true);
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
