/**
 * 49 — skiller managed 權限路由閉環（promote / retire / restore + agents/*.md）
 *
 * 驗收重點：
 *   - promote（managed）選填 targetAgents：preview 顯示計畫寫入、apply 後
 *     指定 agent 檔的 permission.skill 區塊出現 `    <skill>: allow`，
 *     其餘內容逐字不變。
 *   - retire（managed）apply 掃描全部 agent 檔並移除該 skill 的 exact 行；
 *     preview 顯示將修改哪些檔案。
 *   - restore（managed）選填 targetAgents：復原後重新插入。
 *   - 缺 skill 區塊的 agent 回報 skipped 且不寫檔；未知 agent 名拒絕；
 *     非 managed scope 帶 targetAgents 一律拒絕；缺省時行為與現狀相同；
 *     同名 exact 行已存在時冪等（不重複插入）；單檔寫入走原子寫入。
 *
 * 安全邊界：
 *   - 測試只寫暫存 fixture agents 目錄（deps.roots.agentsRoot 注入），
 *     絕不觸碰真實全域 agents 目錄。
 */

import {
  describe,
  test,
  expect,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import {
  insertAgentSkillAllow,
  removeAgentSkillLine,
} from "../../../../src/modules/skiller/skiller-common.ts";
import { createSkillerPromoteTool } from "../../../../src/modules/skiller/skiller-promote.ts";
import { createSkillerRetireTool } from "../../../../src/modules/skiller/skiller-retire.ts";
import { createSkillerRestoreTool } from "../../../../src/modules/skiller/skiller-restore.ts";

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex");
}

