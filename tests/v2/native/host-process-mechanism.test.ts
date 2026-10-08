/**
 * 程序能力機制的行為測試（Green 錨點）。
 *
 * 用共用機制服務的真實作驗證：逾時傳遞與清理、取消可觀察、
 * 輸出上限、同步面，以及合成宿主走 setupUltraworkCore 的啟動整合。
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../../src/settings/defaults.ts";
import { setupUltraworkCore } from "../../../src/core/setup.ts";
import { createHostProcess } from "../../../src/kit/process-runner.ts";
import { EXPECTED_TOOL_NAMES } from "../../../src/modules/diagnostics/index.ts";
import {
  createSyntheticHost,
  invokeSynthetic,
  makeSyntheticProcess,
  makeSyntheticRoots,
} from "./_synthetic-host.ts";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function errnoOfTest(error: unknown): string | undefined {
  return typeof (error as NodeJS.ErrnoException | null)?.code === "string"
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

/**
 * PID 存活探測（不依賴 ps）：signal 0 探測；ESRCH 代表已死，
 * 其他錯誤（含 EPERM）保守視為存活。
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoOfTest(error) !== "ESRCH";
  }
}

/**
 * 讀 pid 檔：缺失或內容不是有效 PID 就丟錯。
 * 存活／死亡斷言一律經此取得 PID，不得把讀不到當成已死、空泛通過。
 */
function readPidFile(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    throw new Error(`讀不到 pid 檔 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`pid 檔 ${path} 內容不是有效 PID：${JSON.stringify(text.slice(0, 100))}`);
  }
  return pid;
}

/** 有界等待 pid 檔出現（背景程序啟動需要一點時間）；逾時就讓讀取錯誤拋出來。 */
async function waitPidFile(path: string, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  for (;;) {
    try {
      return readPidFile(path);
    } catch {
      if (Date.now() - startedAt > timeoutMs) return readPidFile(path);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/** 等待 PID 消失（輪詢）；逾時回 false，不丟錯。 */
async function waitPidGone(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  for (;;) {
    if (!pidAlive(pid)) return true;
    if (Date.now() - startedAt > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 以 PID 終止（清理用）：先 SIGTERM，等不到就 SIGKILL；程序已死就直接收手。
 * 只清指定的 PID，不掃整個系統。
 */
async function killPid(pid: number): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < 1000) {
      if (!pidAlive(pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describe("程序能力機制：逾時、取消與清理", () => {
  test("短逾時睡程序回 timedOut，無殘留程序群組", async () => {
    const roots = await makeSyntheticRoots("uw-proc-timeout-");
    const tag = `uw-proc-sleeper-${process.pid}-${Date.now()}`;
    const sleeper = join(roots.projectDirectory, `${tag}.sh`);
    const pidfile = join(roots.projectDirectory, `${tag}.pid`);
    try {
      // 腳本啟動即寫下自身 PID（$$）：死亡偵測不掃 ps，直接探測該 PID。
      writeFileSync(
        sleeper,
        `#!/bin/sh\necho $$ > "${pidfile}"\ntrap '' TERM\nsleep 30\n`,
        "utf-8",
      );
      chmodSync(sleeper, 0o755);
      const proc = createHostProcess();
      const startedAt = Date.now();
      const result = await proc.run({
        command: sleeper,
        args: [],
        cwd: roots.projectDirectory,
        // 逾時餘裕 1.5 秒：腳本要先完成「寫 pid 檔＋設定 trap」，
        // SIGTERM 才有意義（太早送會在 trap 生效前殺掉，pid 檔永不出現）。
        timeoutMs: 1500,
        processGroup: true,
        killGraceMs: 200,
      });
      const durationMs = Date.now() - startedAt;
      // trap 擋掉 SIGTERM：能在寬限內結束就證明升級到 SIGKILL 有作用。
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(durationMs).toBeLessThan(5000);
      // 群組清理：sleeper 的 PID 必須已死（pid 檔讀不到就直接失敗）。
      expect(await waitPidGone(readPidFile(pidfile), 5000)).toBe(true);
    } finally {
      await roots.cleanup();
    }
  });

  test("取消可觀察：abort 後回 cancelled，不算逾時", async () => {
    const roots = await makeSyntheticRoots("uw-proc-cancel-");
    try {
      const proc = createHostProcess();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const startedAt = Date.now();
      const result = await proc.run({
        command: "sleep",
        args: ["30"],
        cwd: roots.projectDirectory,
        timeoutMs: 30_000,
        signal: controller.signal,
      });
      const durationMs = Date.now() - startedAt;
      expect(result.cancelled).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(durationMs).toBeLessThan(10_000);
    } finally {
      await roots.cleanup();
    }
  });

  test("輸出上限：超過即標 truncated，不當成功快照", async () => {
    const roots = await makeSyntheticRoots("uw-proc-truncate-");
    try {
      const proc = createHostProcess();
      const result = await proc.run({
        command: "sh",
        args: ["-c", "i=0; while [ $i -lt 20000 ]; do echo 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; i=$((i+1)); done"],
        cwd: roots.projectDirectory,
        timeoutMs: 15_000,
        maxOutputBytes: 1024,
      });
      expect(result.exitCode).toBe(0);
      expect(result.truncated).toBe(true);
      expect(result.stdoutBytes).toBeGreaterThan(1024);
      expect(result.stdout.length).toBeLessThanOrEqual(1024);
    } finally {
      await roots.cleanup();
    }
  });

  test("同步面：git --version 成功；不存在的命令回原因", async () => {
    if (!hasGit()) return;
    const roots = await makeSyntheticRoots("uw-proc-sync-");
    try {
      const proc = createHostProcess();
      const ok = proc.runSync({
        command: "git",
        args: ["--version"],
        cwd: roots.projectDirectory,
        timeoutMs: 10_000,
      });
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toContain("git version");

      const missing = proc.runSync({
        command: "uw-definitely-no-such-binary",
        args: [],
        cwd: roots.projectDirectory,
        timeoutMs: 10_000,
      });
      expect(missing.exitCode).toBeNull();
      expect(typeof missing.error).toBe("string");
    } finally {
      await roots.cleanup();
    }
  });
});

