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

describe("workflow_doctor 版控衛生：專案根目錄同時是全域設定資料夾", () => {
  function initRepo(root: string): void {
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: root, stdio: "ignore" });
  }

  test("全域層檔案被追蹤 → 不當成專案資料外洩，passed 並註明排除了哪些", async () => {
    if (!hasGit()) return;
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeMemoryFile(root, "skills-policy.json", "{}\n");
    writeMemoryFile(root, "skills-personal.json", "{}\n");
    writeFileSync(join(root, ".ultrawork", ".gitignore"), "*\n!.gitignore\n!skills-policy.json\n!skills-personal.json\n", "utf-8");
    initRepo(root);
    execFileSync(
      "git",
      ["add", ".ultrawork/.gitignore", ".ultrawork/skills-policy.json", ".ultrawork/skills-personal.json"],
      { cwd: root, stdio: "ignore" },
    );

    const fake = await setupDiagnostics(root, undefined, { globalDir: root });
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Ultrawork Git Tracking");
    expect(item.status).toBe("passed");
    expect(item.details).toContain("skills-policy.json");
    expect(item.details).toContain("全域");
    expect(r.warnings.some((w: string) => w.startsWith("[tracking]"))).toBe(false);
    expect(checkByName(r, "Ultrawork Gitignore").status).toBe("passed");
    await fake.registration?.dispose();
  });

  test("同資料夾時專案層的工作流資料被追蹤，仍然 warn，且只列專案層檔案", async () => {
    if (!hasGit()) return;
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeMemoryFile(root, "skills-policy.json", "{}\n");
    initRepo(root);
    execFileSync("git", ["add", ".ultrawork/tasks.json", ".ultrawork/skills-policy.json"], { cwd: root, stdio: "ignore" });

    const fake = await setupDiagnostics(root, undefined, { globalDir: root });
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Ultrawork Git Tracking");
    expect(item.status).toBe("warn");
    expect(item.details).toContain("1 個 .ultrawork/ 內的檔案正被版控追蹤（.ultrawork/tasks.json）");
    const tracking = r.warnings.find((w: string) => w.startsWith("[tracking]"));
    expect(tracking).toContain("tasks.json");
    expect(tracking).not.toContain("skills-policy.json");
    await fake.registration?.dispose();
  });

  test("同資料夾時豁免 ultrawork.jsonc（它也是全域設定檔）不警告", async () => {
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeFileSync(join(root, ".ultrawork", ".gitignore"), "*\n!ultrawork.jsonc\n", "utf-8");
    const fake = await setupDiagnostics(root, undefined, { globalDir: root });
    const r = await callTool(fake, "workflow_doctor");
    expect(checkByName(r, "Ultrawork Gitignore").status).toBe("passed");
    await fake.registration?.dispose();
  });

  test("專案根目錄不是全域設定資料夾時，skills-policy.json 被追蹤照常 warn", async () => {
    if (!hasGit()) return;
    const root = await tempRoot();
    writeMinimalWorkspace(root);
    writeMemoryFile(root, "skills-policy.json", "{}\n");
    initRepo(root);
    execFileSync("git", ["add", ".ultrawork/skills-policy.json"], { cwd: root, stdio: "ignore" });

    const fake = await setupDiagnostics(root);
    const r = await callTool(fake, "workflow_doctor");
    const item = checkByName(r, "Ultrawork Git Tracking");
    expect(item.status).toBe("warn");
    expect(item.details).toContain("skills-policy.json");
    await fake.registration?.dispose();
  });
});
