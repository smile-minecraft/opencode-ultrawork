/**
 * 受限的獨立驗證工具。
 *
 * 安全邊界：
 * - 不接受 shell command string，只接受 runner + allowlisted script family。
 * - subprocess 以 argv 直接啟動，shell=false，cwd 必須位於 worktree。
 * - package lifecycle scripts（postinstall 等）與任意 script 名稱一律拒絕。
 * - 移除常見 credential env，限制 timeout 與輸出大小。
 */

import type { Plugin } from "@opencode/plugin";
import { type ChildProcess, spawn as spawnChildProcess } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { z } from "zod";
import { defineTool, type DefinedTool, type ToolExecutionContext } from "../../kit/define-tool.ts";
import { jsonResult } from "../../kit/json.ts";
import { assertSafeWorktreePath, isInsideWorktree, resolveInsideWorktree } from "../../kit/path-guard.ts";
import { captureTrackedFileSnapshots, type TrackedFileSnapshot } from "./change-scope-check.ts";
import { isVerificationRunAllowedAgent, VERIFICATION_RUN_ALLOWED_AGENTS } from "./verification-policy.ts";
import { isUnsafeRoot, resolveSessionDirectory } from "./session-root.ts";

const SUPPORTED_RUNNERS = [
  "bun",
  "npm",
  "pnpm",
  "yarn",
  "pytest",
  "python",
  "python3",
  "go",
  "cargo",
  "swift",
  "node",
  "deno",
  "dotnet",
  "maven",
  "flutter",
  "mix",
  "phpunit",
  "gradle",
] as const;
const PACKAGE_RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);
const SUPPORTED_RUNNER_SET = new Set<string>(SUPPORTED_RUNNERS);

// 套件管理器 script family 的單一定義位置；測試由此推導。
// 這些是唯讀的驗證動作，安全性和 test/lint 同級——都是 package.json 裡的
// 具名 script，不是 lifecycle hook。
export const STANDALONE_SCRIPT_FAMILIES = ["test", "lint", "typecheck", "check", "verify"] as const;
// 只能帶特定後綴的 family：`npm run format` 慣例上直接改檔，違反「驗證工具
// 不改狀態」；只放行 format:check / format:verify。
export const SUFFIX_ONLY_SCRIPT_FAMILIES: Record<string, readonly string[]> = {
  format: ["check", "verify"],
};
const STANDALONE_SCRIPT_PATTERN = new RegExp(
  `^(${STANDALONE_SCRIPT_FAMILIES.join("|")})(?::[A-Za-z0-9._-]+)*$`,
);
const SUFFIX_ONLY_SCRIPT_PATTERN = new RegExp(
  `^(${Object.entries(SUFFIX_ONLY_SCRIPT_FAMILIES)
    .map(([base, suffixes]) => `${base}:(${suffixes.join("|")})`)
    .join("|")})$`,
);

export function isPackageScriptAllowed(script: string): boolean {
  return STANDALONE_SCRIPT_PATTERN.test(script) || SUFFIX_ONLY_SCRIPT_PATTERN.test(script);
}
// 天花板拉到 10 分鐘：真實整合套件常超過兩分鐘，逾時就被列為證據不足，
// 直接驅使 momus 改用 bash。預設維持保守，momus 只重跑最小必要的測試。
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 60_000;
// 逾時後先 SIGTERM 整個 process group，寬限期過了再 SIGKILL。
const KILL_GRACE_MS = 4_000;
const MAX_ARG_COUNT = 128;
const MAX_ARG_LENGTH = 512;
// 輸出保留頭尾、丟中段。測試的結論（N pass / M fail、第一個 assertion diff、
// failure summary）在尾端，所以尾端配額大於開頭。全程串流讀取，記憶體鎖在
// 頭 + 尾 + 單一 chunk，與逾時長度無關。
const OUTPUT_HEAD_BYTES = 4_000;
const OUTPUT_TAIL_BYTES = 16_000;
const SENSITIVE_ENV_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH|COOKIE|SESSION|API[_-]?KEY|ACCESS[_-]?KEY)/i;
// Python 系 runner 固定注入 PYTHONDONTWRITEBYTECODE=1，避免驗證執行在
// 專案內新增 __pycache__/*.pyc 副作用。此旗標在 parent env 複製之後設定，
// 因此 parent env 或 input.args 都無法覆寫。
const PYTHON_RUNNERS = new Set(["python", "python3", "pytest"]);

type Runner = (typeof SUPPORTED_RUNNERS)[number];

function restrictedEnvironment(runner: Runner): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || SENSITIVE_ENV_PATTERN.test(key)) continue;
    env[key] = value;
  }
  env.CI = "1";
  env.NO_COLOR = "1";
  if (PYTHON_RUNNERS.has(runner)) {
    env.PYTHONDONTWRITEBYTECODE = "1";
  }
  return env;
}

// 用 node:child_process 而非 Bun.spawn：Bun.spawn 沒有 process group 支援，
// subprocess.kill() 只終止直接子程序，測試 runner 起的 dev server／watcher／
// xdist worker 會變孤兒。detached:true 讓子程序成為新 process group leader，
// 逾時就能用 process.kill(-pid) 打整個 group。僅 macOS（POSIX）。
// command[0] 必須是呼叫端用 findExecutableOnPath 解析出的絕對路徑，不傳裸名稱，
// 避免 spawn 時的 PATH 查找跟檢查時看到的不是同一個檔案（TOCTOU）。
function spawnRestricted(command: string[], cwd: string, runner: Runner): ChildProcess {
  return spawnChildProcess(command[0]!, command.slice(1), {
    cwd,
    env: restrictedEnvironment(runner),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    windowsHide: true,
    shell: false,
  });
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 程序已結束。
    }
  }
}

