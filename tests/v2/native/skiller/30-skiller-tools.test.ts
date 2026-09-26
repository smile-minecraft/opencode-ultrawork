/**
 * 30 — Skiller lifecycle tools（scan / validate / draft / promote / retire）
 *
 * 草稿編輯（draft-read / draft-update / draft-delete）與 quarantine 復原
 * （restore）的行為測試在 43-skiller-draft-ops-and-restore.test.ts。
 *
 * 驗收重點：
 *   - 固定 public tool names 掛入 plugin 對外表面（parity 43）。
 *   - 固定 root：project 以 runtime project root 推導；personal 由測試以
 *     direct factory DI 注入暫存 roots，絕不觸碰真實 global/personal roots。
 *   - 安全：name/namespace 驗證、lexical containment、realpath/symlink guard、
 *     atomic write、preview/confirm gate、quarantine-only retire。
 *   - 所有回覆走 {ok, summary, data} envelope；空 args 也必須是合法 envelope。
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
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
  EXPECTED_TOOL_NAMES,
  type TestWorkspace,
} from "./_harness.ts";
import type { SkillerDeps } from "../../../../src/modules/skiller/skiller-common.ts";
import { listSkillFiles } from "../../../../src/modules/skiller/skiller-common.ts";
import { createSkillerScanTool } from "../../../../src/modules/skiller/skiller-scan.ts";
import { createSkillerValidateTool } from "../../../../src/modules/skiller/skiller-validate.ts";
import { createSkillerDraftTool } from "../../../../src/modules/skiller/skiller-draft.ts";
import { createSkillerPromoteTool } from "../../../../src/modules/skiller/skiller-promote.ts";
import { createSkillerRetireTool } from "../../../../src/modules/skiller/skiller-retire.ts";
import { createSkillerRestoreTool } from "../../../../src/modules/skiller/skiller-restore.ts";

// ─── Constants / helpers ─────────────────────────────────────

const SKILLER_TOOLS = [
  "skiller-scan",
  "skiller-validate",
  "skiller-draft",
  "skiller-draft-read",
  "skiller-draft-update",
  "skiller-draft-delete",
  "skiller-promote",
  "skiller-retire",
  "skiller-restore",
] as const;

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex");
}

function validSkillMd(name: string, description = "demo skill for tests"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nUse this skill carefully.\n`;
}

function projectSlugOf(ws: TestWorkspace): string {
  return ws.root.split("/").pop()!.toLowerCase();
}

function projectName(ws: TestWorkspace, capability = "demo"): string {
  return `project-${projectSlugOf(ws)}-${capability}`;
}

/** personal scope 測試用暫存 roots + policy/pins fixture（絕不使用真實路徑）。 */
interface PersonalFixture {
  base: string;
  draftRoot: string;
  skillRoot: string;
  quarantineRoot: string;
  policyPath: string;
  pinsPath: string;
  /** 隔離的 fixture agents 目錄：managed retire/restore 的路由掃描只寫這裡，絕不碰真實 agents/。 */
  agentsRoot: string;
  cleanup(): void;
}

const GOVERNANCE_AGENT_GROUPS: Record<string, string[]> = {
  planning: ["arch"],
  implementation: ["build"],
  review: ["review"],
  documentation: ["writer"],
};

function initialPinsContent(pins: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ schemaVersion: 1, pins }, null, 2)}\n`;
}

function createPersonalFixture(digests: Record<string, string> = {}, pinsRaw?: string): PersonalFixture {
  const base = mkdtempSync(join(tmpdir(), "skiller-personal-"));
  const draftRoot = join(base, "drafts");
  const skillRoot = join(base, "skills");
  const quarantineRoot = join(base, "quarantine");
  const policyPath = join(base, "skills-policy.json");
  const pinsPath = join(base, "skills-personal.json");
  const agentsRoot = join(base, "agents");
  mkdirSync(draftRoot, { recursive: true });
  mkdirSync(skillRoot, { recursive: true });
  mkdirSync(quarantineRoot, { recursive: true });
  mkdirSync(agentsRoot, { recursive: true });
  writeFileSync(policyPath, JSON.stringify({
    schemaVersion: 2,
    skillRoot,
    approval: {
      digestAlgorithm: "sha256",
      agentAllowlist: Object.keys(digests),
      contentDigests: digests,
    },
    personalGovernance: {
      pinsPath,
      personalNamespace: "personal-",
      trustTiers: ["approved", "drifted", "recorded", "managed", "allowlisted", "retired", "unreviewed", "unknown"],
      agentGroups: GOVERNANCE_AGENT_GROUPS,
    },
  }, null, 2), "utf-8");
  writeFileSync(pinsPath, pinsRaw ?? initialPinsContent(), "utf-8");
  return { base, draftRoot, skillRoot, quarantineRoot, policyPath, pinsPath, agentsRoot, cleanup() { rmSync(base, { recursive: true, force: true }); } };
}

/** 在測試 workspace 寫入最小 agent 檔，模擬 group 成員的 personal-* ask 路由。 */
function writeAgentRouteFile(ws: TestWorkspace, agent: string, options?: { withPersonalRoute?: boolean }): void {
  const withRoute = options?.withPersonalRoute ?? true;
  const skillRules = withRoute
    ? `"*": deny\n    project-*: ask\n    personal-*: ask`
    : `"*": deny\n    project-*: ask`;
  const dir = join(ws.root, "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agent}.md`), `---\ndescription: test agent\nmode: subagent\npermission:\n  skill:\n    ${skillRules}\n---\n\nbody\n`, "utf-8");
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
            agentsRoot: fx.agentsRoot,
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

