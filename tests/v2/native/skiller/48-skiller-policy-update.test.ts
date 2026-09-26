/**
 * 48 — skiller-policy-update：把來源、核准與 digest 登記進 skills-policy.json。
 *
 * 行為契約（skiller policy update）：
 *   - preview（預設）：讀取現行 policy、套用請求的變更、回傳 diff 與
 *     expectedSha256，不寫檔。
 *   - apply：需 confirm:true + expectedSha256，以原子寫入更新 policy；
 *     sha 不符（檔案已被外部改動）fail closed。
 *   - 可寫範圍限四個區塊：managed（新增／更新 entry）、
 *     approval.agentAllowlist（新增名稱）、approval.contentDigests
 *     （新增／更新 64 hex digest）、scriptReviews（新增／更新 entry）；
 *     其他區塊逐字保留。
 *   - 防禦性驗證：JSON 可解析、schemaVersion 存在、digest 格式正確、
 *     不得刪除既有 managed entry；結構異常一律 fail closed 不寫。
 *   - 測試一律用暫存 fixture policy 檔（deps 注入路徑），不碰真實檔。
 *
 * @see ../../../../src/modules/skiller/skiller-policy-update.ts — 受測 factory
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTestWorkspace,
  loadPlugin,
  createFakeContext,
  parseToolResult,
  type TestWorkspace,
} from "./_harness.ts";
import type { SkillerDeps } from "../../../../src/modules/skiller/skiller-common.ts";
import { createSkillerPolicyUpdateTool } from "../../../../src/modules/skiller/skiller-policy-update.ts";

// ─── Helpers ─────────────────────────────────────────────────

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex");
}

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);

function basePolicy(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    skillRoot: "/tmp/policy-fixture-skills",
    qualityContract: { requiredFrontmatter: ["name", "description"] },
    managed: {
      "existing-skill": {
        source: "https://example.com/repo/tree/main/skills/existing-skill",
        maintainer: "Example Org",
      },
    },
    builtIn: {
      "customize-opencode": { location: "<built-in>", maintainer: "OpenCode" },
    },
    approval: {
      reviewedAt: "2026-09-01",
      reviewScope: ["frontmatter 與 description trigger 品質"],
      digestAlgorithm: "sha256",
      agentAllowlist: ["alpha-skill"],
      capabilityDigests: { "alpha-skill": HEX_A },
      contentDigests: { "existing-skill": HEX_B },
    },
    scriptReviews: {
      "existing-skill": {
        status: "reviewed",
        files: ["scripts/check.py"],
        note: "唯讀檢查，無外部寫入。",
      },
    },
    locallyUpdated: { "alpha-skill": "測試用註記" },
    personalGovernance: { pinsPath: "/tmp/policy-fixture-pins.json" },
    retired: { obsoleteAgentRuntime: ["old-skill"] },
  };
}

interface PolicyFixture {
  dir: string;
  policyPath: string;
  cleanup(): void;
}

function createPolicyFixture(initial?: Record<string, unknown>): PolicyFixture {
  const dir = mkdtempSync(join(tmpdir(), "skiller-policy-update-fixture-"));
  const ultraworkDir = join(dir, ".ultrawork");
  mkdirSync(ultraworkDir, { recursive: true });
  const policyPath = join(ultraworkDir, "skills-policy.json");
  writeFileSync(policyPath, `${JSON.stringify(initial ?? basePolicy(), null, 2)}\n`, "utf-8");
  return { dir, policyPath, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

const fixtures: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

function makeDeps(ws: TestWorkspace, fx: PolicyFixture): SkillerDeps {
  return {
    resolveProjectRoot: () => ws.root,
    roots: { policyPath: fx.policyPath },
  };
}

type ToolDef = { execute(args: Record<string, unknown>, ctx?: unknown): Promise<any> };

async function execPolicyUpdate(
  deps: SkillerDeps,
  args: Record<string, unknown>,
): Promise<ReturnType<typeof parseToolResult>> {
  const ws = (deps as { resolveProjectRoot: () => string }).resolveProjectRoot();
  const def = createSkillerPolicyUpdateTool(deps) as unknown as ToolDef;
  return parseToolResult(await def.execute(args, createFakeContext(ws) as never));
}

function readRaw(fx: PolicyFixture): string {
  return readFileSync(fx.policyPath, "utf-8");
}

// ─── Section 1：factory 與 preview ────────────────────────────

describe("48 - skiller-policy-update: factory & preview", () => {
  test("factory 存在且三要素健全", () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createPolicyFixture();
    fixtures.push(fx);
    const def = createSkillerPolicyUpdateTool(makeDeps(ws, fx)) as unknown as {
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

  test("preview 回 diff 與 expectedSha256 且不寫檔", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createPolicyFixture();
    fixtures.push(fx);
    const before = readRaw(fx);
    const r = await execPolicyUpdate(makeDeps(ws, fx), {
      managedUpsert: [{ name: "new-skill", source: "https://example.com/repo", maintainer: "Example Org" }],
      allowlistAdd: ["new-skill"],
      contentDigestUpsert: [{ name: "new-skill", digest: HEX_C }],
    });
    expect(r.ok).toBe(true);
    const data = r.data as {
      mode?: string;
      diff?: Array<{ block?: string; action?: string }>;
      expectedSha256?: string;
    };
    expect(data.mode).toBe("preview");
    expect(Array.isArray(data.diff)).toBe(true);
    expect(data.diff!.length).toBeGreaterThan(0);
    expect(data.expectedSha256).toBe(sha256(before));
    // preview 不寫檔
    expect(readRaw(fx)).toBe(before);
  });

  test("preview 空變更回 changed=false 且不寫檔", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createPolicyFixture();
    fixtures.push(fx);
    const before = readRaw(fx);
    const r = await execPolicyUpdate(makeDeps(ws, fx), {});
    expect(r.ok).toBe(true);
    expect((r.data as { changed?: boolean }).changed).toBe(false);
    expect(readRaw(fx)).toBe(before);
  });
});

// ─── Section 2：apply gates 與 sha 競態 ────────────────────────

describe("48 - skiller-policy-update: apply gates", () => {
  test("apply 缺 confirm 回 CONFIRM_REQUIRED 且不寫檔", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createPolicyFixture();
    fixtures.push(fx);
    const before = readRaw(fx);
    const preview = await execPolicyUpdate(makeDeps(ws, fx), {
      allowlistAdd: ["beta-skill"],
    });
    const r = await execPolicyUpdate(makeDeps(ws, fx), {
      mode: "apply",
      expectedSha256: (preview.data as { expectedSha256?: string }).expectedSha256,
      allowlistAdd: ["beta-skill"],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIRM_REQUIRED");
    expect(readRaw(fx)).toBe(before);
  });

  test("apply 缺 expectedSha256 回 EXPECTED_SHA256_REQUIRED 且不寫檔", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createPolicyFixture();
    fixtures.push(fx);
    const before = readRaw(fx);
    const r = await execPolicyUpdate(makeDeps(ws, fx), {
      mode: "apply",
      confirm: true,
      allowlistAdd: ["beta-skill"],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("EXPECTED_SHA256_REQUIRED");
    expect(readRaw(fx)).toBe(before);
  });

  test("apply sha 不符回 HASH_CONFLICT 且不寫檔", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createPolicyFixture();
    fixtures.push(fx);
    const before = readRaw(fx);
    const r = await execPolicyUpdate(makeDeps(ws, fx), {
      mode: "apply",
      confirm: true,
      expectedSha256: "0".repeat(64),
      allowlistAdd: ["beta-skill"],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toContain("HASH_CONFLICT");
    expect(readRaw(fx)).toBe(before);
  });

  test("preview 後外部改動再 apply → sha 競態 fail closed", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createPolicyFixture();
    fixtures.push(fx);
    const preview = await execPolicyUpdate(makeDeps(ws, fx), {
      allowlistAdd: ["gamma-skill"],
    });
    const staleSha = (preview.data as { expectedSha256?: string }).expectedSha256;
    // 外部改動：直接改 fixture 檔（模擬 concurrent writer）
    const current = JSON.parse(readRaw(fx)) as Record<string, unknown>;
    (current.approval as Record<string, unknown>).reviewedAt = "2026-09-13";
    writeFileSync(fx.policyPath, `${JSON.stringify(current, null, 2)}\n`, "utf-8");
    const externalRaw = readRaw(fx);
    const r = await execPolicyUpdate(makeDeps(ws, fx), {
      mode: "apply",
      confirm: true,
      expectedSha256: staleSha,
      allowlistAdd: ["gamma-skill"],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toContain("HASH_CONFLICT");
    // 外部改動保留，工具自己的變更未寫入
    expect(readRaw(fx)).toBe(externalRaw);
  });

  test("apply 成功：四個區塊一次寫入，未動區塊逐字不變", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createPolicyFixture();
    fixtures.push(fx);
    const beforeParsed = JSON.parse(readRaw(fx)) as Record<string, unknown>;
    const preview = await execPolicyUpdate(makeDeps(ws, fx), {
      managedUpsert: [{ name: "new-skill", source: "https://example.com/other", maintainer: "Other" }],
      allowlistAdd: ["new-skill"],
      contentDigestUpsert: [{ name: "new-skill", digest: HEX_C }],
      scriptReviewUpsert: [{ name: "new-skill", status: "reviewed", files: ["scripts/a.py"], note: "ok" }],
    });
    const r = await execPolicyUpdate(makeDeps(ws, fx), {
      mode: "apply",
      confirm: true,
      expectedSha256: (preview.data as { expectedSha256?: string }).expectedSha256,
      managedUpsert: [{ name: "new-skill", source: "https://example.com/other", maintainer: "Other" }],
      allowlistAdd: ["new-skill"],
      contentDigestUpsert: [{ name: "new-skill", digest: HEX_C }],
      scriptReviewUpsert: [{ name: "new-skill", status: "reviewed", files: ["scripts/a.py"], note: "ok" }],
    });
    expect(r.ok).toBe(true);
    expect((r.data as { applied?: boolean }).applied).toBe(true);
    const after = JSON.parse(readRaw(fx)) as Record<string, unknown>;
    const managed = after.managed as Record<string, unknown>;
    expect(managed["new-skill"]).toEqual({
      source: "https://example.com/other",
      maintainer: "Other",
    });
    const approval = after.approval as Record<string, unknown>;
    expect(approval.agentAllowlist as string[]).toContain("new-skill");
    expect((approval.contentDigests as Record<string, string>)["new-skill"]).toBe(HEX_C);
    expect(after.scriptReviews as Record<string, unknown>).toMatchObject({
      "new-skill": { status: "reviewed" },
    });
    // 未動區塊逐字不變（以 canonical JSON 比對）
    for (const key of ["schemaVersion", "skillRoot", "qualityContract", "builtIn", "locallyUpdated", "personalGovernance", "retired"]) {
      expect(JSON.stringify(after[key]), key).toBe(JSON.stringify(beforeParsed[key]));
    }
    expect((approval.reviewedAt as string)).toBe("2026-09-01");
    expect(approval.digestAlgorithm).toBe("sha256");
    // 既有 managed entry 保留
    expect(managed["existing-skill"]).toEqual(
      (beforeParsed.managed as Record<string, unknown>)["existing-skill"],
    );
  });
});

// ─── Section 3：格式防禦與範圍拒絕 ────────────────────────────

describe("48 - skiller-policy-update: fail closed", () => {
  test("digest 非 64 hex → 拒絕且不寫檔", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createPolicyFixture();
    fixtures.push(fx);
    const before = readRaw(fx);
    for (const digest of ["xyz", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), ""]) {
      const r = await execPolicyUpdate(makeDeps(ws, fx), {
        contentDigestUpsert: [{ name: "new-skill", digest }],
      });
      expect(r.ok, `digest=${digest}`).toBe(false);
      expect(r.code, `digest=${digest}`).toBe("INVALID_DIGEST");
    }
    expect(readRaw(fx)).toBe(before);
  });

  test("JSON 格式破壞 → 讀取 fail closed", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createPolicyFixture();
    fixtures.push(fx);
    writeFileSync(fx.policyPath, "{ not valid json", "utf-8");
    const r = await execPolicyUpdate(makeDeps(ws, fx), { allowlistAdd: ["x-skill"] });
    expect(r.ok).toBe(false);
    expect(["POLICY_READ_FAILED", "POLICY_MALFORMED"]).toContain(r.code);
  });

  test("缺少 schemaVersion → 拒絕且不寫檔", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const policy = basePolicy();
    delete policy.schemaVersion;
    const fx = createPolicyFixture(policy);
    fixtures.push(fx);
    const before = readRaw(fx);
    const r = await execPolicyUpdate(makeDeps(ws, fx), { allowlistAdd: ["x-skill"] });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("POLICY_SCHEMA_INVALID");
    expect(readRaw(fx)).toBe(before);
  });

  test("刪除 managed entry 的請求 → 拒絕且不寫檔", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createPolicyFixture();
    fixtures.push(fx);
    const before = readRaw(fx);
    const r = await execPolicyUpdate(makeDeps(ws, fx), {
      managedRemove: ["existing-skill"],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("MANAGED_ENTRY_DELETION");
    expect(readRaw(fx)).toBe(before);
  });

  test("越界區塊（如 personalGovernance）→ 拒絕且不寫檔", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createPolicyFixture();
    fixtures.push(fx);
    const before = readRaw(fx);
    for (const args of [
      { personalGovernance: { pinsPath: "/tmp/evil.json" } },
      { retired: { obsoleteAgentRuntime: ["existing-skill"] } },
      { schemaVersion: 99 },
    ]) {
      const r = await execPolicyUpdate(makeDeps(ws, fx), args);
      expect(r.ok, JSON.stringify(args)).toBe(false);
      expect(r.code, JSON.stringify(args)).toBe("OUT_OF_SCOPE");
    }
    expect(readRaw(fx)).toBe(before);
  });

  test("policy lock 被占用 → busy 且不寫入；釋放後可完成", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createPolicyFixture();
    fixtures.push(fx);
    const before = readRaw(fx);
    const lockDir = join(dirname(fx.policyPath), "cache", "locks");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, "skiller.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: "held" }), "utf-8");
    const args = {
      mode: "apply",
      confirm: true,
      expectedSha256: sha256(before),
      allowlistAdd: ["locked-skill"],
    };
    const busy = await execPolicyUpdate(makeDeps(ws, fx), args);
    expect(busy.ok).toBe(false);
    expect(busy.code).toBe("CONTENT_LOCK_BUSY");
    expect(readRaw(fx)).toBe(before);
    unlinkSync(lockPath);
    const released = await execPolicyUpdate(makeDeps(ws, fx), args);
    expect(released.ok).toBe(true);
  });

  test("巢狀 approval.agentAllowlist 結構異常 → fail closed 且不覆蓋", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const initial = basePolicy();
    (initial.approval as Record<string, unknown>).agentAllowlist = "not-an-array";
    const fx = createPolicyFixture(initial);
    fixtures.push(fx);
    const before = readRaw(fx);
    const r = await execPolicyUpdate(makeDeps(ws, fx), {
      mode: "apply",
      confirm: true,
      expectedSha256: sha256(before),
      allowlistAdd: ["new-skill"],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("POLICY_NESTED_INVALID");
    expect(readRaw(fx)).toBe(before);
  });

  test("巢狀 approval.contentDigests 值格式異常 → fail closed 且不覆蓋", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const initial = basePolicy();
    (initial.approval as Record<string, unknown>).contentDigests = { "existing-skill": 123 };
    const fx = createPolicyFixture(initial);
    fixtures.push(fx);
    const before = readRaw(fx);
    const r = await execPolicyUpdate(makeDeps(ws, fx), {
      mode: "apply",
      confirm: true,
      expectedSha256: sha256(before),
      contentDigestUpsert: [{ name: "new-skill", digest: HEX_C }],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("POLICY_NESTED_INVALID");
    expect(readRaw(fx)).toBe(before);
  });

  test("既有 scriptReviews entry 形狀異常 → fail closed 且不覆蓋", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const initial = basePolicy();
    initial.scriptReviews = { "existing-skill": { status: "reviewed", files: "not-an-array" } };
    const fx = createPolicyFixture(initial);
    fixtures.push(fx);
    const before = readRaw(fx);
    const r = await execPolicyUpdate(makeDeps(ws, fx), {
      mode: "apply",
      confirm: true,
      expectedSha256: sha256(before),
      scriptReviewUpsert: [{ name: "existing-skill", status: "reviewed" }],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("POLICY_NESTED_INVALID");
    expect(readRaw(fx)).toBe(before);
  });

  test("同名 managed entry 更新（改 source）→ 允許", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createPolicyFixture();
    fixtures.push(fx);
    const preview = await execPolicyUpdate(makeDeps(ws, fx), {
      managedUpsert: [{
        name: "existing-skill",
        source: "https://example.com/moved",
        maintainer: "Example Org",
        curation: "更新來源位置",
      }],
    });
    expect(preview.ok).toBe(true);
    const r = await execPolicyUpdate(makeDeps(ws, fx), {
      mode: "apply",
      confirm: true,
      expectedSha256: (preview.data as { expectedSha256?: string }).expectedSha256,
      managedUpsert: [{
        name: "existing-skill",
        source: "https://example.com/moved",
        maintainer: "Example Org",
        curation: "更新來源位置",
      }],
    });
    expect(r.ok).toBe(true);
    const after = JSON.parse(readRaw(fx)) as Record<string, unknown>;
    expect((after.managed as Record<string, unknown>)["existing-skill"]).toEqual({
      source: "https://example.com/moved",
      maintainer: "Example Org",
      curation: "更新來源位置",
    });
  });

  test("agentAllowlist 新增重複名稱 → 冪等成功且內容不變", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createPolicyFixture();
    fixtures.push(fx);
    const before = readRaw(fx);
    const preview = await execPolicyUpdate(makeDeps(ws, fx), {
      allowlistAdd: ["alpha-skill"],
    });
    expect(preview.ok).toBe(true);
    const r = await execPolicyUpdate(makeDeps(ws, fx), {
      mode: "apply",
      confirm: true,
      expectedSha256: (preview.data as { expectedSha256?: string }).expectedSha256,
      allowlistAdd: ["alpha-skill"],
    });
    expect(r.ok).toBe(true);
    const after = JSON.parse(readRaw(fx)) as Record<string, unknown>;
    const allowlist = (after.approval as Record<string, unknown>).agentAllowlist as string[];
    expect(allowlist.filter((n) => n === "alpha-skill").length).toBe(1);
    expect(JSON.stringify(after)).toBe(JSON.stringify(JSON.parse(before)));
  });

  test("managed entry 缺 source → 拒絕且不寫檔", async () => {
    const ws = createTestWorkspace();
    fixtures.push({ cleanup: () => ws.cleanup() });
    const fx = createPolicyFixture();
    fixtures.push(fx);
    const before = readRaw(fx);
    const r = await execPolicyUpdate(makeDeps(ws, fx), {
      managedUpsert: [{ name: "bad-skill", maintainer: "Nobody" }],
    });
    expect(r.ok).toBe(false);
    expect(["MANAGED_ENTRY_INVALID", "INVALID_MANAGED_ENTRY", "INVALID_INPUT"]).toContain(r.code);
    expect(readRaw(fx)).toBe(before);
  });
});

// ─── Section 4：registry 掛載 ─────────────────────────────────

describe("48 - skiller-policy-update: registry surface", () => {
  test("plugin registry 已掛入 skiller-policy-update 且三要素健全", async () => {
    const ws = createTestWorkspace();
    try {
      const { tool } = await loadPlugin(ws);
      const def = tool("skiller-policy-update");
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
      const raw = await tool("skiller-policy-update").execute({}, ctx as never);
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
