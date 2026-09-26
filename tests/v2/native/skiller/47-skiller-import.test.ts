/**
 * 47 — skiller-import：把外部 repo 的 skill 匯入 managed draft root。
 *
 * 行為契約（見工作說明 t-skiller-import）：
 *   - preview 模式只做唯讀探索（CLI --list 等價），不寫任何檔。
 *   - apply 模式需 confirm:true，在自建暫存 workdir 執行 npx skills add
 *    （--copy、非互動旗標），驗證 bundle 後搬進 managed draft root，
 *     回傳檔案清單與每檔 SHA-256；任何失敗 fail closed 並清理暫存。
 *   - CLI 經可注入的 runner 抽象隔離；測試用 fake runner，不打網路。
 *
 * @see ../../../../src/modules/skiller/skiller-import.ts — 受測 factory
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTestWorkspace,
  loadPlugin,
  createFakeContext,
  parseToolResult,
  type TestWorkspace,
} from "./_harness.ts";
import type { SkillerDeps } from "../../../../src/modules/skiller/skiller-common.ts";
import {
  createSkillerImportTool,
  type SkillCliResult,
  type SkillerImportDeps,
} from "../../../../src/modules/skiller/skiller-import.ts";

// ─── Helpers ─────────────────────────────────────────────────

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex");
}

function validSkillMd(name: string, description = "imported skill for tests"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nUse this skill carefully.\n`;
}

interface ManagedFixture {
  base: string;
  draftRoot: string;
  skillRoot: string;
  quarantineRoot: string;
  cleanup(): void;
}

function createManagedFixture(): ManagedFixture {
  const base = mkdtempSync(join(tmpdir(), "skiller-import-fixture-"));
  const draftRoot = join(base, "drafts");
  const skillRoot = join(base, "skills");
  const quarantineRoot = join(base, "quarantine");
  mkdirSync(draftRoot, { recursive: true });
  mkdirSync(skillRoot, { recursive: true });
  mkdirSync(quarantineRoot, { recursive: true });
  return { base, draftRoot, skillRoot, quarantineRoot, cleanup() { rmSync(base, { recursive: true, force: true }); } };
}

const fixtures: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

type CliRunner = (command: string[], cwd: string) => Promise<SkillCliResult>;

interface RecordedCall {
  command: string[];
  cwd: string;
}

function makeDeps(ws: TestWorkspace, fx: ManagedFixture, runner: CliRunner): SkillerImportDeps {
  return {
    resolveProjectRoot: () => ws.root,
    roots: {
      personalDraftRoot: fx.draftRoot,
      personalSkillRoot: fx.skillRoot,
      personalQuarantineRoot: fx.quarantineRoot,
    },
    runSkillCli: runner,
  };
}

type ToolDef = { execute(args: Record<string, unknown>, ctx?: unknown): Promise<any> };

async function execImport(
  deps: SkillerImportDeps,
  args: Record<string, unknown>,
): Promise<ReturnType<typeof parseToolResult>> {
  const ws = (deps as { resolveProjectRoot: () => string }).resolveProjectRoot();
  const def = createSkillerImportTool(deps) as unknown as ToolDef;
  return parseToolResult(await def.execute(args, createFakeContext(ws) as never));
}

/** 暫存 workdir 殘留快照（工具自建的 skiller-import-* 目錄）。 */
function tmpImportEntries(): string[] {
  return readdirSync(tmpdir()).filter((e) => e.startsWith("skiller-import-")).sort();
}

/** 成功的 fake runner：在 cwd 下按中央複本布局寫入 bundle，可選附屬檔。 */
function successRunner(skill: string, extraFiles: Record<string, string> = {}, stdout = "Done!"): CliRunner {
  return async (_command: string[], cwd: string) => {
    const dir = join(cwd, "skills", skill);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), validSkillMd(skill), "utf-8");
    for (const [rel, content] of Object.entries(extraFiles)) {
      const target = join(dir, rel);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content, "utf-8");
    }
    return { exitCode: 0, stdout, stderr: "" };
  };
}

