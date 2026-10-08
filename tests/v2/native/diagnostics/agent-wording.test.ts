import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { TAG_EXPLANATIONS } from "../../../../src/modules/comment-signal/tool-explain.ts";

const sharedText = readFileSync(new URL("../../../../src/modules/diagnostics/shared.ts", import.meta.url), "utf8");
const l1Text = readFileSync(new URL("../../../../src/modules/diagnostics/workflow-l1-check.ts", import.meta.url), "utf8");
const evidencePackText = readFileSync(new URL("../../../../src/modules/workflow/gates/evidence-pack.ts", import.meta.url), "utf8");
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function sourceFiles(root: string, extension: ".ts" | ".json"): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) found.push(path);
  }
  return found;
}

describe("診斷文字不綁定固定角色", () => {
  test("記憶診斷與大小建議依設定能力描述，不提固定寫入角色", () => {
    expect(sharedText).not.toContain("memorizer");
    expect(l1Text).not.toContain("memorizer");
    expect(l1Text).toContain("memory.writerAgents");
  });

  test("七節說明與 matcher 註解不提固定角色", () => {
    expect(evidencePackText).not.toMatch(/\bimplementer\b|\bdebugger\b|agents\/(?:build|ultra)\.md/);
  });

  test("comment_signal_explain 的 owner 範例不使用固定角色 handle", () => {
    const examples = Object.values(TAG_EXPLANATIONS).flatMap(({ examples }) => examples).join("\n");
    expect(examples).not.toContain("owner=@build");
  });

  test("src 與 schema 全樹沒有固定角色名稱或角色檔路徑", () => {
    const roleNames = ["momus", "memorizer", "implementer", "debugger", "ultra-coder", "explorer", "arch"];
    const roleWord = new RegExp(`\\b(?:${roleNames.join("|")})\\b`, "i");
    const roleFilePath = new RegExp(`agents/(?:${roleNames.join("|")})\\.md`, "i");
    const files = [
      ...sourceFiles(fileURLToPath(new URL("../../../../src/", import.meta.url)), ".ts"),
      ...sourceFiles(fileURLToPath(new URL("../../../../schema/", import.meta.url)), ".json"),
    ];
    const matches: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (roleWord.test(line) || roleFilePath.test(line)) {
          matches.push(`${relative(repoRoot, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(matches).toEqual([]);
  });
});
