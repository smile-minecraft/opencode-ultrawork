import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * workflow／diagnostics 的模組邊界與收據 validator 單一來源 gate。
 *
 * 背景：收據驗證規則曾有兩份實作（workflow runtime closure 與 memory 純函式），
 * 呼叫端沒有共用；workflow／diagnostics 對 memory 的引用要收斂到模組介面。
 * 這三條規則把收斂結果釘住：
 *   1. 舊的 workflow closure 實作已移除（只剩 memory 的單一來源）。
 *   2. workflow／diagnostics 引用 memory 只走 `memory/index.ts`（模組介面），
 *      不得深路徑引用（例如 `memory/paths.ts`、`memory/helpers.ts`）。
 *   3. `createRuntimeContext` 的 Layer 4 直接委派給 memory 的純函式，
 *      不再經過自家的 validator factory。
 */

const ROOT = process.cwd();
const WORKFLOW = join(ROOT, "src", "modules", "workflow");
const DIAGNOSTICS = join(ROOT, "src", "modules", "diagnostics");

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

/** 抓出靜態 `from "…"` 的模組來源字串。 */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/\bfrom\s+"([^"]+)"/g)) specifiers.push(match[1]);
  return specifiers;
}

function relative(file: string): string {
  return file.slice(ROOT.length + 1);
}

describe("模組邊界與收據 validator 單一來源", () => {
  test("workflow 的舊收據 validator closure 已移除，只剩 memory 的單一實作", () => {
    expect(existsSync(join(WORKFLOW, "runtime", "receipt-validator.ts"))).toBe(false);
  });

  test("workflow／diagnostics 引用 memory 只走 memory/index.ts", async () => {
    const files = [...(await sourceFiles(WORKFLOW)), ...(await sourceFiles(DIAGNOSTICS))];
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.includes("memory/") && !specifier.endsWith("memory/index.ts")) {
          violations.push(`${relative(file)} → ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("createRuntimeContext 的收據驗證委派給 memory，不再自建 validator", async () => {
    const source = await readFile(join(WORKFLOW, "runtime", "context-builder.ts"), "utf8");
    expect(source).not.toContain("createReceiptValidator");
    expect(source).not.toContain("./receipt-validator");
    expect(source).toContain("validateReceiptForCompletion");
  });
});
