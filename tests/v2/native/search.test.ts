/**
 * search 模組原生實作：peek_file、grep_context。
 *
 * 由 tests/ultrawork/27-search-tools-v2.test.ts 移植，改用
 * setupUltrawork(fake.ctx, { modules: [searchModule] }) 註冊，
 * 再從 fake.added 取工具執行；workspace 在 os.tmpdir() 下建立。
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupUltrawork } from "../../../src/index.ts";
import { searchModule } from "../../../src/modules/search/index.ts";
import { resolveAttachFile } from "../../../src/modules/search/grep-context.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../_fake-v2-context.ts";

function createWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "uw-search-"));
  return {
    root,
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // 清理失敗不擋測試結果
      }
    },
  };
}

interface SearchTools {
  peek: any;
  grep: any;
  cleanup: () => Promise<void>;
}

async function setupSearch(sessionDirectory: string, directory?: string): Promise<SearchTools> {
  const fake = createFakeV2Context({ directory: directory ?? sessionDirectory, sessionDirectory });
  const cleanup = await setupUltrawork(fake.ctx, { modules: [searchModule] });
  const peek = fake.added.get("peek_file");
  const grep = fake.added.get("grep_context");
  if (!peek || !grep) throw new Error("search 工具沒有註冊");
  return { peek, grep, cleanup };
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

function run(tool: any, args: Record<string, unknown>): Promise<any> {
  return tool.execute(args, fakeV2ToolContext()).then(parse);
}

describe("search 模組：peek_file", () => {
  test("回傳有界、帶行號的行區間", async () => {
    const ws = createWorkspace();
    const tools = await setupSearch(ws.root);
    try {
      const file = join(ws.root, "sample.ts");
      writeFileSync(file, Array.from({ length: 40 }, (_, index) => `line-${index + 1}`).join("\n"));

      const result = await run(tools.peek, {
        file: "sample.ts",
        mode: "range",
        startLine: 10,
        lineCount: 5,
        maxChars: 2000,
      });

      expect(result.ok).toBe(true);
      expect(result.file).toBe("sample.ts");
      expect(result.excerpt.startLine).toBe(10);
      expect(result.excerpt.endLine).toBe(14);
      // 內容是「行號: 原文」一行一列的文字，不是每行一個物件：
      // 逐行物件的外框比原文本身還長。
      expect(result.excerpt.lines).toBe("10: line-10\n11: line-11\n12: line-12\n13: line-13\n14: line-14");
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(2000);
      expect(result.nextStartLine).toBe(15);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("擋 traversal、symlink 逃逸、敏感檔案、二進位檔", async () => {
    const ws = createWorkspace();
    const tools = await setupSearch(ws.root);
    const outside = join(tmpdir(), `peek-outside-${Date.now()}.txt`);
    try {
      writeFileSync(outside, "outside");
      writeFileSync(join(ws.root, ".env"), "SECRET=value");
      writeFileSync(join(ws.root, ".env.example"), "SECRET=placeholder");
      writeFileSync(join(ws.root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
      symlinkSync(outside, join(ws.root, "escape-link"));
      symlinkSync(join(ws.root, ".env"), join(ws.root, "env-link"));

      const traversal = await run(tools.peek, { file: outside });
      expect(traversal.code).toBe("PATH_OUTSIDE_WORKTREE");

      const symlink = await run(tools.peek, { file: "escape-link" });
      expect(symlink.code).toBe("PATH_OUTSIDE_WORKTREE");

      const sensitive = await run(tools.peek, { file: ".env" });
      expect(sensitive.code).toBe("SENSITIVE_PATH");

      const sensitiveLink = await run(tools.peek, { file: "env-link" });
      expect(sensitiveLink.code).toBe("SENSITIVE_PATH");

      const example = await run(tools.peek, { file: ".env.example", mode: "head", lineCount: 2 });
      expect(example.ok).toBe(true);

      const binary = await run(tools.peek, { file: "binary.bin" });
      expect(binary.code).toBe("BINARY_FILE");
    } finally {
      try { unlinkSync(outside); } catch {}
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("支援 outline、around、tail 模式與行號", async () => {
    const ws = createWorkspace();
    const tools = await setupSearch(ws.root);
    try {
      const file = join(ws.root, "doc.md");
      writeFileSync(file, [
        "# Title",
        "intro text",
        "## Section A",
        "body",
        "### Sub",
        "more",
        "function foo() {}",
        "export class Bar {}",
        "const x = 1",
        "tail-1",
        "tail-2",
        "tail-3",
      ].join("\n"));

      const outline = await run(tools.peek, { file: "doc.md", mode: "outline", maxChars: 2000 });
      expect(outline.ok).toBe(true);
      expect(outline.outline).toBe("1: # Title\n3: ## Section A\n5: ### Sub\n7: function foo() {}\n8: export class Bar {}");
      expect(outline.profile.mode).toBe("outline");

      const around = await run(tools.peek, { file: "doc.md", mode: "around", line: 5, context: 2, maxChars: 2000 });
      expect(around.ok).toBe(true);
      expect(around.excerpt.startLine).toBe(3);
      expect(around.excerpt.endLine).toBe(7);
      expect(around.excerpt.lines).toBe("3: ## Section A\n4: body\n5: ### Sub\n6: more\n7: function foo() {}");

      const tail = await run(tools.peek, { file: "doc.md", mode: "tail", lineCount: 3, maxChars: 2000 });
      expect(tail.ok).toBe(true);
      expect(tail.excerpt.startLine).toBe(10);
      expect(tail.excerpt.endLine).toBe(12);
      expect(tail.excerpt.lines).toBe("10: tail-1\n11: tail-2\n12: tail-3");
      expect(tail.truncated).toBe(false);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("讀不到的檔案回結構化 FILE_NOT_FOUND", async () => {
    const ws = createWorkspace();
    const tools = await setupSearch(ws.root);
    try {
      const peek = await run(tools.peek, { file: "nope.txt" });
      expect(peek.ok).toBe(false);
      expect(peek.code).toBe("FILE_NOT_FOUND");

      const grep = await run(tools.grep, { pattern: "x", target: "nope.txt", mode: "literal" });
      expect(grep.ok).toBe(false);
      expect(grep.code).toBe("FILE_NOT_FOUND");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("拒絕相對 traversal 路徑", async () => {
    const ws = createWorkspace();
    const tools = await setupSearch(ws.root);
    try {
      writeFileSync(join(ws.root, "sample.ts"), "needle\n");

      const peek = await run(tools.peek, { file: "../outside.txt" });
      expect(peek.ok).toBe(false);
      expect(peek.code).toBe("PATH_OUTSIDE_WORKTREE");

      const grep = await run(tools.grep, { pattern: "needle", target: "../outside.txt", mode: "literal" });
      expect(grep.ok).toBe(false);
      expect(grep.code).toBe("PATH_OUTSIDE_WORKTREE");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("讀取失敗回結構化 FILE_READ_ERROR", async () => {
    const ws = createWorkspace();
    const tools = await setupSearch(ws.root);
    const locked = join(ws.root, "locked.txt");
    try {
      writeFileSync(locked, "secret content\n");
      chmodSync(locked, 0o000);

      const peek = await run(tools.peek, { file: "locked.txt", mode: "head", lineCount: 2 });
      expect(peek.ok).toBe(false);
      expect(peek.code).toBe("FILE_READ_ERROR");

      const grep = await run(tools.grep, { pattern: "secret", target: "locked.txt", mode: "literal" });
      expect(grep.ok).toBe(false);
      expect(grep.code).toBe("FILE_READ_ERROR");
    } finally {
      try { chmodSync(locked, 0o644); } catch {}
      await tools.cleanup();
      ws.cleanup();
    }
  });
});

describe("search 模組：grep_context", () => {
  test("回傳確定性、可分頁的結構化命中", async () => {
    const ws = createWorkspace();
    const tools = await setupSearch(ws.root);
    try {
      mkdirSync(join(ws.root, "src"), { recursive: true });
      writeFileSync(join(ws.root, "src", "a.ts"), "needle one\nignore\nneedle two\n");
      writeFileSync(join(ws.root, "src", "b.ts"), "needle three\nneedle four\n");
      writeFileSync(join(ws.root, "src", "types.d.ts"), "declare const needle: string;\n");

      const first = await run(tools.grep, {
        pattern: "needle",
        target: "src",
        mode: "literal",
        context: 0,
        maxMatches: 2,
        maxChars: 4000,
      });

      expect(first.ok).toBe(true);
      expect(first.returnedMatches).toBe(2);
      expect(first.truncated).toBe(true);
      expect(first.nextOffset).toBe(2);
      expect(first.matches[0]).toMatchObject({ file: "src/a.ts", line: 1 });
      expect(first.matches[1]).toMatchObject({ file: "src/a.ts", line: 3 });
      expect(JSON.stringify(first).length).toBeLessThanOrEqual(4000);

      const second = await run(tools.grep, {
        pattern: "needle",
        target: "src",
        mode: "literal",
        context: 0,
        maxMatches: 2,
        maxChars: 4000,
        offset: 2,
      });
      expect(second.matches[0]).toMatchObject({ file: "src/b.ts", line: 1 });

      const definitions = await run(tools.grep, {
        pattern: "declare const needle",
        target: "src",
        mode: "literal",
        context: 0,
      });
      expect(definitions.matches.some((match: { file: string }) => match.file === "src/types.d.ts")).toBe(true);

      const boundedRaw = await tools.grep.execute({
        pattern: "needle",
        target: "src",
        mode: "literal",
        context: 2,
        maxMatches: 100,
        maxChars: 1000,
      }, fakeV2ToolContext());
      expect(boundedRaw.content.length).toBeLessThanOrEqual(1000);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("把命中行和前後文合成一段帶行號的文字", async () => {
    const ws = createWorkspace();
    const tools = await setupSearch(ws.root);
    try {
      mkdirSync(join(ws.root, "src"), { recursive: true });
      writeFileSync(join(ws.root, "src", "a.ts"), "needle one\nignore\nneedle two\ntail\n");
      const result = await run(tools.grep, {
        pattern: "needle",
        target: "src",
        mode: "literal",
        context: 1,
      });

      expect(result.ok).toBe(true);
      // 沿用 ripgrep 的慣例：命中行是「行號: 」，前後文是「行號- 」。
      expect(result.matches).toEqual([
        { file: "src/a.ts", line: 1, column: 1, lines: "1: needle one\n2- ignore" },
        { file: "src/a.ts", line: 3, column: 1, lines: "2- ignore\n3: needle two\n4- tail" },
      ]);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("守住 worktree 與敏感路徑邊界", async () => {
    const ws = createWorkspace();
    const tools = await setupSearch(ws.root);
    const outside = join(tmpdir(), `grep-outside-${Date.now()}.txt`);
    try {
      writeFileSync(outside, "needle");
      writeFileSync(join(ws.root, ".env"), "needle=secret");

      const traversal = await run(tools.grep, { pattern: "needle", target: outside });
      expect(traversal.code).toBe("PATH_OUTSIDE_WORKTREE");

      const sensitive = await run(tools.grep, { pattern: "needle", target: ".env" });
      expect(sensitive.code).toBe("SENSITIVE_PATH");
    } finally {
      try { unlinkSync(outside); } catch {}
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("工作階段位置為準：外掛目錄是 / 也不影響", async () => {
    const ws = createWorkspace();
    // 外掛所在目錄 canonical 是 /（暫存目錄下的 symlink alias），但工作階段位置
    // 仍是 workspace：工具照工作階段位置解析。fixture 只用暫存路徑，不拿真的 / 當根。
    const pluginDirAlias = join(tmpdir(), `ultrawork-plugin-dir-alias-${Date.now()}`);
    symlinkSync("/", pluginDirAlias);
    const tools = await setupSearch(ws.root, pluginDirAlias);
    try {
      writeFileSync(join(ws.root, "sample.ts"), "needle line\n");

      const peek = await run(tools.peek, {
        file: "sample.ts",
        mode: "head",
        lineCount: 2,
      });
      expect(peek.ok).toBe(true);
      expect(peek.file).toBe("sample.ts");

      const grep = await run(tools.grep, {
        pattern: "needle",
        target: "sample.ts",
        mode: "literal",
        context: 0,
      });
      expect(grep.ok).toBe(true);
      expect(grep.matches.some((match: { file: string }) => match.file === "sample.ts")).toBe(true);
    } finally {
      try { unlinkSync(pluginDirAlias); } catch {}
      await tools.cleanup();
      ws.cleanup();
    }
  });
  test("不安全的工作階段根目錄直接 fail closed", async () => {
    const ws = createWorkspace();
    // fixture 只用暫存路徑：alias 在暫存目錄下，canonical 分別指向 /、/Users、
    // /Volumes（lexical 字面不再拿真的系統根當根目錄，避免 setup 時對真的 /
    // 跑搬遷；字面 "/" 的判定由 kit isUnsafeRoot 單元測試覆蓋）。
    const unsafeTargets = ["/", "/Users", "/Volumes"];
    const aliases = unsafeTargets.map((_, index) => join(tmpdir(), `ultrawork-root-alias-${Date.now()}-${index}`));
    try {
      for (const [index, target] of unsafeTargets.entries()) {
        symlinkSync(target, aliases[index]);
      }
      writeFileSync(join(ws.root, "sample.ts"), "needle\n");

      for (const projectRoot of aliases) {
        const tools = await setupSearch(projectRoot);

        const peek = await run(tools.peek, { file: "sample.ts" });
        expect(peek.code, `peek with projectRoot=${projectRoot}`).toBe("UNSAFE_ROOT");

        const grep = await run(tools.grep, { pattern: "needle", target: "sample.ts" });
        expect(grep.code, `grep with projectRoot=${projectRoot}`).toBe("UNSAFE_ROOT");
        await tools.cleanup();
      }
    } finally {
      for (const alias of aliases) {
        try { unlinkSync(alias); } catch {}
      }
      ws.cleanup();
    }
  });

  test("include glob 也撈不到敏感檔案的命中", async () => {
    const ws = createWorkspace();
    const tools = await setupSearch(ws.root);
    try {
      writeFileSync(join(ws.root, ".env"), "needle=secret\n");
      writeFileSync(join(ws.root, "secret.pem"), "needle pem\n");
      writeFileSync(join(ws.root, "ok.txt"), "needle ok\n");

      const result = await run(tools.grep, {
        pattern: "needle",
        target: ".",
        mode: "literal",
        context: 0,
        include: ["**/*"],
      });

      expect(result.ok).toBe(true);
      const files = result.matches.map((match: { file: string }) => match.file);
      expect(files).toContain("ok.txt");
      expect(files).not.toContain(".env");
      expect(files).not.toContain("secret.pem");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("分頁跳過被過濾的敏感命中，不重複也不漏接", async () => {
    const ws = createWorkspace();
    const tools = await setupSearch(ws.root);
    try {
      writeFileSync(join(ws.root, ".env"), "needle=secret\n");
      writeFileSync(join(ws.root, "ok1.txt"), "needle one\n");
      writeFileSync(join(ws.root, "ok2.txt"), "needle two\n");

      const first = await run(tools.grep, {
        pattern: "needle",
        target: ".",
        mode: "literal",
        context: 0,
        maxMatches: 1,
        include: ["**/*"],
      });
      expect(first.ok).toBe(true);
      expect(first.matches.map((match: { file: string }) => match.file)).toEqual(["ok1.txt"]);
      expect(first.nextOffset).toBe(1);

      const second = await run(tools.grep, {
        pattern: "needle",
        target: ".",
        mode: "literal",
        context: 0,
        maxMatches: 1,
        offset: 1,
        include: ["**/*"],
      });
      expect(second.ok).toBe(true);
      expect(second.matches.map((match: { file: string }) => match.file)).toEqual(["ok2.txt"]);
      expect(second.nextOffset).toBeNull();
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("回報專案相對路徑；共同前綴的兄弟目錄不混入", async () => {
    const ws = createWorkspace();
    const tools = await setupSearch(ws.root);
    const sibling = `${ws.root}-old`;
    try {
      mkdirSync(join(ws.root, "src"), { recursive: true });
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(ws.root, "src", "a.ts"), "needle\n");
      writeFileSync(join(sibling, "needle.txt"), "needle\n");

      const result = await run(tools.grep, {
        pattern: "needle",
        target: ".",
        mode: "literal",
        context: 0,
      });
      expect(result.ok).toBe(true);
      const files = result.matches.map((match: { file: string }) => match.file);
      expect(files).toEqual(["src/a.ts"]);
      expect(files.some((file: string) => file.includes("old"))).toBe(false);

      const outside = await run(tools.peek, { file: join(sibling, "needle.txt") });
      expect(outside.code).toBe("PATH_OUTSIDE_WORKTREE");
    } finally {
      try { rmSync(sibling, { recursive: true, force: true }); } catch {}
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("讀取前重新確認 containment：attach 擋外部 symlink", async () => {
    const ws = createWorkspace();
    const outside = join(tmpdir(), `attach-outside-${Date.now()}.txt`);
    try {
      writeFileSync(outside, "EXTERNAL SECRET\nneedle\n");
      writeFileSync(join(ws.root, "ok.txt"), "needle\n");
      symlinkSync(outside, join(ws.root, "escape-link.txt"));
      // production 流程傳入的 worktreeRoot 是 canonical realpath（resolveReadableTarget
      // 已 realpath）；macOS 的 /var -> /private/var 會讓 ws.root 非 canonical。
      const root = realpathSync(ws.root);

      const ok = resolveAttachFile("ok.txt", root);
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.absolutePath).toBe(realpathSync(join(ws.root, "ok.txt")));

      const escape = resolveAttachFile("escape-link.txt", root);
      expect(escape.ok).toBe(false);

      const deleted = resolveAttachFile("deleted.txt", root);
      expect(deleted.ok).toBe(false);
    } finally {
      try { unlinkSync(outside); } catch {}
      ws.cleanup();
    }
  });

  test("attach 擋 root 內的敏感替換檔", async () => {
    const ws = createWorkspace();
    try {
      writeFileSync(join(ws.root, ".env"), "SECRET=value\n");
      writeFileSync(join(ws.root, "secret.pem"), "PRIVATE KEY\n");
      writeFileSync(join(ws.root, "id_ed25519"), "PRIVATE KEY\n");
      writeFileSync(join(ws.root, "ok.txt"), "needle\n");
      // root 內指向 sensitive 檔案的 symlink 也必須拒絕（canonical 後仍為 sensitive）
      symlinkSync(join(ws.root, ".env"), join(ws.root, "env-link.txt"));
      const root = realpathSync(ws.root);

      expect(resolveAttachFile(".env", root).ok).toBe(false);
      expect(resolveAttachFile("secret.pem", root).ok).toBe(false);
      expect(resolveAttachFile("id_ed25519", root).ok).toBe(false);
      expect(resolveAttachFile("env-link.txt", root).ok).toBe(false);

      const ok = resolveAttachFile("ok.txt", root);
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.absolutePath).toBe(realpathSync(join(ws.root, "ok.txt")));
    } finally {
      ws.cleanup();
    }
  });

  test("WORKTREE_NOT_FOUND 不洩漏根目錄", async () => {
    const ws = createWorkspace();
    const missingRoot = join(tmpdir(), `missing-root-${Date.now()}`);
    const tools = await setupSearch(missingRoot);
    try {
      writeFileSync(join(ws.root, "sample.ts"), "needle\n");

      const peek = await run(tools.peek, { file: "sample.ts" });
      expect(peek.code).toBe("WORKTREE_NOT_FOUND");
      expect(JSON.stringify(peek)).not.toContain(missingRoot);

      const grep = await run(tools.grep, { pattern: "needle", target: "sample.ts", mode: "literal" });
      expect(grep.code).toBe("WORKTREE_NOT_FOUND");
      expect(JSON.stringify(grep)).not.toContain(missingRoot);
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });

  test("RG_ERROR 不洩漏 ripgrep stderr", async () => {
    const ws = createWorkspace();
    const tools = await setupSearch(ws.root);
    try {
      writeFileSync(join(ws.root, "sample.ts"), "needle\n");

      // 不合法 regex 讓 rg 以非零 code 退出並寫 stderr（穩定 fixture）
      const result = await run(tools.grep, {
        pattern: "[",
        target: "sample.ts",
        mode: "regex",
        context: 0,
      });
      expect(result.code).toBe("RG_ERROR");
      expect(JSON.stringify(result)).not.toContain("regex parse error");
      expect(JSON.stringify(result)).not.toContain("unclosed character class");
    } finally {
      await tools.cleanup();
      ws.cleanup();
    }
  });
});

describe("search 模組開關", () => {
  test("模組關閉時兩個工具都不註冊", async () => {
    const fake = createFakeV2Context();
    const cleanup = await setupUltrawork(fake.ctx, {
      modules: [searchModule],
      settings: { modules: { search: false } },
    });
    expect(fake.added.size).toBe(0);
    expect(fake.added.get("peek_file")).toBeUndefined();
    expect(fake.added.get("grep_context")).toBeUndefined();
    await cleanup();
  });

  test("模組開啟時兩個工具都註冊", async () => {
    const fake = createFakeV2Context();
    const cleanup = await setupUltrawork(fake.ctx, { modules: [searchModule] });
    expect(fake.added.get("peek_file")?.description).toBe("安全地回傳檔案輪廓或有界行區間；預設不輸出全文");
    expect(fake.added.get("grep_context")?.description).toBe("在 worktree 內搜尋文字，回傳有界、可分頁且帶行號的結構化結果");
    await cleanup();
  });
});
