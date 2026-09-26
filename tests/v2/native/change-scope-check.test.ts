/**
 * change-scope-check（新模組）：移植自 tests/ultrawork/46-change-scope-check.test.ts。
 *
 * 差異（工作說明授權的唯一行為變更）：
 * - 快照位置改為 `<工作階段位置>/.ultrawork/cache/change-scope/`（扁平），
 *   storedBaselineDir 直接讀新位置，不再經過 sha16 子目錄。
 * - 工具從模組註冊表拿，不再走舊外掛 harness；agent 由執行 context 帶入。
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeScopeStoreDirForRoot } from "../../../src/modules/verification/change-scope-check.ts";
import { verificationModule } from "../../../src/modules/verification/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/settings/defaults.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../_fake-v2-context.ts";

interface Workspace {
  root: string;
  cleanup(): void;
}

function createWorkspace(prefix: string): Workspace {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 工具把快照存在工作階段位置下的 .ultrawork；測試直接讀回保存的內容來核對。 */
function storedBaselineDir(root: string): string {
  return changeScopeStoreDirForRoot(realpathSync(root));
}

function storedBaseline(root: string, baselineId: string) {
  return JSON.parse(readFileSync(join(storedBaselineDir(root), `${baselineId}.json`), "utf8"));
}

async function loadTools(root: string) {
  const fake = createFakeV2Context({ directory: root });
  await verificationModule.register({ ctx: fake.ctx, settings: DEFAULT_SETTINGS });
  const tool = (name: string) => {
    const definition = fake.added.get(name);
    if (!definition) throw new Error(`tool not registered: ${name}`);
    return definition;
  };
  return { tool };
}

async function executeTool(definition: any, input: unknown, agent?: string) {
  const raw = await definition.execute(input, { ...fakeV2ToolContext(), agent });
  const parsed = JSON.parse(raw.content);
  return {
    ok: parsed.ok,
    code: parsed.code,
    summary: parsed.summary,
    nextAction: parsed.nextAction,
    ...(parsed.data ?? {}),
  } as { ok: boolean; code?: string; summary?: string; nextAction?: string; [key: string]: any };
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function initGit(root: string): void {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "scope-test@example.invalid"]);
  git(root, ["config", "user.name", "scope-test"]);
}

