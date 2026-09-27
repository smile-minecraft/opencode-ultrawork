import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMemoryStoreMigrated, MEMORY_MIGRATION_MARKER, splitLegacyMemory } from "../../../../src/migrate/memory-store.ts";
import { memoryLayer, memoryPath } from "../../../../src/modules/memory/layers.ts";
import { readLog } from "../../../../src/modules/memory/log.ts";
import { listTopics, renderTopic, type TopicFrontmatter } from "../../../../src/modules/memory/topic.ts";
import { createMemorySnapshotStore, renderMemorySnapshot } from "../../../../src/modules/memory/snapshot.ts";
import { createFakeV2Context } from "../../_fake-v2-context.ts";
import { memoryModule } from "../../../../src/modules/memory/index.ts";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
const roots: string[] = [];
function root() {
  const r = mkdtempSync(join(tmpdir(), "memory-lifecycle-"));
  roots.push(r);
  return r;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const fm: TopicFrontmatter = {
  title: "主題",
  description: "可供參考",
  type: "reference",
  pinned: true,
  source: "manual",
  created: "2026-01-01T00:00:00.000Z",
  updated: "2026-01-01T00:00:00.000Z",
  verified_at: "",
};
test("遷移保留中文、重複標題、code fence 和超大段落", async () => {
  const r = root();
  mkdirSync(join(r, ".ultrawork"));
  const raw = "# Overview\n前言\n## 中文標題\n知識\n```md\n## fenced\n```\n## 中文標題\n" + "長".repeat(4500);
  expect(splitLegacyMemory(raw)).toHaveLength(3);
  writeFileSync(join(r, ".ultrawork/project.md"), raw);
  expect(await ensureMemoryStoreMigrated(r)).toBe(true);
  const topics = listTopics(memoryLayer(r));
  expect(topics).toHaveLength(3);
  expect(topics.some((t) => t.size > 4000)).toBe(true);
  expect(topics.some((t) => t.topic.endsWith("-2"))).toBe(true);
  expect(existsSync(join(r, ".ultrawork/project.md"))).toBe(false);
  expect(readdirSync(join(r, ".ultrawork")).some((n) => n.startsWith("project.md.migrated-"))).toBe(true);
  expect(await ensureMemoryStoreMigrated(r)).toBe(true);
  expect(readLog(memoryLayer(r))).toHaveLength(3);
});
test("遷移僅轉 ARCHIVING 的有效收據，改名保留全部收據", async () => {
  const r = root();
  mkdirSync(join(r, ".ultrawork/receipts"), { recursive: true });
  const binding = { projectId: "example", projectPath: r };
  writeFileSync(
    join(r, ".ultrawork/tasks.json"),
    JSON.stringify({
      ...binding,
      tasks: { a: { taskId: "a", state: "ARCHIVING" }, b: { taskId: "b", state: "COMPLETED" } },
    }),
  );
  for (const id of ["a", "b"])
    writeFileSync(
      join(r, `.ultrawork/receipts/${id}.json`),
      JSON.stringify({
        ...binding,
        taskId: id,
        status: "ok",
        createdAt: new Date().toISOString(),
        zeroExtractionReason: "無待萃取",
      }),
    );
  expect(await ensureMemoryStoreMigrated(r)).toBe(true);
  expect(readLog(memoryLayer(r))).toHaveLength(1);
  expect(readLog(memoryLayer(r))[0]?.outcome).toBe("legacy-receipt");
});
test("遷移封存目標已存在時不覆蓋，改用未被占用的名稱", async () => {
  const r = root();
  mkdirSync(join(r, ".ultrawork"));
  // 遷移用 `new Date().toISOString()` 產生時間戳；凍結時間才能預先造出碰撞的目標名稱。
  // 凍結期間只支援無參數建構（遷移路徑上只有這種用法），結束後立刻還原。
  const RealDate = globalThis.Date;
  const fixed = new RealDate("2026-09-27T12:00:00.000Z").getTime();
  class FrozenDate extends RealDate {
    constructor() {
      super(fixed);
    }
    static now(): number {
      return fixed;
    }
  }
  globalThis.Date = FrozenDate as unknown as DateConstructor;
  try {
    const timestamp = "2026-09-27T12-00-00-000Z";
    const sentinel = "既有封存，不可覆蓋";
    writeFileSync(join(r, `.ultrawork/project.md.migrated-${timestamp}`), sentinel);
    const raw = "# Overview\n前言\n";
    writeFileSync(join(r, ".ultrawork/project.md"), raw);
    expect(await ensureMemoryStoreMigrated(r)).toBe(true);
    // 既有封存檔內容不變。
    expect(readFileSync(join(r, `.ultrawork/project.md.migrated-${timestamp}`), "utf8")).toBe(sentinel);
    // 新的封存用下一個未被占用的名稱，內容是原本的 project.md。
    const actual = `project.md.migrated-${timestamp}-2`;
    expect(readFileSync(join(r, ".ultrawork", actual), "utf8")).toBe(raw);
    // 遷移標記的 archives 反映實際使用的名稱。
    const marker = JSON.parse(readFileSync(memoryPath(memoryLayer(r), MEMORY_MIGRATION_MARKER), "utf8")) as {
      archives: string[];
    };
    expect(marker.archives).toContain(`.ultrawork/${actual}`);
  } finally {
    globalThis.Date = RealDate;
  }
});
test("遷移拒絕 symlink，不改外部資料", async () => {
  const r = root(),
    outside = root();
  mkdirSync(join(r, ".ultrawork"));
  writeFileSync(join(outside, "old.md"), "# 外部");
  symlinkSync(join(outside, "old.md"), join(r, ".ultrawork/project.md"));
  expect(await ensureMemoryStoreMigrated(r)).toBe(false);
  expect(readFileSync(join(outside, "old.md"), "utf8")).toBe("# 外部");
});
test("遷移失敗重跑不覆寫已產生主題", async () => {
  const r = root(),
    l = memoryLayer(r);
  mkdirSync(memoryPath(l, "topics"), { recursive: true });
  writeFileSync(join(r, ".ultrawork/project.md"), "# Overview\n前言\n## 第二節\n內文");
  mkdirSync(memoryPath(l, "MEMORY.md"));
  expect(await ensureMemoryStoreMigrated(r)).toBe(false);
  const path = memoryPath(l, "topics", "overview.md"),
    before = readFileSync(path, "utf8");
  rmSync(memoryPath(l, "MEMORY.md"), { recursive: true });
  expect(await ensureMemoryStoreMigrated(r)).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(before);
});
test("同 session 快照固定，新 session 讀新內容，pinned 預算不截主題", async () => {
  const r = root(),
    l = memoryLayer(r);
  mkdirSync(memoryPath(l, "topics"), { recursive: true });
  writeFileSync(memoryPath(l, "topics", "a.md"), renderTopic(fm, "舊內容"));
  const fake = createFakeV2Context({ directory: r }),
    get = createMemorySnapshotStore(fake.ctx.storage);
  const a = await get("s", async () => renderMemorySnapshot([l]));
  writeFileSync(memoryPath(l, "topics", "a.md"), renderTopic(fm, "新內容"));
  expect(await get("s", async () => renderMemorySnapshot([l]))).toBe(a);
  expect(await get("new", async () => renderMemorySnapshot([l]))).toContain("新內容");
  writeFileSync(memoryPath(l, "topics", "a.md"), renderTopic(fm, "長".repeat(2600)));
  expect(renderMemorySnapshot([l])).toContain("Pinned 正文超過預算");
});
test("hook 標記不重複，inject false 不掛 hook，unsafe root 略過", async () => {
  const r = root(),
    fake = createFakeV2Context({ directory: r, options: { globalDir: r } });
  await memoryModule.register({ ctx: fake.ctx, settings: DEFAULT_SETTINGS });
  const event = { sessionID: "s", system: [] as { type: string; text: string }[] };
  await fake.sessionHooks.get("context")!(event);
  await fake.sessionHooks.get("context")!(event);
  expect(event.system).toHaveLength(1);
  const off = createFakeV2Context({ directory: r });
  await memoryModule.register({
    ctx: off.ctx,
    settings: { ...DEFAULT_SETTINGS, memory: { ...DEFAULT_SETTINGS.memory, inject: false } },
  });
  expect(off.sessionHooks.has("context")).toBe(false);
  const unsafe = createFakeV2Context({ directory: "/" });
  await memoryModule.register({ ctx: unsafe.ctx, settings: DEFAULT_SETTINGS });
  const e = { sessionID: "s", system: [] };
  await unsafe.sessionHooks.get("context")!(e);
  expect(e.system).toHaveLength(0);
});