describe("程序能力機制：忽略 SIGTERM 的非群組程序仍被升級終止", () => {
  test("逾時：回傳有界，但寬限後程序確實被 SIGKILL", async () => {
    const roots = await makeSyntheticRoots("uw-proc-escalate-timeout-");
    const tag = `uw-proc-term-ignore-${process.pid}-${Date.now()}`;
    const pidfile = join(roots.projectDirectory, `${tag}.pid`);
    try {
      // 直接子程序（sh）啟動即寫下自身 PID（$$）：斷言對象就是它，
      // 不靠 cmdline 標記（死後孤兒 sleep 是另一個 PID，本來就不在斷言內）。
      // 睡眠遠長於輪詢窗口：自然退出掩蓋不了升級終止缺席。
      const proc = createHostProcess();
      const startedAt = Date.now();
      const result = await proc.run({
        command: "sh",
        args: ["-c", `echo $$ > "${pidfile}"; trap "" TERM; sleep 20`],
        cwd: roots.projectDirectory,
        // 逾時餘裕 1.5 秒：同上，trap 生效後才送 SIGTERM，升級驗證才成立。
        timeoutMs: 1500,
      });
      const returnMs = Date.now() - startedAt;
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
      // 有界回傳：不等升級完成就回（預設 stopWaitMs=500）。
      expect(returnMs).toBeLessThan(5000);
      // 升級終止不被回傳取消：寬限（預設 4000ms）後該 PID 已死。
      expect(await waitPidGone(readPidFile(pidfile), 6000)).toBe(true);
    } finally {
      await roots.cleanup();
    }
  }, 15000);

  test("取消：回傳有界，但寬限後程序確實被 SIGKILL", async () => {
    const roots = await makeSyntheticRoots("uw-proc-escalate-cancel-");
    const tag = `uw-proc-term-ignore-${process.pid}-${Date.now()}`;
    const pidfile = join(roots.projectDirectory, `${tag}.pid`);
    try {
      const proc = createHostProcess();
      const controller = new AbortController();
      // 取消餘裕 1.5 秒：腳本先完成啟動，取消才打得到 trap 生效後的程序。
      setTimeout(() => controller.abort(), 1500);
      const startedAt = Date.now();
      const result = await proc.run({
        command: "sh",
        args: ["-c", `echo $$ > "${pidfile}"; trap "" TERM; sleep 20`],
        cwd: roots.projectDirectory,
        timeoutMs: 30_000,
        signal: controller.signal,
        killGraceMs: 800,
      });
      const returnMs = Date.now() - startedAt;
      expect(result.cancelled).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(returnMs).toBeLessThan(5000);
      expect(await waitPidGone(readPidFile(pidfile), 4000)).toBe(true);
    } finally {
      await roots.cleanup();
    }
  }, 15000);
});

