/**
 * verification_run（新模組）：移植自 tests/ultrawork/25-verification-run.test.ts。
 *
 * 差異（工作說明授權）：
 * - 工作階段位置取代舊 runtime 綁定：工具執行時以執行 context 的 sessionID
 *   向 ctx.session.get 拿位置，拿不到才退回外掛實例的位置。
 * - 工具從模組註冊表拿，不再走舊外掛 harness；agent 由執行 context 帶入。
 * - 「錯誤 context.worktree」舊案例改為「工作階段位置優先於外掛實例位置」。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { setupUltrawork } from "../../../src/index.ts";
import { verificationModule } from "../../../src/modules/verification/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/settings/defaults.ts";
import { createFakeV2Context, fakeV2ToolContext } from "../_fake-v2-context.ts";

interface Workspace {
  root: string;
  cleanup(): void;
}

function createWorkspace(prefix = "verification-run-test-"): Workspace {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function loadTools(locationDirectory: string, sessionDirectory?: string) {
  const fake = createFakeV2Context({ directory: locationDirectory, sessionDirectory });
  await verificationModule.register({ ctx: fake.ctx, settings: DEFAULT_SETTINGS });
  const tool = (name: string) => {
    const definition = fake.added.get(name);
    if (!definition) throw new Error(`tool not registered: ${name}`);
    return definition;
  };
  return { tool };
}

async function executeTool(definition: any, input: unknown, agent?: string) {
  const raw = await definition.execute(input, { ...fakeV2ToolContext(), agent });
  const parsed = JSON.parse(raw.content);
  return {
    ok: parsed.ok,
    code: parsed.code,
    summary: parsed.summary,
    nextAction: parsed.nextAction,
    ...(parsed.data ?? {}),
  } as { ok: boolean; code?: string; summary?: string; nextAction?: string; [key: string]: any };
}

describe("verification_run（新模組）", () => {
  let ws: Workspace;
  let originalPath: string | undefined;

  function installFakeRunner(executable: string) {
    const binPath = join(ws.root, "fake-bin");
    mkdirSync(binPath, { recursive: true });
    const executablePath = join(binPath, executable);
    writeFileSync(
      executablePath,
      "#!/bin/sh\nprintf 'RUNNER_ARGS:%s\\n' \"$*\"\n",
      "utf-8",
    );
    chmodSync(executablePath, 0o755);
    process.env.PATH = `${binPath}${delimiter}${process.env.PATH ?? ""}`;
  }

  // 印出 subprocess 實際收到的環境變數，供 env assertion 使用。
  function installEnvProbeRunner(executable: string) {
    const binPath = join(ws.root, "fake-bin");
    mkdirSync(binPath, { recursive: true });
    const executablePath = join(binPath, executable);
    writeFileSync(
      executablePath,
      [
        "#!/bin/sh",
        'printf \'PYTHONDONTWRITEBYTECODE:%s\\n\' "$PYTHONDONTWRITEBYTECODE"',
        'printf \'CI:%s\\n\' "$CI"',
        'printf \'NO_COLOR:%s\\n\' "$NO_COLOR"',
        'printf \'RUNNER_ARGS:%s\\n\' "$*"',
        "",
      ].join("\n"),
      "utf-8",
    );
    chmodSync(executablePath, 0o755);
    process.env.PATH = `${binPath}${delimiter}${process.env.PATH ?? ""}`;
  }

  beforeEach(() => {
    originalPath = process.env.PATH;
    ws = createWorkspace();
    writeFileSync(
      `${ws.root}/package.json`,
      JSON.stringify({
        scripts: {
          "test:p0": "bun -e \"console.log('VERIFICATION_OK')\"",
          "test:slow": "bun -e \"await Bun.sleep(1000)\"",
          "test:mutate": "bun -e \"await Bun.write('src/program.ts', 'changed-by-verification')\"",
          check: "bun -e \"console.log('CHECK_OK')\"",
          verify: "bun -e \"console.log('VERIFY_OK')\"",
          format: "bun -e \"console.log('FORMAT_MUTATES')\"",
          "format:check": "bun -e \"console.log('FORMAT_CHECK_OK')\"",
          postinstall: "bun -e \"console.log('MUST_NOT_RUN')\"",
          prepare: "bun -e \"console.log('MUST_NOT_RUN')\"",
        },
      }),
      "utf-8",
    );
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    ws.cleanup();
  });

  test("模組開關：開啟時註冊兩個工具，關閉時都不註冊", async () => {
    const location = createWorkspace("verification-module-switch-");
    try {
      const enabled = createFakeV2Context({ directory: location.root });
      const cleanupEnabled = await setupUltrawork(enabled.ctx, {
        modules: [verificationModule],
        settings: { modules: { verification: true } },
      });
      expect(enabled.added.has("verification_run")).toBe(true);
      expect(enabled.added.has("change-scope-check")).toBe(true);
      await cleanupEnabled();

      const disabled = createFakeV2Context({ directory: location.root });
      const cleanupDisabled = await setupUltrawork(disabled.ctx, {
        modules: [verificationModule],
        settings: { modules: { verification: false } },
      });
      expect(disabled.added.has("verification_run")).toBe(false);
      expect(disabled.added.has("change-scope-check")).toBe(false);
      await cleanupDisabled();
    } finally {
      location.cleanup();
    }
  });

  test("允許 package runner 執行 test/lint/typecheck family script", async () => {
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "bun", script: "test:p0", timeoutMs: 5000 },
      "momus",
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout)).toContain("VERIFICATION_OK");
    expect(result.policy).toBe("restricted-verification-v1");
  });

  test("允許 Gradle wrapper 執行受控 test task 與測試篩選參數", async () => {
    const wrapperPath = `${ws.root}/gradlew`;
    writeFileSync(wrapperPath, "#!/bin/sh\nprintf 'GRADLE_ARGS:%s\\n' \"$*\"\n", "utf-8");
    chmodSync(wrapperPath, 0o755);

    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      {
        runner: "gradle",
        script: "test",
        args: ["--rerun-tasks", "--tests", "com.example.player.*"],
        timeoutMs: 5000,
      },
      "momus",
    );

    expect(result.ok).toBe(true);
    expect(result.command).toEqual([
      realpathSync(wrapperPath),
      "test",
      "--rerun-tasks",
      "--tests",
      "com.example.player.*",
    ]);
    expect(String(result.stdout)).toContain(
      "GRADLE_ARGS:test --rerun-tasks --tests com.example.player.*",
    );
  });

  test("未知 runner 回傳精準錯誤與支援清單", async () => {
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "unknown-runner", script: "test" },
      "momus",
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("RUNNER_NOT_SUPPORTED");
    expect(result.supportedRunners).toContain("gradle");
    expect(result.supportedRunners).toContain("pytest");
    expect(result.supportedRunners).toContain("dotnet");
    expect(result.supportedRunners).toContain("maven");
    expect(result.supportedRunners).not.toContain("unknown-runner");
  });

  test("直接 runner 會用固定測試指令並傳遞參數", async () => {
    const cases = [
      { runner: "pytest", executable: "pytest", command: ["pytest", "tests/unit"] },
      { runner: "python", executable: "python", command: ["python", "-m", "pytest", "tests/unit"] },
      { runner: "python3", executable: "python3", command: ["python3", "-m", "pytest", "tests/unit"] },
      { runner: "go", executable: "go", command: ["go", "test", "tests/unit"] },
      { runner: "cargo", executable: "cargo", command: ["cargo", "test", "tests/unit"] },
      { runner: "swift", executable: "swift", command: ["swift", "test", "tests/unit"] },
      { runner: "node", executable: "node", command: ["node", "--test", "tests/unit"] },
      { runner: "deno", executable: "deno", command: ["deno", "test", "tests/unit"] },
      { runner: "dotnet", executable: "dotnet", command: ["dotnet", "test", "tests/unit"] },
      { runner: "maven", executable: "mvn", command: ["mvn", "test", "tests/unit"] },
      { runner: "flutter", executable: "flutter", command: ["flutter", "test", "tests/unit"] },
      { runner: "mix", executable: "mix", command: ["mix", "test", "tests/unit"] },
      { runner: "phpunit", executable: "phpunit", command: ["phpunit", "tests/unit"] },
    ] as const;

    const { tool } = await loadTools(ws.root);
    for (const item of cases) {
      installFakeRunner(item.executable);
      const result = await executeTool(
        tool("verification_run"),
        { runner: item.runner, script: "test", args: ["tests/unit"], timeoutMs: 5000 },
        "momus",
      );

      expect(result.ok).toBe(true);
      expect(result.command).toEqual(item.command);
      expect(String(result.stdout)).toContain(`RUNNER_ARGS:${item.command.slice(1).join(" ")}`);
    }
  });

  test("找不到直接 runner 時回傳可操作錯誤", async () => {
    const emptyBin = join(ws.root, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    process.env.PATH = emptyBin;

    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "pytest", script: "test" },
      "momus",
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("RUNNER_NOT_FOUND");
    expect(result.executable).toBe("pytest");
    expect(String(result.error)).toContain("找不到驗證工具 pytest");
  });

  test("python3 是受支援 runner，以 direct argv 啟動 fake python3 並回傳 VERIFIED", async () => {
    installFakeRunner("python3");
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "python3", script: "test", args: ["tests/unit"], timeoutMs: 5000 },
      "momus",
    );

    expect(result.ok).toBe(true);
    expect(result.code).toBe("VERIFIED");
    expect(result.command).toEqual(["python3", "-m", "pytest", "tests/unit"]);
    expect(result.cwd).toBe(realpathSync(ws.root));
    expect(String(result.stdout)).toContain("RUNNER_ARGS:-m pytest tests/unit");
  });

  test("python／python3／pytest subprocess 收到不可覆寫的 PYTHONDONTWRITEBYTECODE=1", async () => {
    const saved = process.env.PYTHONDONTWRITEBYTECODE;
    process.env.PYTHONDONTWRITEBYTECODE = "0";
    try {
      for (const runner of ["python", "python3", "pytest"] as const) {
        installEnvProbeRunner(runner);
        const { tool } = await loadTools(ws.root);
        const result = await executeTool(
          tool("verification_run"),
          { runner, script: "test", args: ["tests/unit"], timeoutMs: 5000 },
          "momus",
        );

        const stdout = String(result.stdout ?? "");
        expect({
          ok: result.ok,
          stdout,
        }).toEqual({
          ok: true,
          stdout: expect.stringContaining("PYTHONDONTWRITEBYTECODE:1"),
        });
        expect(stdout).toContain("CI:1");
        expect(stdout).toContain("NO_COLOR:1");
      }
    } finally {
      if (saved === undefined) delete process.env.PYTHONDONTWRITEBYTECODE;
      else process.env.PYTHONDONTWRITEBYTECODE = saved;
    }
  });

  test("非 Python runner 不注入 PYTHONDONTWRITEBYTECODE，且 CI/NO_COLOR 保持", async () => {
    const saved = process.env.PYTHONDONTWRITEBYTECODE;
    process.env.PYTHONDONTWRITEBYTECODE = "0";
    try {
      installEnvProbeRunner("go");
      const { tool } = await loadTools(ws.root);
      const result = await executeTool(
        tool("verification_run"),
        { runner: "go", script: "test", args: ["tests/unit"], timeoutMs: 5000 },
        "momus",
      );

      const stdout = String(result.stdout ?? "");
      expect(result.ok).toBe(true);
      expect(stdout).toContain("PYTHONDONTWRITEBYTECODE:0");
      expect(stdout).toContain("CI:1");
      expect(stdout).toContain("NO_COLOR:1");
    } finally {
      if (saved === undefined) delete process.env.PYTHONDONTWRITEBYTECODE;
      else process.env.PYTHONDONTWRITEBYTECODE = saved;
    }
  });

  test("找不到 python3 時回傳可操作錯誤", async () => {
    const emptyBin = join(ws.root, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    process.env.PATH = emptyBin;

    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "python3", script: "test" },
      "momus",
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("RUNNER_NOT_FOUND");
    expect(result.executable).toBe("python3");
    expect(String(result.error)).toContain("找不到驗證工具 python3");
  });

  test("python／python3 仍只允許 test script，拒絕 .sh script（shell script 不執行）", async () => {
    installFakeRunner("python3");
    installFakeRunner("python");
    const { tool } = await loadTools(ws.root);
    for (const runner of ["python", "python3"] as const) {
      const result = await executeTool(
        tool("verification_run"),
        { runner, script: "test.sh" },
        "momus",
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe("SCRIPT_NOT_ALLOWED");
    }
  });

  test("Gradle 拒絕非 test task 與額外 task 注入", async () => {
    const wrapperPath = `${ws.root}/gradlew`;
    writeFileSync(wrapperPath, "#!/bin/sh\nexit 0\n", "utf-8");
    chmodSync(wrapperPath, 0o755);

    const { tool } = await loadTools(ws.root);
    const taskResult = await executeTool(
      tool("verification_run"),
      { runner: "gradle", script: "build" },
      "momus",
    );
    const injectedTaskResult = await executeTool(
      tool("verification_run"),
      { runner: "gradle", script: "test", args: ["assemble"] },
      "momus",
    );

    expect(taskResult.ok).toBe(false);
    expect(taskResult.code).toBe("SCRIPT_NOT_ALLOWED");
    expect(injectedTaskResult.ok).toBe(false);
    expect(injectedTaskResult.code).toBe("GRADLE_ARGS_NOT_ALLOWED");
  });

  test("Gradle 缺少 worktree wrapper 時回傳可操作錯誤", async () => {
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "gradle", script: "test" },
      "momus",
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("GRADLE_WRAPPER_NOT_FOUND");
    expect(String(result.error)).toContain("gradlew");
  });

  test("Gradle 拒絕經 symlink cwd 逃逸至 worktree 外的 wrapper", async () => {
    const outside = mkdtempSync(join(tmpdir(), "verification-run-outside-"));
    const markerPath = join(outside, "wrapper-executed");
    try {
      const wrapperPath = join(outside, "gradlew");
      writeFileSync(wrapperPath, `#!/bin/sh\ntouch "${markerPath}"\n`, "utf-8");
      chmodSync(wrapperPath, 0o755);
      symlinkSync(outside, join(ws.root, "linked-project"));

      const { tool } = await loadTools(ws.root);
      const result = await executeTool(
        tool("verification_run"),
        { runner: "gradle", script: "test", cwd: "linked-project" },
        "momus",
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe("INVALID_CWD");
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("Gradle 拒絕 cwd 內指向外部的 wrapper symlink", async () => {
    const outside = mkdtempSync(join(tmpdir(), "verification-run-wrapper-"));
    const markerPath = join(outside, "wrapper-executed");
    try {
      const outsideWrapper = join(outside, "gradlew");
      writeFileSync(outsideWrapper, `#!/bin/sh\ntouch "${markerPath}"\n`, "utf-8");
      chmodSync(outsideWrapper, 0o755);
      symlinkSync(outsideWrapper, join(ws.root, "gradlew"));

      const { tool } = await loadTools(ws.root);
      const result = await executeTool(
        tool("verification_run"),
        { runner: "gradle", script: "test" },
        "momus",
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe("GRADLE_WRAPPER_INVALID");
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("Gradle 拒絕不可執行的 regular wrapper", async () => {
    const wrapperPath = join(ws.root, "gradlew");
    writeFileSync(wrapperPath, "#!/bin/sh\nexit 0\n", "utf-8");
    chmodSync(wrapperPath, 0o644);

    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "gradle", script: "test" },
      "momus",
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("GRADLE_WRAPPER_NOT_EXECUTABLE");
  });

  test("拒絕 lifecycle／任意 script", async () => {
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "bun", script: "postinstall" },
      "momus",
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("SCRIPT_NOT_ALLOWED");
  });

  test("即使繞過 frontmatter，非授權 agent 仍由工具拒絕（共用授權清單）", async () => {
    const { VERIFICATION_RUN_ALLOWED_AGENTS, isVerificationRunAllowedAgent } = await import(
      "../../../src/modules/verification/verification-policy.ts"
    );
    expect([...VERIFICATION_RUN_ALLOWED_AGENTS]).toEqual(["momus"]);
    expect(isVerificationRunAllowedAgent("build")).toBe(false);
    expect(isVerificationRunAllowedAgent(undefined)).toBe(false);
    expect(isVerificationRunAllowedAgent("momus")).toBe(true);

    const { tool } = await loadTools(ws.root);
    for (const agent of ["build", "implementer", "arch", undefined] as const) {
      const result = await executeTool(
        tool("verification_run"),
        { runner: "bun", script: "test:p0" },
        agent,
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe("AGENT_NOT_ALLOWED");
    }
  });

  test("拒絕 worktree 外 cwd", async () => {
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "bun", script: "test:p0", cwd: "../outside" },
      "momus",
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("INVALID_CWD");
  });

  test("工作階段位置優先於外掛實例位置（root 綁定回歸）", async () => {
    // 情境：外掛實例位置（directory）是另一個存在、且與 ws.root 無關的目錄，
    // 但本次呼叫的工作階段位置是 ws.root。合法的 project-relative cwd
    //（tests/unit 只存在於 ws.root）不應被拒絕。
    const wrongRoot = mkdtempSync(join(tmpdir(), "verification-run-wrong-root-"));
    const markerPath = join(ws.root, "pytest-executed");
    try {
      mkdirSync(join(ws.root, "tests", "unit"), { recursive: true });
      const fakeBin = join(ws.root, "fake-bin");
      mkdirSync(fakeBin, { recursive: true });
      const fakePytest = join(fakeBin, "pytest");
      writeFileSync(
        fakePytest,
        `#!/bin/sh\ntouch "${markerPath}"\nprintf 'RUNNER_ARGS:%s\\n' "$*"\n`,
        "utf-8",
      );
      chmodSync(fakePytest, 0o755);
      process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ""}`;

      const { tool } = await loadTools(wrongRoot, ws.root);
      const result = await executeTool(
        tool("verification_run"),
        { runner: "pytest", script: "test", args: ["tests/unit"], cwd: "tests/unit" },
        "momus",
      );

      const canonicalCwd = realpathSync(join(ws.root, "tests", "unit"));
      expect({
        ok: result.ok,
        code: result.code,
        cwd: result.cwd,
        markerCreated: existsSync(markerPath),
        stdout: String(result.stdout ?? ""),
      }).toEqual({
        ok: true,
        code: "VERIFIED",
        cwd: canonicalCwd,
        markerCreated: true,
        stdout: expect.stringContaining("RUNNER_ARGS:tests/unit"),
      });
    } finally {
      rmSync(wrongRoot, { recursive: true, force: true });
    }
  });

  test("unsafe 工作階段位置（/、/Users、/Volumes）必須 fail closed，不在危險目錄啟動 runner", async () => {
    const outside = mkdtempSync(join(tmpdir(), "verification-run-unsafe-"));
    const markerPath = join(outside, "unsafe-pytest-ran");
    try {
      const fakeBin = join(ws.root, "fake-bin");
      mkdirSync(fakeBin, { recursive: true });
      const fakePytest = join(fakeBin, "pytest");
      writeFileSync(
        fakePytest,
        `#!/bin/sh\ntouch "${markerPath}"\nprintf 'RUNNER_ARGS:%s\\n' "$*"\n`,
        "utf-8",
      );
      chmodSync(fakePytest, 0o755);
      process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ""}`;

      const unsafeRoots = ["/", "/Users", "/Volumes"] as const;
      const observations: Array<{ root: string; code: string; markerCreated: boolean }> = [];

      for (const unsafeRoot of unsafeRoots) {
        try {
          rmSync(markerPath);
        } catch {
          // ignore
        }

        const { tool } = await loadTools(unsafeRoot);
        const result = await executeTool(
          tool("verification_run"),
          { runner: "pytest", script: "test", cwd: "." },
          "momus",
        );

        observations.push({
          root: unsafeRoot,
          code: String(result.code ?? "MISSING_CODE"),
          markerCreated: existsSync(markerPath),
        });
      }

      expect(observations).toEqual([
        { root: "/", code: "INVALID_CWD", markerCreated: false },
        { root: "/Users", code: "INVALID_CWD", markerCreated: false },
        { root: "/Volumes", code: "INVALID_CWD", markerCreated: false },
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("unsafe canonical root（symlink alias → /、/Users、/Volumes）必須 fail closed，不啟動 runner", async () => {
    const aliasParent = mkdtempSync(join(tmpdir(), "verification-run-alias-parent-"));
    const outside = mkdtempSync(join(tmpdir(), "verification-run-alias-marker-"));
    const markerPath = join(outside, "unsafe-pytest-ran");
    try {
      const fakeBin = join(ws.root, "fake-bin");
      mkdirSync(fakeBin, { recursive: true });
      const fakePytest = join(fakeBin, "pytest");
      writeFileSync(
        fakePytest,
        `#!/bin/sh\ntouch "${markerPath}"\nprintf 'RUNNER_ARGS:%s\\n' "$*"\n`,
        "utf-8",
      );
      chmodSync(fakePytest, 0o755);
      process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ""}`;

      const unsafeTargets = ["/", "/Users", "/Volumes"] as const;
      const observations: Array<{ target: string; code: string; markerCreated: boolean }> = [];

      for (const unsafeTarget of unsafeTargets) {
        try {
          rmSync(markerPath);
        } catch {
          // ignore
        }

        const aliasRoot = join(aliasParent, `alias-to-${unsafeTarget.slice(1) || "root"}`);
        symlinkSync(unsafeTarget, aliasRoot);

        try {
          const { tool } = await loadTools(aliasRoot);
          const result = await executeTool(
            tool("verification_run"),
            { runner: "pytest", script: "test", cwd: "." },
            "momus",
          );

          observations.push({
            target: unsafeTarget,
            code: String(result.code ?? "MISSING_CODE"),
            markerCreated: existsSync(markerPath),
          });
        } catch (error) {
          observations.push({
            target: unsafeTarget,
            code: `THREW:${error instanceof Error ? error.constructor.name : "Unknown"}`,
            markerCreated: existsSync(markerPath),
          });
        }

        try {
          rmSync(aliasRoot);
        } catch {
          // ignore
        }
      }

      expect(observations).toEqual([
        { target: "/", code: "INVALID_CWD", markerCreated: false },
        { target: "/Users", code: "INVALID_CWD", markerCreated: false },
        { target: "/Volumes", code: "INVALID_CWD", markerCreated: false },
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(aliasParent, { recursive: true, force: true });
    }
  });

  test("canonicalization 失敗（dangling symlink／不存在 root）必須 fail closed，回傳 INVALID_CWD 且不啟動 runner", async () => {
    const aliasParent = mkdtempSync(join(tmpdir(), "verification-run-canonical-fail-"));
    const outside = mkdtempSync(join(tmpdir(), "verification-run-canonical-marker-"));
    const markerPath = join(outside, "unsafe-pytest-ran");
    try {
      const fakeBin = join(ws.root, "fake-bin");
      mkdirSync(fakeBin, { recursive: true });
      const fakePytest = join(fakeBin, "pytest");
      writeFileSync(
        fakePytest,
        `#!/bin/sh\ntouch "${markerPath}"\nprintf 'RUNNER_ARGS:%s\\n' "$*"\n`,
        "utf-8",
      );
      chmodSync(fakePytest, 0o755);
      process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ""}`;

      const cases: Array<{ label: string; projectRoot: string }> = [
        {
          label: "dangling symlink",
          projectRoot: join(aliasParent, "dangling-root"),
        },
        {
          label: "nonexistent path",
          projectRoot: join(aliasParent, "no-such-directory"),
        },
      ];

      const observations: Array<{ label: string; code: string; markerCreated: boolean }> = [];

      for (const item of cases) {
        if (item.label === "dangling symlink") {
          symlinkSync(join(aliasParent, "no-such-target"), item.projectRoot);
        }

        try {
          rmSync(markerPath);
        } catch {
          // ignore
        }

        try {
          const { tool } = await loadTools(item.projectRoot);
          const result = await executeTool(
            tool("verification_run"),
            { runner: "pytest", script: "test", cwd: "." },
            "momus",
          );

          observations.push({
            label: item.label,
            code: String(result.code ?? "MISSING_CODE"),
            markerCreated: existsSync(markerPath),
          });
        } catch (error) {
          observations.push({
            label: item.label,
            code: `THREW:${error instanceof Error ? error.constructor.name : "Unknown"}`,
            markerCreated: existsSync(markerPath),
          });
        }
      }

      expect(observations).toEqual([
        { label: "dangling symlink", code: "INVALID_CWD", markerCreated: false },
        { label: "nonexistent path", code: "INVALID_CWD", markerCreated: false },
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(aliasParent, { recursive: true, force: true });
    }
  });

  test("timeout 會終止 subprocess 並回傳可稽核結果", async () => {
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "bun", script: "test:slow", timeoutMs: 100 },
      "momus",
    );

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  // ——— B1：輸出頭尾保留、串流有界 ———

  function installBlobRunner(executable: string, fillerLines: number, lastLine: string) {
    const binPath = join(ws.root, "fake-bin");
    mkdirSync(binPath, { recursive: true });
    const executablePath = join(binPath, executable);
    writeFileSync(
      executablePath,
      [
        "#!/bin/sh",
        "echo HEAD_MARKER_FIRST_LINE",
        `awk 'BEGIN{for(i=0;i<${fillerLines};i++) print "filler-line-" i "-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}'`,
        `echo '${lastLine}'`,
        "",
      ].join("\n"),
      "utf-8",
    );
    chmodSync(executablePath, 0o755);
    process.env.PATH = `${binPath}${delimiter}${process.env.PATH ?? ""}`;
  }

  test("未超長輸出逐位元組還原，不截斷", async () => {
    installFakeRunner("go");
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "go", script: "test", args: ["tests/unit"], timeoutMs: 5000 },
      "momus",
    );
    expect(result.ok).toBe(true);
    expect(result.outputTruncated).toBe(false);
    expect(String(result.stdout)).toBe("RUNNER_ARGS:test tests/unit\n");
    expect(result.stdoutBytes).toBe("RUNNER_ARGS:test tests/unit\n".length);
  });

  test("中等長度輸出（頭尾涵蓋全部）逐位元組還原且不標截斷", async () => {
    // ~110KB，超過 head+tail 需要重建，但 gap<=0 → 完整還原
    installBlobRunner("go", 1400, "END_OF_MEDIUM_OUTPUT");
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "go", script: "test", timeoutMs: 10000 },
      "momus",
    );
    const stdout = String(result.stdout);
    if (!result.outputTruncated) {
      // 完整還原：位元組數等於重建文字的 UTF-8 長度
      expect(new TextEncoder().encode(stdout).length).toBe(result.stdoutBytes);
      expect(stdout).toContain("HEAD_MARKER_FIRST_LINE");
      expect(stdout).toContain("END_OF_MEDIUM_OUTPUT");
      expect(stdout).not.toMatch(/略過中段/);
    }
  });

  test("超長輸出保留尾端結論行與開頭，中段標記省略量", async () => {
    installBlobRunner("go", 3000, "TESTS: 5 passed, 2 failed");
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "go", script: "test", args: ["tests/unit"], timeoutMs: 10000 },
      "momus",
    );
    const stdout = String(result.stdout);
    expect(result.outputTruncated).toBe(true);
    // 尾端結論行沒有被丟掉（舊實作留開頭就會丟這行）
    expect(stdout).toContain("TESTS: 5 passed, 2 failed");
    // 開頭也留著
    expect(stdout).toContain("HEAD_MARKER_FIRST_LINE");
    // 中段被省略且標記位元組數
    expect(stdout).toMatch(/略過中段 \d+ 位元組/);
    // 回傳的 stdout 遠小於實際輸出量
    expect(result.stdoutBytes).toBeGreaterThan(150_000);
    expect(stdout.length).toBeLessThan(30_000);
    // heuristic 結論行擷取
    expect(Array.isArray(result.summaryLines)).toBe(true);
    expect((result.summaryLines as string[]).some((l) => l.includes("5 passed, 2 failed"))).toBe(true);
  });

  test("逾時仍回傳已擷取的部分輸出", async () => {
    const binPath = join(ws.root, "fake-bin");
    mkdirSync(binPath, { recursive: true });
    const exe = join(binPath, "go");
    writeFileSync(exe, "#!/bin/sh\necho PARTIAL_OUTPUT_BEFORE_HANG\nsleep 30\n", "utf-8");
    chmodSync(exe, 0o755);
    process.env.PATH = `${binPath}${delimiter}${process.env.PATH ?? ""}`;

    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "go", script: "test", timeoutMs: 500 },
      "momus",
    );
    expect(result.timedOut).toBe(true);
    expect(String(result.stdout)).toContain("PARTIAL_OUTPUT_BEFORE_HANG");
  });

  // ——— B2：逾時上限與 process group 清理 ———

  test("逾時終止整個 process group，孫程序不會存活", async () => {
    const marker = join(ws.root, "grandchild-marker");
    const binPath = join(ws.root, "fake-bin");
    mkdirSync(binPath, { recursive: true });
    const exe = join(binPath, "go");
    // 背景孫程序：2 秒後 touch marker；父程序 sleep 30。舊實作 subprocess.kill()
    // 只殺父程序，孫程序存活並 touch marker。
    writeFileSync(exe, `#!/bin/sh\nsh -c 'sleep 2; touch "${marker}"' &\nsleep 30\n`, "utf-8");
    chmodSync(exe, 0o755);
    process.env.PATH = `${binPath}${delimiter}${process.env.PATH ?? ""}`;

    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "go", script: "test", timeoutMs: 500 },
      "momus",
    );

    expect(result.timedOut).toBe(true);
    // 給「本來會 touch marker」的孫程序足夠時間
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(existsSync(marker)).toBe(false);
  });

  test("timeoutMs 上限為 600 秒", async () => {
    installFakeRunner("go");
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "go", script: "test", timeoutMs: 9_999_999 },
      "momus",
    );
    expect(result.timeoutMs).toBe(600_000);
  });

  // ——— B4：script family 擴充 ———

  test("B4：check / verify 加入 standalone family，可執行", async () => {
    const { tool } = await loadTools(ws.root);
    for (const [script, marker] of [["check", "CHECK_OK"], ["verify", "VERIFY_OK"]] as const) {
      const result = await executeTool(tool("verification_run"), { runner: "bun", script, timeoutMs: 5000 }, "momus");
      expect(result.ok).toBe(true);
      expect(String(result.stdout)).toContain(marker);
    }
  });

  test("B4：裸 format 被拒，format:check / format:verify 放行", async () => {
    const { tool } = await loadTools(ws.root);

    const bare = await executeTool(tool("verification_run"), { runner: "bun", script: "format" }, "momus");
    expect(bare.ok).toBe(false);
    expect(bare.code).toBe("SCRIPT_NOT_ALLOWED");

    const checked = await executeTool(tool("verification_run"), { runner: "bun", script: "format:check", timeoutMs: 5000 }, "momus");
    expect(checked.ok).toBe(true);
    expect(String(checked.stdout)).toContain("FORMAT_CHECK_OK");
  });

  test("B4：lifecycle script（postinstall / prepare）仍被拒", async () => {
    const { tool } = await loadTools(ws.root);
    for (const script of ["postinstall", "prepare"] as const) {
      const result = await executeTool(tool("verification_run"), { runner: "bun", script }, "momus");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("SCRIPT_NOT_ALLOWED");
    }
  });

  test("B4：script family 清單有單一定義位置，isPackageScriptAllowed 由此推導", async () => {
    const { STANDALONE_SCRIPT_FAMILIES, SUFFIX_ONLY_SCRIPT_FAMILIES, isPackageScriptAllowed } = await import(
      "../../../src/modules/verification/verification-run.ts"
    );
    for (const base of STANDALONE_SCRIPT_FAMILIES) {
      expect(isPackageScriptAllowed(base)).toBe(true);
      expect(isPackageScriptAllowed(`${base}:p0`)).toBe(true);
    }
    for (const [base, suffixes] of Object.entries(SUFFIX_ONLY_SCRIPT_FAMILIES)) {
      expect(isPackageScriptAllowed(base)).toBe(false);
      for (const suffix of suffixes) expect(isPackageScriptAllowed(`${base}:${suffix}`)).toBe(true);
      expect(isPackageScriptAllowed(`${base}:write`)).toBe(false);
    }
    for (const bad of ["postinstall", "prepare", "build", "start", "deploy", ""]) {
      expect(isPackageScriptAllowed(bad)).toBe(false);
    }
  });

  // ——— B5：輕量參數路徑 containment ———

  test("B5：參數指向 worktree 外的既有路徑被拒（位置參數與 flag value）", async () => {
    installFakeRunner("pytest");
    installFakeRunner("cargo");
    const outside = mkdtempSync(join(tmpdir(), "verification-run-b5-"));
    try {
      writeFileSync(join(outside, "x.py"), "", "utf-8");
      writeFileSync(join(outside, "Cargo.toml"), "", "utf-8");
      const rel = (p: string) => relative(realpathSync(ws.root), join(outside, p));

      const { tool } = await loadTools(ws.root);

      const positional = await executeTool(
        tool("verification_run"),
        { runner: "pytest", args: [rel("x.py")] },
        "momus",
      );
      expect(positional.ok).toBe(false);
      expect(positional.code).toBe("ARG_PATH_OUTSIDE_WORKTREE");

      const flagValue = await executeTool(
        tool("verification_run"),
        { runner: "cargo", args: ["--manifest-path", rel("Cargo.toml")] },
        "momus",
      );
      expect(flagValue.ok).toBe(false);
      expect(flagValue.code).toBe("ARG_PATH_OUTSIDE_WORKTREE");

      const flagEquals = await executeTool(
        tool("verification_run"),
        { runner: "cargo", args: [`--manifest-path=${join(outside, "Cargo.toml")}`] },
        "momus",
      );
      expect(flagEquals.ok).toBe(false);
      expect(flagEquals.code).toBe("ARG_PATH_OUTSIDE_WORKTREE");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("B5：worktree 內的相對路徑參數與非路徑參數不受影響", async () => {
    mkdirSync(join(ws.root, "tests", "unit"), { recursive: true });
    writeFileSync(join(ws.root, "tests", "unit", "test_a.py"), "", "utf-8");
    installFakeRunner("pytest");
    const { tool } = await loadTools(ws.root);

    const inside = await executeTool(
      tool("verification_run"),
      { runner: "pytest", args: ["-q", "tests/unit/test_a.py"], timeoutMs: 5000 },
      "momus",
    );
    expect(inside.ok).toBe(true);

    // 非路徑參數（測試名、-k 表達式）解析後不存在 → 不誤判
    const testName = await executeTool(
      tool("verification_run"),
      { runner: "pytest", args: ["-k", "test_recovery or test_boundary", "not/a/real/path"], timeoutMs: 5000 },
      "momus",
    );
    expect(testName.code).not.toBe("ARG_PATH_OUTSIDE_WORKTREE");
  });

  // ——— 回歸鎖定：verification_run 工具說明與自我修正文案 ———

  test("tool description 必須載明 direct runner script:\"test\"、args 與 package test／lint／typecheck 契約", async () => {
    const { tool } = await loadTools(ws.root);
    const def = tool("verification_run") as unknown as { description: string };
    const description = String(def.description ?? "");

    // Direct runner 契約
    expect(description).toContain('script:"test"');
    expect(description).toContain("args");
    expect(description).toContain('runner:"pytest"');
    expect(description).toContain("tests/test_recovery_verification.py");
    // 不可將完整命令塞入 script
    expect(description).toContain("不可將完整命令塞入 script");
    // Package runner family
    expect(description).toContain("test／lint／typecheck");
    expect(description).toContain("bun／npm／pnpm／yarn");
    // Direct runner 清單
    expect(description).toContain("pytest");
  });

  test("直接 runner 誤用：完整命令放入 script 仍 SCRIPT_NOT_ALLOWED 且回自我修正指引", async () => {
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "pytest", script: "pytest -q tests/test_recovery_verification.py" },
      "momus",
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("SCRIPT_NOT_ALLOWED");
    expect(result.policy).toBe("restricted-verification-v1");
    const error = String(result.error ?? "");
    expect(error).toContain('script 必須是 "test"');
    expect(error).toContain("args");
    expect(error).toContain("tests/test_recovery_verification.py");
    expect(error).toContain('runner: "pytest"');
    expect(error).toContain("或直接省略");
    expect(error).toContain("請勿將完整命令塞入 script");
  });

  test("B3：直接 runner 省略 script（或 script:\"test\"）等同 test 指令", async () => {
    installFakeRunner("go");
    const { tool } = await loadTools(ws.root);
    for (const input of [
      { runner: "go", args: ["tests/unit"] },
      { runner: "go", script: "test", args: ["tests/unit"] },
    ]) {
      const result = await executeTool(tool("verification_run"), { ...input, timeoutMs: 5000 }, "momus");
      expect(result.ok).toBe(true);
      expect(result.command).toEqual(["go", "test", "tests/unit"]);
    }
  });

  test("直接 runner 非 test script 仍拒絕且含直接 runner 指引", async () => {
    const { tool } = await loadTools(ws.root);
    const cases = ["lint", "test:unit", "pytest"] as const;
    for (const script of cases) {
      const result = await executeTool(
        tool("verification_run"),
        { runner: "pytest", script },
        "momus",
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe("SCRIPT_NOT_ALLOWED");
      expect(result.policy).toBe("restricted-verification-v1");
      const error = String(result.error ?? "");
      expect(error).toContain('script 必須是 "test"');
      expect(error).toContain("args");
    }
  });

  test("套件管理器誤用：postinstall 與任意 script 仍 SCRIPT_NOT_ALLOWED 且僅含 package 指引", async () => {
    const { tool } = await loadTools(ws.root);
    const cases = ["postinstall", "build", "pytest -q tests/unit"] as const;
    for (const script of cases) {
      const result = await executeTool(
        tool("verification_run"),
        { runner: "bun", script },
        "momus",
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe("SCRIPT_NOT_ALLOWED");
      expect(result.policy).toBe("restricted-verification-v1");
      const error = String(result.error ?? "");
      expect(error).toContain("test／lint／typecheck");
      expect(error).toContain("套件管理器");
      // 不應出現 direct runner 專用指引
      expect(error).not.toContain('script 必須是 "test"');
      expect(error).not.toContain("tests/test_recovery_verification.py");
    }
  });

  test("package runner 的 SCRIPT_NOT_ALLOWED 文案不混入 direct runner 範例路徑", async () => {
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(
      tool("verification_run"),
      { runner: "npm", script: "postinstall" },
      "momus",
    );
    expect(result.code).toBe("SCRIPT_NOT_ALLOWED");
    const error = String(result.error ?? "");
    expect(error).toContain("test／lint／typecheck");
    expect(error).not.toContain('script 必須是 "test"');
  });

  test("指定追蹤檔案未變時附加穩定摘要，但不把它當成整個系統正確", async () => {
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "program.ts"), "unchanged", "utf8");
    writeFileSync(join(ws.root, "src", "test.ts"), "test-fixture", "utf8");
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(tool("verification_run"), {
      runner: "bun",
      script: "test:p0",
      trackedFiles: ["src/program.ts", "src/test.ts"],
      timeoutMs: 5000,
    }, "momus");

    expect(result.ok).toBe(true);
    expect(result.evidence.schema).toBe("verification-evidence-v1");
    expect(result.evidence.comparison.unchanged).toEqual(["src/program.ts", "src/test.ts"]);
    expect(result.evidence.comparison.changed).toEqual([]);
    expect(result.evidence.reusable).toBe(true);
    expect(result.evidence.note).toContain("不等於整個系統正確");
  });

  test("追蹤程式／測試檔案改變後，舊驗證證據不能重用", async () => {
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "program.ts"), "before", "utf8");
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(tool("verification_run"), {
      runner: "bun",
      script: "test:mutate",
      trackedFiles: ["src/program.ts"],
      timeoutMs: 5000,
    }, "momus");

    expect(result.ok).toBe(true);
    expect(result.evidence.comparison.unchanged).toEqual([]);
    expect(result.evidence.comparison.changed).toEqual(["src/program.ts"]);
    expect(result.evidence.reusable).toBe(false);
    expect(result.evidence.status).toBe("changed_requires_reverification");
  });

  test("遺失、跨專案與讀取不完整的追蹤範圍不會誤判可重用", async () => {
    const outside = mkdtempSync(join(tmpdir(), "verification-evidence-outside-"));
    try {
      const { tool } = await loadTools(ws.root);
      const result = await executeTool(tool("verification_run"), {
        runner: "bun",
        script: "test:p0",
        trackedFiles: ["missing.ts", join(outside, "outside.ts")],
        timeoutMs: 5000,
      }, "momus");

      expect(result.ok).toBe(true);
      expect(result.evidence.reusable).toBe(false);
      expect(result.evidence.comparison.unableToDetermine).toEqual([join(outside, "outside.ts"), "missing.ts"].sort());
      expect(result.evidence.status).toBe("insufficient_evidence");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("空的追蹤清單不能被當成可重用的驗證證據", async () => {
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(tool("verification_run"), {
      runner: "bun",
      script: "test:p0",
      trackedFiles: [],
      timeoutMs: 5000,
    }, "momus");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("INVALID_TRACKED_FILES");
    expect(result.evidence.reusable).toBe(false);
  });

  test("未提供追蹤範圍時維持原有 verification_run 相容性，但明確不能重用證據", async () => {
    const { tool } = await loadTools(ws.root);
    const result = await executeTool(tool("verification_run"), {
      runner: "bun",
      script: "test:p0",
      timeoutMs: 5000,
    }, "momus");

    expect(result.ok).toBe(true);
    expect(result.evidence.reusable).toBe(false);
    expect(result.evidence.status).toBe("tracking_not_provided");
  });

  test("recheck 入口會在驗證後檔案改變時撤銷 reusable", async () => {
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "program.ts"), "before", "utf8");
    const { tool } = await loadTools(ws.root);
    const run = await executeTool(tool("verification_run"), {
      runner: "bun",
      script: "test:p0",
      trackedFiles: ["src/program.ts"],
      timeoutMs: 5000,
    }, "momus");
    expect(run.evidence.reusable).toBe(true);

    writeFileSync(join(ws.root, "src", "program.ts"), "changed-after-verification", "utf8");
    const rechecked = await executeTool(tool("verification_run"), {
      action: "recheck",
      evidence: run.evidence,
    }, "momus");
    expect(rechecked.ok).toBe(true);
    expect(rechecked.code).toBe("EVIDENCE_RECHECKED");
    expect(rechecked.evidence.comparison.changed).toEqual(["src/program.ts"]);
    expect(rechecked.evidence.status).toBe("stale_requires_reverification");
    expect(rechecked.evidence.reusable).toBe(false);
  });

  test("recheck 在指定檔案未變時保留可重用證據，缺欄位則回傳輸入錯誤", async () => {
    mkdirSync(join(ws.root, "src"), { recursive: true });
    writeFileSync(join(ws.root, "src", "program.ts"), "stable", "utf8");
    const { tool } = await loadTools(ws.root);
    const run = await executeTool(tool("verification_run"), {
      runner: "bun",
      script: "test:p0",
      trackedFiles: ["src/program.ts"],
      timeoutMs: 5000,
    }, "momus");
    const rechecked = await executeTool(tool("verification_run"), {
      action: "recheck",
      evidence: run.evidence,
    }, "momus");
    expect(rechecked.evidence.comparison.unchanged).toEqual(["src/program.ts"]);
    expect(rechecked.evidence.status).toBe("stable");
    expect(rechecked.evidence.reusable).toBe(true);

    const invalid = await executeTool(tool("verification_run"), {
      action: "recheck",
      evidence: { schema: "verification-evidence-v1" },
    }, "momus");
    expect(invalid.ok).toBe(false);
    expect(invalid.code).toBe("INVALID_EVIDENCE");
  });
});