/** 以 signal 0 探測 process group 是否還有成員；ESRCH 代表整組已死。 */
function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// leader 退出後，給群組一個有上界的等待：SIGTERM 能處理的群組立刻就死；
// 忽略 SIGTERM 的成員會在升級計時器的 SIGKILL 送達後死亡。上界一到就回傳，
// 呼叫端不被卡住；還沒死的群組由 unref 的升級計時器補上 SIGKILL。
const GROUP_EXIT_WAIT_MS = KILL_GRACE_MS + 2_000;

async function waitForProcessGroupExit(pid: number | undefined, maxWaitMs: number): Promise<boolean> {
  if (pid === undefined) return true;
  const startedAt = Date.now();
  for (;;) {
    if (!isProcessGroupAlive(pid)) return true;
    if (Date.now() - startedAt >= maxWaitMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * 正規化並驗證 script。
 * - 套件管理器（bun／npm／pnpm／yarn）：必填，且必須落在 script family。
 * - 直接 runner：指令永遠是「runner test + args」，script 對它們沒有意義。
 *   可省略（等同 "test"）；有給只接受 "test"（配肌肉記憶）。
 */
function normalizeScript(runner: Runner, script: string): string | null {
  if (PACKAGE_RUNNERS.has(runner)) return isPackageScriptAllowed(script) ? script : null;
  return script === "" || script === "test" ? "test" : null;
}

/**
 * 輕量參數路徑 containment（威脅模型：避免 momus 不小心跑到別的專案的測試，
 * 不是抵抗惡意輸入）。
 *
 * 對每個參數（以及 `--flag=value` 的 value 部分）：解析成相對於 cwd 的絕對
 * 路徑，如果該路徑**實際存在**、而且**不在 worktree 內**，就拒絕。「實際存在」
 * 這個條件濾掉非路徑參數（測試名 `test_foo` 解析後不存在 → 不擋），誤判率
 * 趨近零，也不需要 per-runner 的旗標知識。
 *
 * 已知殘留：指向不存在的外部路徑不擋（runner 會自己報錯，無害）；設定檔內
 * 的間接指向不擋。依威脅模型接受。
 */
function findArgPathOutsideWorktree(args: string[], cwd: string, worktree: string): string | null {
  for (const arg of args) {
    const candidates = arg.includes("=") ? [arg, arg.slice(arg.indexOf("=") + 1)] : [arg];
    for (const candidate of candidates) {
      if (!candidate || candidate.startsWith("-")) continue;
      const resolved = resolve(cwd, candidate);
      let exists = false;
      try {
        statSync(resolved);
        exists = true;
      } catch {
        // 不是實際存在的路徑 → 不是我們要擋的東西。
      }
      if (exists && !isInsideWorktree(resolved, worktree)) return candidate;
    }
  }
  return null;
}

function validateGradleArgs(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--rerun-tasks") continue;
    if (arg === "--tests") {
      const pattern = args[index + 1];
      if (!pattern || pattern.startsWith("-")) {
        return "Gradle 的 --tests 需要一個不以 - 開頭的測試樣式。";
      }
      index += 1;
      continue;
    }
    return `不允許的 Gradle 參數：${arg}`;
  }
  return null;
}

// 套件管理器 runner 的 args 會原樣轉交給具名 script，底層命令未知；只放行
// 常見的測試篩選／輸出旗標，寫檔（--fix／--write 類由各工具自行命名，無法窮舉）
// 靠「驗證工具不改狀態＋trackedFiles 證據」兜底。
const PACKAGE_RUNNER_FILTER_FLAGS = [
  "-t",
  "--testNamePattern",
  "--testPathPattern",
  "--grep",
  "--filter",
  "-k",
  "-q",
  "--silent",
  "-v",
  "--verbose",
] as const;

/**
 * 每個 direct runner 允許的旗標（exact match，`--flag=value` 比對 `=` 之前）。
 *
 * 設計原則：
 * - 位置參數（不以 - 開頭）一律放行：測試檔、測試名稱、套件路徑都走這裡，
 *   再由 findArgPathOutsideWorktree 擋 worktree 外的既有路徑。
 * - 旗標只放行「選測試／調輸出」的讀取型旗標；會執行外部程式（go -exec、
 *   node --import、pytest -p、phpunit --bootstrap）、會寫檔（-coverprofile、
 *   --coverage、--junitxml、--bootstrap）的一律不在清單內。
 * - 同一個短旗標在不同 runner 語意不同就分開處理：cargo -p 是選套件（放行），
 *   pytest -p 是載入外掛（拒絕）。
 */
const EXTRA_ARG_FLAG_ALLOWLIST: Record<string, readonly string[]> = {
  bun: PACKAGE_RUNNER_FILTER_FLAGS,
  npm: PACKAGE_RUNNER_FILTER_FLAGS,
  pnpm: PACKAGE_RUNNER_FILTER_FLAGS,
  yarn: PACKAGE_RUNNER_FILTER_FLAGS,
  pytest: ["-q", "-v", "-s", "-x", "--maxfail", "-k", "-m", "--tb", "--no-header", "-rf", "--collect-only", "--co"],
  python: ["-q", "-v", "-s", "-x", "--maxfail", "-k", "-m", "--tb", "--no-header", "-rf", "--collect-only", "--co"],
  python3: ["-q", "-v", "-s", "-x", "--maxfail", "-k", "-m", "--tb", "--no-header", "-rf", "--collect-only", "--co"],
  go: ["-run", "-v", "-count", "-timeout", "-race", "-cover", "-failfast", "-short", "-list"],
  cargo: ["-p", "--package", "--test", "--tests", "--lib", "--bins", "--all-targets", "--no-run", "--no-fail-fast", "--skip", "--exact", "--ignored", "--include-ignored", "--manifest-path", "--offline", "-q", "--quiet", "-v", "--verbose"],
  swift: ["--filter", "--skip", "-v", "--verbose", "--parallel", "--num-workers"],
  node: ["--test-name-pattern", "--test-skip-pattern", "--test-concurrency"],
  deno: ["--filter", "--fail-fast", "--no-run", "-q", "--quiet"],
  dotnet: ["--filter", "--configuration", "-c", "--verbosity", "-v", "--no-build", "--no-restore", "--nologo"],
  maven: ["-Dtest", "-DfailIfNoTests", "-Dsurefire.failIfNoSpecifiedTests", "-q", "-o", "--offline"],
  flutter: ["--plain-name", "--concurrency"],
  mix: ["--only", "--exclude", "--seed", "--max-failures", "--failed", "--stale"],
  phpunit: ["--filter", "--testsuite", "--group", "--exclude-group", "--no-coverage"],
};

const EXTRA_ARG_EXAMPLES: Record<string, string> = {
  bun: 'args: ["tests/unit/login.test.ts", "-t", "recovery"]',
  npm: 'args: ["tests/unit/login.test.ts", "-t", "recovery"]',
  pnpm: 'args: ["tests/unit/login.test.ts", "-t", "recovery"]',
  yarn: 'args: ["tests/unit/login.test.ts", "-t", "recovery"]',
  pytest: 'args: ["-q", "tests/unit/test_a.py", "-k", "test_recovery"]',
  python: 'args: ["-q", "tests/unit/test_a.py", "-k", "test_recovery"]',
  python3: 'args: ["-q", "tests/unit/test_a.py", "-k", "test_recovery"]',
  go: 'args: ["-run", "TestRecovery", "./..."]',
  cargo: 'args: ["-p", "my-crate", "test_recovery"]',
  swift: 'args: ["--filter", "RecoveryTests"]',
  node: 'args: ["app.test.js", "--test-name-pattern", "recovery"]',
  deno: 'args: ["--filter", "recovery", "tests/"]',
  dotnet: 'args: ["--filter", "Name~Recovery"]',
  maven: 'args: ["-Dtest=RecoveryTest"]',
  flutter: 'args: ["--plain-name", "recovery"]',
  mix: 'args: ["test/recovery_test.exs", "--only", "recovery"]',
  phpunit: 'args: ["--filter", "RecoveryTest"]',
};

/** 回傳第一個不允許的旗標，沒有則回 null。gradle 走自己的 validateGradleArgs。 */
function validateExtraArgs(runner: Runner, args: string[]): string | null {
  if (runner === "gradle") return null;
  const allowed = EXTRA_ARG_FLAG_ALLOWLIST[runner] ?? [];
  for (const arg of args) {
    if (arg === "--" || arg === "-" || !arg.startsWith("-")) continue;
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (!allowed.includes(flag)) return arg;
  }
  return null;
}

function executableForRunner(runner: Runner): string {
  if (runner === "maven") return "mvn";
  return runner === "phpunit" ? "phpunit" : runner;
}

function findExecutableOnPath(executable: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory || ".", executable);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching the remaining PATH entries.
    }
  }
  return null;
}