function validSkillMd(name: string, description = "demo skill for tests"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nUse this skill carefully.\n`;
}

interface RoutingFixture {
  base: string;
  draftRoot: string;
  skillRoot: string;
  quarantineRoot: string;
  policyPath: string;
  pinsPath: string;
  agentsRoot: string;
  cleanup(): void;
}

function agentFileContent(skillLines: string[]): string {
  return `---\ndescription: test agent\nmode: subagent\npermission:\n  skill:\n${skillLines.join("\n")}\n---\n\nbody\n`;
}

const STANDARD_SKILL_LINES = [`    "*": deny`, `    project-*: ask`, `    personal-*: ask`];

function createRoutingFixture(managedNames: string[]): RoutingFixture {
  const base = mkdtempSync(join(tmpdir(), "skiller-routing-"));
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
  const managed: Record<string, unknown> = {};
  for (const name of managedNames) {
    managed[name] = { source: `https://example.com/skills/${name}`, maintainer: "External" };
  }
  writeFileSync(
    policyPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        skillRoot,
        managed,
        approval: { digestAlgorithm: "sha256", agentAllowlist: [], contentDigests: {} },
        personalGovernance: {
          pinsPath,
          personalNamespace: "personal-",
          trustTiers: ["approved", "drifted", "recorded", "managed", "allowlisted", "retired", "unreviewed", "unknown"],
          agentGroups: { implementation: ["build"] },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  writeFileSync(pinsPath, `${JSON.stringify({ schemaVersion: 1, pins: {} }, null, 2)}\n`, "utf-8");
  for (const agent of ["build", "arch"]) {
    writeFileSync(join(agentsRoot, `${agent}.md`), agentFileContent(STANDARD_SKILL_LINES), "utf-8");
  }
  return {
    base,
    draftRoot,
    skillRoot,
    quarantineRoot,
    policyPath,
    pinsPath,
    agentsRoot,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function makeDeps(ws: TestWorkspace, fx: RoutingFixture, extra?: Partial<SkillerDeps>): SkillerDeps {
  return {
    resolveProjectRoot: () => ws.root,
    roots: {
      personalDraftRoot: fx.draftRoot,
      personalSkillRoot: fx.skillRoot,
      personalQuarantineRoot: fx.quarantineRoot,
      policyPath: fx.policyPath,
      personalPinsPath: fx.pinsPath,
      agentsRoot: fx.agentsRoot,
    },
    ...extra,
  } as SkillerDeps;
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

function writeDraft(fx: RoutingFixture, name: string, content: string): void {
  const dir = join(fx.draftRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
}

function writeInstalled(fx: RoutingFixture, name: string, content: string): void {
  const dir = join(fx.skillRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
}

const fixtures: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

describe("49 - personal route uses configured agentsRoot", () => {
  test("自訂 agentsDir 且無 project-local agent 檔時，promote/restore 都正確路由", async () => {
    const ws = createTestWorkspace();
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    try {
      const name = "personal-domain-capability";
      const fx = createRoutingFixture([]);
      fixtures.push(fx);
      process.env.OPENCODE_CONFIG_DIR = join(fx.base, "missing-global-config");
      writeDraft(fx, name, validSkillMd(name));
      const deps = makeDeps(ws, fx);

      const promoted = await execFactory(createSkillerPromoteTool, deps, {
        scope: "personal",
        name,
        mode: "apply",
        confirm: true,
        targetAgentGroups: ["implementation"],
      });
      expect(promoted.ok, promoted.summary).toBe(true);

      const retired = await execFactory(createSkillerRetireTool, deps, {
        scope: "personal",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(retired.ok, retired.summary).toBe(true);

      const restored = await execFactory(createSkillerRestoreTool, deps, {
        scope: "personal",
        name,
        mode: "apply",
        confirm: true,
        targetAgentGroups: ["implementation"],
      });
      expect(restored.ok, restored.summary).toBe(true);
      expect(existsSync(join(fx.skillRoot, name, "SKILL.md"))).toBe(true);
    } finally {
      if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
      ws.cleanup();
    }
  });
});

// ─── promote：targetAgents 路由 ────────────────────────────────

describe("49 - promote managed targetAgents 路由", () => {
  test("preview 顯示將寫入的 agent 檔案與插入內容，不寫檔", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "api-design";
      const fx = createRoutingFixture([name]);
      fixtures.push(fx);
      writeDraft(fx, name, validSkillMd(name));
      const deps = makeDeps(ws, fx);
      const before = readFileSync(join(fx.agentsRoot, "build.md"), "utf-8");

      const r = await execFactory(createSkillerPromoteTool, deps, {
        scope: "managed",
        name,
        targetAgents: ["build"],
      });
      expect(r.ok).toBe(true);
      const routing = (r.data as { agentRouting?: Record<string, unknown> }).agentRouting;
      expect(routing).toBeDefined();
      expect(JSON.stringify(routing)).toContain("build.md");
      expect(JSON.stringify(routing)).toContain(`${name}: allow`);
      expect(readFileSync(join(fx.agentsRoot, "build.md"), "utf-8")).toBe(before);
    } finally {
      ws.cleanup();
    }
  });

  test("apply 後 agent 檔出現 exact allow 行，其餘內容逐字不變", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "api-design";
      const fx = createRoutingFixture([name]);
      fixtures.push(fx);
      writeDraft(fx, name, validSkillMd(name));
      const deps = makeDeps(ws, fx);
      const before = readFileSync(join(fx.agentsRoot, "build.md"), "utf-8");

      const r = await execFactory(createSkillerPromoteTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
        targetAgents: ["build"],
      });
      expect(r.ok).toBe(true);
      expect(existsSync(join(fx.skillRoot, name, "SKILL.md"))).toBe(true);
      const after = readFileSync(join(fx.agentsRoot, "build.md"), "utf-8");
      expect(after).toContain(`    ${name}: allow`);
      expect(after.replace(`    ${name}: allow\n`, "")).toBe(before);
      // 未指定的 agent 不受影響
      expect(readFileSync(join(fx.agentsRoot, "arch.md"), "utf-8")).not.toContain(`${name}: allow`);
    } finally {
      ws.cleanup();
    }
  });

  test("缺省 targetAgents 時不寫任何 agent 檔（行為與現狀相同）", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "api-design";
      const fx = createRoutingFixture([name]);
      fixtures.push(fx);
      writeDraft(fx, name, validSkillMd(name));
      const deps = makeDeps(ws, fx);
      const beforeBuild = readFileSync(join(fx.agentsRoot, "build.md"), "utf-8");
      const beforeArch = readFileSync(join(fx.agentsRoot, "arch.md"), "utf-8");

      const r = await execFactory(createSkillerPromoteTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(r.ok).toBe(true);
      expect(readFileSync(join(fx.agentsRoot, "build.md"), "utf-8")).toBe(beforeBuild);
      expect(readFileSync(join(fx.agentsRoot, "arch.md"), "utf-8")).toBe(beforeArch);
    } finally {
      ws.cleanup();
    }
  });

  test("非 managed scope 帶 targetAgents 一律拒絕", async () => {
    const ws = createTestWorkspace();
    try {
      const fx = createRoutingFixture([]);
      fixtures.push(fx);
      const deps = makeDeps(ws, fx);
      const slug = ws.root.split("/").pop()!.toLowerCase();
      const projectName = `project-${slug}-demo`;
      // project scope 走 project-local draft root：fixture 必須有效，
      // 讓這個測試在缺少 scope gate 時真的會成功（紅在對的原因）。
      const dir = join(ws.root, ".opencode", "skill-drafts", projectName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), validSkillMd(projectName), "utf-8");
      const r = await execFactory(createSkillerPromoteTool, deps, {
        scope: "project",
        name: projectName,
        mode: "apply",
        confirm: true,
        targetAgents: ["build"],
      });
      expect(r.ok).toBe(false);
      expect(String((r as { code?: string }).code ?? "")).toMatch(/TARGET_AGENTS/);
    } finally {
      ws.cleanup();
    }
  });

  test("未知 agent 名被拒絕", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "api-design";
      const fx = createRoutingFixture([name]);
      fixtures.push(fx);
      writeDraft(fx, name, validSkillMd(name));
      const deps = makeDeps(ws, fx);
      const r = await execFactory(createSkillerPromoteTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
        targetAgents: ["no-such-agent"],
      });
      expect(r.ok).toBe(false);
      // bundle 不得已被寫入：agent 名驗證在任何 mutation 之前
      expect(existsSync(join(fx.skillRoot, name))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("缺 skill 區塊的 agent 回報 skipped 且不寫檔", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "api-design";
      const fx = createRoutingFixture([name]);
      fixtures.push(fx);
      writeDraft(fx, name, validSkillMd(name));
      writeFileSync(
        join(fx.agentsRoot, "plain.md"),
        `---\ndescription: no skill block\nmode: subagent\npermission:\n  edit: deny\n---\n\nbody\n`,
        "utf-8",
      );
      const deps = makeDeps(ws, fx);
      const before = readFileSync(join(fx.agentsRoot, "plain.md"), "utf-8");
      const r = await execFactory(createSkillerPromoteTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
        targetAgents: ["plain"],
      });
      expect(r.ok).toBe(true);
      expect(JSON.stringify(r.data)).toMatch(/skipped/i);
      expect(readFileSync(join(fx.agentsRoot, "plain.md"), "utf-8")).toBe(before);
    } finally {
      ws.cleanup();
    }
  });

  test("同一 agent 已有同名 exact 行時冪等（不重複插入）", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "api-design";
      const fx = createRoutingFixture([name]);
      fixtures.push(fx);
      writeDraft(fx, name, validSkillMd(name));
      const deps = makeDeps(ws, fx);
      const first = await execFactory(createSkillerPromoteTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
        targetAgents: ["build"],
      });
      expect(first.ok).toBe(true);
      const afterFirst = readFileSync(join(fx.agentsRoot, "build.md"), "utf-8");
      // 第二次 promote 同名 skill（overwrite）仍不得重複插入
      const second = await execFactory(createSkillerPromoteTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
        overwrite: true,
        targetAgents: ["build"],
      });
      expect(second.ok).toBe(true);
      const afterSecond = readFileSync(join(fx.agentsRoot, "build.md"), "utf-8");
      expect(afterSecond).toBe(afterFirst);
      expect(afterSecond.split(`    ${name}: allow`).length - 1).toBe(1);
    } finally {
      ws.cleanup();
    }
  });

  test("managed 命名規範：personal- prefix 的 skill 名被拒絕", async () => {
    const ws = createTestWorkspace();
    try {
      const fx = createRoutingFixture([]);
      fixtures.push(fx);
      const deps = makeDeps(ws, fx);
      const r = await execFactory(createSkillerPromoteTool, deps, {
        scope: "managed",
        name: "personal-demo-capability",
        mode: "apply",
        confirm: true,
        targetAgents: ["build"],
      });
      expect(r.ok).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("agent 檔寫入失敗時原檔不變（原子寫入）", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "api-design";
      const fx = createRoutingFixture([name]);
      fixtures.push(fx);
      writeDraft(fx, name, validSkillMd(name));
      const before = readFileSync(join(fx.agentsRoot, "build.md"), "utf-8");
      const deps = makeDeps(ws, fx, {
        writeFile: (path: string, content: string) => {
          if (path.startsWith(fx.agentsRoot)) throw new Error("injected agent write failure");
          writeFileSync(path, content, "utf-8");
        },
      });
      const r = await execFactory(createSkillerPromoteTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
        targetAgents: ["build"],
      });
      expect(r.ok).toBe(true);
      expect(JSON.stringify(r.data)).toMatch(/fail/i);
      expect(readFileSync(join(fx.agentsRoot, "build.md"), "utf-8")).toBe(before);
    } finally {
      ws.cleanup();
    }
  });
});