describe("程序能力機制：群組正常結束但背景子程序握著 stdout", () => {
  test("exit 即結算成功：不報逾時、不砍背景程序、有界回傳", async () => {
    const roots = await makeSyntheticRoots("uw-proc-bg-");
    const tag = `uw-proc-bg-${process.pid}-${Date.now()}`;
    const sleeper = join(roots.projectDirectory, `${tag}.sh`);
    const pidfile = join(roots.projectDirectory, `${tag}.pid`);
    try {
      // exec 讓腳本程序本體就是 sleep：記錄的 PID 即背景程序，無中間孤兒。
      writeFileSync(sleeper, "#!/bin/sh\nexec sleep 30\n", "utf-8");
      chmodSync(sleeper, 0o755);
      const proc = createHostProcess();
      const startedAt = Date.now();
      const result = await proc.run({
        // 背景啟動後記下 $!（POSIX：背景程序的 PID；子殼內 $$ 仍是原殼，不可用）。
        command: "/bin/sh",
        args: ["-c", `"${sleeper}" & echo $! > "${pidfile}"; echo done; exit 0`],
        cwd: roots.projectDirectory,
        timeoutMs: 3000,
        processGroup: true,
      });
      const durationMs = Date.now() - startedAt;
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("done");
      // 有界收尾：比 timeoutMs 早回，不會等滿逾時。
      expect(durationMs).toBeLessThan(3000);
      // 背景程序存活：正常結束不得對它送任何訊號。
      expect(pidAlive(await waitPidFile(pidfile, 5000))).toBe(true);
    } finally {
      try {
        await killPid(readPidFile(pidfile));
      } catch {
        // pid 檔缺失或程序已死：無需清理。
      }
      await roots.cleanup();
    }
  }, 15000);

  test("持續輸出背景服務不被阻塞：結算後輸出仍持續被消耗", async () => {
    const roots = await makeSyntheticRoots("uw-proc-bgstream-");
    const tag = `uw-proc-bgstream-${process.pid}-${Date.now()}`;
    const service = join(roots.projectDirectory, `${tag}.sh`);
    const marker = join(roots.projectDirectory, `${tag}.marker`);
    const pidfile = join(roots.projectDirectory, `${tag}.pid`);
    try {
      // 背景服務在結算（exit＋2 秒收尾）之後才輸出：監聽若在結算時被拆掉，
      // 這些輸出就到不了消費者（舊版 drainStream 會持續消費到 stream close）。
      // 背景子殼的 PID 由 $! 記下；結尾 exec 讓子殼本體就是 sleep，清理無殘留。
      writeFileSync(
        service,
        "#!/bin/sh\n" +
          `(sleep 3; echo '${tag}-LATE-1'; echo '${tag}-LATE-2'; touch "${marker}"; exec sleep 30) &\n` +
          `echo $! > "${pidfile}"\n` +
          "echo early\n" +
          "exit 0\n",
        "utf-8",
      );
      chmodSync(service, 0o755);
      const proc = createHostProcess();
      const chunks: string[] = [];
      const decoder = new TextDecoder();
      const startedAt = Date.now();
      const result = await proc.run({
        command: "/bin/sh",
        args: ["-c", `"${service}"`],
        cwd: roots.projectDirectory,
        timeoutMs: 12_000,
        processGroup: true,
        onStdoutChunk: (chunk) => {
          chunks.push(decoder.decode(chunk));
        },
      });
      const durationMs = Date.now() - startedAt;
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("early");
      // 呼叫有界回傳（結算只等 exit＋2 秒收尾，不等背景結束）。
      expect(durationMs).toBeLessThan(12_000);
      // 背景輸出持續被消耗：有界輪詢直到 marker 出現、且兩行晚到輸出
      // 都送達消費者（檔案可見與 JS 回呼送達沒有嚴格先後保證，不分開等）。
      let markerSeen = false;
      let streamed = "";
      const pollStart = Date.now();
      while (Date.now() - pollStart < 10_000) {
        if (existsSync(marker)) markerSeen = true;
        streamed = chunks.join("");
        if (markerSeen && streamed.includes(`${tag}-LATE-1`) && streamed.includes(`${tag}-LATE-2`)) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      // 逾時未達成時印出已收內容：可分辨是背景沒跑完還是回呼沒送達。
      if (!markerSeen || !streamed.includes(`${tag}-LATE-1`) || !streamed.includes(`${tag}-LATE-2`)) {
        throw new Error(
          `背景輸出未在時限內送達：marker=${markerSeen}，已收 chunks 長度=${streamed.length}，內容=${JSON.stringify(streamed.slice(0, 500))}`,
        );
      }
      expect(markerSeen).toBe(true);
      expect(streamed).toContain(`${tag}-LATE-1`);
      expect(streamed).toContain(`${tag}-LATE-2`);
      // 背景程序存活：正常結束不得對它送任何訊號。
      expect(pidAlive(await waitPidFile(pidfile, 5000))).toBe(true);
    } finally {
      try {
        await killPid(readPidFile(pidfile));
      } catch {
        // pid 檔缺失或程序已死：無需清理。
      }
      await roots.cleanup();
    }
  }, 30000);
});

describe("核心啟動整合：合成宿主走 setupUltraworkCore", () => {
  test("暫存設定檔載入、不再遷移的路徑、工具可執行、cleanup 完整", async () => {
    const roots = await makeSyntheticRoots("uw-core-setup-");
    try {
      // 暫存設定檔（全域層）：只覆寫 verification 授權，其餘沿用內建預設
      //（內建預設是空清單拒絕所有人，能區分「有載入」與「沒載入」）。
      const globalUltraworkDir = join(roots.globalDirectory, ".ultrawork");
      await mkdir(globalUltraworkDir, { recursive: true });
      await writeFile(
        join(globalUltraworkDir, "ultrawork.jsonc"),
        JSON.stringify({ verification: { runAllowedAgents: ["momus"] } }),
        "utf-8",
      );
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
        capabilities: { process: makeSyntheticProcess() },
      });
      // 專案內無 .opencode 舊資料：走不再遷移的路徑，不得丟錯。
      const cleanup = await setupUltraworkCore(synth.host);
      try {
        // 同一份設定在第二宿主生效：momus 越過授權門（走到政策分支）。
        const allowed = await invokeSynthetic(
          synth,
          "verification_run",
          { runner: "no-such-runner", script: "test" },
          "synthetic-session",
          "momus",
        );
        expect(allowed.code).toBe("RUNNER_NOT_SUPPORTED");
        // 未授權 agent 仍被拒：載入的是檔案值，不是寬鬆預設。
        const denied = await invokeSynthetic(
          synth,
          "verification_run",
          { runner: "no-such-runner", script: "test" },
          "synthetic-session",
          "build",
        );
        expect(denied.code).toBe("AGENT_NOT_ALLOWED");
        // 49 工具全數組裝（與 OpenCode 宿主同一份核心）。
        expect([...synth.definitions.keys()].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
        // 唯讀工具在第二宿主可執行。
        const manifest = await invokeSynthetic(synth, "tool_hook_manifest", {});
        expect(manifest.ok).toBe(true);
        expect(manifest.data?.toolCount).toBe(49);
      } finally {
        await cleanup();
      }
      // cleanup 把註冊全部 dispose：工具定義清空。
      expect(synth.definitions.size).toBe(0);
    } finally {
      await roots.cleanup();
    }
  });

  test("設定預設值參考：空全域層時授權門拒絕所有人", async () => {
    const roots = await makeSyntheticRoots("uw-core-setup-defaults-");
    try {
      const synth = createSyntheticHost({
        projectDirectory: roots.projectDirectory,
        globalConfigDirectory: roots.globalDirectory,
        capabilities: { process: makeSyntheticProcess() },
      });
      const cleanup = await setupUltraworkCore(synth.host);
      try {
        const denied = await invokeSynthetic(
          synth,
          "verification_run",
          { runner: "bun", script: "test:p0" },
          "synthetic-session",
          "momus",
        );
        expect(denied.code).toBe("AGENT_NOT_ALLOWED");
        expect(DEFAULT_SETTINGS.verification.runAllowedAgents).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await roots.cleanup();
    }
  });
});
