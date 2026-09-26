/**
 * project-memory 三工具測試。
 *
 * 由 tests/ultrawork/12-project-memory-tools.test.ts 全數移植，改用
 * setupUltrawork(fake.ctx, { modules: [memoryModule] }) 註冊，
 * 再從 fake.added 取工具執行；workspace 在 os.tmpdir() 下建立，
 * project.md 落在 <root>/.ultrawork/project.md。
 *
 * 與舊版唯一的測試環境差異：隔離執行時沒有 tasks.json／state.md
 *（那是其他模組的檔案），「不寫歷史／不動 registry」改為斷言
 * project.md 位元組不變＋.ultrawork 目錄快照不變。
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupUltrawork } from "../../../../src/index.ts";
import { memoryModule } from "../../../../src/modules/memory/index.ts";
import { PROJECT_MD_LIMIT } from "../../../../src/modules/memory/constants.ts";
import { setProjectMemoryFileOpsForTesting } from "../../../../src/modules/memory/project-memory.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../../_fake-v2-context.ts";

const SAMPLE_PROJECT_MD = `---
label: project
limit: 5000
read_only: false
---
# 專案設定 (L1)

Intro line.

## 規則

- rule one
- rule two

## Plan 系統

Plan state machine here.

## 維護

Maintenance notes.
`;

interface Workspace {
  root: string;
  memoryDir: string;
  projectMd: string;
  cleanup: () => void;
}

function createWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), "uw-project-memory-"));
  const memoryDir = join(root, ".ultrawork");
  mkdirSync(memoryDir, { recursive: true });
  return {
    root,
    memoryDir,
    projectMd: join(memoryDir, "project.md"),
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // 清理失敗不擋測試結果
      }
    },
  };
}

function writeSampleProjectMd(ws: Workspace): void {
  writeFileSync(ws.projectMd, SAMPLE_PROJECT_MD, "utf-8");
}

/** .ultrawork 目錄快照：斷言「沒動到別的檔案」用。 */
function snapshotMemoryDir(memoryDir: string): string[] {
  return readdirSync(memoryDir).sort();
}

/** 把工具執行結果（{ content } JSON 外框）攤平成舊測試的斷言形狀。 */
function parse(result: { content: string }): any {
  const parsed = JSON.parse(result.content) as Record<string, unknown>;
  if (parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
    for (const [key, value] of Object.entries(parsed.data)) {
      if (!(key in parsed)) {
        Object.defineProperty(parsed, key, { configurable: true, enumerable: false, value });
      }
    }
    if (parsed.ok === false && typeof parsed.summary === "string" && !("error" in parsed)) {
      Object.defineProperty(parsed, "error", { configurable: true, enumerable: false, value: parsed.summary });
    }
  }
  return parsed;
}

interface MemoryTools {
  read: any;
  update: any;
  rewrite: any;
  cleanup: () => Promise<void>;
}

async function setupMemory(sessionDirectory: string): Promise<MemoryTools> {
  const fake = createFakeV2Context({ directory: sessionDirectory, sessionDirectory });
  const cleanup = await setupUltrawork(fake.ctx, { modules: [memoryModule] });
  const read = fake.added.get("project-memory-read");
  const update = fake.added.get("project-memory-update");
  const rewrite = fake.added.get("project-memory-rewrite");
  if (!read || !update || !rewrite) throw new Error("project-memory 工具沒有註冊");
  return { read, update, rewrite, cleanup };
}

function run(tool: any, args: Record<string, unknown>): Promise<any> {
  return tool.execute(args, fakeV2ToolContext()).then(parse);
}

async function readSha(tool: any): Promise<string> {
  const r = await run(tool, { mode: "full" });
  return r.fileSha256 ?? r.currentSha256;
}

async function applyUpdate(
  tool: any,
  args: { section: string; content?: string; op?: string; maxChars?: number },
): Promise<any> {
  const preview = await run(tool, { ...args, mode: "preview" });
  if (!preview.ok) return preview;
  const sha = preview.currentSha256;
  return run(tool, { ...args, mode: "apply", expectedSha256: sha });
}

