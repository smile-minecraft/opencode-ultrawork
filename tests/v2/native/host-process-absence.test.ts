/**
 * 受限程序走宿主能力邊界（審查退回修正的 Red 錨點）。
 *
 * 宿主沒有提供程序執行能力時，工具邏輯不得直接啟動外部程序：
 * verification_run（run 動作）／grep_context／skiller-import 明確拒絕
 * （HOST_CAPABILITY_UNAVAILABLE 風格、繁中訊息，不得靜默成功）；
 * change-scope-check 的 git 步驟與 diagnostics 的 git 追蹤降級並明列原因。
 * 有程序能力時，工具一律經能力執行（逾時／取消可觀察）。
 *
 * 本檔只用既有匯入（合成宿主 harness＋手寫假能力），修正前全部紅：
 * 現況工具直接 spawn，不看 capabilities.process。
 */

import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../../src/settings/defaults.ts";
import {
  createSyntheticHost,
  invokeSynthetic,
  makeSyntheticRoots,
  registerSynthetic,
} from "./_synthetic-host.ts";

function syntheticSettings(globalDirectory: string) {
  return {
    ...DEFAULT_SETTINGS,
    verification: {
      runAllowedAgents: ["momus"],
      scopeCheckAllowedAgents: ["build"],
    },
    skiller: {
      personalSkillRoot: join(globalDirectory, "skills"),
      agentsDir: join(globalDirectory, "agents"),
    },
  };
}

/** 手寫假程序能力：只記錄呼叫並拒絕，證明工具真的經能力執行。 */
function makeRecordingProcess(calls: unknown[]) {
  return {
    async run(options: unknown) {
      calls.push(options);
      throw new Error("合成程序能力：拒絕執行");
    },
    runSync() {
      throw new Error("合成程序能力：拒絕執行");
    },
  };
}

describe("無程序能力時的明確拒絕與降級", () => {
  test("verification_run（run 動作）無程序能力→明確拒絕，不靜默成功", async () => {
    const roots = await makeSyntheticRoots("uw-proc-absence-verify-");
    try {
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
      });
      const registrations = await registerSynthetic(synth, syntheticSettings(roots.globalDirectory));
      try {
        const result = await invokeSynthetic(
          synth,
          "verification_run",
          { runner: "bun", script: "test:p0", timeoutMs: 15000 },
          "synthetic-session",
          "momus",
        );
        expect(result.ok).toBe(false);
        expect(result.code).toBe("HOST_CAPABILITY_UNAVAILABLE");
        expect(JSON.stringify(result)).toContain("程序");
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });

  test("verification_run（recheck 動作）不需程序能力→照常運作", async () => {
    const roots = await makeSyntheticRoots("uw-proc-absence-recheck-");
    try {
      await mkdir(join(roots.projectDirectory, "src"), { recursive: true });
      await writeFile(join(roots.projectDirectory, "src", "a.ts"), "content-v1\n", "utf-8");
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
      });
      const registrations = await registerSynthetic(synth, syntheticSettings(roots.globalDirectory));
      try {
        const snapshot = {
          path: "src/a.ts",
          state: "file",
          comparable: true,
          sizeBytes: 11,
        };
        const evidence = {
          schema: "verification-evidence-v1",
          requestedFiles: ["src/a.ts"],
          before: [snapshot],
          after: [snapshot],
          stable: true,
          reusable: true,
          status: "stable",
        };
        const result = await invokeSynthetic(
          synth,
          "verification_run",
          { action: "recheck", evidence },
          "synthetic-session",
          "momus",
        );
        expect(result.ok).toBe(true);
        expect(result.code).toBe("EVIDENCE_RECHECKED");
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });

  test("grep_context 無程序能力→明確拒絕，不直接啟動 rg", async () => {
    const roots = await makeSyntheticRoots("uw-proc-absence-grep-");
    try {
      await mkdir(join(roots.projectDirectory, "src"), { recursive: true });
      await writeFile(join(roots.projectDirectory, "src", "evidence.txt"), "synthetic-search-marker\n", "utf-8");
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
      });
      const registrations = await registerSynthetic(synth, syntheticSettings(roots.globalDirectory));
      try {
        const result = await invokeSynthetic(synth, "grep_context", {
          pattern: "synthetic-search-marker",
          target: "src/evidence.txt",
          mode: "literal",
        });
        expect(result.ok).toBe(false);
        expect(result.code).toBe("HOST_CAPABILITY_UNAVAILABLE");
        expect(JSON.stringify(result)).toContain("程序");
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });

  test("skiller-import preview 無程序能力→明確拒絕，不啟動 npx", async () => {
    const roots = await makeSyntheticRoots("uw-proc-absence-import-");
    const originalPath = process.env.PATH;
    try {
      // 測速用：把 PATH 清空讓現況的直接 spawn 快速失敗（ENOENT），
      // 不等 npx 下載與連網。修正後能力檢查在 spawn 之前，與 PATH 無關。
      const emptyBin = join(roots.projectDirectory, "empty-bin");
      await mkdir(emptyBin, { recursive: true });
      process.env.PATH = emptyBin;
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
      });
      const registrations = await registerSynthetic(synth, syntheticSettings(roots.globalDirectory));
      try {
        const result = await invokeSynthetic(synth, "skiller-import", {
          source: "vercel-labs/agent-skills",
        });
        expect(result.ok).toBe(false);
        expect(result.code).toBe("HOST_CAPABILITY_UNAVAILABLE");
        expect(JSON.stringify(result)).toContain("程序");
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await roots.cleanup();
    }
  });

  test("change-scope-check 無程序能力→git 降級並在產出中明列原因", async () => {
    const roots = await makeSyntheticRoots("uw-proc-absence-scope-");
    try {
      await mkdir(join(roots.projectDirectory, "src"), { recursive: true });
      await writeFile(join(roots.projectDirectory, "src", "file.ts"), "before", "utf-8");
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
      });
      const registrations = await registerSynthetic(synth, syntheticSettings(roots.globalDirectory));
      try {
        const baseline = await invokeSynthetic(
          synth,
          "change-scope-check",
          {
            action: "create",
            paths: [{ path: "src/file.ts", kind: "file" }],
            includeGitFiles: true,
          },
          "synthetic-session",
          "build",
        );
        expect(baseline.ok).toBe(true);
        expect(baseline.data?.git?.available).toBe(false);
        expect(JSON.stringify(baseline.data?.coverage ?? baseline)).toContain("程序");
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });

  test("change-scope-check 預設路徑無程序能力→git 摘要仍明列原因，覆蓋語意不變", async () => {
    const roots = await makeSyntheticRoots("uw-proc-absence-scope-default-");
    try {
      await mkdir(join(roots.projectDirectory, "src"), { recursive: true });
      await writeFile(join(roots.projectDirectory, "src", "file.ts"), "before", "utf-8");
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
      });
      const registrations = await registerSynthetic(synth, syntheticSettings(roots.globalDirectory));
      try {
        const baseline = await invokeSynthetic(
          synth,
          "change-scope-check",
          {
            action: "create",
            paths: [{ path: "src/file.ts", kind: "file" }],
          },
          "synthetic-session",
          "build",
        );
        expect(baseline.ok).toBe(true);
        expect(baseline.data?.git?.available).toBe(false);
        // 預設路徑也要看得到能力缺席原因，但不誤標覆蓋不完整。
        expect(JSON.stringify(baseline.data?.git ?? {})).toContain("程序");
        expect(baseline.data?.coverage?.complete).toBe(true);
        expect(baseline.data?.coverage?.issues ?? []).toEqual([]);
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });

  test("diagnostics 無程序能力→git 追蹤 skipped 並明列原因", async () => {
    const roots = await makeSyntheticRoots("uw-proc-absence-diag-");
    try {
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
      });
      const registrations = await registerSynthetic(synth, syntheticSettings(roots.globalDirectory));
      try {
        const doctor = await invokeSynthetic(synth, "workflow_doctor", {});
        const tracking = doctor.data.checks.find((check: { name: string }) => check.name === "Ultrawork Git Tracking");
        expect(tracking.status).toBe("skipped");
        expect(tracking.details).toContain("程序");
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });
});