describe("change-scope-check（新模組）", () => {
  test("內容比較會偵測乾淨、既有 dirty、未追蹤、新增、刪除，且目錄前綴不誤配", async () => {
    const ws = createWorkspace("scope-check-");
    try {
      initGit(ws.root);
      mkdirSync(join(ws.root, "src", "foo"), { recursive: true });
      writeFileSync(join(ws.root, "src", "clean.ts"), "clean-v1", "utf8");
      writeFileSync(join(ws.root, "src", "preexisting.ts"), "preexisting-v1", "utf8");
      writeFileSync(join(ws.root, "src", "deleted.ts"), "delete-me", "utf8");
      writeFileSync(join(ws.root, "src", "foo", "nested.ts"), "nested-v1", "utf8");
      git(ws.root, ["add", "src"]);
      git(ws.root, ["commit", "-qm", "fixture"]);
      writeFileSync(join(ws.root, "src", "preexisting.ts"), "preexisting-dirty-before-baseline", "utf8");
      writeFileSync(join(ws.root, "src", "untracked.ts"), "untracked-v1", "utf8");

      const { tool } = await loadTools(ws.root);
      const baseline = await executeTool(tool("change-scope-check"), {
        action: "create",
        paths: [{ path: "src", kind: "directory" }],
      }, "build");

      expect(baseline.ok).toBe(true);
      expect(baseline.schema).toBe("change-scope-baseline-v1");
      expect(storedBaseline(ws.root, baseline.baselineId).files.map((file: { path: string }) => file.path)).toEqual([
        "src/clean.ts",
        "src/deleted.ts",
        "src/foo/nested.ts",
        "src/preexisting.ts",
        "src/untracked.ts",
      ]);
      expect(storedBaseline(ws.root, baseline.baselineId).files.find((file: { path: string }) => file.path === "src/preexisting.ts").baselineDirty).toBe(true);
      expect(storedBaseline(ws.root, baseline.baselineId).files.find((file: { path: string }) => file.path === "src/untracked.ts").baselineDirty).toBe(true);

      writeFileSync(join(ws.root, "src", "clean.ts"), "clean-v2", "utf8");
      writeFileSync(join(ws.root, "src", "preexisting.ts"), "preexisting-dirty-after-baseline", "utf8");
      writeFileSync(join(ws.root, "src", "untracked.ts"), "untracked-v2", "utf8");
      writeFileSync(join(ws.root, "src", "new.ts"), "new", "utf8");
      writeFileSync(join(ws.root, "src", "foobar.ts"), "prefix-must-not-match", "utf8");
      writeFileSync(join(ws.root, "src", "foo", "nested.ts"), "nested-v2", "utf8");
      git(ws.root, ["rm", "-q", "src/deleted.ts"]);

      const compared = await executeTool(tool("change-scope-check"), {
        action: "compare",
        baselineId: baseline.baselineId,
        allowedPaths: [{ path: "src/foo", kind: "directory" }, { path: "src/clean.ts", kind: "file" }],
      }, "build");

      expect(compared.ok).toBe(true);
      expect(compared.changes.added.map((file: { path: string }) => file.path)).toEqual(["src/foobar.ts", "src/new.ts"]);
      expect(compared.changes.deleted.map((file: { path: string }) => file.path)).toEqual(["src/deleted.ts"]);
      expect(compared.changes.modified.map((file: { path: string }) => file.path)).toEqual([
        "src/clean.ts",
        "src/foo/nested.ts",
        "src/preexisting.ts",
        "src/untracked.ts",
      ]);
      expect(compared.classifications.allowed).toEqual(["src/clean.ts", "src/foo/nested.ts"]);
      expect(compared.classifications.outOfScope).toEqual([
        "src/deleted.ts",
        "src/foobar.ts",
        "src/new.ts",
        "src/preexisting.ts",
        "src/untracked.ts",
      ]);
      expect(compared.classifications.baselineExisting).toEqual(["src/preexisting.ts", "src/untracked.ts"]);
      expect(compared.scopeViolations).toEqual([
        "src/deleted.ts",
        "src/foobar.ts",
        "src/new.ts",
        "src/preexisting.ts",
        "src/untracked.ts",
      ]);
      expect(compared.safeToClaimNoOutOfScopeChanges).toBe(false);
      expect(compared.note).toContain("不能證明是哪個代理修改");
    } finally {
      ws.cleanup();
    }
  });

  test("沒有 Git 時仍能用指定路徑比較內容，且不寫入 .opencode 記憶檔", async () => {
    const ws = createWorkspace("scope-check-no-git-");
    try {
      const target = join(ws.root, "src", "file.ts");
      mkdirSync(join(ws.root, "src"), { recursive: true });
      writeFileSync(target, "before", "utf8");
      const { tool } = await loadTools(ws.root);
      const baseline = await executeTool(tool("change-scope-check"), {
        action: "create",
        paths: [{ path: "src/file.ts", kind: "file" }],
      }, "ultra");
      expect(baseline.ok).toBe(true);
      expect(baseline.git.available).toBe(false);

      writeFileSync(target, "after", "utf8");
      const compared = await executeTool(tool("change-scope-check"), {
        action: "compare",
        baselineId: baseline.baselineId,
        allowedPaths: [{ path: "src/file.ts", kind: "file" }],
      }, "ultra");
      expect(compared.ok).toBe(true);
      expect(compared.classifications.allowed).toEqual(["src/file.ts"]);
      expect(compared.safeToClaimNoOutOfScopeChanges).toBe(true);
      expect(existsSync(join(ws.root, ".opencode"))).toBe(false);
      expect(existsSync(join(storedBaselineDir(ws.root), `${baseline.baselineId}.json`))).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  test("Git HEAD 改變會明確列為比較問題，不當成乾淨結果", async () => {
    const ws = createWorkspace("scope-check-head-");
    try {
      initGit(ws.root);
      mkdirSync(join(ws.root, "src"), { recursive: true });
      writeFileSync(join(ws.root, "src", "base.ts"), "base", "utf8");
      git(ws.root, ["add", "src"]);
      git(ws.root, ["commit", "-qm", "baseline"]);

      const { tool } = await loadTools(ws.root);
      const baseline = await executeTool(tool("change-scope-check"), {
        action: "create",
        paths: [{ path: "src", kind: "directory" }],
      }, "build");

      writeFileSync(join(ws.root, "src", "after-baseline.ts"), "after", "utf8");
      git(ws.root, ["add", "src/after-baseline.ts"]);
      git(ws.root, ["commit", "-qm", "parallel-change"]);

      const compared = await executeTool(tool("change-scope-check"), {
        action: "compare",
        baselineId: baseline.baselineId,
        allowedPaths: [{ path: "src", kind: "directory" }],
      }, "build");
      expect(compared.ok).toBe(true);
      expect(compared.issues.some((issue: { code: string }) => issue.code === "HEAD_CHANGED")).toBe(true);
      expect(compared.changes.added.map((file: { path: string }) => file.path)).toEqual(["src/after-baseline.ts"]);
      expect(compared.safeToClaimNoOutOfScopeChanges).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("跨專案、symlink 與不完整摘要都 fail closed，不當成沒有變更", async () => {
    const ws = createWorkspace("scope-check-unsafe-");
    const other = createWorkspace("scope-check-other-");
    try {
      writeFileSync(join(ws.root, "tracked.ts"), "before", "utf8");
      const outside = join(other.root, "outside.ts");
      writeFileSync(outside, "outside", "utf8");
      symlinkSync(outside, join(ws.root, "linked.ts"));
      const { tool } = await loadTools(ws.root);
      const baseline = await executeTool(tool("change-scope-check"), {
        action: "create",
        paths: [
          { path: "tracked.ts", kind: "file" },
          { path: "linked.ts", kind: "file" },
        ],
      }, "build");
      expect(baseline.ok).toBe(true);
      expect(baseline.coverage.issues.some((issue: { code: string }) => issue.code === "SYMLINK_NOT_FOLLOWED")).toBe(true);

      const otherPlugin = await loadTools(other.root);
      const cross = await executeTool(otherPlugin.tool("change-scope-check"), {
        action: "compare",
        baselineId: baseline.baselineId,
        allowedPaths: [{ path: "tracked.ts", kind: "file" }],
      }, "ultra");
      expect(cross.ok).toBe(false);
      expect(cross.code).toBe("BASELINE_NOT_FOUND");

      writeFileSync(join(ws.root, "tracked.ts"), "after", "utf8");
      const compared = await executeTool(tool("change-scope-check"), {
        action: "compare",
        baselineId: baseline.baselineId,
        allowedPaths: [{ path: "tracked.ts", kind: "file" }],
      }, "build");
      expect(compared.ok).toBe(true);
      expect(compared.classifications.unableToDetermine).toContain("linked.ts");
      expect(compared.safeToClaimNoOutOfScopeChanges).toBe(false);
    } finally {
      ws.cleanup();
      other.cleanup();
    }
  });

  test("工具只允許 Build／Ultra，且不接受複雜 glob", async () => {
    const ws = createWorkspace("scope-check-policy-");
    try {
      const { tool } = await loadTools(ws.root);
      const denied = await executeTool(tool("change-scope-check"), { action: "create" }, "momus");
      expect(denied.ok).toBe(false);
      expect(denied.code).toBe("AGENT_NOT_ALLOWED");
      const invalid = await executeTool(tool("change-scope-check"), {
        action: "create",
        paths: [{ path: "src/**/*.ts", kind: "directory" }],
      }, "build");
      expect(invalid.ok).toBe(false);
      expect(invalid.code).toBe("INVALID_PATH_SPEC");
    } finally {
      ws.cleanup();
    }
  });

  test("比較會保留基準建立時的不完整範圍，不能事後誤報安全", async () => {
    const ws = createWorkspace("scope-check-baseline-coverage-");
    try {
      const { tool } = await loadTools(ws.root);
      const baseline = await executeTool(tool("change-scope-check"), {
        action: "create",
        paths: [{ path: "later.ts", kind: "file" }],
      }, "build");
      expect(baseline.ok).toBe(true);
      expect(baseline.coverage.complete).toBe(false);

      writeFileSync(join(ws.root, "later.ts"), "created-after-baseline", "utf8");
      const compared = await executeTool(tool("change-scope-check"), {
        action: "compare",
        baselineId: baseline.baselineId,
        allowedPaths: [{ path: "later.ts", kind: "file" }],
      }, "build");

      expect(compared.ok).toBe(true);
      expect(compared.baselineCoverage.complete).toBe(false);
      expect(compared.issues.some((issue: { code: string }) => issue.code === "BASELINE_COVERAGE_INCOMPLETE")).toBe(true);
      expect(compared.safeToClaimNoOutOfScopeChanges).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("保存的快照缺少必要欄位時回傳可辨識的錯誤，不會拋例外", async () => {
    const ws = createWorkspace("scope-check-invalid-baseline-");
    try {
      const { tool } = await loadTools(ws.root);
      writeFileSync(join(ws.root, "a.ts"), "a", "utf8");
      const created = await executeTool(tool("change-scope-check"), {
        action: "create",
        paths: [{ path: "a.ts", kind: "file" }],
      }, "build");
      const stored = storedBaseline(ws.root, created.baselineId);
      delete stored.git;
      writeFileSync(join(storedBaselineDir(ws.root), `${created.baselineId}.json`), JSON.stringify(stored), "utf8");
      const result = await executeTool(tool("change-scope-check"), {
        action: "compare",
        baselineId: created.baselineId,
        allowedPaths: [],
      }, "build");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("INVALID_BASELINE");
    } finally {
      ws.cleanup();
    }
  });

  test("建立時只回傳代號與摘要，不把逐檔雜湊交給模型", async () => {
    const ws = createWorkspace("scope-check-compact-");
    try {
      mkdirSync(join(ws.root, "src"), { recursive: true });
      for (let index = 0; index < 400; index += 1) {
        writeFileSync(join(ws.root, "src", `file-${index}.ts`), `content-${index}`, "utf8");
      }
      const { tool } = await loadTools(ws.root);
      const definition = tool("change-scope-check");
      const raw = await definition.execute({
        action: "create",
        paths: [{ path: "src", kind: "directory" }],
      }, { ...fakeV2ToolContext(), agent: "build" });
      const text = raw.content;
      const created = JSON.parse(text);
      const data = created.data;
      expect(created.ok).toBe(true);
      expect(data.baselineId).toMatch(/^csb_[0-9a-z]+_[0-9a-f]{8}$/);
      expect(data.fileCount).toBe(400);
      expect(data.baseline).toBeUndefined();
      expect(text).not.toMatch(/[a-f0-9]{64}/);
      expect(text.length).toBeLessThan(3000);
      expect(storedBaseline(ws.root, data.baselineId).files).toHaveLength(400);
    } finally {
      ws.cleanup();
    }
  });

  test("compare 的 baselineId 缺少、格式不對或找不到時各自回報，不讀 workspace 外的任意路徑", async () => {
    const ws = createWorkspace("scope-check-baseline-id-");
    try {
      const { tool } = await loadTools(ws.root);
      const missing = await executeTool(tool("change-scope-check"), { action: "compare" }, "ultra");
      expect(missing.ok).toBe(false);
      expect(missing.code).toBe("INVALID_INPUT");
      const traversal = await executeTool(tool("change-scope-check"), {
        action: "compare",
        baselineId: "../../etc/passwd",
      }, "ultra");
      expect(traversal.ok).toBe(false);
      expect(traversal.code).toBe("INVALID_INPUT");
      const unknown = await executeTool(tool("change-scope-check"), {
        action: "compare",
        baselineId: "csb_abc123_0011aabb",
      }, "ultra");
      expect(unknown.ok).toBe(false);
      expect(unknown.code).toBe("BASELINE_NOT_FOUND");
    } finally {
      ws.cleanup();
    }
  });

  test("快照存在專案 .ultrawork 下，超過保留期限的舊快照在下次建立時清除", async () => {
    const ws = createWorkspace("scope-check-retention-");
    try {
      writeFileSync(join(ws.root, "a.ts"), "a", "utf8");
      const before = readdirSync(ws.root).sort();
      const { tool } = await loadTools(ws.root);
      const first = await executeTool(tool("change-scope-check"), {
        action: "create",
        paths: [{ path: "a.ts", kind: "file" }],
      }, "build");
      expect(first.ok).toBe(true);
      // 快照只落在 .ultrawork，不污染工作區其他位置。
      expect(readdirSync(ws.root).sort()).toEqual([...before, ".ultrawork"].sort());
      expect(existsSync(join(storedBaselineDir(ws.root), `${first.baselineId}.json`))).toBe(true);

      const oldFile = join(storedBaselineDir(ws.root), `${first.baselineId}.json`);
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      utimesSync(oldFile, eightDaysAgo, eightDaysAgo);
      const second = await executeTool(tool("change-scope-check"), {
        action: "create",
        paths: [{ path: "a.ts", kind: "file" }],
      }, "build");
      expect(second.ok).toBe(true);
      expect(existsSync(oldFile)).toBe(false);
      expect(existsSync(join(storedBaselineDir(ws.root), `${second.baselineId}.json`))).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  test("Git 專案預設只掃描指定範圍，完整 Git 掃描必須明確開啟", async () => {
    const ws = createWorkspace("scope-check-explicit-git-");
    try {
      initGit(ws.root);
      mkdirSync(join(ws.root, "src"), { recursive: true });
      writeFileSync(join(ws.root, "src", "inside.ts"), "inside", "utf8");
      writeFileSync(join(ws.root, "root.ts"), "root", "utf8");
      git(ws.root, ["add", "src", "root.ts"]);
      git(ws.root, ["commit", "-qm", "fixture"]);

      const { tool } = await loadTools(ws.root);
      const requestedOnly = await executeTool(tool("change-scope-check"), {
        action: "create",
        paths: [{ path: "src", kind: "directory" }],
      }, "build");
      expect(requestedOnly.coverage.scope).toBe("requested-paths-only");
      expect(storedBaseline(ws.root, requestedOnly.baselineId).files.map((file: { path: string }) => file.path)).toEqual(["src/inside.ts"]);

      const emptyScope = await executeTool(tool("change-scope-check"), {
        action: "create",
      }, "build");
      expect(emptyScope.coverage.complete).toBe(false);
      expect(emptyScope.coverage.issues.some((issue: { code: string }) => issue.code === "INSUFFICIENT_SCOPE")).toBe(true);

      const fullGit = await executeTool(tool("change-scope-check"), {
        action: "create",
        paths: [{ path: "src", kind: "directory" }],
        includeGitFiles: true,
      }, "build");
      expect(fullGit.includeGitFiles).toBe(true);
      expect(fullGit.coverage.scope).toBe("git-plus-requested");
      expect(storedBaseline(ws.root, fullGit.baselineId).files.map((file: { path: string }) => file.path)).toEqual(["root.ts", "src/inside.ts"]);
    } finally {
      ws.cleanup();
    }
  });
});
