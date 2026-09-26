/**
 * 50 — skiller V2 形狀角色檔（permissions: 陣列）的權限路由閉環。
 *
 * V2 形狀依據：repo 釘住的 @opencode/schema@2.0.16
 *（Permission.Rule = {action, resource, effect}，Ruleset = Array<Rule>；
 * Agent.Info.default() 的 canonical 樣本見 node_modules/@opencode/schema/dist/agent.js）。
 * 排版依據：2026-09-26 於使用者的全域 agent 設定目錄實際觀察到 V2 形狀的 agent 檔
 *（`permissions:` 陣列形狀）。本檔只取其排版結構做成去識別化 fixture：原始檔案的
 * description、model、color、steps 以及具體工具與技能名稱，一律換成一般化佔位字串，
 * 不保留任何真實內容。
 * 保留的排版結構：頂層鍵之後接序列、2 空格 dash 與 4 空格續行、帶星號的 resource 加引號、
 * skill 規則在序列中段連續聚在一起、並保持 last-match 順序（概括的 deny 在具體 allow 之前）。
 * 行級編輯器接受
 * 任何一致的縮排與鍵順序（不寫死單一排版），其餘一律 fail closed。
 *
 * 與 49 號 V1 測試平行：狀態表（inserted/already-present/removed/absent/
 * skipped-no-skill-block/malformed）與 V1 一字對應；49 號原案例不得改寫。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  agentHasPersonalAskRoute,
  insertAgentSkillAllow,
  parseFrontmatter,
  removeAgentSkillLine,
} from "../../../../src/modules/skiller/skiller-common.ts";
import { createSkillerPromoteTool } from "../../../../src/modules/skiller/skiller-promote.ts";
import { createSkillerRetireTool } from "../../../../src/modules/skiller/skiller-retire.ts";
import { createSkillerRestoreTool } from "../../../../src/modules/skiller/skiller-restore.ts";

function validSkillMd(name: string, description = "demo skill for tests"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nUse this skill carefully.\n`;
}

/** V2 形狀的 agent 檔：permissions 陣列，元素為 {action, resource, effect}。 */
function v2AgentContent(items: string[]): string {
  return `---\ndescription: test agent\nmode: subagent\npermissions:\n${items.join("\n")}\n---\n\nbody\n`;
}

const V2_STANDARD_ITEMS = [
  `  - action: skill`,
  `    resource: "*"`,
  `    effect: deny`,
  `  - action: skill`,
  `    resource: personal-*`,
  `    effect: ask`,
];

const V2_STANDARD = v2AgentContent(V2_STANDARD_ITEMS);

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