const LIST_STDOUT = [
  "  Found 2 skills",
  "",
  "    alpha-skill",
  "",
  "      First skill description.",
  "",
  "    beta-skill",
  "",
  "      Second skill description.",
  "",
].join("\n");

// ─── Section 1：factory 與 preview ────────────────────────────

describe("47 - skiller-import: factory & preview", () => {
  test("factory 存在且三要素健全", () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createManagedFixture();
    fixtures.push(fx);
    const def = createSkillerImportTool(makeDeps(ws, fx, async () => ({ exitCode: 0, stdout: "", stderr: "" }))) as unknown as {
      description?: unknown;
      args?: unknown;
      input?: unknown;
      execute?: unknown;
    };
    expect(typeof def.description).toBe("string");
    expect((def.description as string).length).toBeGreaterThan(0);
    expect(def.input).toBeDefined();
    expect(typeof def.execute).toBe("function");
  });

  test("preview 回傳探索到的 skill 清單且不寫任何檔", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createManagedFixture();
    fixtures.push(fx);
    const calls: RecordedCall[] = [];
    const before = tmpImportEntries();
    const r = await execImport(
      makeDeps(ws, fx, async (command, cwd) => {
        calls.push({ command, cwd });
        return { exitCode: 0, stdout: LIST_STDOUT, stderr: "" };
      }),
      { source: "vercel-labs/agent-skills" },
    );
    expect(r.ok).toBe(true);
    const data = r.data as { mode?: string; skills?: string[] };
    expect(data.mode).toBe("preview");
    expect(data.skills).toEqual(["alpha-skill", "beta-skill"]);
    // preview 不寫 draft root、不留暫存
    expect(readdirSync(fx.draftRoot)).toEqual([]);
    expect(tmpImportEntries()).toEqual(before);
    // CLI 以參數陣列呼叫（含 --list 與 -y，非互動）
    expect(calls.length).toBe(1);
    expect(calls[0]!.command).toContain("add");
    expect(calls[0]!.command).toContain("vercel-labs/agent-skills");
    expect(calls[0]!.command).toContain("--list");
    expect(calls[0]!.command).toContain("-y");
    expect(calls[0]!.command[0]).toBe("npx");
  });

  test("preview 接受 https URL source", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createManagedFixture();
    fixtures.push(fx);
    const calls: RecordedCall[] = [];
    const r = await execImport(
      makeDeps(ws, fx, async (command, cwd) => {
        calls.push({ command, cwd });
        return { exitCode: 0, stdout: LIST_STDOUT, stderr: "" };
      }),
      { source: "https://github.com/vercel-labs/agent-skills" },
    );
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.command).toContain("https://github.com/vercel-labs/agent-skills");
  });

  test("source 格式非法一律拒絕且不呼叫 CLI", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createManagedFixture();
    fixtures.push(fx);
    const badSources = [
      "",
      "not a source",
      "../escape",
      "owner/",
      "/owner/repo",
      "owner/repo/extra",
      "git@github.com:owner/repo.git",
      "http://github.com/owner/repo",
      "ftp://example.com/owner/repo",
    ];
    for (const source of badSources) {
      let called = false;
      const r = await execImport(
        makeDeps(ws, fx, async () => {
          called = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
        { source },
      );
      expect(r.ok, `source=${source}`).toBe(false);
      expect(r.code, `source=${source}`).toBe("INVALID_SOURCE");
      expect(called, `source=${source}`).toBe(false);
    }
    expect(readdirSync(fx.draftRoot)).toEqual([]);
  });
});

// ─── Section 2：apply 成功路徑 ────────────────────────────────

