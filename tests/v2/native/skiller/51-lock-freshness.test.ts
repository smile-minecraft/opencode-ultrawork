/**
 * 51 — Skiller 鎖內全量重載回歸（Ultra-Coder 統一重構的 Red）。
 *
 * 針對「鎖／交易邊界完整性」障礙：mutation 在取鎖前載入的 policy／bundle
 * 狀態，可能在等待鎖期間被外部改動；鎖內若沿用鎖外狀態，就會把已 drift
 * 或已變 risky 的內容寫進 discovery root。
 *
 * 時序模型（與既有 30／43 測試一致的確定性注入）：
 *   - 以 `resolveProjectRoot` 呼叫次數為注入點：前兩次呼叫（工具轉接層的
 *     context 建立＋執行初期的 project slug 推導）不動；第 3 次起（已落在
 *     鎖前驗證完成之後的路由檢查／鎖內重載）把真實磁碟檔案改掉。
 *   - 變更一律是真實 `writeFileSync` 落盤，不是 mock 回傳值；操作看到或沒
 *     看到，完全取決於它有沒有在鎖內重新載入。
 *   - wall-clock 雙行程競速在本 repo 是 fail-fast busy 語意（搶不到直接
 *     CONTENT_LOCK_BUSY，不排隊等待），無法穩定命中 T0→T1 視窗；此注入是
 *     該視窗的確定性等價，參考 30「promote 驗證後等待鎖期間 draft 附屬檔案
 *     變成 risky」與 43「等待鎖期間草稿被改動」兩案的既有慣例。
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTestWorkspace,
  createFakeContext,
  parseToolResult,
  type TestWorkspace,
} from "./_harness.ts";
import type { SkillerDeps } from "../../../../src/modules/skiller/skiller-common.ts";
import { createSkillerPromoteTool } from "../../../../src/modules/skiller/skiller-promote.ts";
import { createSkillerRestoreTool } from "../../../../src/modules/skiller/skiller-restore.ts";

// ─── fixtures（與 30 號測試同一慣例，絕不碰真實路徑） ──────────

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
  agentsRoot: string;
  cleanup(): void;
}

const fixtures: PersonalFixture[] = [];
const workspaces: TestWorkspace[] = [];
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup();
  while (workspaces.length > 0) workspaces.pop()!.cleanup();
});

function createPersonalFixture(digests: Record<string, string> = {}): PersonalFixture {
  const base = mkdtempSync(join(tmpdir(), "skiller-fresh-"));
  const draftRoot = join(base, "drafts");
  const skillRoot = join(base, "skills");
  const quarantineRoot = join(base, "quarantine");
  const policyPath = join(base, "skills-policy.json");
  const pinsPath = join(base, "skills-personal.json");
  const agentsRoot = join(base, "agents");
  for (const dir of [draftRoot, skillRoot, quarantineRoot, agentsRoot]) mkdirSync(dir, { recursive: true });
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
  writeFileSync(pinsPath, `${JSON.stringify({ schemaVersion: 1, pins: {} }, null, 2)}\n`, "utf-8");
  const fx = { base, draftRoot, skillRoot, quarantineRoot, policyPath, pinsPath, agentsRoot, cleanup() { rmSync(base, { recursive: true, force: true }); } };
  fixtures.push(fx);
  return fx;
}

function workspace(): TestWorkspace {
  const ws = createTestWorkspace("skiller-fresh-ws-");
  workspaces.push(ws);
  return ws;
}

function validSkillMd(name: string): string {
  return `---\nname: ${name}\ndescription: demo skill for tests\n---\n\n# ${name}\n\nUse this skill carefully.\n`;
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

function makeDeps(ws: TestWorkspace, fx: PersonalFixture): SkillerDeps {
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

const WRONG_DIGEST = "f".repeat(64);
const SECRET_APPENDIX = "\nsecret ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456\n";

describe("51 - skiller 鎖內全量重載", () => {
  test("promote：等待鎖期間 policy 變更（contentDigest drift）→ 鎖內必須以新 policy 重驗拒絕", async () => {
    const ws = workspace();
    writeAgentRouteFile(ws, "build");
    const name = "personal-fresh-promote";
    const fx = createPersonalFixture();
    const draftDir = join(fx.draftRoot, name);
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(join(draftDir, "SKILL.md"), validSkillMd(name), "utf-8");
    const base = makeDeps(ws, fx);

    // 基準證據：變更尚未注入時 preview 是 ready（證明之後的拒絕來自新狀態，而非原本就壞）。
    const preview = await execFactory(createSkillerPromoteTool, base, {
      scope: "personal", name, targetAgentGroups: ["implementation"],
    });
    expect(preview.ok).toBe(true);
    expect((preview.data as { readiness: string }).readiness).toBe("ready");

    // 注入點：第 3 次 resolveProjectRoot 起（落在鎖前驗證完成之後的路由檢查
    // 及其後的鎖內重載），把 policy 加上一筆與草稿不符的 digest。
    let resolveCalls = 0;
    const racingDeps: SkillerDeps = {
      ...base,
      resolveProjectRoot: () => {
        resolveCalls += 1;
        if (resolveCalls >= 3) {
          const policy = JSON.parse(readFileSync(fx.policyPath, "utf-8")) as {
            approval: { contentDigests: Record<string, string> };
          };
          policy.approval.contentDigests[name] = WRONG_DIGEST;
          writeFileSync(fx.policyPath, JSON.stringify(policy, null, 2), "utf-8");
        }
        return ws.root;
      },
    };
    const result = await execFactory(createSkillerPromoteTool, racingDeps, {
      scope: "personal", name, mode: "apply", confirm: true, targetAgentGroups: ["implementation"],
    });
    expect(resolveCalls).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(readFileSync(fx.policyPath, "utf-8")).approval.contentDigests[name]).toBe(WRONG_DIGEST);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("PROMOTION_BLOCKED");
    const blockers = ((result.data as { blockers: Array<{ code: string }> }).blockers ?? []).map((b) => b.code);
    expect(blockers).toContain("POLICY_DIGEST_DRIFT");
    expect(existsSync(join(fx.skillRoot, name))).toBe(false);
  });

  test("restore：等待鎖期間附屬檔案變 risky → 鎖內必須全量重驗拒絕（只比 SKILL.md digest 不夠）", async () => {
    const ws = workspace();
    writeAgentRouteFile(ws, "build");
    const name = "personal-fresh-restore";
    const content = validSkillMd(name);
    const fx = createPersonalFixture();
    writeFileSync(fx.pinsPath, `${JSON.stringify({
      schemaVersion: 1,
      pins: {
        [name]: {
          name,
          digest: "0".repeat(64),
          targetAgentGroups: ["implementation"],
          resolvedTargetAgents: ["build"],
          status: "retired",
          promotedAt: new Date().toISOString(),
          retiredAt: new Date().toISOString(),
        },
      },
    }, null, 2)}\n`, "utf-8");
    const sourceDir = join(fx.quarantineRoot, name);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "SKILL.md"), content, "utf-8");
    const notesPath = join(sourceDir, "notes.md");
    writeFileSync(notesPath, "# safe notes\n", "utf-8");
    const base = makeDeps(ws, fx);

    // 基準證據：變更尚未注入時 preview 是 ready。
    const preview = await execFactory(createSkillerRestoreTool, base, { scope: "personal", name });
    expect(preview.ok).toBe(true);
    expect((preview.data as { readiness: string }).readiness).toBe("ready");

    // 注入點：第 3 次起把附屬檔案加上 secret marker；SKILL.md 本身完全不動，
    // 只比 SKILL.md digest 的實作看不見這個變更。
    let resolveCalls = 0;
    const racingDeps: SkillerDeps = {
      ...base,
      resolveProjectRoot: () => {
        resolveCalls += 1;
        if (resolveCalls >= 3) {
          const current = readFileSync(notesPath, "utf-8");
          if (!current.includes("ghp_")) writeFileSync(notesPath, `${current}${SECRET_APPENDIX}`, "utf-8");
        }
        return ws.root;
      },
    };
    const result = await execFactory(createSkillerRestoreTool, racingDeps, {
      scope: "personal", name, mode: "apply", confirm: true,
    });
    expect(resolveCalls).toBeGreaterThanOrEqual(3);
    // 缺陷版會把 bundle 搬進 skill root；修正版必須留在 quarantine。
    // 無論落在哪一邊，附屬檔案的變更都必須已落盤（證明注入確實發生）。
    const movedNotes = join(fx.skillRoot, name, "notes.md");
    const finalNotesPath = existsSync(notesPath) ? notesPath : movedNotes;
    expect(readFileSync(finalNotesPath, "utf-8")).toContain("ghp_");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("RESTORE_BLOCKED");
    const blockers = ((result.data as { blockers: Array<{ code: string; message: string }> }).blockers ?? []);
    expect(blockers.some((b) => b.code === "SECRET_MARKER" && b.message.includes("notes.md"))).toBe(true);
    expect(existsSync(join(fx.quarantineRoot, name))).toBe(true);
    expect(existsSync(join(fx.skillRoot, name))).toBe(false);
  });
});