// ─── retire：掃描全部 agent 檔移除 exact 行 ────────────────────

describe("49 - retire managed 移除全域 exact 行", () => {
  test("preview 顯示將修改哪些檔案，不移動", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "api-design";
      const content = validSkillMd(name);
      const fx = createRoutingFixture([name]);
      fixtures.push(fx);
      writeInstalled(fx, name, content);
      writeFileSync(
        join(fx.agentsRoot, "build.md"),
        agentFileContent([...STANDARD_SKILL_LINES, `    ${name}: allow`]),
        "utf-8",
      );
      const deps = makeDeps(ws, fx);
      const r = await execFactory(createSkillerRetireTool, deps, { scope: "managed", name });
      expect(r.ok).toBe(true);
      expect(JSON.stringify(r.data)).toContain("build.md");
      expect(existsSync(join(fx.skillRoot, name))).toBe(true);
      expect(readFileSync(join(fx.agentsRoot, "build.md"), "utf-8")).toContain(`${name}: allow`);
    } finally {
      ws.cleanup();
    }
  });

  test("apply 移除所有 agent 檔的 exact 行（無論 allow/ask/deny）", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "api-design";
      const content = validSkillMd(name);
      const fx = createRoutingFixture([name]);
      fixtures.push(fx);
      writeInstalled(fx, name, content);
      writeFileSync(
        join(fx.agentsRoot, "build.md"),
        agentFileContent([...STANDARD_SKILL_LINES, `    ${name}: allow`]),
        "utf-8",
      );
      writeFileSync(
        join(fx.agentsRoot, "arch.md"),
        agentFileContent([...STANDARD_SKILL_LINES, `    ${name}: ask`]),
        "utf-8",
      );
      const deps = makeDeps(ws, fx);
      const r = await execFactory(createSkillerRetireTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(r.ok).toBe(true);
      expect(existsSync(join(fx.quarantineRoot, name, "SKILL.md"))).toBe(true);
      for (const agent of ["build", "arch"]) {
        const after = readFileSync(join(fx.agentsRoot, `${agent}.md`), "utf-8");
        expect(after).not.toContain(`${name}:`);
        expect(after).toBe(agentFileContent(STANDARD_SKILL_LINES));
      }
    } finally {
      ws.cleanup();
    }
  });

  test("沒有任何 agent 檔含該行時成功且無檔案變更", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "api-design";
      const content = validSkillMd(name);
      const fx = createRoutingFixture([name]);
      fixtures.push(fx);
      writeInstalled(fx, name, content);
      const deps = makeDeps(ws, fx);
      const beforeBuild = readFileSync(join(fx.agentsRoot, "build.md"), "utf-8");
      const r = await execFactory(createSkillerRetireTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(r.ok).toBe(true);
      expect(readFileSync(join(fx.agentsRoot, "build.md"), "utf-8")).toBe(beforeBuild);
    } finally {
      ws.cleanup();
    }
  });
});

