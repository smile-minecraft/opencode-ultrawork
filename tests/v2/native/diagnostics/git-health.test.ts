/**
 * `workflow_doctor` 回報 `.ultrawork/` 的版控衛生三種情況：
 *
 * (a) `.ultrawork/.gitignore` 缺必要行（` * `）；
 * (b) `.ultrawork/` 內有檔案正被版控追蹤（含已追蹤的 `ultrawork.jsonc`）；
 * (c) 專案設定檔（`ultrawork.jsonc`）仍被豁免（`!ultrawork.jsonc` 還在）。
 *
 * 三種都是 warn（不影響診斷 ok，外掛照常運作）；git 不能用時 (b) 標 skipped。
 * 全域層不建 `.gitignore`，插件不插手使用者的全域政策，所以這裡只看專案層。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callTool,
  setupDiagnostics,
  writeMemoryFile,
  writeMinimalWorkspace,
} from "./_helpers.ts";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-diag-githealth-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function checkByName(r: any, name: string) {
  return r.checks.find((c: any) => c.name === name);
}

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("workflow_doctor 版控衛生：.gitignore 必要行", () => {
  test("(a) 缺 `*` → warn 並點名缺少必要行", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeFileSync(join(root, ".ultrawork", ".gitignore"), "cache/\n", "utf-8");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Ultrawork Gitignore");
    expect(item.status).toBe("warn");
    expect(item.details).toContain("*");
    expect(r.warnings.some((w: string) => w.includes(".gitignore") && w.includes("*"))).toBe(true);
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("有 `*` 的自訂內容 → passed，不擾民", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeFileSync(
      join(root, ".ultrawork", ".gitignore"),
      "*\n!skills-policy.json\n",
      "utf-8",
    );
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(checkByName(r, "Ultrawork Gitignore").status).toBe("passed");
    await fake.registration?.dispose();
  });
});

describe("workflow_doctor 版控衛生：設定檔豁免", () => {
  test("(c) `!ultrawork.jsonc` 還在 → warn 並點名專案設定檔仍被豁免", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeFileSync(join(root, ".ultrawork", ".gitignore"), "*\n!.gitignore\n!ultrawork.jsonc\n", "utf-8");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Ultrawork Gitignore");
    expect(item.status).toBe("warn");
    expect(item.details).toContain("ultrawork.jsonc");
    expect(item.details).toContain("豁免");
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });
});

describe("workflow_doctor 版控衛生：被追蹤的檔案", () => {
  test("(b) ultrawork.jsonc 被版控追蹤 → warn 並列出檔案，只提示用 git rm --cached", async () => {
    if (!hasGit()) return;
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeMemoryFile(root, "ultrawork.jsonc", '{ "modules": {} }\n');
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: root, stdio: "ignore" });
    await writeFile(join(root, ".gitignore"), ".DS_Store\n", "utf-8");
    execFileSync("git", ["add", ".ultrawork/tasks.json", ".ultrawork/ultrawork.jsonc"], {
      cwd: root,
      stdio: "ignore",
    });

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Ultrawork Git Tracking");
    expect(item.status).toBe("warn");
    expect(item.details).toContain("ultrawork.jsonc");
    expect(item.details).toContain("git rm --cached");
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("沒有檔案被追蹤 → passed", async () => {
    if (!hasGit()) return;
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(checkByName(r, "Ultrawork Git Tracking").status).toBe("passed");
    await fake.registration?.dispose();
  });

  test("不是 git repo（git 不能用）→ skipped，不假裝檢查過", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    // 暫存目錄不是 git repo：git ls-files 失敗，只能標 skipped。
    expect(checkByName(r, "Ultrawork Git Tracking").status).toBe("skipped");
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });
});

describe("workflow_doctor 版控衛生：廣泛否定也算豁免", () => {
  test("(c) `!*.jsonc` 會讓設定檔重新納入版控 → warn 並點名豁免", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeFileSync(join(root, ".ultrawork", ".gitignore"), "*\n!*.jsonc\n", "utf-8");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Ultrawork Gitignore");
    expect(item.status).toBe("warn");
    expect(item.details).toContain("ultrawork.jsonc");
    expect(item.details).toContain("豁免");
    expect(r.ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("不會誤判：`!*.md` 與 `!sub/*.jsonc` 不影響設定檔 → passed", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeFileSync(join(root, ".ultrawork", ".gitignore"), "*\n!*.md\n!sub/*.jsonc\n", "utf-8");
    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    expect(checkByName(r, "Ultrawork Gitignore").status).toBe("passed");
    await fake.registration?.dispose();
  });
});
