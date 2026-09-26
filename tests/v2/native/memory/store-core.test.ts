import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryLayer, memoryLayers, memoryPath, withMemoryLock } from "../../../../src/modules/memory/layers.ts";
import { parseTopic, renderTopic, validateSlug, type TopicFrontmatter } from "../../../../src/modules/memory/topic.ts";
import { renderIndex } from "../../../../src/modules/memory/index-render.ts";
import { appendLog, readLog, verifyLog, pendingNotes } from "../../../../src/modules/memory/log.ts";
import { searchMemory } from "../../../../src/modules/memory/search.ts";
const roots: string[] = [];
const root = () => {
  const r = mkdtempSync(join(tmpdir(), "memory-core-"));
  roots.push(r);
  return r;
};
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const fm: TopicFrontmatter = {
  title: "發布檢查",
  description: "執行測試",
  type: "decision",
  pinned: false,
  source: "manual",
  created: "2026-09-27T00:00:00.000Z",
  updated: "2026-09-27T00:00:00.000Z",
  verified_at: "",
};
test("主題格式拒絕缺漏、多餘、重複、多行與非法純量", () => {
  const raw = renderTopic(fm, "正文\n");
  expect(parseTopic("release", raw).frontmatter).toEqual(fm);
  for (const malformed of [
    raw.replace(/title:.*\n/, ""),
    raw.replace("---\n", "---\nextra: true\n"),
    raw.replace("---\n", "---\ntitle: another\n"),
    raw.replace('title: "發布檢查"', "title: |\n  multiline"),
    raw.replace("pinned: false", "pinned: maybe"),
    raw.replace('type: "decision"', 'type: "other"'),
    raw.replace('source: "manual"', 'source: "other"'),
  ])
    expect(() => parseTopic("release", malformed)).toThrow();
  for (const slug of ["../a", "A", "", "a/b", "a".repeat(65)]) expect(() => validateSlug(slug)).toThrow();
});
test("索引只列一次 pinned，固定分組並依時間排序", () => {
  const topics = [
    parseTopic("old", renderTopic(fm, "a")),
    parseTopic("new", renderTopic({ ...fm, updated: "2026-09-28T00:00:00.000Z" }, "b")),
    parseTopic("pin", renderTopic({ ...fm, pinned: true }, "c")),
  ];
  const index = renderIndex(topics, "project");
  expect(index.indexOf("topics/pin")).toBeLessThan(index.indexOf("## decision"));
  expect(index.indexOf("topics/new")).toBeLessThan(index.indexOf("topics/old"));
  expect(index.match(/topics\/pin/g)).toHaveLength(1);
});
test("同資料夾只回一層，所有子路徑拒絕 symlink", () => {
  const r = root();
  expect(memoryLayers(r, r)).toHaveLength(1);
  const l = memoryLayer(r);
  mkdirSync(l.directory, { recursive: true });
  symlinkSync(root(), join(l.directory, "topics"));
  expect(() => memoryPath(l, "topics", "a.md")).toThrow();
});
test("hash 鏈偵測損壞，壞尾端拒絕一般附加而 reseal 可復原且不截斷", async () => {
  const l = memoryLayer(root());
  await withMemoryLock(l, () => {
    appendLog(l, [{ kind: "note", content: "筆記", agent: "build", sessionID: "s" }]);
    expect(verifyLog(readLog(l))).toBe(true);
    appendFileSync(memoryPath(l, "log.jsonl"), "broken");
    expect(verifyLog(readLog(l))).toBe(false);
    expect(() => appendLog(l, [{ kind: "note", content: "a", agent: null, sessionID: null }])).toThrow();
    appendLog(l, [{ kind: "reseal", reason: "人工確認", shas: {}, agent: "memorizer", sessionID: "s" }]);
    expect(verifyLog(readLog(l))).toBe(true);
    expect(readLog(l)).toHaveLength(3);
    appendLog(l, [{ kind: "note-consumed", noteSeq: 1, agent: "memorizer", sessionID: "s" }]);
    expect(pendingNotes(readLog(l))).toHaveLength(0);
  });
});
test("中文查詢片段命中正文，搜尋不寫 usage", () => {
  const l = memoryLayer(root());
  mkdirSync(memoryPath(l, "topics"), { recursive: true });
  writeFileSync(memoryPath(l, "topics", "release.md"), renderTopic(fm, "需要發布前檢查"));
  expect(searchMemory([l], "發布流程")[0]?.topic).toBe("release");
});
