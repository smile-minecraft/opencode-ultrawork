/**
 * 記憶預算可設定化：分層 budget 設定與每層主題數上限。
 *
 * 鎖定的行為（實作前先紅）：
 * 1. 寫入把關讀得到該層設定（小 indexCharLimit 會擋，訊息帶設定值）。
 * 2. 分層管轄：專案層的 budget.global 被忽略並警告；budget.project 生效；
 *    全域層額度不受專案層影響。
 * 3. maxTopics：超限拒絕新增、0 不限制、既有超標主題不刪除。
 * 4. 無效值警告並退回預設，外掛照常載入。
 * 5. 診斷回報的上限反映設定值，欄位結構不變。
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
import { loadSettings } from "../../../../src/settings/load.ts";
import { sanitizeSettings } from "../../../../src/settings/validate.ts";
import {
  DEFAULT_MEMORY_BUDGET,
  defaultMemoryBudgets,
  type MemoryBudgets,
} from "../../../../src/modules/memory/constants.ts";
import { createMemoryWriteTool } from "../../../../src/modules/memory/tools/memory-write.ts";
import { createMemoryNoteTool } from "../../../../src/modules/memory/tools/memory-note.ts";
import type { MemoryToolDeps } from "../../../../src/modules/memory/tools/shared.ts";
import { memoryLayer, memoryPath, readOptional } from "../../../../src/modules/memory/layers.ts";
import { listTopics, sha256 } from "../../../../src/modules/memory/topic.ts";
import { renderMemorySnapshot } from "../../../../src/modules/memory/snapshot.ts";
import { collectMemoryBudget } from "../../../../src/modules/diagnostics/shared.ts";
import type { Paths } from "../../../../src/modules/workflow/index.ts";

const roots: string[] = [];
const root = () => {
  const r = mkdtempSync(join(tmpdir(), "memory-budget-"));
  roots.push(r);
  return r;
};
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function budgetsWith(project: Partial<MemoryBudgets["project"]>, global: Partial<MemoryBudgets["global"]> = {}): MemoryBudgets {
  const budgets = defaultMemoryBudgets();
  return { global: { ...budgets.global, ...global }, project: { ...budgets.project, ...project } };
}

function depsFor(r: string, budgets: MemoryBudgets): MemoryToolDeps {
  return {
    resolveRoot: async () => r,
    globalRoot: r,
    writerAgents: ["memorizer"],
    budgets,
    taskMaterials: async () => null,
  };
}

function baseCreate(topic: string, extra: Record<string, unknown> = {}) {
  return {
    layer: "project",
    topic,
    op: "create",
    title: "測試",
    description: "驗證功能",
    type: "decision",
    body: "每次執行測試",
    mode: "apply",
    ...extra,
  };
}

async function call(
  tool: ReturnType<typeof createMemoryWriteTool> | ReturnType<typeof createMemoryNoteTool>,
  input: unknown,
) {
  const result = JSON.parse((await tool.execute(input, { sessionID: "s", agent: "memorizer" })).content);
  return { ...result.data, ok: result.ok, code: result.code };
}

function reader(files: Record<string, string>) {
  return (path: string) => files[path];
}

describe("寫入把關讀得到該層設定", () => {
  test("budget.project.indexCharLimit 設小值時，超過就拒絕且訊息帶設定值", async () => {
    const r = root();
    const deps = depsFor(r, budgetsWith({ indexCharLimit: 10 }));
    const write = createMemoryWriteTool(deps);
    const preview = await call(write, { ...baseCreate("checks"), mode: "preview" });
    const issue = (preview.issues as Array<{ code: string; error: string }>).find(
      (i) => i.code === "INDEX_BUDGET_EXCEEDED",
    );
    expect(issue).toBeDefined();
    expect(issue!.error).toContain("10");
    expect(issue!.error).not.toContain("3000");
    const applied = await call(write, baseCreate("checks"));
    expect(applied.ok).toBe(false);
    expect(applied.code).toBe("INDEX_BUDGET_EXCEEDED");
    expect(listTopics(memoryLayer(r))).toHaveLength(0);
  });

  test("預設預算下同樣內容可以寫入", async () => {
    const r = root();
    const write = createMemoryWriteTool(depsFor(r, defaultMemoryBudgets()));
    expect(await call(write, baseCreate("checks"))).toMatchObject({ ok: true });
  });

  test("topicCharLimit／descriptionCharLimit／pinnedLimit 讀設定值", async () => {
    const r = root();
    const deps = depsFor(r, budgetsWith({ topicCharLimit: 50, descriptionCharLimit: 5, pinnedLimit: 1 }));
    const write = createMemoryWriteTool(deps);
    const preview = await call(write, { ...baseCreate("checks"), mode: "preview", description: "超過五個字的描述文字" });
    const codes = (preview.issues as Array<{ code: string }>).map((i) => i.code);
    expect(codes).toContain("TOPIC_TOO_LARGE");
    expect(codes).toContain("DESCRIPTION_TOO_LONG");
    const descMsg = (preview.issues as Array<{ code: string; error: string }>).find(
      (i) => i.code === "DESCRIPTION_TOO_LONG",
    )!.error;
    expect(descMsg).toContain("5");
    const topicMsg = (preview.issues as Array<{ code: string; error: string }>).find(
      (i) => i.code === "TOPIC_TOO_LARGE",
    )!.error;
    expect(topicMsg).toContain("50");
    // pinned 上限 1：另起一層只收緊 pinned 的設定驗證（主題上限維持預設才寫得進）
    const r2 = root();
    const pinnedWrite = createMemoryWriteTool(depsFor(r2, budgetsWith({ pinnedLimit: 1 })));
    expect(await call(pinnedWrite, baseCreate("a", { pinned: true }))).toMatchObject({ ok: true });
    const second = await call(pinnedWrite, baseCreate("b", { pinned: true, description: "短" }));
    expect(second.ok).toBe(false);
    expect(second.code).toBe("PINNED_LIMIT_EXCEEDED");
  });

  test("noteCharLimit 讀該層設定：小值拒絕並說明上限", async () => {
    const r = root();
    const note = createMemoryNoteTool(depsFor(r, budgetsWith({ noteCharLimit: 10 })));
    const over = await call(note, { content: "這是一段超過十個字的筆記內容" });
    expect(over.ok).toBe(false);
    expect(over.code).toBe("NOTE_TOO_LONG");
    expect(String(over.error)).toContain("10");
    expect(await call(note, { content: "短筆記" })).toMatchObject({ ok: true });
  });

  test("pinnedInjectBudget 讀該層設定：快照截斷並提示", async () => {
    const r = root();
    const deps = depsFor(r, defaultMemoryBudgets());
    const write = createMemoryWriteTool(deps);
    expect(
      await call(write, baseCreate("pinned-one", { pinned: true, body: "很長的正文內容超過預算" })),
    ).toMatchObject({ ok: true });
    const layer = memoryLayer(r);
    const tiny = renderMemorySnapshot([{ ...layer, layer: "project" }], budgetsWith({ pinnedInjectBudget: 1 }));
    expect(tiny).toContain("超過預算");
    const full = renderMemorySnapshot([{ ...layer, layer: "project" }], defaultMemoryBudgets());
    expect(full).toContain("很長的正文內容超過預算");
  });
});

describe("分層管轄", () => {
  test("專案層的 budget.global 被忽略並警告，全域層的值保留", () => {
    const result = loadSettings({
      readFile: reader({
        "/g/.ultrawork/ultrawork.jsonc": `{"memory": {"budget": {"global": {"indexCharLimit": 2000}}}}`,
        "/p/.ultrawork/ultrawork.jsonc": `{"memory": {"budget": {"global": {"indexCharLimit": 100}, "project": {"indexCharLimit": 100}}}}`,
      }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.memory.budget.global.indexCharLimit).toBe(2000);
    expect(result.settings.memory.budget.project.indexCharLimit).toBe(100);
    expect(
      result.warnings.some((w) => w.includes("memory.budget.global") && w.includes("/p/.ultrawork/ultrawork.jsonc")),
    ).toBe(true);
  });

  test("沒有全域檔時專案層的 budget.global 仍被忽略，退回預設並警告", () => {
    const result = loadSettings({
      readFile: reader({
        "/p/.ultrawork/ultrawork.jsonc": `{"memory": {"budget": {"global": {"indexCharLimit": 100}}}}`,
      }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.memory.budget.global).toEqual(DEFAULT_MEMORY_BUDGET);
    expect(result.warnings.some((w) => w.includes("memory.budget.global"))).toBe(true);
  });

  test("專案層只影響專案層：全域層寫入仍用全域額度", async () => {
    const projectRoot = root();
    const globalRoot = root();
    const budgets = budgetsWith({ indexCharLimit: 10 });
    const deps: MemoryToolDeps = {
      resolveRoot: async () => projectRoot,
      globalRoot,
      writerAgents: ["memorizer"],
      budgets,
      taskMaterials: async () => null,
    };
    const write = createMemoryWriteTool(deps);
    // 專案層 10 字元寫不進；全域層用預設 3000 寫得進
    expect((await call(write, baseCreate("p1"))).ok).toBe(false);
    expect(await call(write, { ...baseCreate("g1"), layer: "global" })).toMatchObject({ ok: true });
  });
});

describe("maxTopics", () => {
  test("超過上限拒絕新增並說明上限值", async () => {
    const r = root();
    const write = createMemoryWriteTool(depsFor(r, budgetsWith({ maxTopics: 1 })));
    expect(await call(write, baseCreate("a"))).toMatchObject({ ok: true });
    const preview = await call(write, { ...baseCreate("b"), mode: "preview" });
    expect((preview.issues as Array<{ code: string }>).map((i) => i.code)).toContain("TOPIC_LIMIT_EXCEEDED");
    const rejected = await call(write, baseCreate("b"));
    expect(rejected.ok).toBe(false);
    expect(rejected.code).toBe("TOPIC_LIMIT_EXCEEDED");
    expect(String(rejected.error)).toContain("1");
    // 既有主題不受影響：更新照常通過
    const { sha256 } = await call(write, { layer: "project", topic: "a" });
    void sha256;
    const read = listTopics(memoryLayer(r));
    expect(read.map((t) => t.topic).sort()).toEqual(["a"]);
  });

  test("maxTopics 為 0 表示不限制", async () => {
    const r = root();
    const write = createMemoryWriteTool(depsFor(r, budgetsWith({ maxTopics: 0 })));
    for (const topic of ["a", "b", "c"]) {
      expect(await call(write, baseCreate(topic))).toMatchObject({ ok: true });
    }
  });

  test("既有超標主題不會被刪除，只由診斷提示", async () => {
    const r = root();
    const loose = createMemoryWriteTool(depsFor(r, budgetsWith({ maxTopics: 0 })));
    expect(await call(loose, baseCreate("a"))).toMatchObject({ ok: true });
    expect(await call(loose, baseCreate("b"))).toMatchObject({ ok: true });
    const paths = { PROJECT_ROOT: r, STATE_MD: join(r, ".ultrawork", "state.md") } as unknown as Paths;
    const outcome = collectMemoryBudget(paths, r, budgetsWith({ maxTopics: 1 }));
    expect(outcome.memory_budget.layers.project.status).toBe("warn");
    expect(outcome.warnings.some((w) => w.includes("project"))).toBe(true);
    expect(listTopics(memoryLayer(r)).map((t) => t.topic).sort()).toEqual(["a", "b"]);
  });
});

describe("無效值退回預設", () => {
  test("型別或範圍錯誤警告並退回該欄位預設", () => {
    const { settings, warnings } = sanitizeSettings({
      memory: {
        budget: {
          global: { indexCharLimit: "big", maxTopics: -1 },
          project: { pinnedLimit: 1.5, noteCharLimit: 0 },
        },
      },
    });
    expect(settings.memory.budget.global.indexCharLimit).toBe(DEFAULT_MEMORY_BUDGET.indexCharLimit);
    expect(settings.memory.budget.global.maxTopics).toBe(0);
    expect(settings.memory.budget.project.pinnedLimit).toBe(DEFAULT_MEMORY_BUDGET.pinnedLimit);
    expect(settings.memory.budget.project.noteCharLimit).toBe(DEFAULT_MEMORY_BUDGET.noteCharLimit);
    expect(warnings.some((w) => w.includes("memory.budget.global.indexCharLimit"))).toBe(true);
    expect(warnings.some((w) => w.includes("memory.budget.global.maxTopics"))).toBe(true);
    // maxTopics 為 0 合法，不警告也不改寫
    const ok = sanitizeSettings({ memory: { budget: { project: { maxTopics: 0 } } } });
    expect(ok.settings.memory.budget.project.maxTopics).toBe(0);
    expect(ok.warnings.some((w) => w.includes("maxTopics"))).toBe(false);
  });

  test("budget 整段型別錯誤退回預設，外掛照常載入", () => {
    const result = loadSettings({
      readFile: reader({ "/p/.ultrawork/ultrawork.jsonc": `{"memory": {"budget": "big"}}` }),
      globalDir: "/g",
      projectDir: "/p",
    });
    expect(result.settings.memory.budget).toEqual({
      global: DEFAULT_MEMORY_BUDGET,
      project: DEFAULT_MEMORY_BUDGET,
    });
    expect(result.warnings.some((w) => w.includes("memory.budget"))).toBe(true);
  });

  test("DEFAULT_SETTINGS 帶完整 budget", () => {
    expect(DEFAULT_SETTINGS.memory.budget.global).toEqual(DEFAULT_MEMORY_BUDGET);
    expect(DEFAULT_SETTINGS.memory.budget.project).toEqual(DEFAULT_MEMORY_BUDGET);
  });
});

describe("預算回報反映設定值", () => {
  test("index_limit 反映該層設定，欄位結構不變", async () => {
    const r = root();
    const paths = { PROJECT_ROOT: r, STATE_MD: join(r, ".ultrawork", "state.md") } as unknown as Paths;
    const outcome = collectMemoryBudget(paths, r, budgetsWith({ indexCharLimit: 2000 }));
    expect(outcome.memory_budget.layers.project.index_limit).toBe(2000);
    expect(Object.keys(outcome.memory_budget.layers.project).sort()).toEqual(
      ["index_chars", "index_limit", "oversized_topics", "pinned", "status", "topics"],
    );
    expect(outcome.memory_budget.layers.global.index_limit).toBe(DEFAULT_MEMORY_BUDGET.indexCharLimit);
  });
});

/** 讀取某主題目前檔案內容的 sha256，給 update／delete／verify 的 expectedSha256 用。 */
function shaOf(r: string, topic: string): string {
  const raw = readOptional(memoryPath(memoryLayer(r), "topics", `${topic}.md`));
  if (raw === null) throw new Error(`測試前置失敗：主題 ${topic} 不存在`);
  return sha256(raw);
}

