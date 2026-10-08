/**
 * 合成宿主逐家族覆蓋：同一個宿主無關核心，在合成宿主上真實執行每家族代表工具。
 *
 * 每個案例都真的執行並斷言結果，不只斷言工具存在。
 * 授權清單由設定明確給值（空清單拒絕所有人的語意另由一致性測試覆蓋）。
 */

import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../../src/settings/defaults.ts";
import { EXPECTED_TOOL_NAMES } from "../../../src/modules/diagnostics/index.ts";
import {
  createSyntheticHost,
  invokeSynthetic,
  makeSyntheticProcess,
  makeSyntheticRoots,
  registerSynthetic,
  seedSkillCatalog,
} from "./_synthetic-host.ts";

function syntheticSettings() {
  return {
    ...DEFAULT_SETTINGS,
    verification: {
      runAllowedAgents: ["momus"],
      scopeCheckAllowedAgents: ["build"],
    },
  };
}

describe("合成宿主逐家族覆蓋", () => {
  test("搜尋家族：grep_context 與 peek_file 真實讀到暫存檔", async () => {
    const roots = await makeSyntheticRoots("uw-synth-search-");
    try {
      await mkdir(join(roots.projectDirectory, "src"), { recursive: true });
      await writeFile(join(roots.projectDirectory, "src", "evidence.txt"), "synthetic-search-marker\n第二行\n");
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
        capabilities: { process: makeSyntheticProcess() },
      });
      const registrations = await registerSynthetic(synth, syntheticSettings());
      try {
        const grep = await invokeSynthetic(synth, "grep_context", {
          pattern: "synthetic-search-marker",
          target: "src/evidence.txt",
          mode: "literal",
        });
        expect(grep.ok).toBe(true);
        expect(JSON.stringify(grep)).toContain("synthetic-search-marker");

        const peek = await invokeSynthetic(synth, "peek_file", { file: "src/evidence.txt" });
        expect(peek.ok).toBe(true);
        expect(JSON.stringify(peek.data ?? peek)).toContain("synthetic-search-marker");
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });

  test("驗證家族：verification_run 真跑暫存 bun 專案；未授權 agent 被拒", async () => {
    const roots = await makeSyntheticRoots("uw-synth-verify-");
    try {
      await writeFile(
        join(roots.projectDirectory, "package.json"),
        JSON.stringify({ scripts: { "test:p0": "bun -e \"console.log('SYNTHETIC_VERIFICATION_OK')\"" } }),
      );
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
        capabilities: { process: makeSyntheticProcess() },
      });
      const registrations = await registerSynthetic(synth, syntheticSettings());
      try {
        const ran = await invokeSynthetic(
          synth,
          "verification_run",
          { runner: "bun", script: "test:p0", timeoutMs: 15000 },
          "synthetic-session",
          "momus",
        );
        expect(ran.ok).toBe(true);
        expect(String(ran.data?.stdout ?? ran.stdout ?? "")).toContain("SYNTHETIC_VERIFICATION_OK");

        const denied = await invokeSynthetic(
          synth,
          "verification_run",
          { runner: "bun", script: "test:p0" },
          "synthetic-session",
          "build",
        );
        expect(denied.ok).toBe(false);
        expect(denied.code).toBe("AGENT_NOT_ALLOWED");
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });

  test("驗證家族：change-scope-check 建快照再比對（無 git 也可用）", async () => {
    const roots = await makeSyntheticRoots("uw-synth-scope-");
    try {
      await mkdir(join(roots.projectDirectory, "src"), { recursive: true });
      await writeFile(join(roots.projectDirectory, "src", "file.ts"), "before", "utf-8");
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
      });
      const registrations = await registerSynthetic(synth, syntheticSettings());
      try {
        const baseline = await invokeSynthetic(
          synth,
          "change-scope-check",
          { action: "create", paths: [{ path: "src/file.ts", kind: "file" }] },
          "synthetic-session",
          "build",
        );
        expect(baseline.ok).toBe(true);
        expect(typeof baseline.data?.baselineId).toBe("string");

        await writeFile(join(roots.projectDirectory, "src", "file.ts"), "after", "utf-8");
        const compared = await invokeSynthetic(
          synth,
          "change-scope-check",
          {
            action: "compare",
            baselineId: baseline.data.baselineId,
            allowedPaths: [{ path: "src/file.ts", kind: "file" }],
          },
          "synthetic-session",
          "build",
        );
        expect(compared.ok).toBe(true);
        expect(compared.data?.classifications?.allowed).toEqual(["src/file.ts"]);
        expect(compared.data?.safeToClaimNoOutOfScopeChanges).toBe(true);
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });

  test("註解家族：comment_signal_check 以 path 掃到違規；policy 為唯讀案例", async () => {
    const roots = await makeSyntheticRoots("uw-synth-comment-");
    try {
      const authDir = join(roots.projectDirectory, "src", "auth");
      await mkdir(authDir, { recursive: true });
      await writeFile(
        join(authDir, "login.ts"),
        "// [SECURITY:P0 owner=@auth issue=#391] 不要將 token 寫入 log，否則會洩漏個資\n",
        "utf-8",
      );
      await writeFile(join(authDir, "session.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
      });
      const registrations = await registerSynthetic(synth, syntheticSettings());
      try {
        const report = await invokeSynthetic(
          synth,
          "comment_signal_check",
          { path: "src/auth", changedOnly: false },
        );
        expect(report.ok).toBe(true);
        expect(report.data?.scannedFileCount).toBe(2);
        expect(report.data?.highRiskCount).toBeGreaterThanOrEqual(1);

        const policy = await invokeSynthetic(synth, "comment_signal_policy", {});
        expect(policy.ok).toBe(true);
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });

  test("技能家族：skill_search 在受控清單下命中；無清單時明確回報不可用", async () => {
    const roots = await makeSyntheticRoots("uw-synth-skills-");
    try {
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
      });
      const registrations = await registerSynthetic(synth, syntheticSettings());
      try {
        await seedSkillCatalog(synth, "synthetic-session", [
          { name: "sepia-write", description: "台灣繁中寫作風格潤稿" },
          { name: "personal-mcc-player-testing", description: "機器人連線測試" },
        ]);
        const hit = await invokeSynthetic(synth, "skill_search", { query: "寫作潤稿" });
        expect(hit.ok).toBe(true);
        expect(hit.data?.totalMatches).toBeGreaterThanOrEqual(1);

        const unavailable = await invokeSynthetic(synth, "skill_search", { query: "寫作" }, "empty-session");
        expect(unavailable.ok).toBe(false);
        expect(unavailable.code).toBe("SKILL_CATALOG_UNAVAILABLE");
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });

  test("任務與計畫家族：task-state-sync＋plan-state-sync＋plan-task-link 片段生命週期", async () => {
    const roots = await makeSyntheticRoots("uw-synth-workflow-");
    try {
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
      });
      const registrations = await registerSynthetic(synth, syntheticSettings());
      try {
        const task = await invokeSynthetic(synth, "task-state-sync", {
          event: "create",
          taskId: "synth-t1",
          to: "NEW",
          title: "合成宿主任務",
          owner: "ultra",
          priority: "normal",
        });
        expect(task.ok).toBe(true);

        const plan = await invokeSynthetic(synth, "plan-state-sync", {
          event: "create",
          planId: "synth-p1",
          title: "合成宿主計畫",
        });
        expect(plan.ok).toBe(true);

        const link = await invokeSynthetic(synth, "plan-task-link", {
          planId: "synth-p1",
          taskId: "synth-t1",
        });
        expect(link.ok).toBe(true);

        const taskStatus = await invokeSynthetic(synth, "task-state-sync", { event: "status" });
        expect(JSON.stringify(taskStatus)).toContain("synth-t1");
        const planStatus = await invokeSynthetic(synth, "plan-state-sync", {
          event: "status",
          planId: "synth-p1",
        });
        expect(planStatus.ok).toBe(true);
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });

  test("診斷家族：tool_hook_manifest 關鍵輸出存在；doctor 回傳檢查清單", async () => {
    const roots = await makeSyntheticRoots("uw-synth-diagnostics-");
    try {
      const projectId = roots.projectDirectory;
      const memoryDir = join(roots.projectDirectory, ".ultrawork");
      await mkdir(join(memoryDir, "plans"), { recursive: true });
      const emptyRegistry = (key: "tasks" | "plans") => key === "tasks"
        ? { version: "1", projectId, projectPath: roots.projectDirectory, activeTaskIds: [], taskCursor: null, tasks: {} }
        : { version: "1", projectId, projectPath: roots.projectDirectory, activePlanIds: [], planCursor: null, plans: {} };
      await writeFile(join(memoryDir, "tasks.json"), JSON.stringify(emptyRegistry("tasks"), null, 2));
      await writeFile(join(memoryDir, "plans.json"), JSON.stringify(emptyRegistry("plans"), null, 2));
      await writeFile(
        join(memoryDir, "state.md"),
        "---\nlabel: state\nlimit: 3000\n---\n# Project State\n\nstate: IDLE\ntask_id: —\nowner: —\npriority: —\ncurrent_plan: —\n",
      );
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
      });
      const registrations = await registerSynthetic(synth, syntheticSettings());
      try {
        const manifest = await invokeSynthetic(synth, "tool_hook_manifest", {});
        expect(manifest.ok).toBe(true);
        expect(Array.isArray(manifest.data?.tools)).toBe(true);
        expect(manifest.data?.toolCount).toBe(49);

        const doctor = await invokeSynthetic(synth, "workflow_doctor", {});
        expect(Array.isArray(doctor.data?.checks)).toBe(true);
        expect(doctor.data.checks.length).toBeGreaterThan(0);
        expect(doctor.data.checks.some((check: { name: string }) => check.name === "Agent Role Files")).toBe(true);
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });

  test("記憶家族：memory-note 寫入成功且宿主間隔離", async () => {
    const firstRoots = await makeSyntheticRoots("uw-synth-memory-a-");
    const secondRoots = await makeSyntheticRoots("uw-synth-memory-b-");
    try {
      const first = createSyntheticHost({
        projectDirectory: firstRoots.projectDirectory,
        globalConfigDirectory: firstRoots.globalDirectory,
      });
      const second = createSyntheticHost({
        projectDirectory: secondRoots.projectDirectory,
        globalConfigDirectory: secondRoots.globalDirectory,
      });
      const registrations = [
        ...(await registerSynthetic(first, syntheticSettings())),
        ...(await registerSynthetic(second, syntheticSettings())),
      ];
      try {
        const noted = await invokeSynthetic(first, "memory-note", {
          content: "合成宿主 A 的教訓：暫存目錄要清理",
        });
        expect(noted.ok).toBe(true);

        const { readdirSync, readFileSync, statSync } = await import("node:fs");
        const containsNote = (dir: string): boolean => {
          const walk = (current: string): boolean => {
            for (const entry of readdirSync(current, { withFileTypes: true })) {
              const full = join(current, entry.name);
              if (entry.isDirectory()) {
                if (walk(full)) return true;
              } else {
                try {
                  if (statSync(full).size < 1_000_000 && readFileSync(full, "utf-8").includes("合成宿主 A 的教訓")) return true;
                } catch {
                  // 二進位或不可讀檔案略過。
                }
              }
            }
            return false;
          };
          return walk(dir);
        };
        expect(containsNote(firstRoots.projectDirectory)).toBe(true);
        expect(containsNote(secondRoots.projectDirectory)).toBe(false);

        expect([...first.definitions.keys()].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await Promise.all([firstRoots.cleanup(), secondRoots.cleanup()]);
    }
  });
});