function writeProjectDraft(ws: TestWorkspace, name: string, content: string): void {
  const dir = join(ws.root, ".opencode", "skill-drafts", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
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

// ─── Section 1：public surface parity ────────────────────────

describe("30 - skiller: public surface parity", () => {
  test("EXPECTED_TOOL_NAMES 包含全部 skiller 工具且總數為 11", () => {
    for (const name of SKILLER_TOOLS) {
      expect(EXPECTED_TOOL_NAMES, `缺少 ${name}`).toContain(name);
    }
    expect(EXPECTED_TOOL_NAMES.length).toBe(11);
  });

  test("plugin registry 已掛入全部 skiller 工具且三要素健全", async () => {
    const ws = createTestWorkspace();
    try {
      const { tool } = await loadPlugin(ws);
      for (const name of SKILLER_TOOLS) {
        const def = tool(name);
        expect(typeof def.description, `${name} description`).toBe("string");
        expect(def.description.length, `${name} description length`).toBeGreaterThan(0);
        expect(def.args, `${name} args`).toBeDefined();
        expect(typeof def.execute, `${name} execute`).toBe("function");
      }
    } finally {
      ws.cleanup();
    }
  });

  test("五個工具空 args 都回傳合法 outer envelope", async () => {
    const ws = createTestWorkspace();
    try {
      const { tool } = await loadPlugin(ws);
      const ctx = createFakeContext(ws.root);
      for (const name of SKILLER_TOOLS) {
        const raw = await tool(name).execute({}, ctx as never);
        const parsed = parseToolResult(raw);
        expect(parsed.ok, name).toBeTypeOf("boolean");
        expect(parsed.summary, name).toBeTypeOf("string");
        expect(parsed.data, name).toBeDefined();
        if (parsed.ok === false) {
          expect(parsed.code, name).toBeTypeOf("string");
          expect(parsed.nextAction, name).toBeTypeOf("string");
        }
      }
    } finally {
      ws.cleanup();
    }
  });
});

// ─── Section 2：draft ────────────────────────────────────────

describe("30 - skiller: draft", () => {
  test("未 confirm 不寫入，回 CONFIRM_REQUIRED 與 preview", async () => {
    const ws = createTestWorkspace();
    try {
      const name = projectName(ws);
      const r = await execFactory(createSkillerDraftTool, makeDeps(ws), {
        scope: "project",
        name,
        content: validSkillMd(name),
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("CONFIRM_REQUIRED");
      expect(existsSync(join(ws.root, ".opencode", "skill-drafts"))).toBe(false);
      const preview = (r.data as { preview?: { path?: string } }).preview;
      expect(preview?.path).toBeDefined();
    } finally {
      ws.cleanup();
    }
  });

  test("confirm 後 atomic 寫入 fixed draft root 並回傳 SHA-256", async () => {
    const ws = createTestWorkspace();
    try {
      const name = projectName(ws);
      const content = validSkillMd(name);
      const r = await execFactory(createSkillerDraftTool, makeDeps(ws), {
        scope: "project",
        name,
        content,
        confirm: true,
      });
      expect(r.ok).toBe(true);
      const target = join(ws.root, ".opencode", "skill-drafts", name, "SKILL.md");
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf-8")).toBe(content);
      expect((r.data as { digest?: string }).digest).toBe(sha256(content));
    } finally {
      ws.cleanup();
    }
  });

  test("已存在時拒絕覆蓋；overwrite + confirm 才可更新", async () => {
    const ws = createTestWorkspace();
    try {
      const name = projectName(ws);
      writeProjectDraft(ws, name, validSkillMd(name, "v1"));
      const deps = makeDeps(ws);
      const r1 = await execFactory(createSkillerDraftTool, deps, {
        scope: "project",
        name,
        content: validSkillMd(name, "v2"),
        confirm: true,
      });
      expect(r1.ok).toBe(false);
      expect(r1.code).toBe("ALREADY_EXISTS");

      const r2 = await execFactory(createSkillerDraftTool, deps, {
        scope: "project",
        name,
        content: validSkillMd(name, "v2"),
        confirm: true,
        overwrite: true,
      });
      expect(r2.ok).toBe(true);
      const target = join(ws.root, ".opencode", "skill-drafts", name, "SKILL.md");
      expect(readFileSync(target, "utf-8")).toContain("v2");
    } finally {
      ws.cleanup();
    }
  });

  test("非法 name（traversal / slash / absolute / 大寫 / 過長）一律拒絕且不寫入", async () => {
    const ws = createTestWorkspace();
    try {
      const deps = makeDeps(ws);
      const badNames = ["../escape", "foo/bar", "/abs/name", "Bad-Name", `${"a".repeat(65)}`, ".."];
      for (const bad of badNames) {
        const r = await execFactory(createSkillerDraftTool, deps, {
          scope: "project",
          name: bad,
          content: validSkillMd("x"),
          confirm: true,
        });
        expect(r.ok, `name=${bad}`).toBe(false);
        expect(r.code, `name=${bad}`).toBe("INVALID_NAME");
      }
      // harness 會預建 .opencode/memory，因此只驗證 draft root 未被建立。
      expect(existsSync(join(ws.root, ".opencode", "skill-drafts"))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("namespace 不符（project 名稱格式錯誤）拒絕", async () => {
    const ws = createTestWorkspace();
    try {
      const deps = makeDeps(ws);
      const r1 = await execFactory(createSkillerDraftTool, deps, {
        scope: "project",
        name: "project-wrongslug-demo",
        content: validSkillMd("x"),
        confirm: true,
      });
      expect(r1.ok).toBe(false);
      expect(r1.code).toBe("INVALID_NAMESPACE");

      const r2 = await execFactory(createSkillerDraftTool, deps, {
        scope: "project",
        name: "totally-unrelated-name",
        content: validSkillMd("x"),
        confirm: true,
      });
      expect(r2.ok).toBe(false);
      expect(r2.code).toBe("INVALID_NAMESPACE");
    } finally {
      ws.cleanup();
    }
  });

  test("draft root 是 symlink 時拒絕（root symlink escape）", async () => {
    const ws = createTestWorkspace();
    try {
      const outside = mkdtempSync(join(tmpdir(), "skiller-outside-"));
      fixtures.push({ cleanup: () => rmSync(outside, { recursive: true, force: true }) });
      const draftsDir = join(ws.root, ".opencode", "skill-drafts");
      mkdirSync(join(ws.root, ".opencode"), { recursive: true });
      symlinkSync(outside, draftsDir, "dir");

      const name = projectName(ws);
      const r = await execFactory(createSkillerDraftTool, makeDeps(ws), {
        scope: "project",
        name,
        content: validSkillMd(name),
        confirm: true,
      });
      expect(r.ok).toBe(false);
      expect(["SYMLINK_REJECTED", "ROOT_ESCAPE"]).toContain(r.code);
      expect(existsSync(join(outside, name))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });
});

// ─── Section 3：promote ──────────────────────────────────────

describe("30 - skiller: promote", () => {
  test("專案 skiller.lock 被占用 → busy 且不寫入；釋放後可完成", async () => {
    const ws = createTestWorkspace();
    try {
      const name = projectName(ws);
      writeProjectDraft(ws, name, validSkillMd(name));
      const lockDir = join(ws.root, ".ultrawork", "cache", "locks");
      mkdirSync(lockDir, { recursive: true });
      const lockPath = join(lockDir, "skiller.lock");
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: "held" }), "utf-8");
      const args = { scope: "project", name, mode: "apply", confirm: true };
      const deps = makeDeps(ws);
      const busy = await execFactory(createSkillerPromoteTool, deps, args);
      expect(busy.ok).toBe(false);
      expect(busy.code).toBe("CONTENT_LOCK_BUSY");
      expect(existsSync(join(ws.root, ".opencode", "skills", name))).toBe(false);
      unlinkSync(lockPath);
      const released = await execFactory(createSkillerPromoteTool, deps, args);
      expect(released.ok).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  test("promote 驗證後等待鎖期間 draft 附屬檔案變成 risky → 鎖內重驗拒絕", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "personal-domain-race";
      const fx = createPersonalFixture();
      fixtures.push(fx);
      const draftDir = join(fx.draftRoot, name);
      mkdirSync(draftDir, { recursive: true });
      writeFileSync(join(draftDir, "SKILL.md"), validSkillMd(name), "utf-8");
      const notes = join(draftDir, "notes.md");
      writeFileSync(notes, "# safe\n", "utf-8");
      writeAgentRouteFile(ws, "build");
      let resolveProjectCalls = 0;
      const deps = makeDeps(ws, fx);
      const racingDeps: SkillerDeps = {
        ...deps,
        resolveProjectRoot: () => {
          resolveProjectCalls += 1;
          if (resolveProjectCalls === 2) {
            writeFileSync(notes, "# changed\n\nsecret ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456\n", "utf-8");
          }
          return ws.root;
        },
      };
      const result = await execFactory(createSkillerPromoteTool, racingDeps, {
        scope: "personal", name, mode: "apply", confirm: true, targetAgentGroups: ["implementation"],
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("PROMOTION_BLOCKED");
      expect(existsSync(join(fx.skillRoot, name))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("預設 preview 不寫入任何檔案", async () => {
    const ws = createTestWorkspace();
    try {
      const name = projectName(ws);
      writeProjectDraft(ws, name, validSkillMd(name));
      const r = await execFactory(createSkillerPromoteTool, makeDeps(ws), {
        scope: "project",
        name,
      });
      expect(r.ok).toBe(true);
      expect((r.data as { mode?: string }).mode).toBe("preview");
      expect(existsSync(join(ws.root, ".opencode", "skills"))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("apply 未 confirm 拒絕且不寫入", async () => {
    const ws = createTestWorkspace();
    try {
      const name = projectName(ws);
      writeProjectDraft(ws, name, validSkillMd(name));
      const r = await execFactory(createSkillerPromoteTool, makeDeps(ws), {
        scope: "project",
        name,
        mode: "apply",
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("CONFIRM_REQUIRED");
      expect(existsSync(join(ws.root, ".opencode", "skills"))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("project apply 只寫入 project .opencode/skills 並回傳 digest", async () => {
    const ws = createTestWorkspace();
    try {
      const name = projectName(ws);
      const content = validSkillMd(name);
      writeProjectDraft(ws, name, content);
      const r = await execFactory(createSkillerPromoteTool, makeDeps(ws), {
        scope: "project",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(r.ok).toBe(true);
      const target = join(ws.root, ".opencode", "skills", name, "SKILL.md");
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf-8")).toBe(content);
      expect((r.data as { digest?: string }).digest).toBe(sha256(content));
    } finally {
      ws.cleanup();
    }
  });

  test("personal apply 缺 targetAgentGroups 或 confirm 一律拒絕", async () => {
    const ws = createTestWorkspace();
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      const name = "personal-domain-capability";
      writeInstalledSkill(fx.draftRoot, name, validSkillMd(name));
      const deps = makeDeps(ws, fx);

      const r1 = await execFactory(createSkillerPromoteTool, deps, {
        scope: "personal",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(r1.ok).toBe(false);
      expect(r1.code).toBe("TARGET_GROUPS_REQUIRED");

      const r2 = await execFactory(createSkillerPromoteTool, deps, {
        scope: "personal",
        name,
        mode: "apply",
        targetAgentGroups: ["implementation"],
      });
      expect(r2.ok).toBe(false);
      expect(r2.code).toBe("CONFIRM_REQUIRED");

      expect(existsSync(join(fx.skillRoot, name))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("personal apply 成功寫入 canonical root、pins metadata，且 skills-policy.json 保持未修改", async () => {
    const ws = createTestWorkspace();
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      writeAgentRouteFile(ws, "build");
      writeAgentRouteFile(ws, "review");
      const name = "personal-domain-capability";
      const content = validSkillMd(name);
      writeInstalledSkill(fx.draftRoot, name, content);
      const policyBefore = readFileSync(fx.policyPath, "utf-8");
      const pinsBefore = readFileSync(fx.pinsPath, "utf-8");

      const writtenPaths: string[] = [];
      const deps: SkillerDeps = {
        ...makeDeps(ws, fx),
        writeFile: (path: string, content: string) => {
          writtenPaths.push(path);
          writeFileSync(path, content, "utf-8");
        },
      };
      const r = await execFactory(createSkillerPromoteTool, deps, {
        scope: "personal",
        name,
        mode: "apply",
        confirm: true,
        targetAgentGroups: ["implementation", "review"],
      });
      expect(r.ok).toBe(true);
      const data = r.data as { digest?: string; targetAgentGroups?: string[]; resolvedTargetAgents?: string[] };
      expect(data.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(data.digest).toBe(sha256(content));
      expect(data.targetAgentGroups).toEqual(["implementation", "review"]);
      expect(data.resolvedTargetAgents).toEqual(["build", "review"]);
      expect(readFileSync(join(fx.skillRoot, name, "SKILL.md"), "utf-8")).toBe(content);

      // pins registry：digest / groups / resolved agents / active status
      const pins = JSON.parse(readFileSync(fx.pinsPath, "utf-8")) as {
        schemaVersion: number;
        pins: Record<string, { name: string; digest: string; targetAgentGroups: string[]; resolvedTargetAgents: string[]; status: string; promotedAt: string }>;
      };
      expect(pins.schemaVersion).toBe(1);
      const pin = pins.pins[name];
      expect(pin).toBeDefined();
      expect(pin.name).toBe(name);
      expect(pin.digest).toBe(sha256(content));
      expect(pin.targetAgentGroups).toEqual(["implementation", "review"]);
      expect(pin.resolvedTargetAgents).toEqual(["build", "review"]);
      expect(pin.status).toBe("active");
      expect(pin.promotedAt.trim().length).toBeGreaterThan(0);

      // skills-policy.json 唯讀：內容不變，且從未成為寫入目標
      expect(readFileSync(fx.policyPath, "utf-8")).toBe(policyBefore);
      expect(writtenPaths.some((p) => p === fx.policyPath)).toBe(false);
      expect(pinsBefore !== readFileSync(fx.pinsPath, "utf-8")).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  test("personal preview 不建立或修改 pins registry", async () => {
    const ws = createTestWorkspace();
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      const name = "personal-domain-capability";
      writeInstalledSkill(fx.draftRoot, name, validSkillMd(name));
      const pinsBefore = readFileSync(fx.pinsPath, "utf-8");
      const r = await execFactory(createSkillerPromoteTool, makeDeps(ws, fx), {
        scope: "personal",
        name,
        targetAgentGroups: ["implementation"],
      });
      expect(r.ok).toBe(true);
      expect((r.data as { mode?: string }).mode).toBe("preview");
      expect(existsSync(join(fx.skillRoot, name))).toBe(false);
      expect(readFileSync(fx.pinsPath, "utf-8")).toBe(pinsBefore);
    } finally {
      ws.cleanup();
    }
  });

  test("personal apply 對未知語意 group 與缺少 personal-* 路由的成員 fail closed", async () => {
    const ws = createTestWorkspace();
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      const name = "personal-domain-capability";
      writeInstalledSkill(fx.draftRoot, name, validSkillMd(name));

      // 未知 group
      const r1 = await execFactory(createSkillerPromoteTool, makeDeps(ws, fx), {
        scope: "personal",
        name,
        mode: "apply",
        confirm: true,
        targetAgentGroups: ["not-a-group"],
      });
      expect(r1.ok).toBe(false);
      expect(r1.code).toBe("UNKNOWN_AGENT_GROUP");
      expect(existsSync(join(fx.skillRoot, name))).toBe(false);

      // group 成員缺 personal-* ask 路由
      writeAgentRouteFile(ws, "build", { withPersonalRoute: false });
      const r2 = await execFactory(createSkillerPromoteTool, makeDeps(ws, fx), {
        scope: "personal",
        name,
        mode: "apply",
        confirm: true,
        targetAgentGroups: ["implementation"],
      });
      expect(r2.ok).toBe(false);
      expect(r2.code).toBe("GROUP_ROUTE_INVALID");
      expect(existsSync(join(fx.skillRoot, name))).toBe(false);
      expect(JSON.parse(readFileSync(fx.pinsPath, "utf-8")) as { schemaVersion: number; pins: Record<string, unknown> }).toEqual({ schemaVersion: 1, pins: {} });
    } finally {
      ws.cleanup();
    }
  });

  test("同名 overwrite promotion 更新單一 pin entry 且維持 registry consistency", async () => {
    const ws = createTestWorkspace();
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      writeAgentRouteFile(ws, "build");
      const name = "personal-domain-capability";
      const deps = makeDeps(ws, fx);
      const args = { scope: "personal", name, mode: "apply", confirm: true, targetAgentGroups: ["implementation"] };

      writeInstalledSkill(fx.draftRoot, name, validSkillMd(name, "v1"));
      const r1 = await execFactory(createSkillerPromoteTool, deps, args);
      expect(r1.ok).toBe(true);

      writeInstalledSkill(fx.draftRoot, name, validSkillMd(name, "v2"));
      const r2 = await execFactory(createSkillerPromoteTool, deps, { ...args, overwrite: true });
      expect(r2.ok).toBe(true);

      const pins = JSON.parse(readFileSync(fx.pinsPath, "utf-8")) as {
        pins: Record<string, { digest: string; status: string }>;
      };
      expect(Object.keys(pins.pins)).toEqual([name]);
      expect(pins.pins[name].digest).toBe(sha256(validSkillMd(name, "v2")));
      expect(pins.pins[name].status).toBe("active");
      expect(readFileSync(join(fx.skillRoot, name, "SKILL.md"), "utf-8")).toBe(validSkillMd(name, "v2"));
    } finally {
      ws.cleanup();
    }
  });

  test("pins registry missing / malformed / unknown schema 時 personal apply fail closed 且不寫入 skill", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "personal-domain-capability";
      const cases: Array<[string, PersonalFixture]> = [
        ["missing", createPersonalFixture({}, undefined)],
        ["malformed", createPersonalFixture({}, "{ not json")],
        ["schema", createPersonalFixture({}, JSON.stringify({ schemaVersion: 99, pins: {} }))],
      ];
      fixtures.push(...cases.map(([, fx]) => fx));
      for (const [label, fx] of cases) {
        // missing：先移除 pins 檔模擬缺席
        if (label === "missing") rmSync(fx.pinsPath);
        writeInstalledSkill(fx.draftRoot, name, validSkillMd(name));
        writeAgentRouteFile(ws, "build");
        const r = await execFactory(createSkillerPromoteTool, makeDeps(ws, fx), {
          scope: "personal",
          name,
          mode: "apply",
          confirm: true,
          targetAgentGroups: ["implementation"],
        });
        expect(r.ok, label).toBe(false);
        expect(["REGISTRY_UNAVAILABLE", "REGISTRY_MALFORMED", "REGISTRY_SCHEMA_UNSUPPORTED"], label).toContain(r.code);
        expect(existsSync(join(fx.skillRoot, name)), label).toBe(false);
      }
    } finally {
      ws.cleanup();
    }
  });

  test("bundle swap 成功但 pins 寫入失敗時回滾：不留未記錄的 active personal skill", async () => {
    const ws = createTestWorkspace();
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      writeAgentRouteFile(ws, "build");
      const name = "personal-domain-capability";
      writeInstalledSkill(fx.draftRoot, name, validSkillMd(name, "v1"));
      const pinsBefore = readFileSync(fx.pinsPath, "utf-8");

      const failingDeps: SkillerDeps = {
        ...makeDeps(ws, fx),
        writeFile: (path: string, content: string) => {
          if (path.includes("skills-personal.json")) throw new Error("E_TEST_PINS_WRITE_FAILED");
          writeFileSync(path, content, "utf-8");
        },
      };
      const r = await execFactory(createSkillerPromoteTool, failingDeps, {
        scope: "personal",
        name,
        mode: "apply",
        confirm: true,
        targetAgentGroups: ["implementation"],
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("REGISTRY_WRITE_FAILED");

      // discovery root 沒有未記錄的 active skill；pins 維持原狀；無 staging/backup 殘留
      expect(existsSync(join(fx.skillRoot, name))).toBe(false);
      expect(readFileSync(fx.pinsPath, "utf-8")).toBe(pinsBefore);
      expect(readdirSync(fx.skillRoot)).toEqual([]);
    } finally {
      ws.cleanup();
    }
  });

  test("project promotion 不寫入 personal pins registry", async () => {
    const ws = createTestWorkspace();
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      const name = projectName(ws);
      const content = validSkillMd(name);
      writeProjectDraft(ws, name, content);
      const pinsBefore = readFileSync(fx.pinsPath, "utf-8");
      const r = await execFactory(createSkillerPromoteTool, makeDeps(ws, fx), {
        scope: "project",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(r.ok).toBe(true);
      expect(readFileSync(fx.pinsPath, "utf-8")).toBe(pinsBefore);
    } finally {
      ws.cleanup();
    }
  });

  test("personal apply 對 scripts inventory fail closed", async () => {
    const ws = createTestWorkspace();
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      const name = "personal-domain-risky";
      writeInstalledSkill(fx.draftRoot, name, validSkillMd(name));
      mkdirSync(join(fx.draftRoot, name, "scripts"), { recursive: true });
      writeFileSync(join(fx.draftRoot, name, "scripts", "run.sh"), "#!/bin/sh\necho hi\n", "utf-8");
      const r = await execFactory(createSkillerPromoteTool, makeDeps(ws, fx), {
        scope: "personal",
        name,
        mode: "apply",
        confirm: true,
        targetAgentGroups: ["implementation"],
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("PROMOTION_BLOCKED");
      const blockers = (r.data as { blockers?: Array<{ code: string }> }).blockers ?? [];
      expect(blockers.some((b) => b.code === "SCRIPTS_PRESENT")).toBe(true);
      expect(existsSync(join(fx.skillRoot, name))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("personal apply 對 high-risk / secret / workflow ID marker fail closed", async () => {
    const ws = createTestWorkspace();
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      const deps = makeDeps(ws, fx);
      const cases: Array<[string, string, string]> = [
        ["personal-domain-hr", validSkillMd("x") + "\nRun rm -rf /tmp/legacy to clean up.\n", "HIGH_RISK_MARKER"],
        ["personal-domain-secret", validSkillMd("x") + "\naws key AKIAIOSFODNN7EXAMPLE\n", "SECRET_MARKER"],
        ["personal-domain-wf", validSkillMd("x") + "\nSee task-20260819-skiller-plugin-tools for context.\n", "WORKFLOW_ID_MARKER"],
      ];
      for (const [name, content, expectedCode] of cases) {
        writeInstalledSkill(fx.draftRoot, name, content);
        const r = await execFactory(createSkillerPromoteTool, deps, {
          scope: "personal",
          name,
          mode: "apply",
          confirm: true,
          targetAgentGroups: ["implementation"],
        });
        expect(r.ok, name).toBe(false);
        expect(r.code, name).toBe("PROMOTION_BLOCKED");
        const blockers = (r.data as { blockers?: Array<{ code: string }> }).blockers ?? [];
        expect(blockers.some((b) => b.code === expectedCode), `${name}: ${expectedCode}`).toBe(true);
        expect(existsSync(join(fx.skillRoot, name)), name).toBe(false);
      }
    } finally {
      ws.cleanup();
    }
  });

  test("personal apply 對 frontmatter name mismatch 與 policy digest drift fail closed", async () => {
    const ws = createTestWorkspace();
    const driftedName = "personal-domain-drifted";
    const fx = createPersonalFixture({ [driftedName]: sha256("stale-content") });
    fixtures.push(fx);
    try {
      const deps = makeDeps(ws, fx);

      // frontmatter name 與目錄不一致
      writeInstalledSkill(fx.draftRoot, "personal-domain-mismatch", validSkillMd("other-name"));
      const r1 = await execFactory(createSkillerPromoteTool, deps, {
        scope: "personal",
        name: "personal-domain-mismatch",
        mode: "apply",
        confirm: true,
        targetAgentGroups: ["implementation"],
      });
      expect(r1.ok).toBe(false);
      expect(r1.code).toBe("PROMOTION_BLOCKED");
      expect(((r1.data as { blockers?: Array<{ code: string }> }).blockers ?? [])
        .some((b) => b.code === "NAME_MISMATCH")).toBe(true);

      // policy digest drift
      writeInstalledSkill(fx.draftRoot, driftedName, validSkillMd(driftedName));
      const r2 = await execFactory(createSkillerPromoteTool, deps, {
        scope: "personal",
        name: driftedName,
        mode: "apply",
        confirm: true,
        targetAgentGroups: ["implementation"],
      });
      expect(r2.ok).toBe(false);
      expect(r2.code).toBe("PROMOTION_BLOCKED");
      expect(((r2.data as { blockers?: Array<{ code: string }> }).blockers ?? [])
        .some((b) => b.code === "POLICY_DIGEST_DRIFT")).toBe(true);

      expect(existsSync(join(fx.skillRoot, "personal-domain-mismatch"))).toBe(false);
      expect(existsSync(join(fx.skillRoot, driftedName))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("promote 找不到 draft 回 NOT_FOUND", async () => {
    const ws = createTestWorkspace();
    try {
      const r = await execFactory(createSkillerPromoteTool, makeDeps(ws), {
        scope: "project",
        name: projectName(ws),
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("NOT_FOUND");
    } finally {
      ws.cleanup();
    }
  });
});

// ─── Section 4：retire ───────────────────────────────────────

describe("30 - skiller: retire", () => {
  test("預設 preview 不移動任何目錄", async () => {
    const ws = createTestWorkspace();
    try {
      const name = projectName(ws);
      writeInstalledSkill(join(ws.root, ".opencode", "skills"), name, validSkillMd(name));
      const r = await execFactory(createSkillerRetireTool, makeDeps(ws), {
        scope: "project",
        name,
      });
      expect(r.ok).toBe(true);
      expect((r.data as { mode?: string }).mode).toBe("preview");
      expect(existsSync(join(ws.root, ".opencode", "skills", name))).toBe(true);
      expect(existsSync(join(ws.root, ".opencode", "skill-quarantine"))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("apply 未 confirm 拒絕", async () => {
    const ws = createTestWorkspace();
    try {
      const name = projectName(ws);
      writeInstalledSkill(join(ws.root, ".opencode", "skills"), name, validSkillMd(name));
      const r = await execFactory(createSkillerRetireTool, makeDeps(ws), {
        scope: "project",
        name,
        mode: "apply",
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("CONFIRM_REQUIRED");
      expect(existsSync(join(ws.root, ".opencode", "skills", name))).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  test("apply 只 quarantine：原位置消失、內容保留、回傳 metadata", async () => {
    const ws = createTestWorkspace();
    try {
      const name = projectName(ws);
      const content = validSkillMd(name);
      writeInstalledSkill(join(ws.root, ".opencode", "skills"), name, content);
      const r = await execFactory(createSkillerRetireTool, makeDeps(ws), {
        scope: "project",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(r.ok).toBe(true);
      expect(existsSync(join(ws.root, ".opencode", "skills", name))).toBe(false);
      const quarantined = join(ws.root, ".opencode", "skill-quarantine", name, "SKILL.md");
      expect(existsSync(quarantined)).toBe(true);
      expect(readFileSync(quarantined, "utf-8")).toBe(content);
      const data = r.data as { digest?: string; movedTo?: string };
      expect(data.digest).toBe(sha256(content));
      expect(data.movedTo).toContain("skill-quarantine");
    } finally {
      ws.cleanup();
    }
  });

  test("既有 quarantine 同名時拒絕且不移動", async () => {
    const ws = createTestWorkspace();
    try {
      const name = projectName(ws);
      const skillsRoot = join(ws.root, ".opencode", "skills");
      const quarantineRoot = join(ws.root, ".opencode", "skill-quarantine");
      writeInstalledSkill(skillsRoot, name, validSkillMd(name));
      writeInstalledSkill(quarantineRoot, name, validSkillMd(name, "old"));
      const r = await execFactory(createSkillerRetireTool, makeDeps(ws), {
        scope: "project",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("QUARANTINE_EXISTS");
      expect(existsSync(join(skillsRoot, name))).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  test("symlink source 拒絕 retire", async () => {
    const ws = createTestWorkspace();
    try {
      const name = projectName(ws);
      const outside = mkdtempSync(join(tmpdir(), "skiller-outside-"));
      fixtures.push({ cleanup: () => rmSync(outside, { recursive: true, force: true }) });
      const skillsRoot = join(ws.root, ".opencode", "skills");
      writeInstalledSkill(skillsRoot, "placeholder", validSkillMd("placeholder"));
      symlinkSync(outside, join(skillsRoot, name), "dir");
      const r = await execFactory(createSkillerRetireTool, makeDeps(ws), {
        scope: "project",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("SYMLINK_REJECTED");
      expect(existsSync(join(skillsRoot, name))).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  test("SKILL.md symlink fail closed：preview/apply 都不讀取外部 metadata 或建立 quarantine", async () => {
    for (const mode of ["preview", "apply"] as const) {
      const ws = createTestWorkspace();
      try {
        const name = projectName(ws);
        const outside = mkdtempSync(join(tmpdir(), "skiller-retire-skill-md-"));
        fixtures.push({ cleanup: () => rmSync(outside, { recursive: true, force: true }) });
        const externalContent = validSkillMd(name, "external retire metadata");
        const externalSkillMd = join(outside, "external-SKILL.md");
        writeFileSync(externalSkillMd, externalContent, "utf-8");

        const sourceDir = join(ws.root, ".opencode", "skills", name);
        writeInstalledSkill(join(ws.root, ".opencode", "skills"), name, validSkillMd(name));
        rmSync(join(sourceDir, "SKILL.md"));
        symlinkSync(externalSkillMd, join(sourceDir, "SKILL.md"), "file");

        const r = await execFactory(createSkillerRetireTool, makeDeps(ws), {
          scope: "project",
          name,
          mode,
          ...(mode === "apply" ? { confirm: true } : {}),
        });
        expect(r.ok).toBe(false);
        expect(["SYMLINK_REJECTED", "ROOT_ESCAPE"]).toContain(r.code);
        const payload = JSON.stringify(r);
        expect(payload).not.toContain(externalContent);
        expect(payload).not.toContain(sha256(externalContent));
        expect(payload).not.toContain(externalSkillMd);
        expect(existsSync(sourceDir)).toBe(true);
        expect(existsSync(join(ws.root, ".opencode", "skill-quarantine"))).toBe(false);
      } finally {
        ws.cleanup();
      }
    }
  });

  test("SKILL.md dangling symlink 或缺失時 fail closed 且不移動 source", async () => {
    for (const kind of ["dangling", "missing"] as const) {
      const ws = createTestWorkspace();
      try {
        const name = projectName(ws);
        const sourceDir = join(ws.root, ".opencode", "skills", name);
        mkdirSync(sourceDir, { recursive: true });
        if (kind === "dangling") {
          symlinkSync(join(sourceDir, "not-present.md"), join(sourceDir, "SKILL.md"), "file");
        }

        const r = await execFactory(createSkillerRetireTool, makeDeps(ws), {
          scope: "project",
          name,
          mode: "apply",
          confirm: true,
        });
        expect(r.ok).toBe(false);
        expect(["SYMLINK_REJECTED", "SKILL_READ_FAILED"]).toContain(r.code);
        expect(JSON.stringify(r)).not.toContain("sourcePath");
        expect(existsSync(sourceDir)).toBe(true);
        expect(existsSync(join(ws.root, ".opencode", "skill-quarantine"))).toBe(false);
      } finally {
        ws.cleanup();
      }
    }
  });

  test("找不到已安裝 skill 回 NOT_FOUND", async () => {
    const ws = createTestWorkspace();
    try {
      const r = await execFactory(createSkillerRetireTool, makeDeps(ws), {
        scope: "project",
        name: projectName(ws),
        mode: "apply",
        confirm: true,
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("NOT_FOUND");
    } finally {
      ws.cleanup();
    }
  });
});

// ─── Section 4b：personal retire 與 pins 同步 ────────────────

describe("30 - skiller: personal retire pins sync", () => {
  function seedActivePin(name: string, digest: string): string {
    return initialPinsContent({
      [name]: {
        name,
        digest,
        targetAgentGroups: ["implementation"],
        resolvedTargetAgents: ["build"],
        status: "active",
        promotedAt: "2026-08-19T00:00:00.000Z",
      },
    });
  }

  test("personal retire apply 先 quarantine，再將 pin 標記 retired；discovery root 無該 skill", async () => {
    const ws = createTestWorkspace();
    const name = "personal-domain-capability";
    const content = validSkillMd(name);
    const fx = createPersonalFixture({}, seedActivePin(name, sha256(content)));
    fixtures.push(fx);
    try {
      writeInstalledSkill(fx.skillRoot, name, content);
      const r = await execFactory(createSkillerRetireTool, makeDeps(ws, fx), {
        scope: "personal",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(r.ok).toBe(true);
      expect(existsSync(join(fx.skillRoot, name))).toBe(false);
      expect(existsSync(join(fx.quarantineRoot, name, "SKILL.md"))).toBe(true);

      const pins = JSON.parse(readFileSync(fx.pinsPath, "utf-8")) as {
        pins: Record<string, { status: string; retiredAt?: string }>;
      };
      expect(pins.pins[name].status).toBe("retired");
      expect((pins.pins[name].retiredAt ?? "").trim().length).toBeGreaterThan(0);
    } finally {
      ws.cleanup();
    }
  });

  test("personal retire preview 不移動 skill 也不修改 pins", async () => {
    const ws = createTestWorkspace();
    const name = "personal-domain-capability";
    const content = validSkillMd(name);
    const fx = createPersonalFixture({}, seedActivePin(name, sha256(content)));
    fixtures.push(fx);
    try {
      writeInstalledSkill(fx.skillRoot, name, content);
      const pinsBefore = readFileSync(fx.pinsPath, "utf-8");
      const r = await execFactory(createSkillerRetireTool, makeDeps(ws, fx), {
        scope: "personal",
        name,
      });
      expect(r.ok).toBe(true);
      expect((r.data as { mode?: string }).mode).toBe("preview");
      expect(existsSync(join(fx.skillRoot, name))).toBe(true);
      expect(readFileSync(fx.pinsPath, "utf-8")).toBe(pinsBefore);
    } finally {
      ws.cleanup();
    }
  });

  test("personal retire 對缺少 pin 或非 active pin fail closed", async () => {
    const ws = createTestWorkspace();
    const name = "personal-domain-capability";
    const content = validSkillMd(name);
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      // 無 pin 紀錄
      writeInstalledSkill(fx.skillRoot, name, content);
      const r1 = await execFactory(createSkillerRetireTool, makeDeps(ws, fx), {
        scope: "personal",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(r1.ok).toBe(false);
      expect(r1.code).toBe("PIN_NOT_FOUND");
      expect(existsSync(join(fx.skillRoot, name))).toBe(true);

      // pin 已是 retired（status drift）
      const retiredName = "personal-domain-already-retired";
      const retiredContent = validSkillMd(retiredName);
      const fx2 = createPersonalFixture({}, initialPinsContent({
        [retiredName]: {
          name: retiredName,
          digest: sha256(retiredContent),
          targetAgentGroups: ["implementation"],
          resolvedTargetAgents: ["build"],
          status: "retired",
          promotedAt: "2026-08-19T00:00:00.000Z",
          retiredAt: "2026-08-19T01:00:00.000Z",
        },
      }));
      fixtures.push(fx2);
      writeInstalledSkill(fx2.skillRoot, retiredName, retiredContent);
      const r2 = await execFactory(createSkillerRetireTool, makeDeps(ws, fx2), {
        scope: "personal",
        name: retiredName,
        mode: "apply",
        confirm: true,
      });
      expect(r2.ok).toBe(false);
      expect(r2.code).toBe("PIN_STATUS_DRIFT");
      expect(existsSync(join(fx2.skillRoot, retiredName))).toBe(true);
      expect(existsSync(join(fx2.quarantineRoot, retiredName))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("quarantine 成功但 pins 寫入失敗時回滾：skill 移回 discovery root，pins 不變", async () => {
    const ws = createTestWorkspace();
    const name = "personal-domain-capability";
    const content = validSkillMd(name);
    const fx = createPersonalFixture({}, seedActivePin(name, sha256(content)));
    fixtures.push(fx);
    try {
      writeInstalledSkill(fx.skillRoot, name, content);
      const pinsBefore = readFileSync(fx.pinsPath, "utf-8");
      const failingDeps: SkillerDeps = {
        ...makeDeps(ws, fx),
        writeFile: (path: string) => {
          if (path.includes("skills-personal.json")) throw new Error("E_TEST_PINS_WRITE_FAILED");
        },
      };
      const r = await execFactory(createSkillerRetireTool, failingDeps, {
        scope: "personal",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("REGISTRY_WRITE_FAILED");
      expect(existsSync(join(fx.skillRoot, name, "SKILL.md"))).toBe(true);
      expect(existsSync(join(fx.quarantineRoot, name))).toBe(false);
      expect(readFileSync(fx.pinsPath, "utf-8")).toBe(pinsBefore);
    } finally {
      ws.cleanup();
    }
  });

  test("project retire 不寫入 personal pins registry", async () => {
    const ws = createTestWorkspace();
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      const name = projectName(ws);
      writeInstalledSkill(join(ws.root, ".opencode", "skills"), name, validSkillMd(name));
      const pinsBefore = readFileSync(fx.pinsPath, "utf-8");
      const r = await execFactory(createSkillerRetireTool, makeDeps(ws, fx), {
        scope: "project",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(r.ok).toBe(true);
      expect(readFileSync(fx.pinsPath, "utf-8")).toBe(pinsBefore);
    } finally {
      ws.cleanup();
    }
  });
});

// ─── Section 5：scan / validate ──────────────────────────────

describe("30 - skiller: scan & validate", () => {
  test("scan 列出 project draft 與 skill entries 含 digest/trust tier/namespace", async () => {
    const ws = createTestWorkspace();
    try {
      const name = projectName(ws);
      const content = validSkillMd(name);
      writeProjectDraft(ws, name, content);
      writeInstalledSkill(join(ws.root, ".opencode", "skills"), name, content);
      const r = await execFactory(createSkillerScanTool, makeDeps(ws), { scope: "project" });
      expect(r.ok).toBe(true);
      const entries = (r.data as { entries?: Array<Record<string, unknown>> }).entries ?? [];
      const drafts = entries.filter((e) => e.sourceKind === "draft");
      const skills = entries.filter((e) => e.sourceKind === "skill");
      expect(drafts.length).toBe(1);
      expect(skills.length).toBe(1);
      for (const entry of [...drafts, ...skills]) {
        expect(entry.name).toBe(name);
        expect(entry.parseOk).toBe(true);
        expect(entry.namespaceValid).toBe(true);
        expect(entry.digest).toBe(sha256(content));
        expect(typeof entry.trustTier).toBe("string");
      }
    } finally {
      ws.cleanup();
    }
  });

  test("scan personal scope 使用注入的 fixture roots 且 trust tier 來自 policy", async () => {
    const ws = createTestWorkspace();
    const approvedName = "personal-domain-approved";
    const content = validSkillMd(approvedName);
    const fx = createPersonalFixture({ [approvedName]: sha256(content) });
    fixtures.push(fx);
    try {
      writeInstalledSkill(fx.skillRoot, approvedName, content);
      const r = await execFactory(createSkillerScanTool, makeDeps(ws, fx), { scope: "personal" });
      expect(r.ok).toBe(true);
      const entries = (r.data as { entries?: Array<Record<string, unknown>> }).entries ?? [];
      const skillEntry = entries.find((e) => e.sourceKind === "skill" && e.name === approvedName);
      expect(skillEntry).toBeDefined();
      expect(skillEntry?.trustTier).toBe("approved");
    } finally {
      ws.cleanup();
    }
  });

  test("validate ready skill 無 blocker；含 secret 時 readiness blocked", async () => {
    const ws = createTestWorkspace();
    try {
      const deps = makeDeps(ws);
      const good = projectName(ws);
      writeProjectDraft(ws, good, validSkillMd(good));
      const r1 = await execFactory(createSkillerValidateTool, deps, { scope: "project", name: good });
      expect(r1.ok).toBe(true);
      expect((r1.data as { readiness?: string }).readiness).toBe("ready");

      const bad = projectName(ws, "bad");
      writeProjectDraft(ws, bad, validSkillMd(bad) + "\ntoken ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456\n");
      const r2 = await execFactory(createSkillerValidateTool, deps, { scope: "project", name: bad });
      expect(r2.ok).toBe(true);
      const data = r2.data as { readiness?: string; blockers?: Array<{ code: string }> };
      expect(data.readiness).toBe("blocked");
      expect((data.blockers ?? []).some((b) => b.code === "SECRET_MARKER")).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  test("validate 找不到 skill 回 NOT_FOUND", async () => {
    const ws = createTestWorkspace();
    try {
      const r = await execFactory(createSkillerValidateTool, makeDeps(ws), {
        scope: "project",
        name: projectName(ws),
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("NOT_FOUND");
    } finally {
      ws.cleanup();
    }
  });
});

describe("30 - skiller: lifecycle lock contention", () => {
  test("retire/restore 的專案 skiller.lock 被占用 → busy 且不移動；釋放後可完成", async () => {
    const ws = createTestWorkspace();
    try {
      const name = projectName(ws);
      const skillRoot = join(ws.root, ".opencode", "skills");
      const quarantineRoot = join(ws.root, ".opencode", "skill-quarantine");
      writeInstalledSkill(skillRoot, name, validSkillMd(name));
      const lockDir = join(ws.root, ".ultrawork", "cache", "locks");
      mkdirSync(lockDir, { recursive: true });
      const lockPath = join(lockDir, "skiller.lock");
      const deps = makeDeps(ws);
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: "held" }), "utf-8");
      const retireArgs = { scope: "project", name, mode: "apply", confirm: true };
      const retireBusy = await execFactory(createSkillerRetireTool, deps, retireArgs);
      expect(retireBusy.code).toBe("CONTENT_LOCK_BUSY");
      expect(existsSync(join(skillRoot, name))).toBe(true);
      unlinkSync(lockPath);
      expect((await execFactory(createSkillerRetireTool, deps, retireArgs)).ok).toBe(true);

      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: "held-2" }), "utf-8");
      const restoreArgs = { scope: "project", name, mode: "apply", confirm: true };
      const restoreBusy = await execFactory(createSkillerRestoreTool, deps, restoreArgs);
      expect(restoreBusy.code).toBe("CONTENT_LOCK_BUSY");
      expect(existsSync(join(quarantineRoot, name))).toBe(true);
      unlinkSync(lockPath);
      expect((await execFactory(createSkillerRestoreTool, deps, restoreArgs)).ok).toBe(true);
    } finally {
      ws.cleanup();
    }
  });
});

// ─── Section 6：bundle 安全與 atomic promotion regression ────

describe("30 - skiller: bundle safety & atomic promotion", () => {
  test("多檔 promotion 中途寫入失敗時不留部分結果，既有 target 與 staging 狀態可驗證", async () => {
    const ws = createTestWorkspace();
    try {
      const name = projectName(ws);
      // draft：三個檔案；第二個檔案會觸發注入的寫入失敗。
      const draftDir = join(ws.root, ".opencode", "skill-drafts", name);
      mkdirSync(join(draftDir, "docs"), { recursive: true });
      writeFileSync(join(draftDir, "SKILL.md"), validSkillMd(name, "v2"), "utf-8");
      writeFileSync(join(draftDir, "docs", "notes.md"), "# notes\n", "utf-8");
      writeFileSync(join(draftDir, "extra.txt"), "extra\n", "utf-8");

      // 既有 target：SKILL.md 為 v1，另有 docs/notes.md 既有內容。
      const skillsRoot = join(ws.root, ".opencode", "skills");
      const targetDir = join(skillsRoot, name);
      mkdirSync(join(targetDir, "docs"), { recursive: true });
      writeFileSync(join(targetDir, "SKILL.md"), validSkillMd(name, "v1"), "utf-8");
      writeFileSync(join(targetDir, "docs", "notes.md"), "old notes\n", "utf-8");

      const baseDeps = makeDeps(ws);
      const failingDeps: SkillerDeps = {
        ...baseDeps,
        writeFile: (path: string, content: string) => {
          if (path.endsWith("docs/notes.md")) throw new Error("E_TEST_WRITE_FAILED");
          writeFileSync(path, content, "utf-8");
        },
      };

      const r = await execFactory(createSkillerPromoteTool, failingDeps, {
        scope: "project",
        name,
        mode: "apply",
        confirm: true,
        overwrite: true,
      });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("WRITE_FAILED");

      // 既有 target 完全未被新內容污染。
      expect(readFileSync(join(targetDir, "SKILL.md"), "utf-8")).toBe(validSkillMd(name, "v1"));
      expect(readFileSync(join(targetDir, "docs", "notes.md"), "utf-8")).toBe("old notes\n");
      expect(existsSync(join(targetDir, "extra.txt"))).toBe(false);

      // 沒有殘留 staging / backup 等 temporary artifacts。
      const leftovers = readdirSync(skillsRoot).filter((e) => e !== name);
      expect(leftovers).toEqual([]);
    } finally {
      ws.cleanup();
    }
  });

  test("promotion 使用 copy 階段的 SKILL.md snapshot，不在 swap 後重讀可被替換的 draft source", async () => {
    const ws = createTestWorkspace();
    try {
      const name = projectName(ws);
      const originalContent = validSkillMd(name, "snapshot");
      const outside = mkdtempSync(join(tmpdir(), "skiller-promote-replacement-"));
      fixtures.push({ cleanup: () => rmSync(outside, { recursive: true, force: true }) });
      const externalContent = validSkillMd(name, "external replacement metadata");
      const externalSkillMd = join(outside, "external-SKILL.md");
      writeFileSync(externalSkillMd, externalContent, "utf-8");

      const draftSkillMd = join(ws.root, ".opencode", "skill-drafts", name, "SKILL.md");
      writeInstalledSkill(join(ws.root, ".opencode", "skill-drafts"), name, originalContent);
      let replaced = false;
      const replacementDeps: SkillerDeps = {
        ...makeDeps(ws),
        writeFile: (path: string, content: string) => {
          writeFileSync(path, content, "utf-8");
          if (!replaced && path.endsWith("SKILL.md")) {
            replaced = true;
            rmSync(draftSkillMd);
            symlinkSync(externalSkillMd, draftSkillMd, "file");
          }
        },
      };

      const r = await execFactory(createSkillerPromoteTool, replacementDeps, {
        scope: "project",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(r.ok).toBe(true);
      expect(replaced).toBe(true);
      const data = r.data as { digest?: string };
      expect(data.digest).toBe(sha256(originalContent));
      expect(data.digest).not.toBe(sha256(externalContent));
      expect(readFileSync(join(ws.root, ".opencode", "skills", name, "SKILL.md"), "utf-8")).toBe(originalContent);
      const payload = JSON.stringify(r);
      expect(payload).not.toContain(externalContent);
      expect(payload).not.toContain(externalSkillMd);
    } finally {
      ws.cleanup();
    }
  });

  test("非 SKILL.md 文字檔的 secret marker 必須反映在 validate/promote 結果", async () => {
    const ws = createTestWorkspace();
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      const name = "personal-domain-docsecret";
      const dir = join(fx.draftRoot, name);
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), validSkillMd(name), "utf-8");
      writeFileSync(join(dir, "docs", "notes.md"), "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456\n", "utf-8");

      const rv = await execFactory(createSkillerValidateTool, makeDeps(ws, fx), { scope: "personal", name });
      expect(rv.ok).toBe(true);
      const vd = rv.data as { readiness?: string; blockers?: Array<{ code: string }> };
      expect(vd.readiness).toBe("blocked");
      expect((vd.blockers ?? []).some((b) => b.code === "SECRET_MARKER")).toBe(true);

      const rp = await execFactory(createSkillerPromoteTool, makeDeps(ws, fx), {
        scope: "personal",
        name,
        mode: "apply",
        confirm: true,
        targetAgentGroups: ["implementation"],
      });
      expect(rp.ok).toBe(false);
      expect(rp.code).toBe("PROMOTION_BLOCKED");
      expect(((rp.data as { blockers?: Array<{ code: string }> }).blockers ?? [])
        .some((b) => b.code === "SECRET_MARKER")).toBe(true);
      expect(existsSync(join(fx.skillRoot, name))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("nested/dangling/out-of-root symlink fail closed，且不讀取或複製 symlink target", async () => {
    const ws = createTestWorkspace();
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      const name = "personal-domain-symlink";
      const outside = mkdtempSync(join(tmpdir(), "skiller-outside-"));
      fixtures.push({ cleanup: () => rmSync(outside, { recursive: true, force: true }) });
      const secretFile = join(outside, "secret.txt");
      writeFileSync(secretFile, "TOP SECRET OUTSIDE ROOT\n", "utf-8");

      const dir = join(fx.draftRoot, name);
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), validSkillMd(name), "utf-8");
      symlinkSync(secretFile, join(dir, "docs", "leak.txt"));
      symlinkSync(join(dir, "missing-target.md"), join(dir, "dangling.md"));

      // validate：readiness blocked + SYMLINK_REJECTED blocker
      const rv = await execFactory(createSkillerValidateTool, makeDeps(ws, fx), { scope: "personal", name });
      expect(rv.ok).toBe(true);
      const vd = rv.data as { readiness?: string; blockers?: Array<{ code: string }> };
      expect(vd.readiness).toBe("blocked");
      expect((vd.blockers ?? []).some((b) => b.code === "SYMLINK_REJECTED")).toBe(true);

      // scan：entry 帶可判斷的 fail-closed error
      const rs = await execFactory(createSkillerScanTool, makeDeps(ws, fx), { scope: "personal" });
      expect(rs.ok).toBe(true);
      const entries = (rs.data as { entries?: Array<Record<string, unknown>> }).entries ?? [];
      const scanEntry = entries.find((e) => e.sourceKind === "draft" && e.name === name);
      expect(scanEntry).toBeDefined();
      expect(String(scanEntry?.error ?? "")).toContain("SYMLINK_REJECTED");

      // promote：fail closed，且 symlink target 內容從未被複製到 skill root
      const rp = await execFactory(createSkillerPromoteTool, makeDeps(ws, fx), {
        scope: "personal",
        name,
        mode: "apply",
        confirm: true,
        targetAgentGroups: ["implementation"],
      });
      expect(rp.ok).toBe(false);
      expect(rp.code).toBe("PROMOTION_BLOCKED");
      expect(existsSync(join(fx.skillRoot, name))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("hidden nested symlink fail closed；hidden regular file 仍被略過", async () => {
    const ws = createTestWorkspace();
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      const outside = mkdtempSync(join(tmpdir(), "skiller-outside-"));
      fixtures.push({ cleanup: () => rmSync(outside, { recursive: true, force: true }) });
      const secretFile = join(outside, "secret.txt");
      const secretContent = "TOP SECRET OUTSIDE ROOT\n";
      writeFileSync(secretFile, secretContent, "utf-8");

      // draft A：hidden nested symlink（名稱以 . 開頭）指向 root 外
      const badName = "personal-domain-hidden-symlink";
      const badDir = join(fx.draftRoot, badName);
      mkdirSync(join(badDir, "docs"), { recursive: true });
      writeFileSync(join(badDir, "SKILL.md"), validSkillMd(badName), "utf-8");
      symlinkSync(secretFile, join(badDir, "docs", ".leak.txt"));

      // helper 層級：hidden symlink 必須回傳 structured issue，且不讀取 target
      const lb = listSkillFiles(badDir);
      expect(lb.ok).toBe(false);
      if (!lb.ok) expect(lb.issue.code).toBe("SYMLINK_REJECTED");

      // draft B：只有 hidden regular file，沒有 symlink → 必須維持可用
      const okName = "personal-domain-hidden-file";
      const okDir = join(fx.draftRoot, okName);
      mkdirSync(okDir, { recursive: true });
      writeFileSync(join(okDir, "SKILL.md"), validSkillMd(okName), "utf-8");
      writeFileSync(join(okDir, ".hidden-note.md"), "internal note\n", "utf-8");

      // helper 層級：hidden regular file 仍被略過，不進 bundle 清單
      const lo = listSkillFiles(okDir);
      expect(lo.ok).toBe(true);
      if (lo.ok) {
        expect(lo.files).toContain("SKILL.md");
        expect(lo.files).not.toContain(".hidden-note.md");
      }

      // validate：draft A readiness blocked + SYMLINK_REJECTED blocker
      const rv = await execFactory(createSkillerValidateTool, makeDeps(ws, fx), { scope: "personal", name: badName });
      expect(rv.ok).toBe(true);
      const vd = rv.data as { readiness?: string; blockers?: Array<{ code: string }> };
      expect(vd.readiness).toBe("blocked");
      expect((vd.blockers ?? []).some((b) => b.code === "SYMLINK_REJECTED")).toBe(true);

      // scan：draft A 帶 SYMLINK_REJECTED error；draft B 不受影響
      const rs = await execFactory(createSkillerScanTool, makeDeps(ws, fx), { scope: "personal" });
      expect(rs.ok).toBe(true);
      const entries = (rs.data as { entries?: Array<Record<string, unknown>> }).entries ?? [];
      const badEntry = entries.find((e) => e.sourceKind === "draft" && e.name === badName);
      expect(badEntry).toBeDefined();
      expect(String(badEntry?.error ?? "")).toContain("SYMLINK_REJECTED");
      const okEntry = entries.find((e) => e.sourceKind === "draft" && e.name === okName);
      expect(okEntry).toBeDefined();
      expect(okEntry?.error ?? "").toBe("");

      // promote：draft A fail closed，且 hidden symlink target 內容從未被複製到 skill root
      const rp = await execFactory(createSkillerPromoteTool, makeDeps(ws, fx), {
        scope: "personal",
        name: badName,
        mode: "apply",
        confirm: true,
        targetAgentGroups: ["implementation"],
      });
      expect(rp.ok).toBe(false);
      expect(rp.code).toBe("PROMOTION_BLOCKED");
      expect(existsSync(join(fx.skillRoot, badName))).toBe(false);

      // hidden regular file 不進 bundle：draft B 的檔案清單不含 .hidden-note.md
      const rvOk = await execFactory(createSkillerValidateTool, makeDeps(ws, fx), { scope: "personal", name: okName });
      expect(rvOk.ok).toBe(true);
      const vdOk = rvOk.data as { readiness?: string; files?: string[] };
      expect(vdOk.readiness).not.toBe("blocked");
      if (Array.isArray(vdOk.files)) {
        expect(vdOk.files).not.toContain(".hidden-note.md");
      }
    } finally {
      ws.cleanup();
    }
  });

  test("nested directory 讀取失敗時 fail closed：validate/promote/scan 不把不完整 bundle 當成功", async () => {
    const ws = createTestWorkspace();
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      const name = "personal-domain-unreadable";
      const dir = join(fx.draftRoot, name);
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), validSkillMd(name), "utf-8");
      writeFileSync(join(dir, "docs", "notes.md"), "# notes\n", "utf-8");

      // deterministic seam：nested docs/ 的 readdir 失敗（模擬不可讀目錄，
      // 不依賴 root privilege 或平台 chmod 行為）。tool 內部以 realpath
      // 傳遞路徑，因此以 bundle 相對後綴比對。
      const failingDeps: SkillerDeps = {
        ...makeDeps(ws, fx),
        readDirectory: (path: string) => {
          if (path.endsWith(join(name, "docs"))) throw new Error("E_TEST_READDIR_DENIED");
          return readdirSync(path);
        },
      };

      // helper 層級：listSkillFiles 回 structured failure，不是靜默截斷
      const lf = listSkillFiles(dir, failingDeps);
      expect(lf.ok).toBe(false);
      if (!lf.ok) {
        expect(lf.issue.code).toBe("BUNDLE_READ_FAILED");
        expect(lf.issue.message).toContain("docs");
      }

      // validate：readiness blocked + BUNDLE_READ_FAILED blocker
      const rv = await execFactory(createSkillerValidateTool, failingDeps, { scope: "personal", name });
      expect(rv.ok).toBe(true);
      const vd = rv.data as { readiness?: string; blockers?: Array<{ code: string }> };
      expect(vd.readiness).toBe("blocked");
      expect((vd.blockers ?? []).some((b) => b.code === "BUNDLE_READ_FAILED")).toBe(true);

      // scan：entry 帶可判斷的 fail-closed error
      const rs = await execFactory(createSkillerScanTool, failingDeps, { scope: "personal" });
      expect(rs.ok).toBe(true);
      const entries = (rs.data as { entries?: Array<Record<string, unknown>> }).entries ?? [];
      const scanEntry = entries.find((e) => e.sourceKind === "draft" && e.name === name);
      expect(scanEntry).toBeDefined();
      expect(String(scanEntry?.error ?? "")).toContain("BUNDLE_READ_FAILED");

      // promote apply：fail closed，不產生任何部分 target
      const rp = await execFactory(createSkillerPromoteTool, failingDeps, {
        scope: "personal",
        name,
        mode: "apply",
        confirm: true,
        targetAgentGroups: ["implementation"],
      });
      expect(rp.ok).toBe(false);
      expect(rp.code).toBe("PROMOTION_BLOCKED");
      expect(existsSync(join(fx.skillRoot, name))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("bundle entry lstat 失敗時 fail closed，不靜默跳過 entry", async () => {
    const ws = createTestWorkspace();
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      const name = "personal-domain-lstat-fail";
      const dir = join(fx.draftRoot, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), validSkillMd(name), "utf-8");
      writeFileSync(join(dir, "extra.txt"), "extra\n", "utf-8");

      const failingDeps: SkillerDeps = {
        ...makeDeps(ws, fx),
        entryStat: (path: string) => {
          if (path.endsWith(join(name, "extra.txt"))) throw new Error("E_TEST_LSTAT_DENIED");
          return statSync(path);
        },
      };

      const lf = listSkillFiles(dir, failingDeps);
      expect(lf.ok).toBe(false);
      if (!lf.ok) {
        expect(lf.issue.code).toBe("BUNDLE_READ_FAILED");
        expect(lf.issue.message).toContain("extra.txt");
      }

      const rv = await execFactory(createSkillerValidateTool, failingDeps, { scope: "personal", name });
      expect(rv.ok).toBe(true);
      const vd = rv.data as { readiness?: string; blockers?: Array<{ code: string }> };
      expect(vd.readiness).toBe("blocked");
      expect((vd.blockers ?? []).some((b) => b.code === "BUNDLE_READ_FAILED")).toBe(true);

      const rp = await execFactory(createSkillerPromoteTool, failingDeps, {
        scope: "personal",
        name,
        mode: "apply",
        confirm: true,
        targetAgentGroups: ["implementation"],
      });
      expect(rp.ok).toBe(false);
      expect(rp.code).toBe("PROMOTION_BLOCKED");
      expect(existsSync(join(fx.skillRoot, name))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("validate/scan 在 bundle listing 後替換 SKILL.md 時不讀取 external metadata", async () => {
    for (const toolCase of ["validate", "scan"] as const) {
      const ws = createTestWorkspace();
      const fx = createPersonalFixture();
      fixtures.push(fx);
      try {
        const name = "personal-domain-post-list-skill-md";
        const dir = join(fx.draftRoot, name);
        mkdirSync(dir, { recursive: true });
        const originalContent = validSkillMd(name, "original metadata");
        const outside = mkdtempSync(join(tmpdir(), "skiller-post-list-"));
        fixtures.push({ cleanup: () => rmSync(outside, { recursive: true, force: true }) });
        const externalContent = validSkillMd(name, "external metadata");
        const externalSkillMd = join(outside, "external-SKILL.md");
        writeFileSync(join(dir, "SKILL.md"), originalContent, "utf-8");
        writeFileSync(externalSkillMd, externalContent, "utf-8");

        let replaced = false;
        const replacementDeps: SkillerDeps = {
          ...makeDeps(ws, fx),
          entryStat: (path: string) => {
            const result = statSync(path);
            if (!replaced && path.endsWith(join(name, "SKILL.md"))) {
              replaced = true;
              rmSync(join(dir, "SKILL.md"));
              symlinkSync(externalSkillMd, join(dir, "SKILL.md"), "file");
            }
            return result;
          },
        };

        const r = toolCase === "validate"
          ? await execFactory(createSkillerValidateTool, replacementDeps, { scope: "personal", name })
          : await execFactory(createSkillerScanTool, replacementDeps, { scope: "personal" });
        expect(replaced).toBe(true);
        const payload = JSON.stringify(r);
        expect(payload).not.toContain(externalContent);
        expect(payload).not.toContain(sha256(externalContent));
        expect(payload).not.toContain(externalSkillMd);

        if (toolCase === "validate") {
          expect(r.ok).toBe(true);
          const data = r.data as { readiness?: string; digest?: string | null; blockers?: Array<{ code?: string }> };
          expect(data.readiness).toBe("blocked");
          expect(data.digest).toBeNull();
          expect((data.blockers ?? []).some((blocker) => blocker.code === "BUNDLE_READ_FAILED")).toBe(true);
        } else {
          expect(r.ok).toBe(true);
          const entries = (r.data as { entries?: Array<Record<string, unknown>> }).entries ?? [];
          const entry = entries.find((candidate) => candidate.sourceKind === "draft" && candidate.name === name);
          expect(entry).toBeDefined();
          expect(entry?.digest ?? null).toBeNull();
          expect(String(entry?.error ?? "")).toContain("BUNDLE_READ_FAILED");
        }
      } finally {
        ws.cleanup();
      }
    }
  });

  test("validate 附帶檔案在 listing 後變成 dangling symlink 時回 blocker，不靜默 continue", async () => {
    const ws = createTestWorkspace();
    const fx = createPersonalFixture();
    fixtures.push(fx);
    try {
      const name = "personal-domain-post-list-attachment";
      const dir = join(fx.draftRoot, name);
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), validSkillMd(name), "utf-8");
      writeFileSync(join(dir, "docs", "notes.md"), "safe notes\n", "utf-8");

      let replaced = false;
      const replacementDeps: SkillerDeps = {
        ...makeDeps(ws, fx),
        entryStat: (path: string) => {
          const result = statSync(path);
          if (!replaced && path.endsWith(join(name, "docs", "notes.md"))) {
            replaced = true;
            rmSync(join(dir, "docs", "notes.md"));
            symlinkSync(join(dir, "docs", "missing.md"), join(dir, "docs", "notes.md"), "file");
          }
          return result;
        },
      };

      const r = await execFactory(createSkillerValidateTool, replacementDeps, { scope: "personal", name });
      expect(r.ok).toBe(true);
      expect(replaced).toBe(true);
      const data = r.data as { readiness?: string; blockers?: Array<{ code?: string }> };
      expect(data.readiness).toBe("blocked");
      expect((data.blockers ?? []).some((blocker) => blocker.code === "BUNDLE_READ_FAILED")).toBe(true);
    } finally {
      ws.cleanup();
    }
  });
});

// ─── Section 7：project ancestor symlink escape ──────────────

describe("30 - skiller: project ancestor symlink escape", () => {
  /** 把 workspace 的 .opencode 換成指向外部 target 的 symlink。 */
  function replaceOpencodeWithSymlink(ws: TestWorkspace, outsideTarget: string): void {
    rmSync(join(ws.root, ".opencode"), { recursive: true, force: true });
    symlinkSync(outsideTarget, join(ws.root, ".opencode"), "dir");
  }

  test(".opencode 是指向外部的 symlink 時 draft fail closed 且外部 target 完全沒被寫入", async () => {
    const ws = createTestWorkspace();
    try {
      const outside = mkdtempSync(join(tmpdir(), "skiller-outside-"));
      fixtures.push({ cleanup: () => rmSync(outside, { recursive: true, force: true }) });
      const externalTarget = join(outside, "escaped-opencode");
      mkdirSync(externalTarget, { recursive: true });
      replaceOpencodeWithSymlink(ws, externalTarget);

      const name = projectName(ws);
      const r = await execFactory(createSkillerDraftTool, makeDeps(ws), {
        scope: "project",
        name,
        content: validSkillMd(name),
        confirm: true,
      });
      expect(r.ok).toBe(false);
      expect(["ROOT_ESCAPE", "SYMLINK_REJECTED", "PATH_OUTSIDE_ROOT"]).toContain(r.code);
      // 外部 target 必須完全沒有被建立或寫入任何內容。
      expect(readdirSync(externalTarget)).toEqual([]);
    } finally {
      ws.cleanup();
    }
  });

  test(".opencode 是指向外部的 symlink 時 promote 不讀取也不使用外部 bundle", async () => {
    const ws = createTestWorkspace();
    try {
      const outside = mkdtempSync(join(tmpdir(), "skiller-outside-"));
      fixtures.push({ cleanup: () => rmSync(outside, { recursive: true, force: true }) });
      const externalTarget = join(outside, "escaped-opencode");
      // 在外部 target 放一個看似合法的 draft bundle 與 skills 目錄。
      const name = projectName(ws);
      writeInstalledSkill(join(externalTarget, "skill-drafts"), name, validSkillMd(name));
      mkdirSync(externalTarget, { recursive: true });
      replaceOpencodeWithSymlink(ws, externalTarget);

      const r = await execFactory(createSkillerPromoteTool, makeDeps(ws), {
        scope: "project",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(r.ok).toBe(false);
      expect(["ROOT_ESCAPE", "SYMLINK_REJECTED", "PATH_OUTSIDE_ROOT", "NOT_FOUND"]).toContain(r.code);
      // 外部 draft 內容沒有被當成合法 bundle 使用；skills 也沒有在外部被建立。
      expect(existsSync(join(externalTarget, "skills"))).toBe(false);
      expect(readdirSync(join(externalTarget, "skill-drafts"))).toEqual([name]);
    } finally {
      ws.cleanup();
    }
  });

  test(".opencode 是指向外部的 symlink 時 scan 回報 escape warning 且不列舉外部 skill", async () => {
    const ws = createTestWorkspace();
    try {
      const outside = mkdtempSync(join(tmpdir(), "skiller-outside-"));
      fixtures.push({ cleanup: () => rmSync(outside, { recursive: true, force: true }) });
      const externalTarget = join(outside, "escaped-opencode");
      const name = projectName(ws);
      writeInstalledSkill(join(externalTarget, "skills"), name, validSkillMd(name));
      mkdirSync(externalTarget, { recursive: true });
      replaceOpencodeWithSymlink(ws, externalTarget);

      const r = await execFactory(createSkillerScanTool, makeDeps(ws), { scope: "project" });
      expect(r.ok).toBe(true);
      const data = r.data as { entries?: Array<Record<string, unknown>>; warnings?: Array<{ code?: string; message?: string }> };
      expect((data.entries ?? []).length).toBe(0);
      const codes = (data.warnings ?? []).map((w) => w.code ?? "");
      expect(codes.some((c) => ["ROOT_ESCAPE", "SYMLINK_REJECTED"].includes(c))).toBe(true);
      // 外部 skills 內容沒有被改動或寫入。
      expect(readdirSync(join(externalTarget, "skills"))).toEqual([name]);
    } finally {
      ws.cleanup();
    }
  });

  test(".opencode 是指向外部的 symlink 時 validate 不回傳外部 draft 的驗證結果", async () => {
    const ws = createTestWorkspace();
    try {
      const outside = mkdtempSync(join(tmpdir(), "skiller-outside-"));
      fixtures.push({ cleanup: () => rmSync(outside, { recursive: true, force: true }) });
      const externalTarget = join(outside, "escaped-opencode");
      const name = projectName(ws);
      // 在外部 target 放一個看似合法的 draft bundle。
      writeInstalledSkill(join(externalTarget, "skill-drafts"), name, validSkillMd(name));
      mkdirSync(externalTarget, { recursive: true });
      replaceOpencodeWithSymlink(ws, externalTarget);

      const r = await execFactory(createSkillerValidateTool, makeDeps(ws), { scope: "project", name });
      expect(r.ok).toBe(false);
      // 安全狀態如實回報：祖先 symlink escape 回 ROOT_ESCAPE，不折算成 NOT_FOUND。
      // 這與 skiller-promote 既有的「escape / symlink 不得靜默吞掉」規則一致；
      // 真正要守的性質是下面兩條——回覆不得洩漏外部路徑或外部內容 digest。
      expect(r.code).toBe("ROOT_ESCAPE");
      // 回覆不得含外部路徑或外部內容的 digest。
      const payload = JSON.stringify(r);
      expect(payload).not.toContain(externalTarget);
      expect(payload).not.toContain(sha256(validSkillMd(name)));
      // 外部 draft 內容沒有被寫入或改動。
      expect(readdirSync(join(externalTarget, "skill-drafts"))).toEqual([name]);
    } finally {
      ws.cleanup();
    }
  });

  test(".opencode 是指向外部的 symlink 時 retire 不讀取外部 metadata 也不建立 quarantine", async () => {
    const ws = createTestWorkspace();
    try {
      const outside = mkdtempSync(join(tmpdir(), "skiller-outside-"));
      fixtures.push({ cleanup: () => rmSync(outside, { recursive: true, force: true }) });
      const externalTarget = join(outside, "escaped-opencode");
      const name = projectName(ws);
      // 在外部 target 放一個看似合法的已安裝 skill。
      writeInstalledSkill(join(externalTarget, "skills"), name, validSkillMd(name));
      mkdirSync(externalTarget, { recursive: true });
      replaceOpencodeWithSymlink(ws, externalTarget);

      const r = await execFactory(createSkillerRetireTool, makeDeps(ws), {
        scope: "project",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(r.ok).toBe(false);
      expect(["NOT_FOUND", "SYMLINK_REJECTED", "ROOT_ESCAPE"]).toContain(r.code);
      // 回覆不得含外部 sourcePath / quarantinePath 或任何外部路徑。
      const payload = JSON.stringify(r);
      expect(payload).not.toContain(externalTarget);
      expect(payload).not.toContain("sourcePath");
      // 外部 skills 未被移動；任何位置都沒有建立 quarantine。
      expect(readdirSync(join(externalTarget, "skills"))).toEqual([name]);
      expect(existsSync(join(externalTarget, "skill-quarantine"))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });
});

// ─── Section 8：project fixed-root guard 順序 contract ───────

describe("30 - skiller: project fixed-root guard order contract", () => {
  // 含括號的 fs 呼叫字樣才會命中呼叫端，不會誤中 import 清單。
  const FS_READ_CALLS = ["existsSync(", "readdirSync(", "lstatSync(", "statSync(", "readFileSync("];

  function toolSource(file: string): string {
    return readFileSync(
      join(import.meta.dir, "../../../../src/modules/skiller", file),
      "utf-8",
    );
  }

  function firstFsReadIndex(source: string): number {
    let idx = -1;
    for (const needle of FS_READ_CALLS) {
      const i = source.indexOf(needle);
      if (i !== -1 && (idx === -1 || i < idx)) idx = i;
    }
    return idx;
  }

  test("validate：scoped root guard 先於任何 filesystem 讀取", () => {
    const src = toolSource("skiller-validate.ts");
    // validate 的定位改走 skiller-common.locateSkillDir，guard 順序由該 helper
    // 保證（scoped fixed-root guard → containedPath → statSync）。這裡鎖兩件事：
    // validate 本身確實走 helper，而且沒有繞過它直接做任何 filesystem 讀取。
    const guardIdx = src.indexOf("locateSkillDir(kind, scope, name, deps, context)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(firstFsReadIndex(src)).toBe(-1);

    // helper 內部本身仍必須維持 guard 先於 stat 的順序。
    const helper = toolSource("skiller-common.ts");
    const helperFn = helper.slice(helper.indexOf("export function locateSkillDir"));
    const helperGuardIdx = helperFn.indexOf("ensureScopedFixedRoot(rootLexical, scope, deps, context)");
    const helperContainIdx = helperFn.indexOf("containedPath(rootGuard.value, rootLexical, name)");
    const helperStatIdx = helperFn.indexOf("statSync(guard.value)");
    expect(helperGuardIdx).toBeGreaterThan(-1);
    expect(helperContainIdx).toBeGreaterThan(helperGuardIdx);
    expect(helperStatIdx).toBeGreaterThan(helperContainIdx);
  });

  test("scan：scoped root guard 先於任何 filesystem 讀取", () => {
    const src = toolSource("skiller-scan.ts");
    const guardIdx = src.indexOf("ensureScopedFixedRoot(root, scope, deps, context)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(firstFsReadIndex(src)).toBeGreaterThan(guardIdx);
  });

  test("retire：scoped root guard 先於任何 filesystem 讀取，且無 guard 外的 fallback lstat", () => {
    const src = toolSource("skiller-retire.ts");
    const guardIdx = src.indexOf("ensureScopedFixedRoot(roots.skillRoot, scope, deps, context)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(firstFsReadIndex(src)).toBeGreaterThan(guardIdx);
    // guard 失敗後不得以未受 guard 的 lexical path 對 name target 做 fallback 讀取。
    expect(src.includes("lstatSync(resolve(roots.skillRoot")).toBe(false);
    const bundleGuardIdx = src.indexOf("listSkillFiles(sourceDir, deps)");
    const metadataGuardIdx = src.indexOf('containedPath(sourceDir, sourceDir, "SKILL.md")');
    const metadataReadIdx = src.indexOf("readFileSync(metadataGuard.value");
    expect(bundleGuardIdx).toBeGreaterThan(guardIdx);
    expect(metadataGuardIdx).toBeGreaterThan(bundleGuardIdx);
    expect(metadataReadIdx).toBeGreaterThan(metadataGuardIdx);
    expect(src.includes('readFileSync(resolve(sourceDir, "SKILL.md")')).toBe(false);
  });

  test("promote：swap 後只使用 copy 階段 snapshot，不重讀 draft source", () => {
    const src = toolSource("skiller-promote.ts");
    expect(src.includes('readFileSync(resolve(draftDir, "SKILL.md")')).toBe(false);
    expect(src.includes("const content = readFileSync(sourceGuard.value")).toBe(true);
    expect(src.includes("skillMdSnapshot")).toBe(true);
    expect(src.includes("sha256Hex(skillMdSnapshot)")).toBe(true);
  });

  test("validate：SKILL.md 與 bundle 附帶檔案 read 都先取得 contained path", () => {
    const src = toolSource("skiller-common.ts");
    expect(src.includes("const guardedFiles = new Map<string, string>()")).toBe(true);
    expect(src.includes("const guard = containedPath(skillDir, skillDir, rel)")).toBe(true);
    expect(src.includes('readFileSync(join(skillDir, "SKILL.md")')).toBe(false);
    expect(src.includes("readFileSync(join(skillDir, rel)")).toBe(false);
    expect(src.includes("sha256File(skillMdPath)")).toBe(false);
  });

  test("scan：SKILL.md read 使用 canonical dir 的 contained path", () => {
    const src = toolSource("skiller-scan.ts");
    expect(src.includes('containedPath(dirGuard.value, dirGuard.value, "SKILL.md")')).toBe(true);
    expect(src.includes('readFileSync(join(dirGuard.value, "SKILL.md")')).toBe(false);
  });
});

// ─── Section 9：personal pins trust tier (governance fix) ─────

describe("30 - skiller: personal pins trust tier", () => {
  function pinJson(name: string, digest: string, status: "active" | "retired" = "active"): string {
    const base: Record<string, unknown> = {
      [name]: {
        name,
        digest,
        targetAgentGroups: ["implementation"],
        resolvedTargetAgents: ["build"],
        status,
        promotedAt: "2026-08-19T00:00:00.000Z",
      },
    };
    if (status === "retired") (base[name] as Record<string, unknown>).retiredAt = "2026-08-19T01:00:00.000Z";
    return initialPinsContent(base);
  }

  test("personal active pin digest 相符時 scan/validate 回 approved 且 readiness ready", async () => {
    const ws = createTestWorkspace();
    const name = "personal-domain-pincap";
    const content = validSkillMd(name);
    const digest = sha256(content);
    const fx = createPersonalFixture({}, pinJson(name, digest, "active"));
    fixtures.push(fx);
    try {
      writeInstalledSkill(fx.skillRoot, name, content);
      writeAgentRouteFile(ws, "build");
      const scan = await execFactory(createSkillerScanTool, makeDeps(ws, fx), { scope: "personal" });
      expect(scan.ok).toBe(true);
      const entry = (scan.data as { entries?: Array<Record<string, unknown>> }).entries?.find((e) => e.name === name && e.sourceKind === "skill");
      expect(entry?.trustTier).toBe("approved");

      const v = await execFactory(createSkillerValidateTool, makeDeps(ws, fx), { scope: "personal", name });
      expect(v.ok).toBe(true);
      const vd = v.data as { trustTier?: string; readiness?: string; blockers?: Array<{ code: string }> };
      expect(vd.trustTier).toBe("approved");
      expect(vd.readiness).toBe("ready");
      expect((vd.blockers ?? []).some((b) => b.code === "POLICY_DIGEST_DRIFT")).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("personal active pin digest 不符時為 drifted 並在 personal scope blocked", async () => {
    const ws = createTestWorkspace();
    const name = "personal-domain-pindrift";
    const installedContent = validSkillMd(name, "v1");
    const staleDigest = "a".repeat(64);
    const fx = createPersonalFixture({}, pinJson(name, staleDigest, "active"));
    fixtures.push(fx);
    try {
      writeInstalledSkill(fx.skillRoot, name, installedContent);
      const scan = await execFactory(createSkillerScanTool, makeDeps(ws, fx), { scope: "personal" });
      expect(scan.ok).toBe(true);
      const entry = (scan.data as { entries?: Array<Record<string, unknown>> }).entries?.find((e) => e.name === name);
      expect(entry?.trustTier).toBe("drifted");

      const v = await execFactory(createSkillerValidateTool, makeDeps(ws, fx), { scope: "personal", name });
      expect(v.ok).toBe(true);
      const vd = v.data as { trustTier?: string; readiness?: string; blockers?: Array<{ code: string }> };
      expect(vd.trustTier).toBe("drifted");
      expect(vd.readiness).toBe("blocked");
      expect((vd.blockers ?? []).some((b) => b.code === "POLICY_DIGEST_DRIFT")).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  test("personal retired pin 回 retired 且不被當作 approved", async () => {
    const ws = createTestWorkspace();
    const name = "personal-domain-pinretired";
    const content = validSkillMd(name);
    const digest = sha256(content);
    const fx = createPersonalFixture({}, pinJson(name, digest, "retired"));
    fixtures.push(fx);
    try {
      writeInstalledSkill(fx.skillRoot, name, content);
      const scan = await execFactory(createSkillerScanTool, makeDeps(ws, fx), { scope: "personal" });
      expect(scan.ok).toBe(true);
      const entry = (scan.data as { entries?: Array<Record<string, unknown>> }).entries?.find((e) => e.name === name);
      expect(entry?.trustTier).toBe("retired");

      const v = await execFactory(createSkillerValidateTool, makeDeps(ws, fx), { scope: "personal", name });
      expect(v.ok).toBe(true);
      const vd = v.data as { trustTier?: string };
      expect(vd.trustTier).toBe("retired");
    } finally {
      ws.cleanup();
    }
  });

  test("personal pins missing/malformed 時 scan 不回 approved，validate fail closed", async () => {
    const ws = createTestWorkspace();
    const name = "personal-domain-pinmissing";
    const content = validSkillMd(name);
    // missing pins file
    const fxMissing = createPersonalFixture();
    fixtures.push(fxMissing);
    rmSync(fxMissing.pinsPath);
    writeInstalledSkill(fxMissing.skillRoot, name, content);
    const scanMissing = await execFactory(createSkillerScanTool, makeDeps(ws, fxMissing), { scope: "personal" });
    expect(scanMissing.ok).toBe(true);
    const entryMissing = (scanMissing.data as { entries?: Array<Record<string, unknown>> }).entries?.find((e) => e.name === name);
    expect(entryMissing?.trustTier).not.toBe("approved");
    const warningsMissing = (scanMissing.data as { warnings?: Array<{ code: string }> }).warnings ?? [];
    expect(warningsMissing.some((w) => w.code === "REGISTRY_UNAVAILABLE")).toBe(true);

    const vMissing = await execFactory(createSkillerValidateTool, makeDeps(ws, fxMissing), { scope: "personal", name });
    expect(vMissing.ok).toBe(false);
    expect(["REGISTRY_UNAVAILABLE", "REGISTRY_MALFORMED", "REGISTRY_SCHEMA_UNSUPPORTED", "REGISTRY_PIN_INVALID"]).toContain(vMissing.code);

    // malformed pins
    const fxMalformed = createPersonalFixture({}, "{ not json");
    fixtures.push(fxMalformed);
    writeInstalledSkill(fxMalformed.skillRoot, name, content);
    const scanMalformed = await execFactory(createSkillerScanTool, makeDeps(ws, fxMalformed), { scope: "personal" });
    expect(scanMalformed.ok).toBe(true);
    const wMalformed = (scanMalformed.data as { warnings?: Array<{ code: string }> }).warnings ?? [];
    expect(wMalformed.some((w) => w.code === "REGISTRY_MALFORMED")).toBe(true);
  });

  test("deriveTrustTier precedence：policy retired 優先於 pins，pins 優先於 policy digest", async () => {
    // 直接驗證 deriveTrustTier precedence 不依賴 filesystem
    const { deriveTrustTier } = await import("../../../../src/modules/skiller/skiller-common.ts");
    const name = "personal-domain-prec";
    const digest = "b".repeat(64);
    const pins = { schemaVersion: 1, pins: { [name]: { name, digest, targetAgentGroups: ["implementation"], resolvedTargetAgents: ["build"], status: "active" as const, promotedAt: "2026-08-19T00:00:00.000Z" } } } as unknown as import("../../../../src/modules/skiller/skiller-common.ts").PersonalPinsFile;
    const policyRetired = { path: "/tmp/fake", retired: { group: [name] } } as unknown as import("../../../../src/modules/skiller/skiller-common.ts").PolicySnapshot;
    const policyDigest = { path: "/tmp/fake", approval: { contentDigests: { [name]: "c".repeat(64) } } } as unknown as import("../../../../src/modules/skiller/skiller-common.ts").PolicySnapshot;
    expect(deriveTrustTier(name, digest, policyRetired, pins)).toBe("retired");
    expect(deriveTrustTier(name, digest, policyDigest, pins)).toBe("approved");
    expect(deriveTrustTier(name, "d".repeat(64), policyDigest, pins)).toBe("drifted");
  });
});

// ─── Section 10：personal registry unavailable fail-closed（Momus edge case）─────

describe("30 - skiller: personal registry unavailable fail-closed", () => {
  test("registry failure + matching policy digest 時 scan 不回 approved/drifted/recorded 且保留 REGISTRY_* warning", async () => {
    const ws = createTestWorkspace();
    const name = "personal-edge-scanfail";
    const content = validSkillMd(name);
    const digest = sha256(content);
    // policy 對同一 name 有相符 digest，pins 卻缺失
    const fxMissing = createPersonalFixture({ [name]: digest });
    fixtures.push(fxMissing);
    rmSync(fxMissing.pinsPath);
    writeInstalledSkill(fxMissing.skillRoot, name, content);
    const scanMissing = await execFactory(createSkillerScanTool, makeDeps(ws, fxMissing), { scope: "personal" });
    expect(scanMissing.ok).toBe(true);
    const entryMissing = (scanMissing.data as { entries?: Array<Record<string, unknown>> }).entries?.find((e) => e.name === name);
    expect(["approved", "drifted", "recorded"]).not.toContain(entryMissing?.trustTier as string);
    expect(["unreviewed", "unknown"]).toContain(entryMissing?.trustTier as string);
    const warningsMissing = (scanMissing.data as { warnings?: Array<{ code: string }> }).warnings ?? [];
    expect(warningsMissing.some((w) => w.code === "REGISTRY_UNAVAILABLE")).toBe(true);

    // malformed
    const fxMalformed = createPersonalFixture({ [name]: digest }, "{ not json");
    fixtures.push(fxMalformed);
    writeInstalledSkill(fxMalformed.skillRoot, name, content);
    const scanMalformed = await execFactory(createSkillerScanTool, makeDeps(ws, fxMalformed), { scope: "personal" });
    const entryMalformed = (scanMalformed.data as { entries?: Array<Record<string, unknown>> }).entries?.find((e) => e.name === name);
    expect(["approved", "drifted", "recorded"]).not.toContain(entryMalformed?.trustTier);
    expect((scanMalformed.data as { warnings?: Array<{ code: string }> }).warnings?.some((w) => w.code === "REGISTRY_MALFORMED")).toBe(true);

    // schema-invalid
    const fxSchema = createPersonalFixture({ [name]: digest }, JSON.stringify({ schemaVersion: 999, pins: {} }));
    fixtures.push(fxSchema);
    writeInstalledSkill(fxSchema.skillRoot, name, content);
    const scanSchema = await execFactory(createSkillerScanTool, makeDeps(ws, fxSchema), { scope: "personal" });
    const entrySchema = (scanSchema.data as { entries?: Array<Record<string, unknown>> }).entries?.find((e) => e.name === name);
    expect(["approved", "drifted", "recorded"]).not.toContain(entrySchema?.trustTier);
    expect((scanSchema.data as { warnings?: Array<{ code: string }> }).warnings?.some((w) => w.code === "REGISTRY_SCHEMA_UNSUPPORTED")).toBe(true);

    // pin-invalid
    const pinInvalidRaw = JSON.stringify({
      schemaVersion: 1,
      pins: { [name]: { name, digest: "nothex", targetAgentGroups: ["implementation"], resolvedTargetAgents: ["build"], status: "active", promotedAt: "2026-08-19T00:00:00.000Z" } },
    });
    const fxPinInvalid = createPersonalFixture({ [name]: digest }, pinInvalidRaw);
    fixtures.push(fxPinInvalid);
    writeInstalledSkill(fxPinInvalid.skillRoot, name, content);
    const scanPinInvalid = await execFactory(createSkillerScanTool, makeDeps(ws, fxPinInvalid), { scope: "personal" });
    const entryPinInvalid = (scanPinInvalid.data as { entries?: Array<Record<string, unknown>> }).entries?.find((e) => e.name === name);
    expect(["approved", "drifted", "recorded"]).not.toContain(entryPinInvalid?.trustTier);
    expect((scanPinInvalid.data as { warnings?: Array<{ code: string }> }).warnings?.some((w) => w.code === "REGISTRY_PIN_INVALID")).toBe(true);

    ws.cleanup();
  });

  test("同樣情境 retire preview 不顯示 policy-derived approved 且不 mutation", async () => {
    const ws = createTestWorkspace();
    const name = "personal-edge-retirefail";
    const content = validSkillMd(name);
    const digest = sha256(content);
    const fx = createPersonalFixture({ [name]: digest });
    fixtures.push(fx);
    rmSync(fx.pinsPath);
    writeInstalledSkill(fx.skillRoot, name, content);
    const beforeExists = existsSync(join(fx.skillRoot, name));
    expect(beforeExists).toBe(true);
    const retirePreview = await execFactory(createSkillerRetireTool, makeDeps(ws, fx), { scope: "personal", name, mode: "preview" });
    expect(retirePreview.ok).toBe(true);
    const trustTier = (retirePreview.data as { trustTier?: string }).trustTier;
    expect(["approved", "drifted", "recorded"]).not.toContain(trustTier as string);
    expect(["unreviewed", "unknown"]).toContain(trustTier as string);
    // preview 不 mutation
    expect(existsSync(join(fx.skillRoot, name))).toBe(true);
    expect(existsSync(join(fx.quarantineRoot, name))).toBe(false);
    ws.cleanup();
  });

  test("deriveTrustTier 標記 registry unavailable 時不Fallback 到 policy digest，但仍保留 retired 優先", async () => {
    const { deriveTrustTier } = await import("../../../../src/modules/skiller/skiller-common.ts");
    const name = "personal-edge-derive";
    const digest = "e".repeat(64);
    const policyDigest = { path: "/tmp/fake", approval: { contentDigests: { [name]: digest } } } as unknown as import("../../../../src/modules/skiller/skiller-common.ts").PolicySnapshot;
    const policyRetired = { path: "/tmp/fake", retired: { g: [name] } } as unknown as import("../../../../src/modules/skiller/skiller-common.ts").PolicySnapshot;
    // unavailable → 不回 approved
    expect(deriveTrustTier(name, digest, policyDigest, null, true)).not.toBe("approved");
    expect(["unreviewed", "unknown"]).toContain(deriveTrustTier(name, digest, policyDigest, null, true));
    expect(deriveTrustTier(name, "f".repeat(64), policyDigest, null, true)).not.toBe("drifted");
    expect(deriveTrustTier(name, null as unknown as string, policyDigest, null, true)).not.toBe("recorded");
    // retired 仍優先
    expect(deriveTrustTier(name, digest, policyRetired, null, true)).toBe("retired");
    // 正常 loaded 時仍可 approved
    const pins = { schemaVersion: 1, pins: { [name]: { name, digest, targetAgentGroups: ["implementation"], resolvedTargetAgents: ["build"], status: "active" as const, promotedAt: "2026-08-19T00:00:00.000Z" } } } as unknown as import("../../../../src/modules/skiller/skiller-common.ts").PersonalPinsFile;
    expect(deriveTrustTier(name, digest, policyDigest, pins, false)).toBe("approved");
  });
});

// ─── Section 11：managed scope（managed external skill）─────

describe("30 - skiller: managed scope", () => {
  /** managed fixture：在 personal fixture 的 policy 上補 managed catalog。 */
  function createManagedFixture(managedNames: string[], digests: Record<string, string> = {}): PersonalFixture {
    const fx = createPersonalFixture(digests);
    fixtures.push(fx);
    const policy = JSON.parse(readFileSync(fx.policyPath, "utf-8")) as Record<string, unknown>;
    const managed: Record<string, unknown> = {};
    for (const name of managedNames) {
      managed[name] = { source: `https://example.com/skills/${name}`, maintainer: "External" };
    }
    policy.managed = managed;
    writeFileSync(fx.policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf-8");
    return fx;
  }

  test("normalizeScope 接受 managed；resolveScopeRoots 回傳與 personal 相同的固定 roots", async () => {
    const { normalizeScope, resolveScopeRoots } = await import(
      "../../../../src/modules/skiller/skiller-common.ts"
    );
    expect(normalizeScope("managed")).toEqual({ ok: true, scope: "managed" });
    expect(normalizeScope("bogus-scope")).toEqual({ ok: false });
    const ws = createTestWorkspace();
    try {
      const fx = createManagedFixture([]);
      const deps = makeDeps(ws, fx);
      const managedRoots = resolveScopeRoots("managed", deps);
      const personalRoots = resolveScopeRoots("personal", deps);
      expect(managedRoots).toEqual(personalRoots);
      expect(managedRoots.skillRoot).toBe(fx.skillRoot);
    } finally {
      ws.cleanup();
    }
  });

  test("validateSkillName：接受無 prefix kebab-case，拒絕 personal-/project- prefix 與非法字元", async () => {
    const { validateSkillName } = await import("../../../../src/modules/skiller/skiller-common.ts");
    expect(validateSkillName("api-design", "managed", "opencode").ok).toBe(true);
    expect(validateSkillName("vercel-react-best-practices", "managed", "opencode").ok).toBe(true);
    const badPrefix = ["personal-demo-capability", "project-opencode-demo"];
    for (const bad of badPrefix) {
      const r = validateSkillName(bad, "managed", "opencode");
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.code).toBe("INVALID_NAMESPACE");
    }
    const badNames = ["Bad-Name", "bad_name", "bad name", `${"a".repeat(65)}`, "../escape"];
    for (const bad of badNames) {
      expect(validateSkillName(bad, "managed", "opencode").ok, bad).toBe(false);
    }
  });

  test("scan / validate 接受 scope:managed 且 namespace 判定正確", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "api-design";
      const content = validSkillMd(name);
      const fx = createManagedFixture([name], { [name]: sha256(content) });
      writeInstalledSkill(fx.skillRoot, name, content);
      const deps = makeDeps(ws, fx);

      const scan = await execFactory(createSkillerScanTool, deps, { scope: "managed" });
      expect(scan.ok).toBe(true);
      const entry = (scan.data as { entries: Array<Record<string, unknown>> }).entries.find((e) => e.name === name);
      expect(entry).toBeDefined();
      expect(entry?.namespaceValid).toBe(true);
      expect(entry?.trustTier).toBe("managed");

      const validate = await execFactory(createSkillerValidateTool, deps, { scope: "managed", name });
      expect(validate.ok).toBe(true);
      expect((validate.data as { namespaceValid?: boolean }).namespaceValid).toBe(true);
      expect((validate.data as { trustTier?: string }).trustTier).toBe("managed");
    } finally {
      ws.cleanup();
    }
  });

  test("managed promote 不要求 targetAgentGroups、不寫 personal pins", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "api-design";
      const content = validSkillMd(name);
      const fx = createManagedFixture([name], { [name]: sha256(content) });
      const deps = makeDeps(ws, fx);
      const draftDir = join(fx.draftRoot, name);
      mkdirSync(draftDir, { recursive: true });
      writeFileSync(join(draftDir, "SKILL.md"), content, "utf-8");

      const preview = await execFactory(createSkillerPromoteTool, deps, { scope: "managed", name });
      expect(preview.ok).toBe(true);

      const applied = await execFactory(createSkillerPromoteTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(applied.ok).toBe(true);
      expect(existsSync(join(fx.skillRoot, name, "SKILL.md"))).toBe(true);
      // pins registry 未被寫入：managed promote 不得建立 pin
      const pins = JSON.parse(readFileSync(fx.pinsPath, "utf-8")) as { pins: Record<string, unknown> };
      expect(Object.keys(pins.pins)).toEqual([]);
    } finally {
      ws.cleanup();
    }
  });

  test("trust tier：catalog 內且 digest 一致為 managed、不在 catalog 為 unreviewed、retired 優先", async () => {
    const { deriveTrustTier } = await import("../../../../src/modules/skiller/skiller-common.ts");
    type Policy = import("../../../../src/modules/skiller/skiller-common.ts").PolicySnapshot;
    const digest = "a".repeat(64);
    const policy = {
      path: "/tmp/fake",
      managed: { "api-design": { source: "https://example.com", maintainer: "External" } },
      approval: { contentDigests: { "api-design": digest } },
    } as unknown as Policy;
    expect(deriveTrustTier("api-design", digest, policy, null, false, "managed")).toBe("managed");
    expect(deriveTrustTier("api-design", "b".repeat(64), policy, null, false, "managed")).toBe("drifted");
    expect(deriveTrustTier("unlisted-skill", digest, policy, null, false, "managed")).toBe("unreviewed");
    const retired = { path: "/tmp/fake", managed: { "api-design": {} }, retired: { g: ["api-design"] } } as unknown as Policy;
    expect(deriveTrustTier("api-design", digest, retired, null, false, "managed")).toBe("retired");
    // allowlist 不得讓 managed scope 變成 allowlisted
    const allowlisted = {
      path: "/tmp/fake",
      managed: {},
      approval: { agentAllowlist: ["unlisted-skill"] },
    } as unknown as Policy;
    expect(deriveTrustTier("unlisted-skill", digest, allowlisted, null, false, "managed")).toBe("unreviewed");
  });

  test("managed retire → restore 往返不碰 pins 且目錄正確移動", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "api-design";
      const content = validSkillMd(name);
      const fx = createManagedFixture([name], { [name]: sha256(content) });
      writeInstalledSkill(fx.skillRoot, name, content);
      const deps = makeDeps(ws, fx);

      const retired = await execFactory(createSkillerRetireTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(retired.ok).toBe(true);
      expect(existsSync(join(fx.skillRoot, name))).toBe(false);
      expect(existsSync(join(fx.quarantineRoot, name, "SKILL.md"))).toBe(true);

      const restored = await execFactory(createSkillerRestoreTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(restored.ok).toBe(true);
      expect(existsSync(join(fx.skillRoot, name, "SKILL.md"))).toBe(true);
      expect(existsSync(join(fx.quarantineRoot, name))).toBe(false);
      const pins = JSON.parse(readFileSync(fx.pinsPath, "utf-8")) as { pins: Record<string, unknown> };
      expect(Object.keys(pins.pins)).toEqual([]);
    } finally {
      ws.cleanup();
    }
  });
});