function createRoutingFixture(managedNames: string[]): RoutingFixture {
  const base = mkdtempSync(join(tmpdir(), "skiller-v2-routing-"));
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
    writeFileSync(join(agentsRoot, `${agent}.md`), V2_STANDARD, "utf-8");
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

// ─── V2 行級編輯器 ──────────────────────────────────────────────

describe("50 - V2 insert/remove 行級編輯", () => {
  test("insert：在序列尾端追加 skill 項目，其餘位元組逐字不變", () => {
    const r = insertAgentSkillAllow(V2_STANDARD, "subject-skill");
    expect(r.status).toBe("inserted");
    expect(r.content).toBe(
      v2AgentContent([
        ...V2_STANDARD_ITEMS,
        `  - action: skill`,
        `    resource: subject-skill`,
        `    effect: allow`,
      ]),
    );
  });

  test("remove：移除該 skill 項目（無論 effect），其餘逐字不變", () => {
    const withSkill = v2AgentContent([
      ...V2_STANDARD_ITEMS,
      `  - action: skill`,
      `    resource: subject-skill`,
      `    effect: allow`,
    ]);
    const r = removeAgentSkillLine(withSkill, "subject-skill");
    expect(r.status).toBe("removed");
    expect(r.currentValue).toBe("allow");
    expect(r.content).toBe(V2_STANDARD);
  });

  test("remove：effect 為 ask/deny 的舊行同樣移除（retire 不留舊值）", () => {
    for (const effect of ["ask", "deny"]) {
      const withSkill = v2AgentContent([
        ...V2_STANDARD_ITEMS,
        `  - action: skill`,
        `    resource: subject-skill`,
        `    effect: ${effect}`,
      ]);
      const r = removeAgentSkillLine(withSkill, "subject-skill");
      expect(r.status, effect).toBe("removed");
      expect(r.content, effect).toBe(V2_STANDARD);
    }
  });

  test("已存在同名 skill 項目時冪等回報 already-present", () => {
    const withSkill = v2AgentContent([
      ...V2_STANDARD_ITEMS,
      `  - action: skill`,
      `    resource: subject-skill`,
      `    effect: ask`,
    ]);
    const r = insertAgentSkillAllow(withSkill, "subject-skill");
    expect(r.status).toBe("already-present");
    expect(r.currentValue).toBe("ask");
    expect(r.content).toBeNull();
  });

  test("沒有 skill 項目時回報 skipped（不建立路由結構）", () => {
    const noSkill = v2AgentContent([`  - action: edit`, `    resource: "*"`, `    effect: deny`]);
    expect(insertAgentSkillAllow(noSkill, "subject-skill").status).toBe("skipped-no-skill-block");
    expect(removeAgentSkillLine(noSkill, "subject-skill").status).toBe("skipped-no-skill-block");
  });

  test("鍵順序與引號排版不影響判定（不寫死排版）", () => {
    const reordered = v2AgentContent([
      `  - effect: ask`,
      `    action: skill`,
      `    resource: "personal-*"`,
    ]);
    const r = insertAgentSkillAllow(reordered, "subject-skill");
    expect(r.status).toBe("inserted");
    expect(r.content).toContain("resource: subject-skill");
    const dup = insertAgentSkillAllow(reordered, "personal-*");
    expect(dup.status).toBe("already-present");
    expect(dup.currentValue).toBe("ask");
  });

  test("flow 項目、純量 permissions、tab 縮排一律 malformed", () => {
    const flow = v2AgentContent([`  - {action: skill, resource: personal-*, effect: ask}`]);
    expect(insertAgentSkillAllow(flow, "subject-skill").status).toBe("malformed");
    const scalar = `---\ndescription: test agent\nmode: subagent\npermissions: oops\n---\n\nbody\n`;
    expect(insertAgentSkillAllow(scalar, "subject-skill").status).toBe("malformed");
    const tabbed = `---\ndescription: test agent\nmode: subagent\npermissions:\n\t- action: skill\n\t  resource: personal-*\n\t  effect: ask\n---\n\nbody\n`;
    expect(insertAgentSkillAllow(tabbed, "subject-skill").status).toBe("malformed");
  });

  test("V1 與 V2 並存（mixed）一律 malformed，不猜結構", () => {
    const mixed = `---\ndescription: test agent\nmode: subagent\npermission:\n  skill:\n    personal-*: ask\npermissions:\n  - action: skill\n    resource: personal-*\n    effect: ask\n---\n\nbody\n`;
    expect(insertAgentSkillAllow(mixed, "subject-skill").status).toBe("malformed");
    expect(removeAgentSkillLine(mixed, "personal-*").status).toBe("malformed");
  });

  test("空陣列 permissions: [] 可插入第一個 skill 項目", () => {
    const empty = `---\ndescription: test agent\nmode: subagent\npermissions: []\n---\n\nbody\n`;
    const r = insertAgentSkillAllow(empty, "subject-skill");
    expect(r.status).toBe("inserted");
    expect(r.content).toContain("resource: subject-skill");
  });
});

// ─── 真實 V2 排版樣本 ──────────────────────────────────────────

/**
 * 去識別化的實際排版樣本：2026-09-26 於使用者的全域 agent 設定目錄觀察到
 * V2 形狀（`permissions:` 陣列）的 agent 檔，取其排版結構而成。原始檔案的
 * 檔名、description、model、color、steps 與具體工具／技能名稱一律未保留，
 * 全部換成一般化佔位字串。
 */
const DEIDENTIFIED_LAYOUT_ITEMS = [
  `  - action: tool_alpha`,
  `    resource: "*"`,
  `    effect: deny`,
  `  - action: skill`,
  `    resource: "*"`,
  `    effect: deny`,
  `  - action: skill`,
  `    resource: namespace-a-*`,
  `    effect: ask`,
  `  - action: skill`,
  `    resource: namespace-b-*`,
  `    effect: ask`,
  `  - action: skill`,
  `    resource: sample-skill`,
  `    effect: allow`,
  `  - action: tool_beta`,
  `    resource: "*"`,
  `    effect: allow`,
];

const DEIDENTIFIED_LAYOUT = v2AgentContent(DEIDENTIFIED_LAYOUT_ITEMS);

describe("50 - 去識別化的實際排版樣本", () => {
  /** 最後一個 skill 項目的下一行索引（webfetch 項目的第一行）。 */
  const SKILL_BLOCK_END = DEIDENTIFIED_LAYOUT_ITEMS.findIndex((line) => line.includes("action: tool_beta"));

  test("insert 落在最後一個 skill 項目之後，不跑到陣列尾端", () => {
    const r = insertAgentSkillAllow(DEIDENTIFIED_LAYOUT, "subject-skill");
    expect(r.status).toBe("inserted");
    // skill 規則維持同一段連續區塊：新項目緊接在 opencode 之後、webfetch 之前。
    expect(r.content).toBe(
      v2AgentContent([
        ...DEIDENTIFIED_LAYOUT_ITEMS.slice(0, SKILL_BLOCK_END),
        `  - action: skill`,
        `    resource: subject-skill`,
        `    effect: allow`,
        ...DEIDENTIFIED_LAYOUT_ITEMS.slice(SKILL_BLOCK_END),
      ]),
    );
  });

  test("insert 後新 allow 排在 skill deny 之後，last-match 下勝出", () => {
    const content = insertAgentSkillAllow(DEIDENTIFIED_LAYOUT, "subject-skill").content!;
    expect(content.indexOf("resource: subject-skill")).toBeGreaterThan(content.indexOf(`    resource: "*"\n    effect: deny`));
    expect(parseFrontmatter(content).ok).toBe(true);
  });

  test("remove 精準移除該 skill 項目，其餘逐字不變", () => {
    const withSkill = v2AgentContent([
      ...DEIDENTIFIED_LAYOUT_ITEMS,
      `  - action: skill`,
      `    resource: subject-skill`,
      `    effect: allow`,
    ]);
    const r = removeAgentSkillLine(withSkill, "subject-skill");
    expect(r.status).toBe("removed");
    expect(r.currentValue).toBe("allow");
    expect(r.content).toBe(DEIDENTIFIED_LAYOUT);
  });

  test("CRLF 的 V2 檔案同樣可插入且沿用 CRLF", () => {
    const crlf = DEIDENTIFIED_LAYOUT.replace(/\n/g, "\r\n");
    const r = insertAgentSkillAllow(crlf, "subject-skill");
    expect(r.status).toBe("inserted");
    expect(r.content).toContain(`  - action: skill\r\n    resource: subject-skill\r\n    effect: allow\r\n`);
  });
});

// ─── agentHasPersonalAskRoute V2 ────────────────────────────────

describe("50 - agentHasPersonalAskRoute V2 判定", () => {
  function depsWithGlobalAgents(ws: TestWorkspace, files: Record<string, string>): SkillerDeps {
    const dir = mkdtempSync(join(tmpdir(), "skiller-v2-hasroute-"));
    fixtures.push({ cleanup: () => rmSync(dir, { recursive: true, force: true }) });
    for (const [name, content] of Object.entries(files)) {
      // agent 檔名帶 .md：agentHasPersonalAskRoute 讀的是 <agent>.md。
      writeFileSync(join(dir, `${name}.md`), content, "utf-8");
    }
    return { resolveProjectRoot: () => ws.root, roots: { agentsRoot: dir } };
  }

  test("personal-* ask 路由回 true", () => {
    const ws = createTestWorkspace();
    try {
      const deps = depsWithGlobalAgents(ws, { build: V2_STANDARD });
      expect(agentHasPersonalAskRoute(ws.root, "build", deps)).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  test("personal-* deny（最後一條）回 false", () => {
    const ws = createTestWorkspace();
    try {
      const content = v2AgentContent([
        `  - action: skill`,
        `    resource: personal-*`,
        `    effect: deny`,
      ]);
      const deps = depsWithGlobalAgents(ws, { build: content });
      expect(agentHasPersonalAskRoute(ws.root, "build", deps)).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  test("last-match：deny 之後再 allow 回 true", () => {
    const ws = createTestWorkspace();
    try {
      const content = v2AgentContent([
        `  - action: skill`,
        `    resource: personal-*`,
        `    effect: deny`,
        `  - action: skill`,
        `    resource: personal-*`,
        `    effect: allow`,
      ]);
      const deps = depsWithGlobalAgents(ws, { build: content });
      expect(agentHasPersonalAskRoute(ws.root, "build", deps)).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  test("沒有 skill 項目回 false", () => {
    const ws = createTestWorkspace();
    try {
      const content = v2AgentContent([`  - action: edit`, `    resource: "*"`, `    effect: allow`]);
      const deps = depsWithGlobalAgents(ws, { build: content });
      expect(agentHasPersonalAskRoute(ws.root, "build", deps)).toBe(false);
    } finally {
      ws.cleanup();
    }
  });
});

// ─── 工具層閉環（promote / retire / restore）────────────────────

describe("50 - promote/retire/restore 走 V2 路由", () => {
  test("promote apply 在 V2 agent 檔插入 skill 項目", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "subject-skill";
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
      expect(after).toContain("resource: subject-skill");
      expect(after).toContain("effect: allow");
      expect(after.replace(/  - action: skill\n    resource: subject-skill\n    effect: allow\n/, "")).toBe(before);
      expect(readFileSync(join(fx.agentsRoot, "arch.md"), "utf-8")).not.toContain("subject-skill");
    } finally {
      ws.cleanup();
    }
  });

  test("retire apply 移除 V2 agent 檔的 skill 項目", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "subject-skill";
      const fx = createRoutingFixture([name]);
      fixtures.push(fx);
      writeInstalled(fx, name, validSkillMd(name));
      writeFileSync(
        join(fx.agentsRoot, "build.md"),
        v2AgentContent([...V2_STANDARD_ITEMS, `  - action: skill`, `    resource: ${name}`, `    effect: allow`]),
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
      expect(readFileSync(join(fx.agentsRoot, "build.md"), "utf-8")).toBe(V2_STANDARD);
    } finally {
      ws.cleanup();
    }
  });

  test("restore apply 在 V2 agent 檔重新插入 skill 項目", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "subject-skill";
      const fx = createRoutingFixture([name]);
      fixtures.push(fx);
      writeInstalled(fx, name, validSkillMd(name));
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
      expect(readFileSync(join(fx.agentsRoot, "build.md"), "utf-8")).toContain("resource: subject-skill");
    } finally {
      ws.cleanup();
    }
  });

  test("mixed 形狀的 agent 檔回報 skipped 且不寫檔", async () => {
    const ws = createTestWorkspace();
    try {
      const name = "subject-skill";
      const fx = createRoutingFixture([name]);
      fixtures.push(fx);
      writeDraft(fx, name, validSkillMd(name));
      const mixed = `---\ndescription: test agent\nmode: subagent\npermission:\n  skill:\n    personal-*: ask\npermissions:\n  - action: skill\n    resource: personal-*\n    effect: ask\n---\n\nbody\n`;
      writeFileSync(join(fx.agentsRoot, "build.md"), mixed, "utf-8");
      const deps = makeDeps(ws, fx);
      const r = await execFactory(createSkillerPromoteTool, deps, {
        scope: "managed",
        name,
        mode: "apply",
        confirm: true,
        targetAgents: ["build"],
      });
      expect(r.ok).toBe(true);
      expect(JSON.stringify(r.data)).toMatch(/skipped/i);
      expect(readFileSync(join(fx.agentsRoot, "build.md"), "utf-8")).toBe(mixed);
    } finally {
      ws.cleanup();
    }
  });
});

// ─── 項目之間的空行 ────────────────────────────────────────────

describe("50 - V2 序列項目之間的空行", () => {
  const SKILL_RULE = (resource: string, effect: string): string[] => [
    `  - action: skill`,
    `    resource: ${resource}`,
    `    effect: ${effect}`,
  ];

  test("retire：目標規則在空行之後，仍必須被移除（修正前只掃前半段會回 absent）", () => {
    const raw = v2AgentContent([
      ...SKILL_RULE(`"*"`, "deny"),
      ``,
      ...SKILL_RULE("subject-skill", "allow"),
    ]);
    const r = removeAgentSkillLine(raw, "subject-skill");
    expect(r.status).toBe("removed");
    expect(r.currentValue).toBe("allow");
    // 移除後剩下的就是前半段，空行保留。
    expect(r.content).toBe(v2AgentContent([...SKILL_RULE(`"*"`, "deny"), ``]));
  });

  test("promote：空行之後若有同名規則，不得靜默插到會被覆蓋的位置", () => {
    const raw = v2AgentContent([...SKILL_RULE(`"*"`, "deny"), ``, ...SKILL_RULE("new-skill", "deny")]);
    const r = insertAgentSkillAllow(raw, "new-skill");
    // 與 V1 語意一致：已存在同名 exact 行就冪等回報，不重複插入。
    expect(r.status).toBe("already-present");
    expect(r.currentValue).toBe("deny");
    expect(r.content).toBeNull();
  });

  test("promote：空行之後沒有同名規則時，新 allow 排在最後一種 action 之後", () => {
    const raw = v2AgentContent([
      ...SKILL_RULE(`"*"`, "deny"),
      ``,
      `  - action: sample_tool`,
      `    resource: "other"`,
      `    effect: allow`,
    ]);
    const r = insertAgentSkillAllow(raw, "subject-skill");
    expect(r.status).toBe("inserted");
    // 不论空行分隔在哪裡，新 allow 後面不得還有任何能覆蓋 skill 的規則（action 為 skill 或 *）。，後面不得再有任何 action 規則可蓋掉它。
    const after = r.content!.slice(r.content!.indexOf("resource: subject-skill"));
    expect(after).not.toMatch(/^\s*-\s*action:\s*(skill|\*)\s*$/m);
  });

  test("空行落在某個項目內部（`- key:` 與續行之間）→ malformed，不猜", () => {
    const raw = `---\ndescription: placeholder\nmode: subagent\npermissions:\n  - action: skill\n\n    resource: personal-*\n    effect: ask\n---\n\nbody\n`;
    expect(insertAgentSkillAllow(raw, "subject-skill").status).toBe("malformed");
    expect(removeAgentSkillLine(raw, "personal-*").status).toBe("malformed");
  });

  test("序列尾端與尾端的空行不影響既有行為", () => {
    const raw = v2AgentContent([...SKILL_RULE(`"*"`, "deny"), ...SKILL_RULE("personal-*", "ask"), ``]);
    expect(insertAgentSkillAllow(raw, "subject-skill").status).toBe("inserted");
    expect(removeAgentSkillLine(raw, "personal-*").status).toBe("removed");
  });
});

describe("50 - 值帶空白的規則（shell 指令）", () => {
  const SHELL_ITEMS = [
    `  - action: shell`,
    `    resource: git status *`,
    `    effect: allow`,
    `  - action: shell`,
    `    resource: "git push *"`,
    `    effect: ask`,
  ];

  test("shell 規則的 resource 帶空白時，整份仍可插入 skill 項目", () => {
    const raw = v2AgentContent([...SHELL_ITEMS, ...V2_STANDARD_ITEMS]);
    const r = insertAgentSkillAllow(raw, "subject-skill");
    expect(r.status).toBe("inserted");
    expect(r.content).toBe(
      v2AgentContent([...SHELL_ITEMS, ...V2_STANDARD_ITEMS, `  - action: skill`, `    resource: subject-skill`, `    effect: allow`]),
    );
    expect(parseFrontmatter(r.content!).ok).toBe(true);
  });

  test("shell 規則在 skill 規則之後、以及位在項目第一行時同樣可解析", () => {
    const raw = v2AgentContent([
      ...V2_STANDARD_ITEMS,
      `  - resource: git log *`,
      `    action: shell`,
      `    effect: allow`,
      `  - action: skill`,
      `    resource: subject-skill`,
      `    effect: allow`,
    ]);
    const r = removeAgentSkillLine(raw, "subject-skill");
    expect(r.status).toBe("removed");
    expect(r.content).toBe(
      v2AgentContent([...V2_STANDARD_ITEMS, `  - resource: git log *`, `    action: shell`, `    effect: allow`]),
    );
  });

  test("帶空白但會被 YAML 讀成註解、巢狀映射或破損引號的值一律 malformed", () => {
    for (const resource of [`git status # note`, `git: status`, `git status:`, `"git status *`, `"git" "status"`]) {
      const raw = v2AgentContent([
        `  - action: shell`,
        `    resource: ${resource}`,
        `    effect: allow`,
        ...V2_STANDARD_ITEMS,
      ]);
      expect(insertAgentSkillAllow(raw, "subject-skill").status).toBe("malformed");
    }
  });
});
