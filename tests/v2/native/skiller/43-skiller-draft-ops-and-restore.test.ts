/**
 * 43 — Skiller 草稿編輯工具與 quarantine 復原
 *
 * 涵蓋 30-skiller-tools.test.ts 之後新增的四支工具：
 *   - `skiller-draft` 的多檔 bundle（`files`）。
 *   - `skiller-draft-read` / `skiller-draft-update` / `skiller-draft-delete`。
 *   - `skiller-restore`（quarantine → skill root，retire 的反向操作）。
 *
 * 驗收重點：
 *   - preview / confirm 與 preview / expectedSha256 兩段式一律不可繞過。
 *   - 路徑一律受 fixed-root containment 與 bundle 相對路徑規則約束；
 *     traversal、絕對路徑、隱藏檔與 SKILL.md 混入 files 都必須拒絕。
 *   - section 級更新逐字保留 frontmatter。
 *   - restore 重跑 promote 等級的驗證；personal scope 與 pins registry 狀態一致。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTestWorkspace,
  createFakeContext,
  parseToolResult,
  type TestWorkspace,
} from "./_harness.ts";
import type { SkillerDeps } from "../../../../src/modules/skiller/skiller-common.ts";
import { createSkillerDraftTool } from "../../../../src/modules/skiller/skiller-draft.ts";
import { draftSha256 } from "../../../../src/modules/skiller/skiller-draft-content.ts";
import {
  createSkillerDraftReadTool,
  createSkillerDraftUpdateTool,
  createSkillerDraftDeleteTool,
} from "../../../../src/modules/skiller/skiller-draft-ops.ts";
import { createSkillerRestoreTool } from "../../../../src/modules/skiller/skiller-restore.ts";
import { createSkillerRetireTool } from "../../../../src/modules/skiller/skiller-retire.ts";
import { createSkillerScanTool } from "../../../../src/modules/skiller/skiller-scan.ts";

// ─── helpers（與 30-skiller-tools.test.ts 同一套慣例）────────

const GOVERNANCE_AGENT_GROUPS: Record<string, string[]> = {
  planning: ["arch"],
  implementation: ["build"],
  review: ["review"],
  documentation: ["writer"],
};

interface PersonalFixture {
  base: string;
  draftRoot: string;
  skillRoot: string;
  quarantineRoot: string;
  policyPath: string;
  pinsPath: string;
  cleanup(): void;
}

function createPersonalFixture(pins: Record<string, unknown> = {}): PersonalFixture {
  const base = mkdtempSync(join(tmpdir(), "skiller-ops-"));
  const draftRoot = join(base, "drafts");
  const skillRoot = join(base, "skills");
  const quarantineRoot = join(base, "quarantine");
  const policyPath = join(base, "skills-policy.json");
  const pinsPath = join(base, "skills-personal.json");
  for (const dir of [draftRoot, skillRoot, quarantineRoot]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    policyPath,
    JSON.stringify(
      {
        schemaVersion: 2,
        skillRoot,
        personalGovernance: {
          pinsPath,
          personalNamespace: "personal-",
          agentGroups: GOVERNANCE_AGENT_GROUPS,
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  writeFileSync(pinsPath, `${JSON.stringify({ schemaVersion: 1, pins }, null, 2)}\n`, "utf-8");
  return {
    base,
    draftRoot,
    skillRoot,
    quarantineRoot,
    policyPath,
    pinsPath,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function writeAgentRouteFile(ws: TestWorkspace, agent: string): void {
  const dir = join(ws.root, "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${agent}.md`),
    `---\ndescription: test agent\nmode: subagent\npermission:\n  skill:\n    "*": deny\n    personal-*: ask\n---\n\nbody\n`,
    "utf-8",
  );
}

function makeDeps(ws: TestWorkspace, fx?: PersonalFixture): SkillerDeps {
  return {
    resolveProjectRoot: () => ws.root,
    ...(fx
      ? {
          roots: {
            personalDraftRoot: fx.draftRoot,
            personalSkillRoot: fx.skillRoot,
            personalQuarantineRoot: fx.quarantineRoot,
            policyPath: fx.policyPath,
            personalPinsPath: fx.pinsPath,
          },
        }
      : {}),
  };
}

type ToolDef = { execute(args: Record<string, unknown>, ctx?: unknown): Promise<any> };

async function execFactory(
  factory: (deps: SkillerDeps) => ToolDef,
  deps: SkillerDeps,
  args: Record<string, unknown>,
): Promise<ReturnType<typeof parseToolResult>> {
  const def = factory(deps);
  return parseToolResult(await def.execute(args, createFakeContext(deps.resolveProjectRoot()) as never));
}

function projectName(ws: TestWorkspace, capability = "demo"): string {
  return `project-${ws.root.split("/").pop()!.toLowerCase()}-${capability}`;
}

function skillMd(name: string, body = "# Title\n\n## Alpha\n\nalpha body\n\n## Beta\n\nbeta body\n"): string {
  return `---\nname: ${name}\ndescription: demo skill for tests\n---\n\n${body}`;
}

function writeInstalledSkill(root: string, name: string, content: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
}

const fixtures: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

function workspace(): TestWorkspace {
  const ws = createTestWorkspace();
  fixtures.push({ cleanup: () => ws.cleanup() });
  return ws;
}

function personalFixture(pins: Record<string, unknown> = {}): PersonalFixture {
  const fx = createPersonalFixture(pins);
  fixtures.push({ cleanup: () => fx.cleanup() });
  return fx;
}

// ─── Section 1：skiller-draft 多檔 bundle ────────────────────

describe("43 - skiller-draft: 多檔 bundle", () => {
  test("preview 列出全部檔案且不寫入任何東西", async () => {
    const ws = workspace();
    const name = projectName(ws);
    const r = await execFactory(createSkillerDraftTool, makeDeps(ws), {
      scope: "project",
      name,
      content: skillMd(name),
      files: [{ path: "references/api.md", content: "# API\n" }],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIRM_REQUIRED");
    const preview = (r.data as { preview: { files: Array<{ relativePath: string }> } }).preview;
    expect(preview.files.map((f) => f.relativePath)).toEqual(["SKILL.md", "references/api.md"]);
    expect(existsSync(join(ws.root, ".opencode", "skill-drafts", name))).toBe(false);
  });

  test("confirm 後 SKILL.md 與附屬檔案一起落地", async () => {
    const ws = workspace();
    const name = projectName(ws);
    const r = await execFactory(createSkillerDraftTool, makeDeps(ws), {
      scope: "project",
      name,
      content: skillMd(name),
      files: [
        { path: "references/api.md", content: "# API\n" },
        { path: "rules/style.md", content: "# Style\n" },
      ],
      confirm: true,
    });
    expect(r.ok).toBe(true);
    const root = join(ws.root, ".opencode", "skill-drafts", name);
    expect(readFileSync(join(root, "references", "api.md"), "utf-8")).toBe("# API\n");
    expect(readFileSync(join(root, "rules", "style.md"), "utf-8")).toBe("# Style\n");
    const written = (r.data as { filesWritten: Array<{ relativePath: string }> }).filesWritten;
    expect(written.map((f) => f.relativePath)).toEqual(["SKILL.md", "references/api.md", "rules/style.md"]);
  });

  test("draft create lock 被占用 → busy 且不建立 draft；釋放後可完成", async () => {
    const ws = workspace();
    const name = projectName(ws);
    const lockDir = join(ws.root, ".ultrawork", "cache", "locks");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, "skiller.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: "held" }), "utf-8");
    const args = { scope: "project", name, content: skillMd(name), confirm: true };
    const busy = await execFactory(createSkillerDraftTool, makeDeps(ws), args);
    expect(busy.code).toBe("CONTENT_LOCK_BUSY");
    expect(existsSync(join(ws.root, ".opencode", "skill-drafts", name))).toBe(false);
    unlinkSync(lockPath);
    expect((await execFactory(createSkillerDraftTool, makeDeps(ws), args)).ok).toBe(true);
  });

  test("traversal、絕對路徑、隱藏檔與重複路徑一律拒絕且不寫入", async () => {
    const ws = workspace();
    const name = projectName(ws);
    const bad: Array<[string, unknown]> = [
      ["traversal", [{ path: "../escape.md", content: "x" }]],
      ["absolute", [{ path: "/etc/passwd", content: "x" }]],
      ["hidden", [{ path: ".secret/notes.md", content: "x" }]],
      ["backslash", [{ path: "refs\\api.md", content: "x" }]],
      ["duplicate", [
        { path: "refs/api.md", content: "x" },
        { path: "refs/api.md", content: "y" },
      ]],
    ];
    for (const [label, files] of bad) {
      const r = await execFactory(createSkillerDraftTool, makeDeps(ws), {
        scope: "project",
        name,
        content: skillMd(name),
        files,
        confirm: true,
      });
      expect(r.ok, label).toBe(false);
      expect(["INVALID_BUNDLE_PATH", "INVALID_FILES"], label).toContain(r.code);
    }
    expect(existsSync(join(ws.root, ".opencode", "skill-drafts", name))).toBe(false);
  });

  test("SKILL.md 不得混進 files（一律由 content 提供）", async () => {
    const ws = workspace();
    const name = projectName(ws);
    const r = await execFactory(createSkillerDraftTool, makeDeps(ws), {
      scope: "project",
      name,
      content: skillMd(name),
      files: [{ path: "SKILL.md", content: "x" }],
      confirm: true,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_FILES");
  });
});

// ─── Section 2：skiller-draft-read ───────────────────────────

describe("43 - skiller-draft-read", () => {
  async function seed(ws: TestWorkspace, name: string): Promise<void> {
    await execFactory(createSkillerDraftTool, makeDeps(ws), {
      scope: "project",
      name,
      content: skillMd(name),
      files: [{ path: "references/api.md", content: "# API\n\nlookup table\n" }],
      confirm: true,
    });
  }

  test("list 回 bundle 檔案清單", async () => {
    const ws = workspace();
    const name = projectName(ws);
    await seed(ws, name);
    const r = await execFactory(createSkillerDraftReadTool, makeDeps(ws), { scope: "project", name, list: true });
    expect(r.ok).toBe(true);
    expect((r.data as { files: string[] }).files).toEqual(["SKILL.md", "references/api.md"]);
  });

  test("outline 回標題結構與 frontmatter 摘要", async () => {
    const ws = workspace();
    const name = projectName(ws);
    await seed(ws, name);
    const r = await execFactory(createSkillerDraftReadTool, makeDeps(ws), { scope: "project", name, outline: true });
    expect(r.ok).toBe(true);
    const data = r.data as {
      outline: Array<{ heading: string; level: number }>;
      frontmatter: { name: string };
      sha256: string;
    };
    expect(data.outline.map((o) => o.heading)).toEqual(["Title", "Alpha", "Beta"]);
    expect(data.frontmatter.name).toBe(name);
    expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("section 取單一段落；找不到時回 SECTION_NOT_FOUND", async () => {
    const ws = workspace();
    const name = projectName(ws);
    await seed(ws, name);
    const hit = await execFactory(createSkillerDraftReadTool, makeDeps(ws), { scope: "project", name, section: "Alpha" });
    expect(hit.ok).toBe(true);
    expect((hit.data as { content: string }).content).toContain("alpha body");
    const miss = await execFactory(createSkillerDraftReadTool, makeDeps(ws), { scope: "project", name, section: "Nope" });
    expect(miss.ok).toBe(false);
    expect(miss.code).toBe("SECTION_NOT_FOUND");
  });

  test("grep 回行級命中，file 可指向附屬檔案", async () => {
    const ws = workspace();
    const name = projectName(ws);
    await seed(ws, name);
    const r = await execFactory(createSkillerDraftReadTool, makeDeps(ws), {
      scope: "project",
      name,
      file: "references/api.md",
      grep: "lookup",
    });
    expect(r.ok).toBe(true);
    expect((r.data as { matchCount: number }).matchCount).toBe(1);
  });

  test("bundle 外的路徑一律拒絕", async () => {
    const ws = workspace();
    const name = projectName(ws);
    await seed(ws, name);
    const r = await execFactory(createSkillerDraftReadTool, makeDeps(ws), {
      scope: "project",
      name,
      file: "../../../etc/passwd",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID_BUNDLE_PATH");
  });
});

// ─── Section 3：skiller-draft-update ─────────────────────────

describe("43 - skiller-draft-update", () => {
  async function seed(ws: TestWorkspace, name: string): Promise<string> {
    await execFactory(createSkillerDraftTool, makeDeps(ws), {
      scope: "project",
      name,
      content: skillMd(name),
      confirm: true,
    });
    const read = await execFactory(createSkillerDraftReadTool, makeDeps(ws), { scope: "project", name });
    return (read.data as { sha256: string }).sha256;
  }

  function draftPath(ws: TestWorkspace, name: string): string {
    return join(ws.root, ".opencode", "skill-drafts", name, "SKILL.md");
  }

  test("preview 回 diff 與 sha 但不寫入", async () => {
    const ws = workspace();
    const name = projectName(ws);
    const sha = await seed(ws, name);
    const before = readFileSync(draftPath(ws, name), "utf-8");
    const r = await execFactory(createSkillerDraftUpdateTool, makeDeps(ws), {
      scope: "project",
      name,
      section: "Alpha",
      op: "replace",
      content: "replaced alpha\n",
    });
    expect(r.ok).toBe(true);
    const data = r.data as { currentSha256: string; proposedSha256: string; diff: string };
    expect(data.currentSha256).toBe(sha);
    expect(data.proposedSha256).not.toBe(sha);
    expect(data.diff).toContain("replaced alpha");
    expect(readFileSync(draftPath(ws, name), "utf-8")).toBe(before);
  });

  test("apply 缺 expectedSha256 或 sha 過期都 fail closed", async () => {
    const ws = workspace();
    const name = projectName(ws);
    const sha = await seed(ws, name);
    const before = readFileSync(draftPath(ws, name), "utf-8");

    const missing = await execFactory(createSkillerDraftUpdateTool, makeDeps(ws), {
      scope: "project", name, section: "Alpha", op: "replace", content: "x\n", mode: "apply",
    });
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("EXPECTED_SHA_REQUIRED");

    const stale = await execFactory(createSkillerDraftUpdateTool, makeDeps(ws), {
      scope: "project", name, section: "Alpha", op: "replace", content: "x\n", mode: "apply",
      expectedSha256: "0".repeat(64),
    });
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe("STALE_SHA");
    expect(readFileSync(draftPath(ws, name), "utf-8")).toBe(before);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });

  test("雙行程 draft update：持鎖者完成、另一行程 busy，重試後兩次更新都保留", async () => {
    const ws = workspace();
    const name = projectName(ws);
    const sha = await seed(ws, name);
    const worker = join(import.meta.dir, "_draft-update-worker.ts");
    const ready = join(ws.root, "worker-ready");
    const holder = Bun.spawn([process.execPath, worker, ws.root, name, sha, "first", "500", ready], { stdout: "pipe", stderr: "pipe" });
    for (let i = 0; i < 100 && !existsSync(ready); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(ready)).toBe(true);

    const contender = Bun.spawn([process.execPath, worker, ws.root, name, sha, "second", "0", join(ws.root, "contender-ready")], { stdout: "pipe", stderr: "pipe" });
    const contenderOut = await new Response(contender.stdout).text();
    await contender.exited;
    const contenderResult = JSON.parse(contenderOut) as { ok: boolean; code?: string };
    expect(contenderResult.code).toBe("CONTENT_LOCK_BUSY");

    const holderOut = await new Response(holder.stdout).text();
    await holder.exited;
    expect((JSON.parse(holderOut) as { ok: boolean }).ok).toBe(true);
    const afterFirst = readFileSync(draftPath(ws, name), "utf-8");
    expect(afterFirst).toContain("first");

    const nextSha = draftSha256(afterFirst);
    const retry = Bun.spawn([process.execPath, worker, ws.root, name, nextSha, "second", "0", join(ws.root, "retry-ready")], { stdout: "pipe", stderr: "pipe" });
    const retryOut = await new Response(retry.stdout).text();
    await retry.exited;
    expect((JSON.parse(retryOut) as { ok: boolean }).ok).toBe(true);
    const final = readFileSync(draftPath(ws, name), "utf-8");
    expect(final).toContain("first");
    expect(final).toContain("second");
  });

  test("等待鎖期間草稿被改動 → 鎖內重讀擋下 stale SHA", async () => {
    const ws = workspace();
    const name = projectName(ws);
    const sha = await seed(ws, name);
    const worker = join(import.meta.dir, "_draft-update-worker.ts");
    const ready = join(ws.root, "stale-ready");
    const holder = Bun.spawn([process.execPath, worker, ws.root, name, sha, "held", "500", ready], { stdout: "pipe", stderr: "pipe" });
    for (let i = 0; i < 100 && !existsSync(ready); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(ready)).toBe(true);
    writeFileSync(draftPath(ws, name), `${skillMd(name)}\nchanged while waiting\n`, "utf-8");
    await holder.exited;
    const stale = await execFactory(createSkillerDraftUpdateTool, makeDeps(ws), {
      scope: "project", name, section: "Alpha", op: "append", content: "must not write\n", mode: "apply", expectedSha256: sha,
    });
    expect(stale.code).toBe("STALE_SHA");
    expect(readFileSync(draftPath(ws, name), "utf-8")).toContain("changed while waiting");
  });

  test("apply 寫入 section 並逐字保留 frontmatter", async () => {
    const ws = workspace();
    const name = projectName(ws);
    const sha = await seed(ws, name);
    const r = await execFactory(createSkillerDraftUpdateTool, makeDeps(ws), {
      scope: "project", name, section: "Alpha", op: "replace", content: "replaced alpha\n",
      mode: "apply", expectedSha256: sha,
    });
    expect(r.ok).toBe(true);
    const after = readFileSync(draftPath(ws, name), "utf-8");
    expect(after.startsWith(`---\nname: ${name}\ndescription: demo skill for tests\n---\n`)).toBe(true);
    expect(after).toContain("## Alpha\n\nreplaced alpha");
    expect(after).toContain("## Beta");
    expect(after).not.toContain("alpha body");
  });

  test("append / prepend / delete 都作用於指定 section", async () => {
    const ws = workspace();
    const name = projectName(ws);
    let sha = await seed(ws, name);

    const appended = await execFactory(createSkillerDraftUpdateTool, makeDeps(ws), {
      scope: "project", name, section: "Alpha", op: "append", content: "tail line\n",
      mode: "apply", expectedSha256: sha,
    });
    expect(appended.ok).toBe(true);
    sha = (appended.data as { sha256: string }).sha256;
    let body = readFileSync(draftPath(ws, name), "utf-8");
    expect(body.indexOf("alpha body")).toBeLessThan(body.indexOf("tail line"));

    const deleted = await execFactory(createSkillerDraftUpdateTool, makeDeps(ws), {
      scope: "project", name, section: "Beta", op: "delete",
      mode: "apply", expectedSha256: sha,
    });
    expect(deleted.ok).toBe(true);
    body = readFileSync(draftPath(ws, name), "utf-8");
    expect(body).not.toContain("## Beta");
    expect(body).toContain("## Alpha");
  });

  test("content 自帶 frontmatter 一律拒絕", async () => {
    const ws = workspace();
    const name = projectName(ws);
    const sha = await seed(ws, name);
    const r = await execFactory(createSkillerDraftUpdateTool, makeDeps(ws), {
      scope: "project", name, section: "Alpha", op: "replace",
      content: "---\nname: evil\n---\n\nbody\n", mode: "apply", expectedSha256: sha,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONTENT_HAS_FRONTMATTER");
  });

  test("整份 body 不支援 delete", async () => {
    const ws = workspace();
    const name = projectName(ws);
    const sha = await seed(ws, name);
    const r = await execFactory(createSkillerDraftUpdateTool, makeDeps(ws), {
      scope: "project", name, op: "delete", mode: "apply", expectedSha256: sha,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("DELETE_TARGET_INVALID");
  });
});

// ─── Section 4：skiller-draft-delete ─────────────────────────

describe("43 - skiller-draft-delete", () => {
  async function seed(ws: TestWorkspace, name: string): Promise<void> {
    await execFactory(createSkillerDraftTool, makeDeps(ws), {
      scope: "project",
      name,
      content: skillMd(name),
      files: [{ path: "references/api.md", content: "# API\n" }],
      confirm: true,
    });
  }

  test("delete lock 被占用 → busy 且不刪除；釋放後可完成", async () => {
    const ws = workspace();
    const name = projectName(ws);
    await seed(ws, name);
    const lockDir = join(ws.root, ".ultrawork", "cache", "locks");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, "skiller.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: "held" }), "utf-8");
    const args = { scope: "project", name, mode: "apply", confirm: true };
    const busy = await execFactory(createSkillerDraftDeleteTool, makeDeps(ws), args);
    expect(busy.code).toBe("CONTENT_LOCK_BUSY");
    expect(existsSync(join(ws.root, ".opencode", "skill-drafts", name, "SKILL.md"))).toBe(true);
    unlinkSync(lockPath);
    expect((await execFactory(createSkillerDraftDeleteTool, makeDeps(ws), args)).ok).toBe(true);
    expect(existsSync(join(ws.root, ".opencode", "skill-drafts", name, "SKILL.md"))).toBe(false);
  });

  test("preview 不刪除，apply 缺 confirm 也不刪除", async () => {
    const ws = workspace();
    const name = projectName(ws);
    await seed(ws, name);
    const dir = join(ws.root, ".opencode", "skill-drafts", name);

    const preview = await execFactory(createSkillerDraftDeleteTool, makeDeps(ws), { scope: "project", name });
    expect(preview.ok).toBe(true);
    expect((preview.data as { files: string[] }).files).toEqual(["SKILL.md", "references/api.md"]);
    expect(existsSync(dir)).toBe(true);

    const noConfirm = await execFactory(createSkillerDraftDeleteTool, makeDeps(ws), {
      scope: "project", name, mode: "apply",
    });
    expect(noConfirm.ok).toBe(false);
    expect(noConfirm.code).toBe("CONFIRM_REQUIRED");
    expect(existsSync(dir)).toBe(true);
  });

  test("confirm 後刪除整份草稿", async () => {
    const ws = workspace();
    const name = projectName(ws);
    await seed(ws, name);
    const dir = join(ws.root, ".opencode", "skill-drafts", name);
    const r = await execFactory(createSkillerDraftDeleteTool, makeDeps(ws), {
      scope: "project", name, mode: "apply", confirm: true,
    });
    expect(r.ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  test("指定 file 只刪單一檔案", async () => {
    const ws = workspace();
    const name = projectName(ws);
    await seed(ws, name);
    const dir = join(ws.root, ".opencode", "skill-drafts", name);
    const r = await execFactory(createSkillerDraftDeleteTool, makeDeps(ws), {
      scope: "project", name, file: "references/api.md", mode: "apply", confirm: true,
    });
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, "references", "api.md"))).toBe(false);
    expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
  });

  test("只作用於 draft root：已安裝 skill 不受影響", async () => {
    const ws = workspace();
    const name = projectName(ws);
    writeInstalledSkill(join(ws.root, ".opencode", "skills"), name, skillMd(name));
    const r = await execFactory(createSkillerDraftDeleteTool, makeDeps(ws), {
      scope: "project", name, mode: "apply", confirm: true,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("NOT_FOUND");
    expect(existsSync(join(ws.root, ".opencode", "skills", name, "SKILL.md"))).toBe(true);
  });
});

// ─── Section 5：skiller-scan 納入 quarantine ─────────────────

describe("43 - skiller-scan: quarantine 可見性", () => {
  test("quarantine 內的 skill 會以 sourceKind=quarantine 列出", async () => {
    const ws = workspace();
    const name = projectName(ws);
    writeInstalledSkill(join(ws.root, ".opencode", "skill-quarantine"), name, skillMd(name));
    const r = await execFactory(createSkillerScanTool, makeDeps(ws), { scope: "project" });
    expect(r.ok).toBe(true);
    const data = r.data as {
      roots: { quarantine: string };
      entries: Array<{ name: string; sourceKind: string }>;
    };
    expect(data.roots.quarantine.endsWith(".opencode/skill-quarantine")).toBe(true);
    expect(data.entries.some((e) => e.name === name && e.sourceKind === "quarantine")).toBe(true);
  });

  test("quarantine root 不存在時不產生 warning 噪音", async () => {
    const ws = workspace();
    const r = await execFactory(createSkillerScanTool, makeDeps(ws), { scope: "project" });
    expect(r.ok).toBe(true);
    const warnings = (r.data as { warnings?: Array<{ message?: string }> }).warnings ?? [];
    expect(warnings.some((w) => (w.message ?? "").includes("quarantine"))).toBe(false);
  });
});

// ─── Section 6：skiller-restore ──────────────────────────────

describe("43 - skiller-restore", () => {
  test("project scope：preview 不移動，confirm 後移回 skill root", async () => {
    const ws = workspace();
    const name = projectName(ws);
    const quarantineDir = join(ws.root, ".opencode", "skill-quarantine", name);
    writeInstalledSkill(join(ws.root, ".opencode", "skill-quarantine"), name, skillMd(name));

    const preview = await execFactory(createSkillerRestoreTool, makeDeps(ws), { scope: "project", name });
    expect(preview.ok).toBe(true);
    expect(existsSync(quarantineDir)).toBe(true);

    const applied = await execFactory(createSkillerRestoreTool, makeDeps(ws), {
      scope: "project", name, mode: "apply", confirm: true,
    });
    expect(applied.ok).toBe(true);
    expect(existsSync(quarantineDir)).toBe(false);
    expect(existsSync(join(ws.root, ".opencode", "skills", name, "SKILL.md"))).toBe(true);
  });

  test("apply 缺 confirm 不移動任何目錄", async () => {
    const ws = workspace();
    const name = projectName(ws);
    writeInstalledSkill(join(ws.root, ".opencode", "skill-quarantine"), name, skillMd(name));
    const r = await execFactory(createSkillerRestoreTool, makeDeps(ws), { scope: "project", name, mode: "apply" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIRM_REQUIRED");
    expect(existsSync(join(ws.root, ".opencode", "skill-quarantine", name))).toBe(true);
  });

  test("目標已存在同名 skill 時拒絕，不覆蓋生效中的內容", async () => {
    const ws = workspace();
    const name = projectName(ws);
    writeInstalledSkill(join(ws.root, ".opencode", "skill-quarantine"), name, skillMd(name));
    writeInstalledSkill(join(ws.root, ".opencode", "skills"), name, skillMd(name, "# Live\n\nlive body\n"));
    const r = await execFactory(createSkillerRestoreTool, makeDeps(ws), {
      scope: "project", name, mode: "apply", confirm: true,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("ALREADY_EXISTS");
    expect(readFileSync(join(ws.root, ".opencode", "skills", name, "SKILL.md"), "utf-8")).toContain("live body");
  });

  test("quarantine 內沒有該 skill 時回 NOT_FOUND", async () => {
    const ws = workspace();
    const r = await execFactory(createSkillerRestoreTool, makeDeps(ws), { scope: "project", name: projectName(ws) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("NOT_FOUND");
  });

  test("personal scope：retire → restore 往返讓 pin 回到 active 且 digest 正確", async () => {
    const ws = workspace();
    for (const agent of ["build", "review"]) writeAgentRouteFile(ws, agent);
    const name = "personal-demo-capability";
    const content = skillMd(name);
    const fx = personalFixture({
      [name]: {
        name,
        digest: createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex"),
        targetAgentGroups: ["implementation", "review"],
        resolvedTargetAgents: ["build", "review"],
        status: "active",
        promotedAt: new Date().toISOString(),
      },
    });
    writeInstalledSkill(fx.skillRoot, name, content);
    const deps = makeDeps(ws, fx);

    const retired = await execFactory(createSkillerRetireTool, deps, {
      scope: "personal", name, mode: "apply", confirm: true,
    });
    expect(retired.ok).toBe(true);
    type PinSnapshot = {
      pins: Record<string, { status: string; retiredAt?: string; targetAgentGroups: string[] }>;
    };
    let pins = JSON.parse(readFileSync(fx.pinsPath, "utf-8")) as PinSnapshot;
    expect(pins.pins[name]!.status).toBe("retired");

    const restored = await execFactory(createSkillerRestoreTool, deps, {
      scope: "personal", name, mode: "apply", confirm: true,
    });
    expect(restored.ok).toBe(true);
    expect(existsSync(join(fx.skillRoot, name, "SKILL.md"))).toBe(true);
    expect(existsSync(join(fx.quarantineRoot, name))).toBe(false);
    pins = JSON.parse(readFileSync(fx.pinsPath, "utf-8")) as PinSnapshot;
    expect(pins.pins[name]!.status).toBe("active");
    expect(pins.pins[name]!.retiredAt).toBeUndefined();
    expect(pins.pins[name]!.targetAgentGroups).toEqual(["implementation", "review"]);
  });

  test("personal scope：registry 沒有 pin 時 fail closed，不動任何目錄", async () => {
    const ws = workspace();
    const name = "personal-demo-capability";
    const fx = personalFixture();
    writeInstalledSkill(fx.quarantineRoot, name, skillMd(name));
    const r = await execFactory(createSkillerRestoreTool, makeDeps(ws, fx), {
      scope: "personal", name, mode: "apply", confirm: true,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("PIN_NOT_FOUND");
    expect(existsSync(join(fx.quarantineRoot, name))).toBe(true);
    expect(existsSync(join(fx.skillRoot, name))).toBe(false);
  });

  test("personal scope：內容含 high-risk marker 時 restore 被 blocker 擋下", async () => {
    const ws = workspace();
    for (const agent of ["build"]) writeAgentRouteFile(ws, agent);
    const name = "personal-demo-capability";
    const risky = skillMd(name, "# Title\n\n## Steps\n\nrun `sudo rm -rf /tmp/x` first\n");
    const fx = personalFixture({
      [name]: {
        name,
        digest: "0".repeat(64),
        targetAgentGroups: ["implementation"],
        resolvedTargetAgents: ["build"],
        status: "retired",
        promotedAt: new Date().toISOString(),
        retiredAt: new Date().toISOString(),
      },
    });
    writeInstalledSkill(fx.quarantineRoot, name, risky);
    const r = await execFactory(createSkillerRestoreTool, makeDeps(ws, fx), {
      scope: "personal", name, mode: "apply", confirm: true,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("RESTORE_BLOCKED");
    expect(existsSync(join(fx.quarantineRoot, name))).toBe(true);
    expect(existsSync(join(fx.skillRoot, name))).toBe(false);
  });
});