// ─── restore：targetAgents 重新插入 ───────────────────────────

describe("49 - restore managed targetAgents 重新插入", () => {
  test("restore 帶 targetAgents 時復原後重新插入 exact 行", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "api-design";
      const content = validSkillMd(name);
      const fx = createRoutingFixture([name]);
      fixtures.push(fx);
      writeInstalled(fx, name, content);
      const deps = makeDeps(ws, fx);
      const retired = await execFactory(createSkillerRetireTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(retired.ok).toBe(true);
      const restored = await execFactory(createSkillerRestoreTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
        targetAgents: ["build"],
      });
      expect(restored.ok).toBe(true);
      expect(existsSync(join(fx.skillRoot, name, "SKILL.md"))).toBe(true);
      expect(readFileSync(join(fx.agentsRoot, "build.md"), "utf-8")).toContain(`    ${name}: allow`);
      expect(readFileSync(join(fx.agentsRoot, "arch.md"), "utf-8")).not.toContain(`${name}: allow`);
    } finally {
      ws.cleanup();
    }
  });

  test("restore 缺省 targetAgents 時不寫 agent 檔", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "api-design";
      const content = validSkillMd(name);
      const fx = createRoutingFixture([name]);
      fixtures.push(fx);
      writeInstalled(fx, name, content);
      const deps = makeDeps(ws, fx);
      const retired = await execFactory(createSkillerRetireTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(retired.ok).toBe(true);
      const before = readFileSync(join(fx.agentsRoot, "build.md"), "utf-8");
      const restored = await execFactory(createSkillerRestoreTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
      });
      expect(restored.ok).toBe(true);
      expect(readFileSync(join(fx.agentsRoot, "build.md"), "utf-8")).toBe(before);
    } finally {
      ws.cleanup();
    }
  });

  test("restore 非 managed scope 帶 targetAgents 一律拒絕", async () => {
    const ws = createTestWorkspace();
    try {
      const fx = createRoutingFixture([]);
      fixtures.push(fx);
      const deps = makeDeps(ws, fx);
      const slug = ws.root.split("/").pop()!.toLowerCase();
      const projectName = `project-${slug}-demo`;
      // project-local quarantine fixture 必須有效，讓缺少 scope gate 時真的會成功。
      const qdir = join(ws.root, ".opencode", "skill-quarantine", projectName);
      mkdirSync(qdir, { recursive: true });
      writeFileSync(join(qdir, "SKILL.md"), validSkillMd(projectName), "utf-8");
      const r = await execFactory(createSkillerRestoreTool, deps, {
        scope: "project",
        name: projectName,
        mode: "apply",
        confirm: true,
        targetAgents: ["build"],
      });
      expect(r.ok).toBe(false);
      expect(String((r as { code?: string }).code ?? "")).toMatch(/TARGET_AGENTS/);
    } finally {
      ws.cleanup();
    }
  });
});