function buildCommand(
  runner: Runner,
  script: string,
  extraArgs: string[],
  executable: string,
): string[] {
  if (PACKAGE_RUNNERS.has(runner)) {
    if (runner === "bun") return [executable, "run", script, ...extraArgs];
    return [executable, "run", script, "--", ...extraArgs];
  }

  if (runner === "gradle") return [executable, "test", ...extraArgs];
  if (runner === "pytest") return [executable, ...extraArgs];
  if (runner === "python" || runner === "python3") return [executable, "-m", "pytest", ...extraArgs];
  if (runner === "node") return [executable, "--test", ...extraArgs];
  if (runner === "deno") return [executable, "test", ...extraArgs];
  if (runner === "dotnet") return [executable, "test", ...extraArgs];
  if (runner === "maven") return [executable, "test", ...extraArgs];
  if (runner === "flutter") return [executable, "test", ...extraArgs];
  if (runner === "mix") return [executable, "test", ...extraArgs];
  if (runner === "phpunit") return [executable, ...extraArgs];
  return [executable, "test", ...extraArgs];
}

function inspectGradleWrapper(cwd: string):
  | { ok: true; path: string }
  | { ok: false; code: string; error: string } {
  const wrapperPath = resolveInsideWorktree("gradlew", cwd);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(wrapperPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      code: code === "ENOENT" ? "GRADLE_WRAPPER_NOT_FOUND" : "GRADLE_WRAPPER_INVALID",
      error: code === "ENOENT"
        ? `找不到 Gradle wrapper：${wrapperPath}。請在驗證目錄放入可執行的 gradlew。`
        : `無法檢查 Gradle wrapper：${wrapperPath}；${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    return {
      ok: false,
      code: "GRADLE_WRAPPER_INVALID",
      error: `Gradle wrapper 必須是驗證目錄內的普通檔案，且不能是 symbolic link：${wrapperPath}`,
    };
  }

  try {
    accessSync(wrapperPath, constants.X_OK);
  } catch {
    return {
      ok: false,
      code: "GRADLE_WRAPPER_NOT_EXECUTABLE",
      error: `Gradle wrapper 不可執行：${wrapperPath}`,
    };
  }

  return { ok: true, path: wrapperPath };
}

function resolveCanonicalCwd(requestedCwd: string, worktree: string): string {
  const lexicalCwd = resolveInsideWorktree(requestedCwd, worktree);
  const canonicalWorktree = realpathSync(worktree);
  const canonicalCwd = realpathSync(lexicalCwd);
  assertSafeWorktreePath(canonicalCwd, canonicalWorktree);
  return canonicalCwd;
}

/**
 * 串流輸出的有界擷取器。保留前 `headMax` 位元組（填滿後不再變動）與後
 * `tailMax` 位元組（丟掉最舊的），中段只累加位元組數。記憶體上界為
 * headMax + tailMax + 單一最大 chunk，與總輸出量、逾時長度都無關。
 */
class BoundedCapture {
  private head: Uint8Array;
  private headLen = 0;
  private tailChunks: Uint8Array[] = [];
  private tailBytes = 0;
  total = 0;

  constructor(private headMax: number, private tailMax: number) {
    this.head = new Uint8Array(headMax);
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.total += chunk.length;
    if (this.headLen < this.headMax) {
      const take = Math.min(this.headMax - this.headLen, chunk.length);
      this.head.set(chunk.subarray(0, take), this.headLen);
      this.headLen += take;
    }
    this.tailChunks.push(chunk);
    this.tailBytes += chunk.length;
    // 丟掉最舊的 chunk，只要丟掉之後剩餘位元組仍 >= tailMax。
    while (this.tailChunks.length > 1 && this.tailBytes - this.tailChunks[0]!.length >= this.tailMax) {
      this.tailBytes -= this.tailChunks.shift()!.length;
    }
  }

  private tailBuffer(): Uint8Array {
    if (this.tailChunks.length === 1) return this.tailChunks[0]!;
    const merged = new Uint8Array(this.tailBytes);
    let offset = 0;
    for (const chunk of this.tailChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }

  /** 重建輸出文字：未超長時逐位元組還原，超長時「頭 + 省略標記 + 尾」。 */
  finalize(): { text: string; truncated: boolean; bytes: number } {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    if (this.total <= this.headMax) {
      return { text: decoder.decode(this.head.subarray(0, this.headLen)), truncated: false, bytes: this.total };
    }
    const tailAll = this.tailBuffer();
    const tail = tailAll.length > this.tailMax ? tailAll.subarray(tailAll.length - this.tailMax) : tailAll;
    const gap = this.total - this.headMax - tail.length;
    if (gap <= 0) {
      // 頭尾涵蓋全部（可能重疊）：把 head 與尾端超出 headMax 的位元組接成
      // 一個陣列再一次解碼，確保跨邊界的多位元組字元逐位元組還原。
      const tailRemainder = tail.subarray(Math.max(0, tail.length - (this.total - this.headMax)));
      const merged = new Uint8Array(this.headLen + tailRemainder.length);
      merged.set(this.head.subarray(0, this.headLen), 0);
      merged.set(tailRemainder, this.headLen);
      return { text: decoder.decode(merged), truncated: false, bytes: this.total };
    }
    return {
      text: `${decoder.decode(this.head.subarray(0, this.headLen))}\n...[略過中段 ${gap} 位元組]...\n${decodeTail(tail, decoder)}`,
      truncated: true,
      bytes: this.total,
    };
  }
}

/** 解碼尾端位元組前，先跳過開頭可能被切一半的 UTF-8 continuation byte。 */
function decodeTail(bytes: Uint8Array, decoder: TextDecoder): string {
  let start = 0;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return decoder.decode(bytes.subarray(start));
}

function drainStream(stream: NodeJS.ReadableStream | null, sink: BoundedCapture): Promise<void> {
  if (!stream) return Promise.resolve();
  return new Promise((resolve) => {
    // Buffer 的底層 ArrayBuffer 可能被 pool 重用，必須複製一份再交給 sink。
    stream.on("data", (chunk: Buffer) => sink.push(new Uint8Array(chunk)));
    stream.on("end", () => resolve());
    stream.on("close", () => resolve());
    stream.on("error", () => resolve());
  });
}

// 從尾端文字裡撈常見的測試結論行（best-effort，不做 per-runner parser）。
const SUMMARY_LINE_PATTERN =
  /\b\d+\s+(pass(?:ed|ing)?|fail(?:ed|ing|ures?)?|error(?:s|ed)?|skip(?:ped)?|todo)\b|^\s*(?:tests?|test\s+suites?|assertions?):|(?:^|\s)(?:PASS|FAIL|FAILED|ok|not ok)\b/i;

function extractSummaryLines(text: string): string[] {
  const lines = text.split("\n");
  const hits: string[] = [];
  for (let i = Math.max(0, lines.length - 40); i < lines.length; i += 1) {
    const line = lines[i]!.replace(/\[[0-9;]*m/g, "").trimEnd();
    if (line.trim().length > 0 && line.length <= 200 && SUMMARY_LINE_PATTERN.test(line)) hits.push(line.trim());
  }
  return hits.slice(-4);
}

function buildTrackingNotCapturedEvidence(status: string, requestedFiles?: string[]) {
  return {
    schema: "verification-evidence-v1",
    status,
    requestedFiles: requestedFiles ?? [],
    before: [],
    after: [],
    comparison: { unchanged: [], changed: [], unableToDetermine: requestedFiles ?? [] },
    stable: false,
    reusable: false,
    note: "沒有可信的檔案前後摘要，這次驗證結果不能直接重用。",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTrackedFileSnapshot(value: unknown): value is TrackedFileSnapshot {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.comparable !== "boolean") return false;
  const states: TrackedFileSnapshot["state"][] = ["file", "missing", "symlink", "unreadable", "outside", "sensitive", "directory"];
  if (!states.includes(value.state as TrackedFileSnapshot["state"])) return false;
  if (value.sizeBytes !== undefined && (typeof value.sizeBytes !== "number" || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0)) return false;
  if (value.sha256 !== undefined && (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sha256))) return false;
  return value.reason === undefined || typeof value.reason === "string";
}

function compareTrackedSnapshots(reference: TrackedFileSnapshot[], current: TrackedFileSnapshot[]) {
  const referenceByPath = new Map(reference.map((item) => [item.path, item]));
  const currentByPath = new Map(current.map((item) => [item.path, item]));
  const unchanged: string[] = [];
  const changed: string[] = [];
  const unableToDetermine: string[] = [];
  const paths = [...new Set([...referenceByPath.keys(), ...currentByPath.keys()])].sort();
  for (const path of paths) {
    const referenceFile = referenceByPath.get(path);
    const currentFile = currentByPath.get(path);
    if (
      referenceFile?.state === "file" && referenceFile.comparable
      && currentFile?.state === "file" && currentFile.comparable
      && referenceFile.sha256 === currentFile.sha256
    ) {
      unchanged.push(path);
    } else if (
      referenceFile?.state === "file" && referenceFile.comparable
      && currentFile?.state === "file" && currentFile.comparable
      && referenceFile.sha256 !== currentFile.sha256
    ) {
      changed.push(path);
    } else {
      unableToDetermine.push(path);
    }
  }
  return { unchanged, changed, unableToDetermine };
}

function buildVerificationEvidence(
  requestedFiles: string[] | undefined,
  before: TrackedFileSnapshot[] | undefined,
  after: TrackedFileSnapshot[] | undefined,
  run: { ok: boolean; outputTruncated: boolean },
) {
  if (requestedFiles === undefined) return buildTrackingNotCapturedEvidence("tracking_not_provided");
  if (!before || !after) return buildTrackingNotCapturedEvidence("insufficient_evidence", requestedFiles);

  const { unchanged, changed, unableToDetermine } = compareTrackedSnapshots(before, after);
  const stable = changed.length === 0 && unableToDetermine.length === 0;
  const status = unableToDetermine.length > 0
    ? "insufficient_evidence"
    : changed.length > 0
      ? "changed_requires_reverification"
      : !run.ok
        ? "verification_failed"
        : run.outputTruncated
          ? "output_incomplete"
          : "stable";
  const reusable = stable && run.ok && !run.outputTruncated;
  return {
    schema: "verification-evidence-v1",
    status,
    requestedFiles,
    before,
    after,
    comparison: { unchanged, changed, unableToDetermine },
    stable,
    reusable,
    note: "指定檔案內容未變只表示這些檔案的摘要仍適用，不等於整個系統正確，也不自動滿足驗收。",
  };
}

function validateRecheckEvidence(value: unknown): value is {
  schema: "verification-evidence-v1";
  requestedFiles: string[];
  before: TrackedFileSnapshot[];
  after: TrackedFileSnapshot[];
  stable: boolean;
  reusable: boolean;
  status: string;
} {
  if (!isRecord(value) || value.schema !== "verification-evidence-v1") return false;
  if (
    !Array.isArray(value.requestedFiles)
    || value.requestedFiles.length === 0
    || value.requestedFiles.length > 128
    || !value.requestedFiles.every((path) => typeof path === "string" && path.trim().length > 0)
    || new Set(value.requestedFiles).size !== value.requestedFiles.length
    || !Array.isArray(value.before)
    || !Array.isArray(value.after)
    || !value.before.every(isTrackedFileSnapshot)
    || !value.after.every(isTrackedFileSnapshot)
    || typeof value.stable !== "boolean"
    || typeof value.reusable !== "boolean"
    || typeof value.status !== "string"
  ) return false;
  return true;
}

function buildRecheckedEvidence(
  evidence: {
    schema: "verification-evidence-v1";
    requestedFiles: string[];
    before: TrackedFileSnapshot[];
    after: TrackedFileSnapshot[];
    stable: boolean;
    reusable: boolean;
    status: string;
  },
  current: TrackedFileSnapshot[],
) {
  const comparison = compareTrackedSnapshots(evidence.after, current);
  const unchanged = comparison.changed.length === 0 && comparison.unableToDetermine.length === 0;
  const reusable = evidence.reusable && evidence.stable && evidence.status === "stable" && unchanged;
  const status = comparison.unableToDetermine.length > 0
    ? "insufficient_evidence"
    : comparison.changed.length > 0
      ? "stale_requires_reverification"
      : reusable
        ? "stable"
        : "not_reusable";
  return {
    schema: "verification-evidence-v1",
    status,
    requestedFiles: evidence.requestedFiles,
    before: evidence.before,
    after: current,
    comparison,
    stable: unchanged,
    reusable,
    recheckedAt: new Date().toISOString(),
    note: "重新核對只確認指定檔案相對於上次驗證結果是否仍未變更；若已變更，必須重新執行驗證。",
  };
}

/** 以本次呼叫的工作階段位置為 worktree；unsafe 或無法解析時 fail closed。 */
async function resolveVerificationWorktree(moduleCtx: Plugin.Context, toolCtx: ToolExecutionContext):
  Promise<{ ok: true; worktree: string } | { ok: false; error: string; worktree?: string }> {
  const lexicalWorktree = await resolveSessionDirectory(moduleCtx, toolCtx);
  let worktree: string;
  try {
    worktree = realpathSync(lexicalWorktree);
  } catch (error) {
    return {
      ok: false,
      error: `無法解析 project root：${lexicalWorktree}（${error instanceof Error ? error.message : String(error)}）`,
      worktree: lexicalWorktree,
    };
  }
  if (isUnsafeRoot(worktree)) {
    return {
      ok: false,
      error: `unsafe project root，禁止在 ${worktree} 啟動驗證工具。請將 runtime 綁定至一般專案目錄。`,
      worktree,
    };
  }
  return { ok: true, worktree };
}

export interface VerificationRunInput {
  runner?: string;
  action?: string;
  script?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  trackedFiles?: unknown;
  evidence?: unknown;
}

// 參數 schema 保持寬鬆，沿用舊版做法由執行邏輯逐項驗證並回傳精準錯誤碼
// （例如不支援的 runner、非法的 script 不能在解析層就變成籠統的輸入錯誤）。
const verificationRunInputSchema: z.ZodType<VerificationRunInput> = z.object({
  runner: z.string().optional(),
  action: z.string().optional(),
  script: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
  trackedFiles: z.unknown().optional(),
  evidence: z.unknown().optional(),
});

export function createVerificationRunTool(
  moduleCtx: Plugin.Context,
  allowedAgents: readonly string[] = VERIFICATION_RUN_ALLOWED_AGENTS,
): DefinedTool {
  return defineTool({
    name: "verification_run",
    description:
      [
        "在專案內執行受限制的驗證，不開放任意 shell 指令。",
        "套件管理器 runner（bun／npm／pnpm／yarn）：要指定 test／lint／typecheck／check／verify 這幾個 script family 之一（可加 :suffix，例如 script:\"test\"、\"test:p0\"、\"check\"），或 format:check／format:verify。",
        "直接測試 runner（pytest／python／python3／go／cargo／swift／node／deno／dotnet／maven／flutter／mix／phpunit／gradle）：script 可以省略（等同 script:\"test\"）。",
        "測試目標和旗標一律放進 args，例如 runner:\"pytest\", args:[\"-q\",\"tests/test_recovery_verification.py\"]。不可將完整命令塞入 script。",
        "可用 trackedFiles 指定要核對的本地程式／測試／設定檔；回傳前後 sha256 摘要與 evidence.reusable。",
        "action:\"recheck\" 可帶回既有 evidence，在不重跑驗證的情況下核對指定檔案是否已改變。",
        "回傳退出碼、是否逾時、截斷後的輸出；證據摘要不代表整個系統正確。",
      ].join("\n"),
    inputSchema: verificationRunInputSchema,
    execute: async (input: VerificationRunInput, toolCtx: ToolExecutionContext) => {
      if (!isVerificationRunAllowedAgent(toolCtx.agent, allowedAgents)) {
        return jsonResult({
          ok: false,
          code: "AGENT_NOT_ALLOWED",
          error: `verification_run 僅限 ${allowedAgents.join("／")} 使用。`,
          policy: "restricted-verification-v1",
        });
      }

      const action = input.action ?? "run";
      if (action !== "run" && action !== "recheck") {
        return jsonResult({
          ok: false,
          code: "INVALID_ACTION",
          error: "action 只能是 run 或 recheck。",
          policy: "restricted-verification-v1",
        });
      }

      if (action === "recheck") {
        if (!validateRecheckEvidence(input.evidence)) {
          return jsonResult({
            ok: false,
            code: "INVALID_EVIDENCE",
            error: "evidence 必須是完整的 verification-evidence-v1，且要包含 requestedFiles、before、after 與 reusable 狀態。",
            policy: "restricted-verification-v1",
          });
        }
        const worktreeResult = await resolveVerificationWorktree(moduleCtx, toolCtx);
        if (!worktreeResult.ok) {
          return jsonResult({
            ok: false,
            code: "INVALID_CWD",
            error: worktreeResult.error,
            ...(worktreeResult.worktree ? { worktree: worktreeResult.worktree } : {}),
            policy: "restricted-verification-v1",
          });
        }
        const current = captureTrackedFileSnapshots(worktreeResult.worktree, input.evidence.requestedFiles);
        const evidence = buildRecheckedEvidence(input.evidence, current);
        return jsonResult({
          ok: true,
          code: "EVIDENCE_RECHECKED",
          evidence,
          policy: "restricted-verification-v1",
        }, "已重新核對驗證證據；若 evidence.reusable 為 false，請重新執行驗證。");
      }

      const extraArgs = input.args ?? [];
      const trackedFiles = input.trackedFiles as string[] | undefined;
      if (trackedFiles !== undefined && (
        !Array.isArray(trackedFiles)
        || trackedFiles.length === 0
        || trackedFiles.length > 128
        || trackedFiles.some((path) => typeof path !== "string" || !path.trim() || path.length > 1024)
        || new Set(trackedFiles).size !== trackedFiles.length
      )) {
        return jsonResult({
          ok: false,
          code: "INVALID_TRACKED_FILES",
          error: "trackedFiles 必須包含 1 到 128 個不重複的精確本地檔案路徑；不接受空字串、glob 或超長路徑。",
          policy: "restricted-verification-v1",
          evidence: buildTrackingNotCapturedEvidence("insufficient_evidence", Array.isArray(trackedFiles) ? trackedFiles : []),
        });
      }
      if (
        extraArgs.length > MAX_ARG_COUNT ||
        extraArgs.some((arg) => arg.length > MAX_ARG_LENGTH || arg.includes("\u0000"))
      ) {
        return jsonResult({
          ok: false,
          code: "INVALID_ARGS",
          error: `args 最多只能有 ${MAX_ARG_COUNT} 個參數，每個不得超過 ${MAX_ARG_LENGTH} 個字元，也不能包含 NUL。`,
          policy: "restricted-verification-v1",
        });
      }

      const rawRunner = typeof input.runner === "string" ? input.runner.trim() : "";
      if (!SUPPORTED_RUNNER_SET.has(rawRunner)) {
        return jsonResult({
          ok: false,
          code: "RUNNER_NOT_SUPPORTED",
          error: `不支援的驗證 runner：${rawRunner || "（空白）"}`,
          supportedRunners: SUPPORTED_RUNNERS,
          policy: "restricted-verification-v1",
        });
      }

      const runner = rawRunner as Runner;
      const rawScript = typeof input.script === "string" ? input.script.trim() : "";
      const script = normalizeScript(runner, rawScript);
      if (script === null) {
        const isPackageRunner = PACKAGE_RUNNERS.has(runner);
        return jsonResult({
          ok: false,
          code: "SCRIPT_NOT_ALLOWED",
          error: isPackageRunner
            ? `不允許的 script："${rawScript || "（空白）"}"。套件管理器（bun／npm／pnpm／yarn）僅允許 test／lint／typecheck／check／verify family（可帶 :suffix），或 format:check／format:verify，例如 script: "test"、"test:p0"、"check"，旗標與目標請放入 args；請勿將完整 shell 命令塞入 script。`
            : `不允許的 script："${rawScript}"。直接 runner（pytest／python／python3／go／cargo／swift／node／deno／dotnet／maven／flutter／mix／phpunit／gradle）的 script 必須是 "test" 或直接省略，測試目標與旗標請放入 args，例如 { runner: "pytest", args: ["-q", "tests/test_recovery_verification.py"] }；請勿將完整命令塞入 script。`,
          policy: "restricted-verification-v1",
        });
      }

      if (runner === "gradle") {
        const gradleArgsError = validateGradleArgs(extraArgs);
        if (gradleArgsError) {
          return jsonResult({
            ok: false,
            code: "GRADLE_ARGS_NOT_ALLOWED",
            error: gradleArgsError,
            allowedArgs: ["--rerun-tasks", "--tests <pattern>"],
            policy: "restricted-verification-v1",
          });
        }
      } else {
        const rejectedFlag = validateExtraArgs(runner, extraArgs);
        if (rejectedFlag) {
          const allowed = [...(EXTRA_ARG_FLAG_ALLOWLIST[runner] ?? [])];
          return jsonResult({
            ok: false,
            code: "ARGS_NOT_ALLOWED",
            error: `不允許的參數：${rejectedFlag}（runner: ${runner}）。這個 runner 只允許這些旗標：${allowed.join("、")}；測試檔或測試名稱請用位置參數（不以 - 開頭），例如 { runner: "${runner}", ${EXTRA_ARG_EXAMPLES[runner] ?? 'args: ["tests/unit"]'} }。會執行外部程式、載入外掛／模組或寫檔的旗標一律拒絕。`,
            rejectedArg: rejectedFlag,
            allowedArgs: allowed,
            policy: "restricted-verification-v1",
          });
        }
      }

      const worktreeResult = await resolveVerificationWorktree(moduleCtx, toolCtx);
      if (!worktreeResult.ok) {
        return jsonResult({
          ok: false,
          code: "INVALID_CWD",
          error: worktreeResult.error,
          ...(worktreeResult.worktree ? { worktree: worktreeResult.worktree } : {}),
          policy: "restricted-verification-v1",
        });
      }
      const worktree = worktreeResult.worktree;
      let cwd: string;
      try {
        cwd = resolveCanonicalCwd(input.cwd?.trim() || ".", worktree);
      } catch (error) {
        return jsonResult({
          ok: false,
          code: "INVALID_CWD",
          error: error instanceof Error ? error.message : String(error),
          policy: "restricted-verification-v1",
        });
      }

      const outsidePath = findArgPathOutsideWorktree(extraArgs, cwd, worktree);
      if (outsidePath) {
        return jsonResult({
          ok: false,
          code: "ARG_PATH_OUTSIDE_WORKTREE",
          error: `參數指向 worktree 外的既有路徑：${outsidePath}。驗證只能在目前 worktree 內進行，把目標改成 worktree 內、相對於 cwd 的路徑。`,
          cwd,
          worktree,
          policy: "restricted-verification-v1",
        });
      }

      let resolvedExecutable: string;
      if (runner === "gradle") {
        const wrapper = inspectGradleWrapper(cwd);
        if (!wrapper.ok) {
          return jsonResult({
            ok: false,
            code: wrapper.code,
            error: wrapper.error,
            cwd,
            policy: "restricted-verification-v1",
          });
        }
        resolvedExecutable = wrapper.path;
      } else {
        const executable = executableForRunner(runner);
        const executablePath = findExecutableOnPath(executable);
        if (!executablePath) {
          return jsonResult({
            ok: false,
            code: "RUNNER_NOT_FOUND",
            error: `找不到驗證工具 ${executable}，請確認已安裝且位於 PATH。`,
            runner,
            executable,
            cwd,
            policy: "restricted-verification-v1",
          });
        }
        resolvedExecutable = executablePath;
      }

      const command = buildCommand(runner, script, extraArgs, resolvedExecutable);

      const trackedBefore = trackedFiles === undefined ? undefined : captureTrackedFileSnapshots(worktree, trackedFiles);

      const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(50, input.timeoutMs ?? DEFAULT_TIMEOUT_MS));
      const startedAt = Date.now();

      const cancelledResult = (note: string) => {
        const trackedAfter = trackedFiles === undefined ? undefined : captureTrackedFileSnapshots(worktree, trackedFiles);
        return jsonResult({
          ok: false,
          code: "CANCELLED",
          error: note,
          cancelled: true,
          runner,
          script,
          command,
          cwd,
          timeoutMs,
          durationMs: Date.now() - startedAt,
          evidence: buildVerificationEvidence(trackedFiles, trackedBefore, trackedAfter, { ok: false, outputTruncated: false }),
          policy: "restricted-verification-v1",
        });
      };

      // 呼叫前就已中止：不要啟動子程序。
      if (toolCtx.signal?.aborted) {
        return cancelledResult("驗證在啟動前被取消，沒有啟動子程序。");
      }

      let subprocess: ReturnType<typeof spawnRestricted>;
      try {
        subprocess = spawnRestricted(command, cwd, runner);
      } catch (error) {
        const trackedAfter = trackedFiles === undefined ? undefined : captureTrackedFileSnapshots(worktree, trackedFiles);
        return jsonResult({
          ok: false,
          code: "SPAWN_FAILED",
          error: `啟動驗證工具失敗：${error instanceof Error ? error.message : String(error)}`,
          command,
          cwd,
          evidence: buildVerificationEvidence(trackedFiles, trackedBefore, trackedAfter, { ok: false, outputTruncated: false }),
          policy: "restricted-verification-v1",
        });
      }

      const stdoutCapture = new BoundedCapture(OUTPUT_HEAD_BYTES, OUTPUT_TAIL_BYTES);
      const stderrCapture = new BoundedCapture(OUTPUT_HEAD_BYTES, OUTPUT_TAIL_BYTES);
      const drained = Promise.all([
        drainStream(subprocess.stdout, stdoutCapture),
        drainStream(subprocess.stderr, stderrCapture),
      ]);

      const childPid = subprocess.pid;
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let spawnError: Error | undefined;
      let forceExit: (() => void) | undefined;
      const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        forceExit = () => resolve({ code: null, signal: null });
        subprocess.once("exit", (code, signal) => resolve({ code, signal }));
        subprocess.once("error", (err) => {
          spawnError = err instanceof Error ? err : new Error(String(err));
          resolve({ code: null, signal: null });
        });
      });

      // 逾時與取消都打整個 process group：先 SIGTERM，寬限期後 SIGKILL，
      // 再一個寬限期還沒結束就不再等，直接回傳（不留孤兒，也不卡住呼叫端）。
      // 升級計時器一律 unref：提前回傳也不會被取消，SIGKILL 照樣送達；
      // 只是不再用它們hold 住事件迴圈。
      const killTimers: ReturnType<typeof setTimeout>[] = [];
      const clearKillTimers = () => {
        for (const killTimer of killTimers.splice(0)) clearTimeout(killTimer);
      };
      const trackKillTimer = (killTimer: ReturnType<typeof setTimeout>) => {
        if (typeof killTimer.unref === "function") killTimer.unref();
        killTimers.push(killTimer);
        return killTimer;
      };
      const killProcessTree = (pid: number | undefined) => {
        if (pid === undefined) return;
        killProcessGroup(pid, "SIGTERM");
        trackKillTimer(setTimeout(() => {
          killProcessGroup(pid, "SIGKILL");
          trackKillTimer(setTimeout(() => forceExit?.(), KILL_GRACE_MS));
        }, KILL_GRACE_MS));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(childPid);
      }, timeoutMs);

      const abortSignal = toolCtx.signal;
      const handleAbort = () => {
        if (settled || timedOut) return;
        cancelled = true;
        clearTimeout(timer);
        killProcessTree(childPid);
      };
      if (abortSignal) {
        if (abortSignal.aborted) handleAbort();
        else abortSignal.addEventListener("abort", handleAbort, { once: true });
      }

      const exit = await exitPromise;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", handleAbort);
      if (timedOut || cancelled) {
        // leader 退出不代表整組全死：確認群組終止才清升級計時器，否則留著
        // unref 計時器讓 SIGKILL 照樣送達。等待有上界，呼叫端不會被卡住。
        if (await waitForProcessGroupExit(childPid, GROUP_EXIT_WAIT_MS)) clearKillTimers();
      }
      // 程序已結束，pipe 應隨即關閉；防禦性上限避免 stream 卡住時掛死。
      await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, 2000))]);

      if (spawnError && !timedOut && !cancelled) {
        return jsonResult({
          ok: false,
          code: "SPAWN_FAILED",
          error: `啟動驗證工具失敗：${spawnError.message}`,
          command,
          cwd,
          policy: "restricted-verification-v1",
        });
      }

      const stdout = stdoutCapture.finalize();
      const stderr = stderrCapture.finalize();

      if (cancelled) {
        const trackedAfter = trackedFiles === undefined ? undefined : captureTrackedFileSnapshots(worktree, trackedFiles);
        const exitSignal = exit.signal ?? null;
        const summaryLines = extractSummaryLines(`${stdout.text}\n${stderr.text}`);
        const evidence = buildVerificationEvidence(
          trackedFiles,
          trackedBefore,
          trackedAfter,
          { ok: false, outputTruncated: stdout.truncated || stderr.truncated },
        );
        return jsonResult({
          ok: false,
          code: "CANCELLED",
          error: "驗證在完成前被取消，已對子程序群組送出 SIGTERM（寬限期後 SIGKILL）；沒有等到逾時。",
          cancelled: true,
          runner,
          script,
          command,
          cwd,
          exitCode: null,
          exitSignal,
          timedOut: false,
          timeoutMs,
          durationMs: Date.now() - startedAt,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutBytes: stdout.bytes,
          stderrBytes: stderr.bytes,
          outputTruncated: stdout.truncated || stderr.truncated,
          summaryLines,
          evidence,
          environmentPolicy: "已移除常見憑證環境變數；CI=1；NO_COLOR=1",
          policy: "restricted-verification-v1",
        }, null, 2);
      }

      const exitCode = timedOut ? null : exit.code;
      const exitSignal = exit.signal ?? null;
      const summaryLines = extractSummaryLines(`${stdout.text}\n${stderr.text}`);
      const trackedAfter = trackedFiles === undefined ? undefined : captureTrackedFileSnapshots(worktree, trackedFiles);
      const evidence = buildVerificationEvidence(
        trackedFiles,
        trackedBefore,
        trackedAfter,
        { ok: !timedOut && exitCode === 0, outputTruncated: stdout.truncated || stderr.truncated },
      );

      return jsonResult({
        ok: !timedOut && exitCode === 0,
        code: timedOut ? "TIMEOUT" : (exitCode === 0 ? "VERIFIED" : "VERIFICATION_FAILED"),
        runner,
        script,
        command,
        cwd,
        exitCode,
        exitSignal,
        timedOut,
        timeoutMs,
        durationMs: Date.now() - startedAt,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        outputTruncated: stdout.truncated || stderr.truncated,
        summaryLines,
        evidence,
        environmentPolicy: "已移除常見憑證環境變數；CI=1；NO_COLOR=1",
        policy: "restricted-verification-v1",
      }, null, 2);
    },
  });
}