describe("工具邏輯一律經能力執行", () => {
  test("verification_run 有程序能力時經能力啟動（假能力被實際呼叫）", async () => {
    const roots = await makeSyntheticRoots("uw-proc-routing-verify-");
    try {
      const calls: unknown[] = [];
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
        capabilities: { process: makeRecordingProcess(calls) as never },
      });
      const registrations = await registerSynthetic(synth, syntheticSettings(roots.globalDirectory));
      try {
        const result = await invokeSynthetic(
          synth,
          "verification_run",
          { runner: "bun", script: "test:p0", timeoutMs: 15000 },
          "synthetic-session",
          "momus",
        );
        expect(calls.length).toBe(1);
        expect(result.ok).toBe(false);
        expect(result.code).toBe("SPAWN_FAILED");
        expect(JSON.stringify(result)).toContain("合成程序能力");
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });

  test("grep_context 有程序能力時經能力啟動（假能力被實際呼叫）", async () => {
    const roots = await makeSyntheticRoots("uw-proc-routing-grep-");
    try {
      const calls: unknown[] = [];
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
        capabilities: { process: makeRecordingProcess(calls) as never },
      });
      const registrations = await registerSynthetic(synth, syntheticSettings(roots.globalDirectory));
      try {
        await mkdir(join(roots.projectDirectory, "src"), { recursive: true });
        await writeFile(join(roots.projectDirectory, "src", "evidence.txt"), "marker\n", "utf-8");
        const result = await invokeSynthetic(synth, "grep_context", {
          pattern: "marker",
          target: "src/evidence.txt",
          mode: "literal",
        });
        expect(calls.length).toBe(1);
        expect(result.ok).toBe(false);
        expect(result.code).toBe("RG_UNAVAILABLE");
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });

  test("verification_run 經能力傳遞逾時：假能力回 timedOut→TIMEOUT", async () => {
    const roots = await makeSyntheticRoots("uw-proc-routing-timeout-");
    try {
      const seen: unknown[] = [];
      const fakeTimeout = {
        async run(options: Record<string, unknown>) {
          seen.push(options);
          return {
            exitCode: null,
            signal: null,
            stdout: "",
            stderr: "",
            stdoutBytes: 0,
            stderrBytes: 0,
            timedOut: true,
            cancelled: false,
            truncated: false,
          };
        },
        runSync() {
          throw new Error("不應走同步面");
        },
      };
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
        capabilities: { process: fakeTimeout as never },
      });
      const registrations = await registerSynthetic(synth, syntheticSettings(roots.globalDirectory));
      try {
        const result = await invokeSynthetic(
          synth,
          "verification_run",
          { runner: "bun", script: "test:p0", timeoutMs: 300 },
          "synthetic-session",
          "momus",
        );
        expect(seen.length).toBe(1);
        expect((seen[0] as Record<string, unknown>).timeoutMs).toBe(300);
        expect(result.ok).toBe(false);
        expect(result.code).toBe("TIMEOUT");
        expect(result.data?.timedOut).toBe(true);
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      await roots.cleanup();
    }
  });
});