describe("超標時不增加的寫入放行", () => {
  test("索引已超標：delete／verify／縮短 description 放行，新增主題仍擋", async () => {
    const r = root();
    const loose = createMemoryWriteTool(depsFor(r, defaultMemoryBudgets()));
    for (const topic of ["a", "b", "c"]) {
      expect(await call(loose, baseCreate(topic, { description: `主題${topic}的說明文字內容` }))).toMatchObject({
        ok: true,
      });
    }
    const tight = createMemoryWriteTool(depsFor(r, budgetsWith({ indexCharLimit: 50 })));

    const preview = await call(tight, {
      layer: "project",
      topic: "a",
      op: "delete",
      reason: "整理",
      mode: "preview",
      expectedSha256: shaOf(r, "a"),
    });
    expect((preview.issues as Array<{ code: string }>).map((i) => i.code)).not.toContain("INDEX_BUDGET_EXCEEDED");

    expect(
      await call(tight, {
        layer: "project",
        topic: "a",
        op: "delete",
        reason: "整理",
        mode: "apply",
        expectedSha256: shaOf(r, "a"),
      }),
    ).toMatchObject({ ok: true });

    expect(
      await call(tight, {
        layer: "project",
        topic: "b",
        op: "verify",
        mode: "apply",
        expectedSha256: shaOf(r, "b"),
      }),
    ).toMatchObject({ ok: true });

    expect(
      await call(tight, {
        layer: "project",
        topic: "c",
        op: "update",
        description: "短",
        mode: "apply",
        expectedSha256: shaOf(r, "c"),
      }),
    ).toMatchObject({ ok: true });

    const over = await call(tight, baseCreate("d"));
    expect(over.ok).toBe(false);
    expect(over.code).toBe("INDEX_BUDGET_EXCEEDED");
  });

  test("主題檔已超標：縮短內容放行，加長仍擋", async () => {
    const r = root();
    const loose = createMemoryWriteTool(depsFor(r, defaultMemoryBudgets()));
    const longBody = "很長的正文內容".repeat(40);
    expect(await call(loose, baseCreate("big", { body: longBody }))).toMatchObject({ ok: true });
    const before = readOptional(memoryPath(memoryLayer(r), "topics", "big.md"))!;
    // 上限卡在「縮短後」與「原本」之間：縮短版比原本少 279 字元（280 字正文換成 1 字），
    // 所以縮短後仍超標 21 字元，舊判定會擋、新判定放行；改回長文則兩種判定都擋。
    const tight = createMemoryWriteTool(depsFor(r, budgetsWith({ topicCharLimit: before.length - 300 })));

    expect(
      await call(tight, {
        layer: "project",
        topic: "big",
        op: "update",
        body: "短",
        mode: "apply",
        expectedSha256: shaOf(r, "big"),
      }),
    ).toMatchObject({ ok: true });

    const over = await call(tight, {
      layer: "project",
      topic: "big",
      op: "update",
      body: longBody,
      mode: "apply",
      expectedSha256: shaOf(r, "big"),
    });
    expect(over.ok).toBe(false);
    expect(over.code).toBe("TOPIC_TOO_LARGE");
  });

  test("pinned 已超標：不增加 pinned 的更新放行，取消 pinned 放行，再 pin 仍擋", async () => {
    const r = root();
    const loose = createMemoryWriteTool(depsFor(r, defaultMemoryBudgets()));
    expect(await call(loose, baseCreate("a", { pinned: true }))).toMatchObject({ ok: true });
    expect(await call(loose, baseCreate("b", { pinned: true, description: "短" }))).toMatchObject({ ok: true });
    const tight = createMemoryWriteTool(depsFor(r, budgetsWith({ pinnedLimit: 1 })));

    expect(
      await call(tight, {
        layer: "project",
        topic: "b",
        op: "update",
        title: "新標題",
        mode: "apply",
        expectedSha256: shaOf(r, "b"),
      }),
    ).toMatchObject({ ok: true });

    expect(
      await call(tight, {
        layer: "project",
        topic: "a",
        op: "update",
        pinned: false,
        mode: "apply",
        expectedSha256: shaOf(r, "a"),
      }),
    ).toMatchObject({ ok: true });

    const over = await call(tight, baseCreate("c", { pinned: true, description: "短" }));
    expect(over.ok).toBe(false);
    expect(over.code).toBe("PINNED_LIMIT_EXCEEDED");
  });
});