describe("47 - skiller-import: apply success", () => {
  test("apply 缺 confirm 回 CONFIRM_REQUIRED 且不呼叫 CLI、不寫檔", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createManagedFixture();
    fixtures.push(fx);
    let called = false;
    const r = await execImport(
      makeDeps(ws, fx, async () => {
        called = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
      { source: "vercel-labs/agent-skills", skill: "web-design-guidelines", mode: "apply" },
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIRM_REQUIRED");
    expect(called).toBe(false);
    expect(readdirSync(fx.draftRoot)).toEqual([]);
  });

  test("apply 缺 skill 回 SKILL_REQUIRED 且不呼叫 CLI", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createManagedFixture();
    fixtures.push(fx);
    let called = false;
    const r = await execImport(
      makeDeps(ws, fx, async () => {
        called = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
      { source: "vercel-labs/agent-skills", mode: "apply", confirm: true },
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe("SKILL_REQUIRED");
    expect(called).toBe(false);
  });

  test("apply 成功：bundle 搬進 managed draft root 並回傳每檔 SHA-256", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createManagedFixture();
    fixtures.push(fx);
    const skill = "web-design-guidelines";
    const calls: RecordedCall[] = [];
    const before = tmpImportEntries();
    const r = await execImport(
      makeDeps(ws, fx, async (command, cwd) => {
        calls.push({ command, cwd });
        return successRunner(skill, { "references/notes.md": "# notes\n" })(command, cwd);
      }),
      { source: "vercel-labs/agent-skills", skill, mode: "apply", confirm: true },
    );
    expect(r.ok).toBe(true);
    // CLI 以 --copy 非互動安裝指定 skill
    expect(calls.length).toBe(1);
    expect(calls[0]!.command[0]).toBe("npx");
    expect(calls[0]!.command[1]).toBe("skills");
    expect(calls[0]!.command).toContain(skill);
    expect(calls[0]!.command).toContain("--copy");
    expect(calls[0]!.command).toContain("-y");
    // draft root 內容
    const skillMd = validSkillMd(skill);
    expect(readFileSync(join(fx.draftRoot, skill, "SKILL.md"), "utf-8")).toBe(skillMd);
    expect(readFileSync(join(fx.draftRoot, skill, "references", "notes.md"), "utf-8")).toBe("# notes\n");
    const data = r.data as { files?: Array<{ relativePath: string; digest: string }> };
    const byRel = new Map((data.files ?? []).map((f) => [f.relativePath, f.digest]));
    expect(byRel.get("SKILL.md")).toBe(sha256(skillMd));
    expect(byRel.get("references/notes.md")).toBe(sha256("# notes\n"));
    // 暫存清理乾淨
    expect(tmpImportEntries()).toEqual(before);
  });

  test("apply 找到巢狀布局的 bundle（非中央 skills/ 目錄時）", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createManagedFixture();
    fixtures.push(fx);
    const skill = "nested-skill";
    const r = await execImport(
      makeDeps(ws, fx, async (_command, cwd) => {
        const dir = join(cwd, ".opencode", "skills", skill);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), validSkillMd(skill), "utf-8");
        return { exitCode: 0, stdout: "Done!", stderr: "" };
      }),
      { source: "vercel-labs/agent-skills", skill, mode: "apply", confirm: true },
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(join(fx.draftRoot, skill, "SKILL.md"), "utf-8")).toBe(validSkillMd(skill));
  });
});

// ─── Section 3：fail closed ───────────────────────────────────

