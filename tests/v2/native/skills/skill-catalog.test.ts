/**
 * skills 模組原生實作：技能清單精簡與 skill_search。
 *
 * 由 tests/ultrawork/55-skill-catalog.test.ts 移植，並補 V2 context、
 * ctx.storage、cache 保留、重新載入與 500 個工作階段淘汰的驗證。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupUltrawork } from "../../../../src/index.ts";
import { skillsModule } from "../../../../src/modules/skills/index.ts";
import {
  COMPACT_THRESHOLD_CHARS,
  createKeywordLoader,
  createSkillCatalogStore,
  createSkillSearchTool,
  parseSkillCatalog,
  queryTerms,
  renderSkillIndex,
  searchSkills,
  type SkillEntry,
} from "../../../../src/modules/skills/skill-catalog.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../../_fake-v2-context.ts";

/** 依 OpenCode V1 的 Skill.fmt 格式產生清單。 */
function renderV1Skills(skills: SkillEntry[]): string {
  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    "<available_skills>",
    ...skills.flatMap((skill) => [
      "  <skill>",
      `    <name>${skill.name}</name>`,
      `    <description>${skill.description}</description>`,
      `    <location>file:///skills/${skill.name}/SKILL.md</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

function renderV2Skills(skills: SkillEntry[]): string {
  return [
    "<available_skills>",
    ...skills.flatMap((skill) => [
      "  <skill>",
      `    <id>${skill.name}</id>`,
      `    <name>${skill.name}</name>`,
      `    <description>${skill.description}</description>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

const MANY_SKILLS: SkillEntry[] = [
  { name: "humanizer-zh-tw", description: "去除文字中的 AI 生成痕跡，讓繁體中文讀起來自然。" },
  { name: "swiftui-navigation", description: "Implement SwiftUI navigation with NavigationStack and deep links." },
  { name: "swiftui-animation", description: "Build SwiftUI animations and transitions." },
  { name: "api-design", description: "REST API design patterns including pagination and versioning." },
  ...Array.from({ length: 40 }, (_, index) => ({
    name: `filler-${String(index).padStart(2, "0")}`,
    description: `Filler skill number ${index} used to push the catalog past the compaction threshold. `.repeat(3),
  })),
];

function v1System(skills: SkillEntry[]): string {
  return ["你是測試代理。", renderV1Skills(skills), "結尾的其他指示。"].join("\n");
}

function parseToolResult(result: { content: string }): any {
  const parsed = JSON.parse(result.content);
  if (parsed.data && typeof parsed.data === "object") {
    for (const [key, value] of Object.entries(parsed.data)) {
      if (!(key in parsed)) Object.defineProperty(parsed, key, { configurable: true, value });
    }
  }
  return parsed;
}

async function setupSkills(
  settings: Record<string, unknown> = {},
  fake = createFakeV2Context(),
) {
  const cleanup = await setupUltrawork(fake.ctx, {
    modules: [skillsModule],
    settings,
  });
  const tool = fake.added.get("skill_search");
  const contextHook = fake.sessionHooks.get("context");
  if (!tool || !contextHook) throw new Error("skills 工具或 context hook 沒有註冊");
  return { fake, tool, contextHook, cleanup };
}

function createWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("技能清單解析與精簡", () => {
  test("大清單換成名稱索引，清單以外的文字不變，同一份清單產生同樣的結果", async () => {
    const fixture = await setupSkills();
    try {
      const original = v1System(MANY_SKILLS);
      expect(parseSkillCatalog(original)!.block.length).toBeGreaterThan(COMPACT_THRESHOLD_CHARS);

      const event = {
        sessionID: "ses-a",
        system: [{ type: "text", text: original }],
      };
      await fixture.contextHook(event);
      const compacted = event.system[0]!.text;
      expect(compacted).not.toContain("<available_skills>");
      expect(compacted).not.toContain("Filler skill number");
      expect(compacted).toContain("<available_skills_index>");
      expect(compacted).toContain("skill_search");
      expect(compacted).toContain("- swiftui：swiftui-animation, swiftui-navigation");
      expect(compacted).toContain("api-design");
      expect(compacted.startsWith("你是測試代理。\n")).toBe(true);
      expect(compacted.endsWith("\n結尾的其他指示。")).toBe(true);
      expect(compacted.length).toBeLessThan(original.length / 4);

      const same = { sessionID: "ses-b", system: [{ type: "text", text: v1System(MANY_SKILLS) }] };
      await fixture.contextHook(same);
      expect(same.system[0]!.text).toBe(compacted);
    } finally {
      await fixture.cleanup();
    }
  });

  test("V1 與 V2 清單格式都解析得到技能", () => {
    expect(parseSkillCatalog(renderV1Skills(MANY_SKILLS.slice(0, 2)))!.skills).toEqual(MANY_SKILLS.slice(0, 2));
    expect(parseSkillCatalog(renderV2Skills(MANY_SKILLS.slice(0, 2)))!.skills).toEqual(MANY_SKILLS.slice(0, 2));
  });

  test("V2 清單也會改寫，且記下 humanizer-zh-tw", async () => {
    const fixture = await setupSkills();
    try {
      const text = ["你是測試代理。", renderV2Skills(MANY_SKILLS), "結尾的其他指示。"].join("\n");
      const event = { sessionID: "ses-v2", system: [{ type: "text", text }] };
      await fixture.contextHook(event);
      expect(event.system[0]!.text).toContain("<available_skills_index>");
      expect(event.system[0]!.text).not.toContain("<id>");
      const result = parseToolResult(await fixture.tool.execute(
        { query: "去除 AI 痕跡" },
        fakeV2ToolContext("ses-v2"),
      ));
      expect(result.skills[0].name).toBe("humanizer-zh-tw");
    } finally {
      await fixture.cleanup();
    }
  });

  test("小清單維持原樣，但仍記下來給 skill_search 查", async () => {
    const fixture = await setupSkills();
    try {
      const original = v1System(MANY_SKILLS.slice(0, 3));
      const event = { sessionID: "ses-small", system: [{ type: "text", text: original }] };
      await fixture.contextHook(event);
      expect(event.system[0]!.text).toBe(original);
      const result = parseToolResult(await fixture.tool.execute(
        { query: "swiftui navigation" },
        fakeV2ToolContext("ses-small"),
      ));
      expect(result.ok).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  test("settings.skills.catalog=full 時完全不改寫", async () => {
    const fixture = await setupSkills({ skills: { catalog: "full" } });
    try {
      const original = v1System(MANY_SKILLS);
      const event = { sessionID: "ses-full", system: [{ type: "text", text: original }] };
      await fixture.contextHook(event);
      expect(event.system[0]!.text).toBe(original);
    } finally {
      await fixture.cleanup();
    }
  });

  test("分組渲染把單一成員併入其他", () => {
    expect(renderSkillIndex([
      { name: "zeta-one", description: "" },
      { name: "alpha-one", description: "" },
      { name: "alpha-two", description: "" },
      { name: "solo", description: "" },
    ])).toBe([
      "<available_skills_index>",
      "這裡只列技能名稱（共 4 個）。要知道某個技能做什麼、適不適合目前的任務，先用 `skill_search` 查，中文或英文關鍵字都可以，它會回傳完整描述；確定需要再用 `skill` 工具依名稱載入。角色說明裡直接點名的技能可以不查，直接載入。",
      "- alpha：alpha-one, alpha-two",
      "- 其他：solo, zeta-one",
      "</available_skills_index>",
    ].join("\n"));
  });

  test("改寫 text part 時保留 cache、metadata 與其他 part", async () => {
    const fixture = await setupSkills();
    try {
      const cache = { type: "persistent", ttlSeconds: 600 } as const;
      const metadata = { source: "test" };
      const before = { type: "text", text: "前段", cache: { type: "ephemeral" } as const };
      const target = { type: "text", text: v1System(MANY_SKILLS), cache, metadata } as const;
      const after = { type: "text", text: "後段" } as const;
      const event = { sessionID: "ses-cache", system: [before, target, after] };
      await fixture.contextHook(event);
      expect(event.system[0]).toBe(before);
      expect(event.system[1]).not.toBe(target);
      expect(event.system[1]).toMatchObject({ type: "text", text: expect.stringContaining("<available_skills_index>"), cache, metadata });
      expect(event.system[2]).toBe(after);
    } finally {
      await fixture.cleanup();
    }
  });

  test("非 text part 與空清單會略過", async () => {
    const fake = createFakeV2Context();
    const store = createSkillCatalogStore(fake.ctx.storage);
    const system = [
      { type: "media", source: {} },
      { type: "text", text: "<available_skills>\n</available_skills>" },
    ] as any[];
    expect(await store.compact(system, "ses-empty")).toBe(false);
    expect(system[0]).toEqual({ type: "media", source: {} });
    expect(await store.get("ses-empty")).toBeUndefined();
  });

  test("儲存失敗時 hook 不拋錯，也不改寫原清單", async () => {
    const fixture = await setupSkills();
    try {
      const original = v1System(MANY_SKILLS);
      (fixture.fake.ctx.storage as any).set = async () => {
        throw new Error("storage unavailable");
      };
      const event = { sessionID: "ses-fail", system: [{ type: "text", text: original }] };
      await fixture.contextHook(event);
      expect(event.system[0]!.text).toBe(original);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("技能搜尋", () => {
  test("同時比對名稱與描述，中文兩字片段也對得到", () => {
    expect(searchSkills(MANY_SKILLS, "swiftui navigation")[0]!.name).toBe("swiftui-navigation");
    expect(searchSkills(MANY_SKILLS, "pagination")[0]!.name).toBe("api-design");
    expect(searchSkills(MANY_SKILLS, "去除AI痕跡")[0]!.name).toBe("humanizer-zh-tw");
    expect(searchSkills(MANY_SKILLS, "kubernetes")).toEqual([]);
  });

  test("中文與英文 policy 關鍵字能補足只有英文描述的技能", () => {
    const skills = [
      { name: "push-notifications", description: "Implement APNs remote and local notifications." },
      { name: "swiftui-navigation", description: "NavigationStack and deep linking." },
    ];
    const keywords = {
      "push-notifications": { zh: ["推播通知", "本地通知"], en: ["apns"] },
      "swiftui-navigation": { zh: ["頁面導覽", "深層連結"], en: ["deep link", "tab view"] },
    };
    expect(searchSkills(skills, "推播通知", {})).toEqual([]);
    expect(searchSkills(skills, "幫我加一個推播通知", keywords)[0]!.name).toBe("push-notifications");
    expect(searchSkills(skills, "深層 連結", keywords)[0]!.name).toBe("swiftui-navigation");
    expect(searchSkills(skills, "tab view", keywords)[0]!.name).toBe("swiftui-navigation");
  });

  test("英文用完整單字邊界，ci 不會命中 decide", () => {
    expect(queryTerms("CI  decide")).toEqual(["ci", "decide"]);
    expect(searchSkills([{ name: "ci-fix", description: "Fix CI." }], "ci")).toHaveLength(1);
    expect(searchSkills([{ name: "decide-flow", description: "Choose a branch." }], "ci")).toEqual([]);
  });

  test("關鍵字忽略空白，limit 預設 8、上限 20，非整數拒絕", async () => {
    const workspace = createWorkspace("uw-skills-policy-");
    try {
      const policyPath = join(workspace, "skills-policy.json");
      const fake = createFakeV2Context();
      const store = createSkillCatalogStore(fake.ctx.storage);
      const storeSkills = Array.from({ length: 9 }, (_, index) => ({
        name: index === 0 ? "storekit" : `storekit-${index}`,
        description: `Manage in-app purchases variant ${index}.`,
      }));
      const searchKeywords = Object.fromEntries(
        storeSkills.map(({ name }) => [name, { zh: ["內購"], en: ["iap"] }]),
      );
      writeFileSync(policyPath, JSON.stringify({ searchKeywords }));
      await store.compact(
        [{ type: "text", text: v1System([...MANY_SKILLS, ...storeSkills]) }],
        "ses",
      );
      const tool = createSkillSearchTool(store, { policyPath });
      const keyword = parseToolResult(await tool.execute({ query: "我要 內購" }, fakeV2ToolContext("ses")));
      expect(keyword.skills[0].name).toBe("storekit");
      expect(keyword.totalMatches).toBeGreaterThan(8);
      expect(keyword.skills).toHaveLength(8);

      const invalid = parseToolResult(await tool.execute({ query: "   " }, fakeV2ToolContext("ses")));
      expect(invalid).toMatchObject({ ok: false, code: "INVALID_INPUT" });
      expect(invalid.data.error).toBe("query 不能是空的。");
      const nonInteger = parseToolResult(await tool.execute({ query: "swiftui", limit: 1.5 }, fakeV2ToolContext("ses")));
      expect(nonInteger).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("找不到技能時回固定摘要；limit 1 只回最高分", async () => {
    const fixture = await setupSkills();
    try {
      await fixture.contextHook({ sessionID: "ses-result", system: [{ type: "text", text: v1System(MANY_SKILLS) }] });
      const one = parseToolResult(await fixture.tool.execute(
        { query: "swiftui navigation", limit: 1 },
        fakeV2ToolContext("ses-result"),
      ));
      expect(one.skills).toEqual([{ name: "swiftui-navigation", description: MANY_SKILLS[1]!.description }]);
      const none = parseToolResult(await fixture.tool.execute({ query: "kubernetes" }, fakeV2ToolContext("ses-result")));
      expect(none).toMatchObject({
        ok: true,
        summary: "沒有符合的技能；換個說法，或改用框架、檔案類型等更具體的關鍵字再查。",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("尚未記下清單的工作階段回固定錯誤", async () => {
    const fixture = await setupSkills();
    try {
      const result = parseToolResult(await fixture.tool.execute({ query: "swiftui" }, fakeV2ToolContext("ses-other")));
      expect(result).toMatchObject({
        ok: false,
        code: "SKILL_CATALOG_UNAVAILABLE",
        summary: "目前無法完成：這個工作階段還沒有技能清單可以查。",
        nextAction: "直接依 system prompt 裡的技能名稱用 skill 工具載入。",
      });
      expect(result.data.error).toBe("這個工作階段還沒有技能清單可以查。");
    } finally {
      await fixture.cleanup();
    }
  });

  test("工具名稱、描述、參數 schema 與舊版一致", async () => {
    const fixture = await setupSkills();
    try {
      expect(fixture.tool.name).toBe("skill_search");
      expect(fixture.tool.description).toBe("依關鍵字查詢目前可用技能的完整描述，用來判斷要不要載入某個技能。中文或英文關鍵字都可以。只查這個工作階段原本就能用的技能；載入仍用 skill 工具。");
      const schema = fixture.tool.input as any;
      expect(schema.required).toEqual(["query"]);
      expect(schema.properties.query).toMatchObject({ type: "string", minLength: 1 });
      expect(schema.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 20 });
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("policy 檔與持久狀態", () => {
  test("關鍵字檔案沒變就用同一份快取，讀不到就退回空索引", () => {
    const workspace = createWorkspace("uw-skill-keywords-");
    try {
      const path = join(workspace, "skills-policy.json");
      writeFileSync(path, JSON.stringify({ searchKeywords: { storekit: { zh: ["內購"], en: ["iap"] }, bad: "x" } }));
      const load = createKeywordLoader(path);
      const first = load();
      expect(first.storekit).toEqual({ zh: ["內購"], en: ["iap"] });
      expect(first.bad).toBeUndefined();
      expect(load()).toBe(first);
      expect(createKeywordLoader(join(workspace, "missing.json"))()).toEqual({});
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("預設 policy 路徑位於全域 .ultrawork", async () => {
    const workspace = createWorkspace("uw-skills-global-");
    try {
      mkdirSync(join(workspace, ".ultrawork"), { recursive: true });
      writeFileSync(
        join(workspace, ".ultrawork", "skills-policy.json"),
        JSON.stringify({ searchKeywords: { "swiftui-navigation": { zh: ["頁面導覽"] } } }),
      );
      const fake = createFakeV2Context({ options: { globalDir: workspace } });
      const fixture = await setupSkills({}, fake);
      try {
        await fixture.contextHook({ sessionID: "ses-default-policy", system: [{ type: "text", text: v1System(MANY_SKILLS) }] });
        const result = parseToolResult(await fixture.tool.execute({ query: "頁面導覽" }, fakeV2ToolContext("ses-default-policy")));
        expect(result.skills[0].name).toBe("swiftui-navigation");
      } finally {
        await fixture.cleanup();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("ctx.storage 重新載入後仍可查詢", async () => {
    const fake = createFakeV2Context();
    const first = await setupSkills({}, fake);
    await first.contextHook({ sessionID: "ses-reload", system: [{ type: "text", text: v1System(MANY_SKILLS) }] });
    await first.cleanup();

    const second = await setupSkills({}, fake);
    try {
      const result = parseToolResult(await second.tool.execute({ query: "pagination" }, fakeV2ToolContext("ses-reload")));
      expect(result.skills[0].name).toBe("api-design");
    } finally {
      await second.cleanup();
    }
  });

  test("儲存 key 使用 session/<id>/skill-catalog，超過 500 個淘汰最舊", async () => {
    const fake = createFakeV2Context();
    const store = createSkillCatalogStore(fake.ctx.storage);
    for (let index = 0; index <= 500; index += 1) {
      const text = v1System([{ name: `skill-${index}`, description: `Skill ${index}` }]);
      await store.compact([{ type: "text", text }], `ses-${index}`);
    }
    expect(fake.store.has("session/ses-0/skill-catalog")).toBe(false);
    expect(fake.store.has("session/ses-500/skill-catalog")).toBe(true);
  });
});

describe("skills 模組開關", () => {
  test("模組關閉時工具與 context hook 都不註冊", async () => {
    const fake = createFakeV2Context();
    const cleanup = await setupUltrawork(fake.ctx, {
      modules: [skillsModule],
      settings: { modules: { skills: false } },
    });
    try {
      expect(fake.added.size).toBe(0);
      expect(fake.sessionHooks.size).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
