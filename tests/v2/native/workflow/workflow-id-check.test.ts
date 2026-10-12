/**
 * `workflow-id-check`：比對任務註冊檔案裡的 ID，找出寫進專案內容的 ID。
 *
 * 只看這次新增的內容（git 變更裡新增的行、新檔案和新檔名），既有的內容不算，
 * 這樣舊專案裡早就存在的 ID 不會擋住不相干的工作。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGitCommit, parseAddedLines } from "../../../../src/modules/workflow/tools/workflow-id-check.ts";
import { DEFAULT_SETTINGS, type UltraworkSettings } from "../../../../src/settings/defaults.ts";
import { WORK_ORDER_ID_NOTICE } from "../../../../src/modules/workflow/tools/work-order-build.ts";
import { callTool, setupWorkflow, validWorkOrder } from "./_helpers.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(root: string, ...args: string[]) {
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { stdio: "pipe" });
}

async function project(options: { git: boolean; settings?: UltraworkSettings }) {
  const root = await mkdtemp(join(tmpdir(), "uw-id-check-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  // 既有的內容裡本來就有一個 ID：不是這次新增的，不該被回報。
  await writeFile(join(root, "src/Audit.java"), 'class Audit {\n  String owner = "economy-review-01";\n}\n');
  if (options.git) {
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
  }
  const fake = await setupWorkflow(root, options.settings);
  await callTool(fake, "plan-state-sync", { event: "create", planId: "economy-review", title: "計畫" });
  for (const taskId of ["economy-review-01", "economy-review-02"]) {
    await callTool(fake, "task-state-sync", { event: "create", taskId, to: "NEW", title: "任務", owner: "ultra", priority: "normal" });
  }
  return { root, fake };
}

describe("parseAddedLines", () => {
  test("只取新增的行，並且算出它在新檔案裡的行號", () => {
    const diff = [
      "diff --git a/src/A.java b/src/A.java",
      "--- a/src/A.java",
      "+++ b/src/A.java",
      "@@ -2,0 +3,2 @@ class A {",
      "+  int a;",
      "+  int b;",
      "@@ -9 +11 @@",
      "-  old",
      "+  changed",
    ].join("\n");
    expect(parseAddedLines(diff)).toEqual([
      { file: "src/A.java", line: 3, text: "  int a;" },
      { file: "src/A.java", line: 4, text: "  int b;" },
      { file: "src/A.java", line: 11, text: "  changed" },
    ]);
  });
});

describe("workflow-id-check", () => {
  test("檢查一段文字：commit 訊息裡的任務 ID", async () => {
    const { fake } = await project({ git: false });
    const dirty = await callTool(fake, "workflow-id-check", { text: "feat(bank): 完成 economy-review-02 的匯入" });
    expect(dirty.ok).toBe(true);
    expect(dirty.data.clean).toBe(false);
    expect(dirty.data.findings).toEqual([{ where: "text", line: 1, id: "economy-review-02", match: "economy-review-02" }]);
    const clean = await callTool(fake, "workflow-id-check", { text: "feat(bank): 匯入改成整筆提交" });
    expect(clean.data.clean).toBe(true);
    await fake.registration?.dispose();
  });

  test("檢查專案：新增的行、新檔案的內容和檔名都算，既有的內容和 .ultrawork 不算", async () => {
    const { root, fake } = await project({ git: true });
    await writeFile(join(root, "src/Audit.java"), 'class Audit {\n  String owner = "economy-review-01";\n  String writer = "economy-review-02";\n}\n');
    await writeFile(join(root, "src/EconomyReview02Test.java"), "class EconomyReview02Test {}\n");
    await writeFile(join(root, "src/Clean.java"), "class Clean {}\n");
    const result = await callTool(fake, "workflow-id-check", {});
    expect(result.ok).toBe(true);
    expect(result.data.available).toBe(true);
    expect(result.data.clean).toBe(false);
    const found = result.data.findings.map((f: any) => `${f.where}:${f.file}:${f.line}:${f.match}`).sort();
    expect(found).toEqual([
      "content:src/Audit.java:3:economy-review-02",
      "content:src/EconomyReview02Test.java:1:EconomyReview02",
      "path:src/EconomyReview02Test.java:0:EconomyReview02",
    ]);
    await fake.registration?.dispose();
  });

  test("staged 模式只看已經暫存的變更", async () => {
    const { root, fake } = await project({ git: true });
    await writeFile(join(root, "src/Staged.java"), '// economy-review-01\n');
    await writeFile(join(root, "src/Unstaged.java"), '// economy-review-02\n');
    git(root, "add", "src/Staged.java");
    const result = await callTool(fake, "workflow-id-check", { staged: true });
    expect(result.data.findings.map((f: any) => f.file)).toEqual(["src/Staged.java"]);
    await fake.registration?.dispose();
  });

  test("不是 git repo 的時候照實回報沒辦法檢查，不當成乾淨", async () => {
    const { fake } = await project({ git: false });
    const result = await callTool(fake, "workflow-id-check", {});
    expect(result.ok).toBe(true);
    expect(result.data.available).toBe(false);
    expect(result.data.clean).toBe(null);
    await fake.registration?.dispose();
  });
});

describe("結案與 commit 之前自動檢查", () => {
  test.each([
    ['git commit -m "x"', true],
    ['git -C /repo commit -am "x"', true],
    ['cd repo && rtk git commit -m "x"', true],
    ["git status", false],
    ["git log --grep commit", false],
    ['echo "git commit"', false],
  ])("isGitCommit(%s) = %s", (command, expected) => {
    expect(isGitCommit(command)).toBe(expected);
  });

  test("complete：這次的變更裡有任務 ID 就擋下，拿掉之後可以結案", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.modules.memory = false;
    settings.modules.commentSignal = false;
    const { root, fake } = await project({ git: true, settings });
    for (const [from, to] of [["NEW", "PLANNED"], ["PLANNED", "IN_PROGRESS"], ["IN_PROGRESS", "REVIEWING"], ["REVIEWING", "ARCHIVING"]]) {
      await callTool(fake, "task-state-sync", { event: "transition", taskId: "economy-review-01", from, to });
    }
    await writeFile(join(root, "src/EconomyReview02Test.java"), "class EconomyReview02Test {}\n");
    const blocked = await callTool(fake, "task-state-sync", { event: "complete", taskId: "economy-review-01" });
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("WORKFLOW_ID_IN_PROJECT");
    expect(JSON.stringify(blocked)).toContain("src/EconomyReview02Test.java");

    await rm(join(root, "src/EconomyReview02Test.java"));
    await writeFile(join(root, "src/BalanceCapTest.java"), "class BalanceCapTest {}\n");
    expect((await callTool(fake, "task-state-sync", { event: "complete", taskId: "economy-review-01" })).ok).toBe(true);
    await fake.registration?.dispose();
  });

  test("git commit：訊息或已暫存的內容有任務 ID 就擋下，其他 shell 指令不受影響", async () => {
    const { root, fake } = await project({ git: true });
    const hook = fake.toolHooks.get("execute.before")!;
    await expect(hook({ tool: "shell", sessionID: "s1", input: { command: 'git commit -m "完成 economy-review-01"' } })).rejects.toThrow(/economy-review-01/);

    await writeFile(join(root, "src/Staged.java"), "// economy-review-02\n");
    git(root, "add", "src/Staged.java");
    await expect(hook({ tool: "bash", sessionID: "s1", input: { command: 'git commit -m "匯入改成整筆提交"' } })).rejects.toThrow(/src\/Staged\.java/);
    // 不是 commit 的指令不檢查，即使工作區有問題也照常執行。
    await hook({ tool: "shell", sessionID: "s1", input: { command: "git status" } });

    git(root, "reset", "-q", "src/Staged.java");
    await hook({ tool: "shell", sessionID: "s1", input: { command: 'git commit -m "匯入改成整筆提交"' } });
    await fake.registration?.dispose();
  });
});

describe("工作說明交代 ID 的用途", () => {
  test("work-order-build 在 Task Identity 最後固定附上說明，其他節不變", async () => {
    const { fake } = await project({ git: false });
    const built = await callTool(fake, "work-order-build", validWorkOrder());
    expect(built.ok).toBe(true);
    const input = { agent: "build", prompt: built.data.workOrderRef };
    await fake.toolHooks.get("execute.before")!({ tool: "subagent", sessionID: "s1", input });
    const [identity, rest] = input.prompt.split("\n\n### 2. Objective\n");
    expect(identity).toBe(`### 1. Task Identity\n${validWorkOrder().taskIdentity}\n\n${WORK_ORDER_ID_NOTICE}`);
    expect(rest.startsWith(validWorkOrder().objective)).toBe(true);
    await fake.registration?.dispose();
  });
});

describe("計畫內容檔的預設章節", () => {
  test("沒有給內容時產生六個固定章節，任務段落只用任務 ID 當編號", async () => {
    const { root, fake } = await project({ git: false });
    await callTool(fake, "plan-task-link", { planId: "economy-review", taskId: "economy-review-01" });
    const created = await callTool(fake, "plan-content-create", { planId: "economy-review" });
    expect(created.ok).toBe(true);
    const body = await readFile(join(root, ".ultrawork/plans/economy-review.md"), "utf8");
    const headings = body.split("\n").filter((line) => line.startsWith("## ") || line.startsWith("### "));
    expect(headings).toEqual(["## 目標與不做的事", "## 已確認的證據", "## 決定", "## 任務", "### task: economy-review-01", "## 風險與復原", "## 還沒決定的事"]);
    await fake.registration?.dispose();
  });
});