describe("47 - skiller-import: fail closed", () => {
  test("root 不存在且 import lock 被占用 → 不建立 root，釋放後可完成", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createManagedFixture();
    fixtures.push(fx);
    rmSync(fx.draftRoot, { recursive: true, force: true });
    const lockDir = join(fx.base, "cache", "locks");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, "skiller.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: "held" }), "utf-8");
    const deps = makeDeps(ws, fx, successRunner("root-late-skill"));
    const args = { source: "owner/repo", skill: "root-late-skill", mode: "apply", confirm: true };
    const busy = await execImport(deps, args);
    expect(busy.code).toBe("CONTENT_LOCK_BUSY");
    expect(existsSync(fx.draftRoot)).toBe(false);
    expect(existsSync(fx.skillRoot)).toBe(true);
    unlinkSync(lockPath);
    const released = await execImport(deps, args);
    expect(released.ok).toBe(true);
    expect(existsSync(join(fx.draftRoot, "root-late-skill", "SKILL.md"))).toBe(true);
  });

  test("import lock 被占用 → busy 且不產生半套 draft；釋放後可完成", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createManagedFixture();
    fixtures.push(fx);
    const lockDir = join(fx.base, "cache", "locks");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, "skiller.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: "held" }), "utf-8");
    const deps = makeDeps(ws, fx, successRunner("imported-skill"));
    const args = { source: "owner/repo", skill: "imported-skill", mode: "apply", confirm: true };
    const busy = await execImport(deps, args);
    expect(busy.code).toBe("CONTENT_LOCK_BUSY");
    expect(readdirSync(fx.draftRoot)).toEqual([]);
    unlinkSync(lockPath);
    const released = await execImport(deps, args);
    expect(released.ok).toBe(true);
    expect(existsSync(join(fx.draftRoot, "imported-skill", "SKILL.md"))).toBe(true);
  });

  test("CLI 非零 exit：draft root 無殘留、暫存清理乾淨", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createManagedFixture();
    fixtures.push(fx);
    const before = tmpImportEntries();
    const r = await execImport(
      makeDeps(ws, fx, async () => ({ exitCode: 1, stdout: "", stderr: "boom" })),
      { source: "vercel-labs/agent-skills", skill: "some-skill", mode: "apply", confirm: true },
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CLI_INSTALL_FAILED");
    expect(readdirSync(fx.draftRoot)).toEqual([]);
    expect(tmpImportEntries()).toEqual(before);
  });

  test("CLI 成功但找不到 bundle：fail closed 且清理暫存", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createManagedFixture();
    fixtures.push(fx);
    const before = tmpImportEntries();
    const r = await execImport(
      makeDeps(ws, fx, async () => ({ exitCode: 0, stdout: "Done!", stderr: "" })),
      { source: "vercel-labs/agent-skills", skill: "ghost-skill", mode: "apply", confirm: true },
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe("BUNDLE_NOT_FOUND");
    expect(readdirSync(fx.draftRoot)).toEqual([]);
    expect(tmpImportEntries()).toEqual(before);
  });

  test("bundle 缺 SKILL.md 或 frontmatter 缺 name/description 一律拒絕", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const cases: Array<[string, Record<string, string> | null]> = [
      ["no-skill-md", null],
      ["no-name", { "SKILL.md": "---\ndescription: has description\n---\n\nbody\n" }],
      ["no-description", { "SKILL.md": "---\nname: no-description\n---\n\nbody\n" }],
      ["no-frontmatter", { "SKILL.md": "# just a title\n" }],
    ];
    for (const [skill, files] of cases) {
      const fx = createManagedFixture();
      fixtures.push(fx);
      const before = tmpImportEntries();
      const r = await execImport(
        makeDeps(ws, fx, async (_command, cwd) => {
          if (files !== null) {
            const dir = join(cwd, "skills", skill);
            mkdirSync(dir, { recursive: true });
            for (const [rel, content] of Object.entries(files)) {
              writeFileSync(join(dir, rel), content, "utf-8");
            }
          }
          return { exitCode: 0, stdout: "Done!", stderr: "" };
        }),
        { source: "vercel-labs/agent-skills", skill, mode: "apply", confirm: true },
      );
      expect(r.ok, skill).toBe(false);
      expect(["BUNDLE_NOT_FOUND", "BUNDLE_INVALID", "FRONTMATTER_MISSING", "FRONTMATTER_PARSE_ERROR", "NAME_REQUIRED", "DESCRIPTION_REQUIRED"]).toContain(r.code);
      expect(readdirSync(fx.draftRoot), skill).toEqual([]);
      expect(tmpImportEntries(), skill).toEqual(before);
    }
  });

  test("frontmatter name 與目錄不一致 → NAME_MISMATCH", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createManagedFixture();
    fixtures.push(fx);
    const skill = "real-dir-name";
    const r = await execImport(
      makeDeps(ws, fx, async (_command, cwd) => {
        const dir = join(cwd, "skills", skill);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), validSkillMd("other-name"), "utf-8");
        return { exitCode: 0, stdout: "Done!", stderr: "" };
      }),
      { source: "vercel-labs/agent-skills", skill, mode: "apply", confirm: true },
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe("NAME_MISMATCH");
    expect(readdirSync(fx.draftRoot)).toEqual([]);
  });

  test("name 帶 personal-/project- prefix 或非法字元 → validateSkillName 拒絕", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    for (const skill of ["personal-domain-cap", "project-x-cap", "Bad_Name", "a".repeat(65)]) {
      const fx = createManagedFixture();
      fixtures.push(fx);
      const r = await execImport(
        makeDeps(ws, fx, successRunner("whatever")),
        { source: "vercel-labs/agent-skills", skill, mode: "apply", confirm: true },
      );
      expect(r.ok, skill).toBe(false);
      expect(["INVALID_NAME", "INVALID_NAMESPACE"], skill).toContain(r.code);
      expect(readdirSync(fx.draftRoot), skill).toEqual([]);
    }
  });

  test("目標 draft 已存在同名 → ALREADY_EXISTS（不覆寫、不呼叫 CLI）", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createManagedFixture();
    fixtures.push(fx);
    const skill = "existing-skill";
    const dir = join(fx.draftRoot, skill);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), validSkillMd(skill, "original"), "utf-8");
    let called = false;
    const r = await execImport(
      makeDeps(ws, fx, async (command, cwd) => {
        called = true;
        return successRunner(skill)(command, cwd);
      }),
      { source: "vercel-labs/agent-skills", skill, mode: "apply", confirm: true },
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe("ALREADY_EXISTS");
    expect(called).toBe(false);
    expect(readFileSync(join(dir, "SKILL.md"), "utf-8")).toContain("original");
  });

  test("runner throw（npx 不可用）→ fail closed 且清理暫存", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createManagedFixture();
    fixtures.push(fx);
    const before = tmpImportEntries();
    const r = await execImport(
      makeDeps(ws, fx, async () => {
        throw new Error("spawn npx ENOENT");
      }),
      { source: "vercel-labs/agent-skills", skill: "any-skill", mode: "apply", confirm: true },
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CLI_SPAWN_FAILED");
    expect(readdirSync(fx.draftRoot)).toEqual([]);
    expect(tmpImportEntries()).toEqual(before);
  });
});

// ─── Section 4：registry 掛載 ─────────────────────────────────

describe("47 - skiller-import: registry surface", () => {
  test("plugin registry 已掛入 skiller-import 且三要素健全", async () => {
    const ws = createTestWorkspace();
    try {
      const { tool } = await loadPlugin(ws);
      const def = tool("skiller-import");
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.args).toBeDefined();
      expect(typeof def.execute).toBe("function");
    } finally {
      ws.cleanup();
    }
  });

  test("空 args 回傳合法 outer envelope", async () => {
    const ws = createTestWorkspace();
    try {
      const { tool } = await loadPlugin(ws);
      const ctx = createFakeContext(ws.root);
      const raw = await tool("skiller-import").execute({}, ctx as never);
      const parsed = parseToolResult(raw);
      expect(parsed.ok).toBeTypeOf("boolean");
      expect(parsed.summary).toBeTypeOf("string");
      expect(parsed.data).toBeDefined();
      if (parsed.ok === false) {
        expect(parsed.code).toBeTypeOf("string");
        expect(parsed.nextAction).toBeTypeOf("string");
      }
    } finally {
      ws.cleanup();
    }
  });
});