// ─── 空行語意：空行視為區塊結束 ───────────────────────────────

const BLANK_AFTER_BLOCK = `---\ndescription: test agent\nmode: subagent\npermission:\n  skill:\n    "*": deny\n    project-*: ask\n\n  read:\n    "*": allow\n---\n\nbody\n`;

const BLANK_INSIDE_BLOCK = `---\ndescription: test agent\nmode: subagent\npermission:\n  skill:\n    "*": deny\n\n    project-*: ask\n---\n\nbody\n`;

describe("49 - agent 檔編輯器空行語意", () => {
  test("區塊後空行：insert 成功，空行保留，新行落在空行前", () => {
    const r = insertAgentSkillAllow(BLANK_AFTER_BLOCK, "api-design");
    expect(r.status).toBe("inserted");
    expect(r.content).toBe(
      `---\ndescription: test agent\nmode: subagent\npermission:\n  skill:\n    "*": deny\n    project-*: ask\n    api-design: allow\n\n  read:\n    "*": allow\n---\n\nbody\n`,
    );
  });

  test("區塊後空行：remove 成功，空行保留", () => {
    const withSkill = BLANK_AFTER_BLOCK.replace(
      `    project-*: ask\n`,
      `    project-*: ask\n    api-design: allow\n`,
    );
    const r = removeAgentSkillLine(withSkill, "api-design");
    expect(r.status).toBe("removed");
    expect(r.content).toBe(BLANK_AFTER_BLOCK);
  });

  test("區塊中間空行：第一個空行即結束區塊，insert 落在空行前", () => {
    const r = insertAgentSkillAllow(BLANK_INSIDE_BLOCK, "api-design");
    expect(r.status).toBe("inserted");
    const lines = r.content!.split("\n");
    const insertedIdx = lines.findIndex((l) => l === "    api-design: allow");
    const blankIdx = lines.findIndex((l) => l === "");
    expect(insertedIdx).toBeGreaterThanOrEqual(0);
    expect(blankIdx).toBeGreaterThanOrEqual(0);
    expect(insertedIdx).toBeLessThan(blankIdx);
    // 空行之後的 key 行不屬於區塊：原樣保留
    expect(r.content).toContain("\n\n    project-*: ask\n");
  });

  test("區塊中間空行之後的 key 行不屬於區塊：remove 回報 absent", () => {
    const r = removeAgentSkillLine(BLANK_INSIDE_BLOCK, "project-*");
    expect(r.status).toBe("absent");
    expect(r.content).toBeNull();
  });

  test("無 skill 區塊維持 skipped", () => {
    const r = insertAgentSkillAllow(
      `---\ndescription: no skill block\nmode: subagent\npermission:\n  edit: deny\n---\n\nbody\n`,
      "api-design",
    );
    expect(r.status).toBe("skipped-no-skill-block");
  });

  test("縮排異常仍為 malformed（fail-closed 不放寬）", () => {
    const r = insertAgentSkillAllow(
      `---\ndescription: x\nmode: subagent\npermission:\n  skill:\n    "*": deny\n      broken-indent: allow\n---\n\nbody\n`,
      "api-design",
    );
    expect(r.status).toBe("malformed");
  });
});

