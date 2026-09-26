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
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync, mkdtempSync } from "node:fs";
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

  test("git 呼叫不阻塞事件迴圈：slow git 執行期間 timer 仍能觸發", async () => {
    const ws = createWorkspace("scope-check-slow-git-");
    const originalPath = process.env.PATH;
    try {
      const binPath = join(ws.root, "slow-bin");
      mkdirSync(binPath, { recursive: true });
      writeFileSync(join(binPath, "git"), "#!/bin/sh\nsleep 1.2\nprintf 'fake-git-output'\n", "utf8");
      chmodSync(join(binPath, "git"), 0o755);
      const { delimiter } = await import("node:path");
      process.env.PATH = `${binPath}${delimiter}${process.env.PATH ?? ""}`;

      const { runGitCommand } = await import("../../../src/modules/verification/change-scope-check.ts");
      const startedAt = Date.now();
      let timerFiredAt = 0;
      const timer = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        timerFiredAt = Date.now();
      })();
      const result = await runGitCommand(ws.root, ["--version"], 10_000);
      await timer;

      expect(result).toEqual({ ok: true, stdout: "fake-git-output", truncated: false });
      expect(timerFiredAt - startedAt).toBeLessThan(800);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      ws.cleanup();
    }
  });

  test("卡住的 git 呼叫會被 timeout 中斷，不會無限等待", async () => {
    const ws = createWorkspace("scope-check-hung-git-");
    const originalPath = process.env.PATH;
    try {
      const binPath = join(ws.root, "hung-bin");
      mkdirSync(binPath, { recursive: true });
      writeFileSync(join(binPath, "git"), "#!/bin/sh\nsleep 30\n", "utf8");
      chmodSync(join(binPath, "git"), 0o755);
      const { delimiter } = await import("node:path");
      process.env.PATH = `${binPath}${delimiter}${process.env.PATH ?? ""}`;

      const { runGitCommand } = await import("../../../src/modules/verification/change-scope-check.ts");
      const startedAt = Date.now();
      const result = await runGitCommand(ws.root, ["rev-parse", "--verify", "HEAD"], 300);
      const durationMs = Date.now() - startedAt;

      expect(result.ok).toBe(false);
      expect(durationMs).toBeLessThan(5000);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      ws.cleanup();
    }
  });

  test("找不到 git 時回傳不可用（ENOENT 語意與舊版相同）", async () => {
    const ws = createWorkspace("scope-check-no-git-");
    const originalPath = process.env.PATH;
    try {
      const emptyBin = join(ws.root, "empty-bin");
      mkdirSync(emptyBin, { recursive: true });
      process.env.PATH = emptyBin;

      const { runGitCommand } = await import("../../../src/modules/verification/change-scope-check.ts");
      const result = await runGitCommand(ws.root, ["rev-parse", "--verify", "HEAD"], 5000);

      expect(result).toEqual({ ok: false, unavailable: true, truncated: false });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      ws.cleanup();
    }
  });

  test("git 輸出超過上限時回報失敗，而不是截斷的成功快照", async () => {    const ws = createWorkspace("scope-check-huge-git-");
    const originalPath = process.env.PATH;
    try {
      const binPath = join(ws.root, "huge-bin");
      mkdirSync(binPath, { recursive: true });
      // 約 20MB，超過 16MiB 上限；exit 0，逼出「靜默截斷卻回成功」的實作。
      writeFileSync(
        join(binPath, "git"),
        "#!/bin/sh\nawk 'BEGIN{for(i=0;i<400000;i++) print \"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"}'\n",
        "utf8",
      );
      chmodSync(join(binPath, "git"), 0o755);
      const { delimiter } = await import("node:path");
      process.env.PATH = `${binPath}${delimiter}${process.env.PATH ?? ""}`;

      const { runGitCommand } = await import("../../../src/modules/verification/change-scope-check.ts");
      const direct = await runGitCommand(ws.root, ["ls-files", "-z"], 10_000);
      expect(direct.ok).toBe(false);
      if (!direct.ok) expect(direct.truncated).toBe(true);

      // 整條工具鏈也不會把超限結果當成有效快照。
      const { tool } = await loadTools(ws.root);
      const created = await executeTool(tool("change-scope-check"), {
        action: "create",
        paths: [{ path: "src", kind: "directory" }],
        includeGitFiles: true,
      }, "build");
      expect(created.ok).toBe(true);
      expect(created.git.available).toBe(false);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      ws.cleanup();
    }
  });

  // ——— 審查退回修正：單一必要清單缺失即整份快照不可用 ———

  /** 用乾淨 PATH 找出真 git，讓假 git 只干擾特定命令、其餘轉交。 */
  function discoverRealGit(cleanPath: string): string {
    const found = execFileSync("/bin/sh", ["-c", "command -v git"], {
      encoding: "utf8",
      env: { ...process.env, PATH: cleanPath },
    }).trim();
    expect(found).not.toBe("");
    return found;
  }

  test("tracked 清單超限但 status 成功時，快照不可用且不漏 tracked 檔案", async () => {
    const ws = createWorkspace("scope-check-tracked-truncated-");
    const originalPath = process.env.PATH ?? "";
    try {
      initGit(ws.root);
      mkdirSync(join(ws.root, "src"), { recursive: true });
      writeFileSync(join(ws.root, "src", "app.ts"), "committed", "utf8");
      git(ws.root, ["add", "src"]);
      git(ws.root, ["commit", "-qm", "fixture"]);

      const realGit = discoverRealGit(originalPath);
      const binPath = join(ws.root, "partial-bin");
      mkdirSync(binPath, { recursive: true });
      // 只有 tracked 清單（ls-files 且不帶 --others）吐超限輸出；
      // status、untracked、rev-parse 都轉交真 git 且成功。
      writeFileSync(
        join(binPath, "git"),
        [
          "#!/bin/sh",
          'case "$*" in',
          '  *"ls-files"*)',
          '    case "$*" in',
          '      *"--others"*) exec "$REAL_GIT" "$@" ;;',
          `      *) awk 'BEGIN{for(i=0;i<400000;i++) print "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}' ;;`,
          "    esac",
          "    ;;",
          '  *) exec "$REAL_GIT" "$@" ;;',
          "esac",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(join(binPath, "git"), 0o755);
      const { delimiter } = await import("node:path");
      process.env.PATH = `${binPath}${delimiter}${originalPath}`;
      process.env.REAL_GIT = realGit;

      const { tool } = await loadTools(ws.root);
      // 只靠 includeGitFiles 納入 tracked 檔案：漏掉就證明悄悄遺失。
      const created = await executeTool(tool("change-scope-check"), {
        action: "create",
        includeGitFiles: true,
      }, "build");

      expect(created.ok).toBe(true);
      expect(created.git.available).toBe(false);
      expect(created.coverage.complete).toBe(false);
      expect(created.coverage.issues.some((issue: { code: string }) => issue.code === "GIT_SCAN_UNAVAILABLE")).toBe(true);
    } finally {
      if (originalPath === "") delete process.env.PATH;
      else process.env.PATH = originalPath;
      delete process.env.REAL_GIT;
      ws.cleanup();
    }
  });

  test("必要清單缺一即整份不可用：tracked／status／untracked 各一", async () => {
    const ws = createWorkspace("scope-check-partial-fail-");
    const originalPath = process.env.PATH ?? "";
    try {
      initGit(ws.root);
      mkdirSync(join(ws.root, "src"), { recursive: true });
      writeFileSync(join(ws.root, "src", "app.ts"), "committed", "utf8");
      git(ws.root, ["add", "src"]);
      git(ws.root, ["commit", "-qm", "fixture"]);

      const realGit = discoverRealGit(originalPath);
      const binPath = join(ws.root, "fail-one-bin");
      mkdirSync(binPath, { recursive: true });
      // FAIL_CMD 決定哪一條必要清單失敗（exit 1），其餘轉交真 git。
      writeFileSync(
        join(binPath, "git"),
        [
          "#!/bin/sh",
          'ARGS="$*"',
          'if [ "$FAIL_CMD" = "tracked" ]; then',
          '  case "$ARGS" in *"ls-files"*)',
          '    case "$ARGS" in *"--others"*) ;; *) exit 1;; esac',
          "  esac",
          "fi",
          'if [ "$FAIL_CMD" = "status" ]; then',
          '  case "$ARGS" in *"status"*) exit 1;; esac',
          "fi",
          'if [ "$FAIL_CMD" = "untracked" ]; then',
          '  case "$ARGS" in *"--others"*) exit 1;; esac',
          "fi",
          'exec "$REAL_GIT" "$@"',
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(join(binPath, "git"), 0o755);
      const { delimiter } = await import("node:path");
      process.env.PATH = `${binPath}${delimiter}${originalPath}`;
      process.env.REAL_GIT = realGit;

      const { tool } = await loadTools(ws.root);
      for (const failCmd of ["tracked", "status", "untracked"] as const) {
        process.env.FAIL_CMD = failCmd;
        const created = await executeTool(tool("change-scope-check"), {
          action: "create",
          includeGitFiles: true,
        }, "build");
        expect(created.ok, failCmd).toBe(true);
        // 三種都是必要清單：缺一即整份快照不可用，不當成空集合＋可用。
        expect(created.git.available, failCmd).toBe(false);
      }
    } finally {
      if (originalPath === "") delete process.env.PATH;
      else process.env.PATH = originalPath;
      delete process.env.REAL_GIT;
      delete process.env.FAIL_CMD;
      ws.cleanup();
    }
  });
});

describe("change-scope-check 授權清單可由設定覆寫", () => {
  test("scopeCheckAllowedAgents 改成 qa 時，qa 放行、build 被拒", async () => {
    const ws = createWorkspace("change-scope-override-");
    try {
      const settings = {
        ...DEFAULT_SETTINGS,
        verification: { ...DEFAULT_SETTINGS.verification, scopeCheckAllowedAgents: ["qa"] },
      };
      const fake = createFakeV2Context({ directory: ws.root });
      await verificationModule.register({ ctx: fake.ctx, settings });
      const tool = fake.added.get("change-scope-check");
      if (!tool) throw new Error("tool not registered: change-scope-check");
      // qa 在新清單內：過了授權門，走到參數檢查才被擋。
      const allowed = await executeTool(tool, { action: "bogus" }, "qa");
      expect(allowed.code).toBe("INVALID_INPUT");
      // build 不在新清單內：授權門直接拒絕，並點名有效清單。
      const denied = await executeTool(tool, { action: "create", paths: [] }, "build");
      expect(denied.code).toBe("AGENT_NOT_ALLOWED");
      expect(denied.error).toContain("qa");
      expect(denied.error).not.toContain("build");
    } finally {
      ws.cleanup();
    }
  });
});