function enoentError(): NodeJS.ErrnoException {
  const error = new Error("project.md disappeared during read") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

describe("project-memory-read", () => {
  test("預設 digest 回 frontmatter、preamble、段落預覽與 SHA", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const result = await run(tools.read, {});
      expect(result.ok).toBe(true);
      expect(result.mode).toBe("digest");
      expect(result.totalSize).toBe(SAMPLE_PROJECT_MD.length);
      expect(typeof result.frontmatter).toBe("string");
      expect(result.frontmatter).toContain("label: project");
      expect(result.preamble).toContain("專案設定");
      expect(Array.isArray(result.sections)).toBe(true);
      expect((result.sections as unknown[]).length).toBe(3);
      expect(result.availableSections).toEqual(["規則", "Plan 系統", "維護"]);
      for (const sec of result.sections as Array<{ name: string; preview: string; size: number }>) {
        expect(typeof sec.preview).toBe("string");
        expect(typeof sec.size).toBe("number");
      }
      expect(result.hint).toMatch(/mode='section'/);
      expect(typeof result.fileSha256).toBe("string");
      expect(typeof result.currentSha256).toBe("string");
      expect(result.fileSha256).toBe(result.currentSha256);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("mode='full' 回全文與 SHA", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const result = await run(tools.read, { mode: "full" });
      expect(result.ok).toBe(true);
      expect(result.mode).toBe("full");
      expect(result.content).toBe(SAMPLE_PROJECT_MD);
      expect(typeof result.fileSha256).toBe("string");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("mode='section' 回指定段落內文與 SHA", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const result = await run(tools.read, { mode: "section", section: "規則" });
      expect(result.ok).toBe(true);
      expect(result.mode).toBe("section");
      expect(result.section).toBe("規則");
      expect(result.content).toContain("- rule one");
      expect(result.content).toContain("- rule two");
      expect(typeof result.fileSha256).toBe("string");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("mode='section' 缺 section 回 SECTION_REQUIRED", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const result = await run(tools.read, { mode: "section" });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("SECTION_REQUIRED");
      expect(Array.isArray(result.availableSections)).toBe(true);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("mode='section' 指到不存在的段落回 SECTION_NOT_FOUND", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const result = await run(tools.read, { mode: "section", section: "不存在" });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("SECTION_NOT_FOUND");
      expect(result.availableSections).toContain("規則");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("project.md 不存在時回錯誤", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      const result = await run(tools.read, { mode: "full" });
      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe("string");
      expect(result.error).toMatch(/找不到 project\.md/);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });
});

describe("project-memory-update", () => {
  test("op='replace' 覆寫段落並保留 frontmatter（preview／apply）", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const preview = await run(tools.update, {
        section: "規則", content: "- new rule", op: "replace", mode: "preview",
      });
      expect(preview.ok).toBe(true);
      expect(preview.mode).toBe("preview");
      expect(preview.changed).toBe(true);
      expect(preview.proposedContent).toContain("- new rule");
      expect(preview.proposedContent).not.toContain("- rule one");
      expect(readFileSync(ws.projectMd, "utf-8")).toBe(SAMPLE_PROJECT_MD);

      const result = await run(tools.update, {
        section: "規則", content: "- new rule", op: "replace", mode: "apply",
        expectedSha256: preview.currentSha256,
      });
      expect(result.ok).toBe(true);
      expect(result.section).toBe("規則");
      expect(result.op).toBe("replace");
      expect(result.mode).toBe("apply");
      expect(result.applied).toBe(true);

      const updated = readFileSync(ws.projectMd, "utf-8");
      expect(updated).toContain("label: project");
      expect(updated).toContain("## 規則");
      expect(updated).toContain("- new rule");
      expect(updated).not.toContain("- rule one");
      expect(updated).toContain("## Plan 系統");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("section 含 CR／LF 直接拒絕且不產生標題", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const before = readFileSync(ws.projectMd);
      const sha = await readSha(tools.read);

      for (const section of ["A\n## B", "A\r## B"]) {
        const readResult = await run(tools.read, { mode: "section", section });
        expect(readResult.ok).toBe(false);
        expect(readResult.code).toBe("INVALID_SECTION_NAME");

        for (const mode of ["preview", "apply"] as const) {
          const result = await run(tools.update, {
            section, content: "injected body", op: "replace", mode, expectedSha256: sha,
          });
          expect(result.ok).toBe(false);
          expect(result.code).toBe("INVALID_SECTION_NAME");
          expect(Buffer.compare(readFileSync(ws.projectMd), before)).toBe(0);
          expect(readFileSync(ws.projectMd, "utf-8")).not.toContain("## B");
        }
      }
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("op='append' 接在既有段落之後", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const result = await applyUpdate(tools.update, { section: "規則", content: "- rule three", op: "append" });
      expect(result.ok).toBe(true);
      expect(result.op).toBe("append");

      const updated = readFileSync(ws.projectMd, "utf-8");
      expect(updated).toContain("- rule one");
      expect(updated).toContain("- rule two");
      expect(updated).toContain("- rule three");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("更新保留其他段落", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      await applyUpdate(tools.update, { section: "維護", content: "Updated maintenance notes.", op: "replace" });

      const updated = readFileSync(ws.projectMd, "utf-8");
      expect(updated).toContain("Updated maintenance notes.");
      expect(updated).toContain("- rule one");
      expect(updated).toContain("Plan state machine here.");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("目標不存在時新增段落", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const result = await applyUpdate(tools.update, { section: "新章節", content: "new section body", op: "replace" });
      expect(result.ok).toBe(true);

      const updated = readFileSync(ws.projectMd, "utf-8");
      expect(updated).toContain("## 新章節");
      expect(updated).toContain("new section body");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("超過上限時拒絕寫入（preview 與 apply）", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const huge = "x".repeat(4900);
      const preview = await run(tools.update, {
        section: "規則", content: huge, op: "replace", mode: "preview",
      });
      expect(preview.ok).toBe(false);
      expect(preview.code).toBe("PROJECT_MD_OVER_LIMIT");
      expect(preview.limit).toBe(5000);
      expect(preview.projected_size).toBeGreaterThan(5000);
      expect(readFileSync(ws.projectMd, "utf-8")).toBe(SAMPLE_PROJECT_MD);

      const read = await run(tools.read, { mode: "full" });
      const apply = await run(tools.update, {
        section: "規則", content: huge, op: "replace", mode: "apply",
        expectedSha256: read.fileSha256,
      });
      expect(apply.ok).toBe(false);
      expect(apply.code).toBe("PROJECT_MD_OVER_LIMIT");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("maxChars 可覆寫上限，但仍受 frontmatter 收緊", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const result = await applyUpdate(tools.update, {
        section: "規則", content: "- rule alpha\n- rule beta", op: "replace", maxChars: 600,
      });
      expect(result.ok).toBe(true);
      expect(result.limit).toBe(600);

      const exactHardLimit = await applyUpdate(tools.update, {
        section: "規則", content: "- rule at hard limit", op: "replace", maxChars: PROJECT_MD_LIMIT,
      });
      expect(exactHardLimit.ok).toBe(true);
      expect(exactHardLimit.limit).toBe(5000);
      expect(exactHardLimit.effectiveLimit).toBe(5000);
      expect(exactHardLimit.hardLimit).toBe(PROJECT_MD_LIMIT);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("maxChars 超過 hard limit 直接拒絕且不寫入", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const before = readFileSync(ws.projectMd);

      for (const mode of ["preview", "apply"] as const) {
        const expectedSha256 = mode === "apply" ? await readSha(tools.read) : undefined;
        const result = await run(tools.update, {
          section: "規則", content: "small proposal", op: "replace", mode,
          maxChars: PROJECT_MD_LIMIT + 1, expectedSha256,
        });
        expect(result.ok).toBe(false);
        expect(result.code).toBe("INVALID_MAX_CHARS");
        expect(result.maxChars).toBe(PROJECT_MD_LIMIT + 1);
        expect(result.hardLimit).toBe(PROJECT_MD_LIMIT);
        expect(Buffer.compare(readFileSync(ws.projectMd), before)).toBe(0);
      }
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("空 section 回 SECTION_REQUIRED", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const result = await run(tools.update, {
        section: "  ", content: "x", op: "replace", mode: "preview",
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("SECTION_REQUIRED");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("maxChars 非正整數回 INVALID_MAX_CHARS", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const result = await run(tools.update, {
        section: "規則", content: "x", op: "replace", mode: "preview", maxChars: 0,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("INVALID_MAX_CHARS");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("更新不寫任何歷史痕跡", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      await applyUpdate(tools.update, { section: "規則", content: "- new rule", op: "replace" });
      await applyUpdate(tools.update, { section: "規則", content: "- another rule", op: "append" });

      const updated = readFileSync(ws.projectMd, "utf-8");
      expect(updated).not.toMatch(/history/i);
      expect(updated).not.toMatch(/transition/i);
      expect(updated).not.toMatch(/last_modified/i);
      expect(updated).not.toMatch(/updated_at/i);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("preview 不寫檔；apply 缺 SHA 被拒", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const preview = await run(tools.update, {
        section: "規則", content: "preview body", op: "replace", mode: "preview",
      });
      expect(preview.ok).toBe(true);
      expect(readFileSync(ws.projectMd, "utf-8")).toBe(SAMPLE_PROJECT_MD);

      const applyNoSha = await run(tools.update, {
        section: "規則", content: "preview body", op: "replace", mode: "apply",
      });
      expect(applyNoSha.ok).toBe(false);
      expect(applyNoSha.code).toBe("EXPECTED_SHA256_REQUIRED");
      expect(readFileSync(ws.projectMd, "utf-8")).toBe(SAMPLE_PROJECT_MD);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("過期 SHA 被拒且不覆寫", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const firstPreview = await run(tools.update, {
        section: "規則", content: "first", op: "replace", mode: "preview",
      });
      const staleSha = firstPreview.currentSha256;
      const firstApply = await run(tools.update, {
        section: "規則", content: "first", op: "replace", mode: "apply", expectedSha256: staleSha,
      });
      expect(firstApply.ok).toBe(true);
      const afterFirst = readFileSync(ws.projectMd, "utf-8");
      expect(afterFirst).toContain("first");

      const secondStale = await run(tools.update, {
        section: "規則", content: "second", op: "replace", mode: "apply", expectedSha256: staleSha,
      });
      expect(secondStale.ok).toBe(false);
      expect(secondStale.code).toBe("PROJECT_MD_HASH_CONFLICT");
      expect(readFileSync(ws.projectMd, "utf-8")).toBe(afterFirst);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("鎖內最終重讀擋下寫入競爭且不寫入", async () => {
    const ws = createWorkspace();
    let restoreFileOps: (() => void) | undefined;
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      let readCount = 0;
      let writeCount = 0;

      restoreFileOps = setProjectMemoryFileOpsForTesting({
        read(path: string): string {
          readCount += 1;
          const current = readFileSync(path, "utf-8");
          if (readCount === 2) {
            writeFileSync(path, `${current}external update change\n`, "utf-8");
          }
          return current;
        },
        write(): void {
          writeCount += 1;
        },
      });

      const preview = await run(tools.update, {
        section: "規則", content: "update final guard proposal", op: "replace", mode: "preview",
      });
      expect(preview.ok).toBe(true);
      const expectedSha = preview.currentSha256;

      const result = await run(tools.update, {
        section: "規則", content: "update final guard proposal", op: "replace",
        mode: "apply", expectedSha256: expectedSha,
      });
      expect(readCount).toBe(3);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("PROJECT_MD_HASH_CONFLICT");
      expect(writeCount).toBe(0);
      expect(readFileSync(ws.projectMd, "utf-8")).toContain("external update change");
      expect(readFileSync(ws.projectMd, "utf-8")).not.toContain("update final guard proposal");
    } finally {
      restoreFileOps?.();
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("delete 只刪目標段落並保留 fence", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      const withFence = `---
label: project
limit: 5000
---
# Title

## Keep

keep body start

\`\`\`
## FakeInsideKeep
# Fake H1 inside Keep
keep fenced content
\`\`\`

keep body end

## Remove

real body to delete

\`\`\`
## Not a section in Remove
\`\`\`

## After

after body start

~~~
## FakeInsideAfter
after fenced content
~~~

after body end
`;
      writeFileSync(ws.projectMd, withFence, "utf-8");

      const preview = await run(tools.update, { section: "Remove", op: "delete", mode: "preview" });
      expect(preview.ok).toBe(true);
      expect(preview.diff.operation).toBe("delete");
      expect(preview.diff.removedContent).toContain("## Remove");
      expect(preview.diff.removedContent).toContain("real body to delete");
      expect(readFileSync(ws.projectMd, "utf-8")).toBe(withFence);

      const apply = await run(tools.update, {
        section: "Remove", op: "delete", mode: "apply", expectedSha256: preview.currentSha256,
      });
      expect(apply.ok).toBe(true);
      const updated = readFileSync(ws.projectMd, "utf-8");
      expect(updated).toContain("label: project");
      expect(updated).toContain("## Keep");
      expect(updated).toContain("## After");
      expect(updated).not.toContain("## Remove");
      expect(updated).not.toContain("real body to delete");
      expect(updated).toContain("```\n## FakeInsideKeep\n# Fake H1 inside Keep\nkeep fenced content\n```");
      expect(updated).toContain("keep body start");
      expect(updated).toContain("keep body end");
      expect(updated).toContain("~~~\n## FakeInsideAfter\nafter fenced content\n~~~");
      expect(updated).toContain("after body start");
      expect(updated).toContain("after body end");
      expect(updated).not.toContain("## Not a section in Remove");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("delete 保留目標 span 之外的原始 CRLF 位元組", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      const exact = [
        "---\r\n",
        "label: project  \r\n",
        "limit: 5000\r\n",
        "---\r\n",
        "# Title\r\n",
        "\r\n",
        "## Keep\r\n",
        "keep trailing spaces  \r\n",
        "\r\n",
        "```\r\n",
        "## FakeInsideKeep\r\n",
        "keep fenced content\r\n",
        "```\r\n",
        "\r\n",
        "keep end\r\n",
        "\r\n",
        "## Remove\r\n",
        "remove trailing spaces  \r\n",
        "\r\n",
        "~~~\r\n",
        "## FakeInsideRemove\r\n",
        "remove fenced content\r\n",
        "~~~\r\n",
        "\r\n",
        "## After\r\n",
        "\r\n",
        "after trailing spaces  \r\n",
        "\r\n",
        "~~~\r\n",
        "## FakeInsideAfter\r\n",
        "after fenced content\r\n",
        "~~~\r\n",
        "after end  \r\n",
        "\r\n",
      ].join("");
      const expected = [
        "---\r\n",
        "label: project  \r\n",
        "limit: 5000\r\n",
        "---\r\n",
        "# Title\r\n",
        "\r\n",
        "## Keep\r\n",
        "keep trailing spaces  \r\n",
        "\r\n",
        "```\r\n",
        "## FakeInsideKeep\r\n",
        "keep fenced content\r\n",
        "```\r\n",
        "\r\n",
        "keep end\r\n",
        "\r\n",
        "## After\r\n",
        "\r\n",
        "after trailing spaces  \r\n",
        "\r\n",
        "~~~\r\n",
        "## FakeInsideAfter\r\n",
        "after fenced content\r\n",
        "~~~\r\n",
        "after end  \r\n",
        "\r\n",
      ].join("");
      writeFileSync(ws.projectMd, exact, "utf-8");
      const beforePreview = readFileSync(ws.projectMd);

      const preview = await run(tools.update, { section: "Remove", op: "delete", mode: "preview" });
      expect(preview.ok).toBe(true);
      expect(preview.proposedContent).toBe(expected);
      expect(preview.diff.removedContent).toContain("## Remove\r\nremove trailing spaces  \r\n");
      expect(preview.diff.removedContent).toContain("## FakeInsideRemove\r\n");
      expect(Buffer.compare(readFileSync(ws.projectMd), beforePreview)).toBe(0);

      const apply = await run(tools.update, {
        section: "Remove", op: "delete", mode: "apply", expectedSha256: preview.currentSha256,
      });
      expect(apply.ok).toBe(true);
      expect(Buffer.compare(readFileSync(ws.projectMd), Buffer.from(expected, "utf-8"))).toBe(0);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("delete 指到不存在的段落回 SECTION_NOT_FOUND", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const preview = await run(tools.update, { section: "不存在", op: "delete", mode: "preview" });
      expect(preview.ok).toBe(false);
      expect(preview.code).toBe("SECTION_NOT_FOUND");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("replace 缺 content 回 CONTENT_REQUIRED", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const result = await run(tools.update, { section: "規則", op: "replace", mode: "preview" });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("CONTENT_REQUIRED");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("fence 內的假標題不算段落", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      const withFence = `---
label: project
limit: 5000
---
# Title

## Real

real body

\`\`\`
## FakeInsideBacktick
content
\`\`\`

~~~
## FakeInsideTilde
content
~~~

\`\`\`\`markdown
## FakeLongFence
\`\`\`\`

## Real2

second real
`;
      writeFileSync(ws.projectMd, withFence, "utf-8");

      const digest = await run(tools.read, {});
      expect(digest.ok).toBe(true);
      expect(digest.availableSections).toEqual(["Real", "Real2"]);

      const sectionFake = await run(tools.read, { mode: "section", section: "FakeInsideBacktick" });
      expect(sectionFake.ok).toBe(false);
      expect(sectionFake.code).toBe("SECTION_NOT_FOUND");

      const previewDeleteFake = await run(tools.update, {
        section: "FakeInsideBacktick", op: "delete", mode: "preview",
      });
      expect(previewDeleteFake.ok).toBe(false);
      expect(previewDeleteFake.code).toBe("SECTION_NOT_FOUND");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("project.md 缺席時 preview／apply 都回 NOT_FOUND 且不建檔", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      const before = snapshotMemoryDir(ws.memoryDir);

      const preview = await run(tools.update, {
        section: "規則", content: "x", op: "replace", mode: "preview",
      });
      expect(preview.ok).toBe(false);
      expect(preview.code).toBe("PROJECT_MD_NOT_FOUND");
      expect(snapshotMemoryDir(ws.memoryDir)).toEqual(before);

      const applyNoSha = await run(tools.update, {
        section: "規則", content: "x", op: "replace", mode: "apply",
      });
      expect(applyNoSha.ok).toBe(false);
      expect(applyNoSha.code).toBe("PROJECT_MD_NOT_FOUND");
      expect(snapshotMemoryDir(ws.memoryDir)).toEqual(before);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("過期 SHA apply 不改檔也不動其他檔案", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const dirBefore = snapshotMemoryDir(ws.memoryDir);

      const preview = await run(tools.update, {
        section: "規則", content: "first", op: "replace", mode: "preview",
      });
      const stale = preview.currentSha256;
      const first = await run(tools.update, {
        section: "規則", content: "first", op: "replace", mode: "apply", expectedSha256: stale,
      });
      expect(first.ok).toBe(true);
      const afterFirst = readFileSync(ws.projectMd, "utf-8");

      const staleApply = await run(tools.update, {
        section: "規則", content: "second", op: "replace", mode: "apply", expectedSha256: stale,
      });
      expect(staleApply.ok).toBe(false);
      expect(staleApply.code).toBe("PROJECT_MD_HASH_CONFLICT");
      expect(readFileSync(ws.projectMd, "utf-8")).toBe(afterFirst);
      expect(snapshotMemoryDir(ws.memoryDir)).toEqual(dirBefore);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("拿不到鎖時回 CONTENT_LOCK_BUSY 且不改檔", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const beforeContent = readFileSync(ws.projectMd, "utf-8");
      const dirBefore = snapshotMemoryDir(ws.memoryDir);

      const preview = await run(tools.update, {
        section: "規則", content: "locked", op: "replace", mode: "preview",
      });
      expect(preview.ok).toBe(true);

      const lockPath = join(ws.memoryDir, ".project-memory.lock");
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: "test-lock-busy" }),
        { flag: "wx" },
      );

      const busy = await run(tools.update, {
        section: "規則", content: "locked", op: "replace", mode: "apply",
        expectedSha256: preview.currentSha256,
      });
      expect(busy.ok).toBe(false);
      expect(busy.code).toBe("CONTENT_LOCK_BUSY");
      expect(readFileSync(ws.projectMd, "utf-8")).toBe(beforeContent);
      expect(snapshotMemoryDir(ws.memoryDir)).toEqual([...dirBefore, ".project-memory.lock"].sort());
      expect(readFileSync(lockPath, "utf-8")).toContain("test-lock-busy");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("update 與 rewrite 缺 frontmatter／壞 frontmatter 時拒絕且不寫入", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      const invalidDocuments = [
        "# No frontmatter\n\n## 規則\n\nbody\n",
        "---\nlabel: project\n# missing closing delimiter\n\n# Title\n",
      ];

      for (const invalidDocument of invalidDocuments) {
        writeFileSync(ws.projectMd, invalidDocument, "utf-8");
        const before = readFileSync(ws.projectMd);
        const sha = await readSha(tools.read);

        const updatePreview = await run(tools.update, {
          section: "規則", content: "replacement", op: "replace", mode: "preview",
        });
        expect(updatePreview.ok).toBe(false);
        expect(updatePreview.code).toBe("PROJECT_MD_FRONTMATTER_REQUIRED");
        expect(Buffer.compare(readFileSync(ws.projectMd), before)).toBe(0);

        const updateApply = await run(tools.update, {
          section: "規則", content: "replacement", op: "replace", mode: "apply", expectedSha256: sha,
        });
        expect(updateApply.ok).toBe(false);
        expect(updateApply.code).toBe("PROJECT_MD_FRONTMATTER_REQUIRED");
        expect(Buffer.compare(readFileSync(ws.projectMd), before)).toBe(0);

        const rewritePreview = await run(tools.rewrite, { body: "# Replacement\n\n## New", mode: "preview" });
        expect(rewritePreview.ok).toBe(false);
        expect(rewritePreview.code).toBe("PROJECT_MD_FRONTMATTER_REQUIRED");
        expect(Buffer.compare(readFileSync(ws.projectMd), before)).toBe(0);

        const rewriteApply = await run(tools.rewrite, {
          body: "# Replacement\n\n## New", mode: "apply", expectedSha256: sha,
        });
        expect(rewriteApply.ok).toBe(false);
        expect(rewriteApply.code).toBe("PROJECT_MD_FRONTMATTER_REQUIRED");
        expect(Buffer.compare(readFileSync(ws.projectMd), before)).toBe(0);
      }
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });
});

describe("project-memory-rewrite", () => {
  test("rewrite 共用寫入鎖：鎖被佔用時回 CONTENT_LOCK_BUSY", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const beforeContent = readFileSync(ws.projectMd, "utf-8");
      const preview = await run(tools.rewrite, { body: "# Replacement\n\n## New", mode: "preview" });
      expect(preview.ok).toBe(true);
      expect(preview.proposedContent).toContain("# Replacement");
      expect(readFileSync(ws.projectMd, "utf-8")).toBe(beforeContent);
      const sha = preview.currentSha256;
      const lockPath = join(ws.memoryDir, ".project-memory.lock");
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: "rewrite-lock-busy" }),
        { flag: "wx" },
      );

      const busy = await run(tools.rewrite, {
        body: "# Replacement\n\n## New", mode: "apply", expectedSha256: sha,
      });
      expect(busy.ok).toBe(false);
      expect(busy.code).toBe("CONTENT_LOCK_BUSY");
      expect(readFileSync(ws.projectMd, "utf-8")).toBe(beforeContent);
      expect(readFileSync(lockPath, "utf-8")).toContain("rewrite-lock-busy");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("rewrite 擋重複 H2 與缺 H1／含 frontmatter 的 body", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const before = readFileSync(ws.projectMd);

      const dup = await run(tools.rewrite, {
        body: "# Title\n\n## Same\none\n\n## Same\ntwo\n", mode: "preview",
      });
      expect(dup.ok).toBe(false);
      expect(dup.code).toBe("DUPLICATE_H2_HEADINGS");
      expect(dup.duplicateHeadings).toContain("Same");

      const noH1 = await run(tools.rewrite, { body: "## Only H2\nbody\n", mode: "preview" });
      expect(noH1.ok).toBe(false);
      expect(noH1.code).toBe("PROJECT_MD_BODY_INVALID");

      const withFm = await run(tools.rewrite, {
        body: "---\nlabel: x\n---\n# Title\n", mode: "preview",
      });
      expect(withFm.ok).toBe(false);
      expect(withFm.code).toBe("PROJECT_MD_BODY_INVALID");

      expect(Buffer.compare(readFileSync(ws.projectMd), before)).toBe(0);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("rewrite preview／apply 整份替換並保留 frontmatter", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const preview = await run(tools.rewrite, { body: "# Replacement\n\n## New\nnew body\n", mode: "preview" });
      expect(preview.ok).toBe(true);
      expect(preview.changed).toBe(true);
      expect(preview.proposedContent).toContain("label: project");
      expect(preview.proposedContent).toContain("# Replacement");

      const apply = await run(tools.rewrite, {
        body: "# Replacement\n\n## New\nnew body\n", mode: "apply",
        expectedSha256: preview.currentSha256,
      });
      expect(apply.ok).toBe(true);
      expect(apply.applied).toBe(true);
      const updated = readFileSync(ws.projectMd, "utf-8");
      expect(updated).toContain("label: project");
      expect(updated).toContain("limit: 5000");
      expect(updated).toContain("# Replacement");
      expect(updated).not.toContain("- rule one");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("rewrite 超限拒絕且不寫入", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const huge = `# Replacement\n\n## New\n${"x".repeat(5100)}\n`;
      const preview = await run(tools.rewrite, { body: huge, mode: "preview" });
      expect(preview.ok).toBe(false);
      expect(preview.code).toBe("PROJECT_MD_OVER_LIMIT");
      expect(readFileSync(ws.projectMd, "utf-8")).toBe(SAMPLE_PROJECT_MD);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("rewrite 寫入前重讀擋下外部修改且不寫入", async () => {
    const ws = createWorkspace();
    let restoreFileOps: (() => void) | undefined;
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      let readCount = 0;
      let writeCount = 0;
      restoreFileOps = setProjectMemoryFileOpsForTesting({
        read(path: string): string {
          const current = readFileSync(path, "utf-8");
          readCount += 1;
          if (readCount === 3) {
            writeFileSync(path, `${current}external editor change\n`, "utf-8");
          }
          return current;
        },
        write(): void {
          writeCount += 1;
        },
      });
      const sha = await readSha(tools.read);

      const result = await run(tools.rewrite, {
        body: "# Replacement\n\n## New", mode: "apply", expectedSha256: sha,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("PROJECT_MD_HASH_CONFLICT");
      expect(readCount).toBeGreaterThanOrEqual(4);
      expect(writeCount).toBe(0);
      expect(readFileSync(ws.projectMd, "utf-8")).toContain("external editor change");
    } finally {
      restoreFileOps?.();
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("read／update／rewrite 對 ENOENT 讀取競爭回 NOT_FOUND；EACCES 照原樣拋出", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const before = readFileSync(ws.projectMd);
      const sha = await readSha(tools.read);
      let writeCount = 0;

      const restorePreview = setProjectMemoryFileOpsForTesting({
        exists: () => true,
        read: () => {
          throw enoentError();
        },
        write: () => {
          writeCount += 1;
        },
      });
      try {
        const readRace = await run(tools.read, { mode: "full" });
        expect(readRace.ok).toBe(false);
        expect(readRace.code).toBe("PROJECT_MD_NOT_FOUND");

        const updatePreviewRace = await run(tools.update, {
          section: "規則", content: "race", op: "replace", mode: "preview",
        });
        expect(updatePreviewRace.ok).toBe(false);
        expect(updatePreviewRace.code).toBe("PROJECT_MD_NOT_FOUND");

        const updateApplyRace = await run(tools.update, {
          section: "規則", content: "race", op: "replace", mode: "apply", expectedSha256: sha,
        });
        expect(updateApplyRace.ok).toBe(false);
        expect(updateApplyRace.code).toBe("PROJECT_MD_NOT_FOUND");

        const rewriteInitialRace = await run(tools.rewrite, {
          body: "# Replacement\n\n## New", mode: "preview",
        });
        expect(rewriteInitialRace.ok).toBe(false);
        expect(rewriteInitialRace.code).toBe("PROJECT_MD_NOT_FOUND");
      } finally {
        restorePreview();
      }

      let readCount = 0;
      const restoreLock = setProjectMemoryFileOpsForTesting({
        exists: () => true,
        read: () => {
          readCount += 1;
          if (readCount === 1) return before.toString();
          throw enoentError();
        },
        write: () => {
          writeCount += 1;
        },
      });
      try {
        const rewriteLockRace = await run(tools.rewrite, {
          body: "# Replacement\n\n## New", mode: "apply", expectedSha256: sha,
        });
        expect(rewriteLockRace.ok).toBe(false);
        expect(rewriteLockRace.code).toBe("PROJECT_MD_NOT_FOUND");
        expect(readCount).toBe(2);
      } finally {
        restoreLock();
      }

      expect(writeCount).toBe(0);
      expect(Buffer.compare(readFileSync(ws.projectMd), before)).toBe(0);

      const nonEnoentError = Object.assign(new Error("permission denied during read"), { code: "EACCES" });
      const restoreNonEnoent = setProjectMemoryFileOpsForTesting({
        exists: () => true,
        read: () => {
          throw nonEnoentError;
        },
      });
      try {
        let observed: unknown;
        try {
          await tools.read.execute({ mode: "full" }, fakeV2ToolContext());
        } catch (error) {
          observed = error;
        }
        expect(observed).toBe(nonEnoentError);
      } finally {
        restoreNonEnoent();
      }
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("exists 的 EACCES 由 read／update／rewrite 原樣拋出", async () => {
    const ws = createWorkspace();
    const tools = await setupMemory(ws.root);
    try {
      writeSampleProjectMd(ws);
      const cases = [
        [tools.read, { mode: "full" }],
        [tools.update, { section: "規則", content: "unchanged", op: "replace", mode: "preview" }],
        [tools.rewrite, { body: "# Replacement\n\n## New", mode: "preview" }],
      ] as const;
      for (const [tool, args] of cases) {
        const permissionError = Object.assign(new Error("permission denied while checking project.md"), { code: "EACCES" });
        const restoreFileOps = setProjectMemoryFileOpsForTesting({
          exists: () => {
            throw permissionError;
          },
        });
        try {
          let observed: unknown;
          try {
            await tool.execute(args, fakeV2ToolContext());
          } catch (error) {
            observed = error;
          }
          expect(observed).toBe(permissionError);
        } finally {
          restoreFileOps();
        }
      }
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });
});
