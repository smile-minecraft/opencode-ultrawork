import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const ALLOWED_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "src/index.ts": ["@opencode/plugin"],
  "src/opencode/adapter.ts": ["@opencode/plugin"],
};
/** 允許反向提及適配器的檔案：只有入口與適配器本身。 */
const ALLOWED_ADAPTER_REFS = new Set(["src/index.ts", "src/opencode/adapter.ts"]);

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

describe("OpenCode 宿主邊界", () => {
  test("src 僅入口與專屬適配器可匯入 OpenCode SDK", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(join(ROOT, "src"))) {
      const relativePath = file.slice(ROOT.length + 1);
      const allowed = ALLOWED_IMPORTS[relativePath] ?? [];
      const source = await readFile(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith("@opencode/")) continue;
        if (!allowed.includes(specifier)) violations.push(`${relativePath} → ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("allowlist 仍為入口與專屬適配器兩個檔案", async () => {
    expect(Object.keys(ALLOWED_IMPORTS).sort()).toEqual([
      "src/index.ts",
      "src/opencode/adapter.ts",
    ]);
    expect([...ALLOWED_ADAPTER_REFS].sort()).toEqual([
      "src/index.ts",
      "src/opencode/adapter.ts",
    ]);
  });

  test("核心不得反向匯入適配器（allowlist 外禁 import 適配器）", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(join(ROOT, "src"))) {
      const relativePath = file.slice(ROOT.length + 1);
      if (ALLOWED_ADAPTER_REFS.has(relativePath)) continue;
      const source = await readFile(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        const normalized = specifier.replace(/^\.\//, "");
        if (
          specifier === "../opencode/adapter.ts"
          || specifier === "../opencode/adapter"
          || /(^|\/)opencode\/adapter(\.ts)?$/.test(normalized)
          || specifier.startsWith("src/opencode/")
          || specifier.includes("/src/opencode/")
        ) {
          violations.push(`${relativePath} → ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("allowlist 外文字層零 @opencode（含註解）", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(join(ROOT, "src"))) {
      const relativePath = file.slice(ROOT.length + 1);
      if (ALLOWED_ADAPTER_REFS.has(relativePath)) continue;
      const source = await readFile(file, "utf8");
      if (source.includes("@opencode")) violations.push(relativePath);
    }
    expect(violations).toEqual([]);
  });

  test("node:child_process 只允許機制服務檔匯入", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(join(ROOT, "src"))) {
      const relativePath = file.slice(ROOT.length + 1);
      if (relativePath === "src/kit/process-runner.ts") continue;
      const source = await readFile(file, "utf8");
      if (source.includes("node:child_process")) violations.push(relativePath);
    }
    expect(violations).toEqual([]);
  });
});