// ─── CRLF 逐字保留 ────────────────────────────────────────────

function toCRLF(s: string): string {
  return s.replace(/\n/g, "\r\n");
}

const LF_AGENT = `---\ndescription: test agent\nmode: subagent\npermission:\n  skill:\n    "*": deny\n    project-*: ask\n    personal-*: ask\n---\n\nbody\n`;

describe("49 - agent 檔編輯器 CRLF 逐字保留", () => {
  test("CRLF insert：除目標行外所有位元組逐字不變，插入行跟隨 CRLF", () => {
    const raw = toCRLF(LF_AGENT);
    const r = insertAgentSkillAllow(raw, "api-design");
    expect(r.status).toBe("inserted");
    expect(r.content).toBe(raw.replace(`    personal-*: ask\r\n`, `    personal-*: ask\r\n    api-design: allow\r\n`));
    expect(r.content).not.toMatch(/(?<!\r)\n/);
  });

  test("CRLF remove：除目標行外所有位元組逐字不變", () => {
    const withSkill = toCRLF(LF_AGENT).replace(
      `    personal-*: ask\r\n`,
      `    personal-*: ask\r\n    api-design: allow\r\n`,
    );
    const r = removeAgentSkillLine(withSkill, "api-design");
    expect(r.status).toBe("removed");
    expect(r.content).toBe(toCRLF(LF_AGENT));
  });

  test("LF 檔不受影響：不引入 CR", () => {
    const r = insertAgentSkillAllow(LF_AGENT, "api-design");
    expect(r.status).toBe("inserted");
    expect(r.content).not.toContain("\r");
  });
});

// 舊版此處會讀真實 agents 目錄作 digest 哨兵；原生測試依約束只使用暫存 fixture。
