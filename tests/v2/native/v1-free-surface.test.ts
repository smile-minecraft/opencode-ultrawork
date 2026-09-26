import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * repo 層級的 V1 表面 gate。
 *
 * 這是 `AGENTS.md` 寫的階段門檻之一：V1 相容表面移除之後，維持在已移除
 * 狀態，不准有任何檔案把它引回來。這個 gate 取代舊的
 * `bun run baseline:uw:check`（該 script 與它依賴的快照已隨 V1 一起移除）。
 *
 * 四條規則：
 *   1. V1 表面路徑在檔案系統上確實不存在。
 *   2. `src/**` 任何位置（包含註解）都不提 V1 表面——`src/**` 是要發布出去
 *      的程式碼，留下指向已刪除檔案的路徑等於留下死路。
 *   3. `src/**` 與 `tests/v2/**` 的 import 來源都不解析到 V1 表面。
 *   4. repo 根層 `index.ts` 存在並轉出 `src/index.ts`（本機目錄形式的安裝
 *      入口，見該檔說明）。
 *
 * 為什麼測試自己被排除在規則 3 之外：本檔為了做比對，本來就必須寫出那些
 * 舊路徑字面值；不排除自己的話這個 gate 會對自己舉紅燈。
 *
 * 為什麼 `tests/v2/**` 只擋 import、不擋註解：`tests/v2/native/**` 相當多
 * 檔的檔頭留著「移植自 tests/ultrawork/… 的某某段落」這類出處註解，那是
 * 刻意的沿革說明，不是會被載入的相依。真要擋連它們一起擋，會把沿革紀錄
 * 也清掉，之後就看不出那些案例是從哪裡搬過來的。
 */

/** 已從 repo 移除的 V1 相容表面（相對於 repo 根層）。 */
const REMOVED_V1_PATHS = [
  "lib",
  "plugins",
  "scripts/generate-ultrawork-baseline.ts",
  "tests/ultrawork",
  ".opencode/baselines",
] as const;

/** `src/**` 不得出現的 V1 表面字串（連註解一起擋）。 */
const V1_REFERENCE_NEEDLES = [
  "@opencode-ai/plugin",
  "opencode-v2-bridge",
  "plugins/opencode-ultrawork",
  "tests/ultrawork",
  ".opencode/baselines",
  "generate-ultrawork-baseline",
] as const;

/** import 來源不得指向的 V1 表面。 */
const V1_IMPORT_NEEDLES = [
  "@opencode-ai/plugin",
  "opencode-v2-bridge",
  "plugins/opencode-ultrawork",
  "tests/ultrawork",
] as const;

const ROOT = process.cwd();
const THIS_FILE = join(ROOT, "tests", "v2", "native", "v1-free-surface.test.ts");

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

/** 抓出 `from "…"` / `import("…")` / `require("…")` 的模組來源字串。 */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+"([^"]+)"/g,
    /\bimport\s*\(\s*"([^"]+)"\s*\)/g,
    /\brequire\s*\(\s*"([^"]+)"\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function relative(file: string): string {
  return file.slice(ROOT.length + 1);
}

describe("repo V1 表面 gate", () => {
  test("V1 表面路徑已從 repo 移除", () => {
    const stillPresent = REMOVED_V1_PATHS.filter((path) => existsSync(join(ROOT, path)));
    expect(stillPresent).toEqual([]);
  });

  test("src 不再 import @opencode-ai/plugin", async () => {
    const files = await sourceFiles(join(ROOT, "src"));
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (source.includes("@opencode-ai/plugin")) violations.push(relative(file));
    }
    expect(violations).toEqual([]);
  });

  test("src 任何位置都不再引用已移除的 V1 表面", async () => {
    const files = await sourceFiles(join(ROOT, "src"));
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const needle of V1_REFERENCE_NEEDLES) {
        if (source.includes(needle)) violations.push(`${relative(file)} → ${needle}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("src 與 tests/v2 的 import 都不解析到 V1 表面", async () => {
    const files = [
      ...(await sourceFiles(join(ROOT, "src"))),
      ...(await sourceFiles(join(ROOT, "tests", "v2"))),
    ].filter((file) => file !== THIS_FILE);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        for (const needle of V1_IMPORT_NEEDLES) {
          if (specifier.includes(needle)) violations.push(`${relative(file)} → ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("repo 根層有轉出 src/index.ts 的安裝入口", async () => {
    const entry = join(ROOT, "index.ts");
    expect(existsSync(entry)).toBe(true);
    const source = (await readFile(entry, "utf-8")).trim();
    expect(source).toContain("./src/index.ts");
  });
});
