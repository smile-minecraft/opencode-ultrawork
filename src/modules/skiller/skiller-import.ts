/**
 * opencode-ultrawork — skiller-import tool factory
 *
 * 角色：
 *   - 把外部 repo 的 skill 匯入 managed draft root，之後走既有
 *     validate → 使用者確認 → promote 流程。
 *   - preview（預設）：以唯讀的 `skills add <source> --list -y` 探索來源
 *     repo 的可安裝 skill 清單，不寫任何檔。
 *   - apply（需 `mode="apply"` + `confirm=true`）：在工具自建的暫存 workdir
 *     執行 `skills add <source> --skill <name> --copy -y`（--copy、非互動旗標），
 *     驗證產出 bundle 的 frontmatter（name/description 必填、name 與目錄一致、
 *     通過 validateSkillName managed 規範），整包搬進 managed draft root，
 *     回傳檔案清單與每檔 SHA-256。
 *   - 任何失敗 fail closed 且清理暫存；draft root 不留半套草稿。
 *
 * 安全設計（不可放寬）：
 *   - tool args 不接受任何 path/root/destination；暫存 workdir 由工具自建
 *     （os.tmpdir() 下的唯一目錄）並在成功或失敗後一律清理。
 *   - CLI 以參數陣列執行（無 shell string）；source 需驗證格式
 *    （owner/repo 或 https URL，拒絕其他）。
 *   - Skiller 角色維持 bash: deny——CLI 由 plugin 端代跑；測試以注入的
 *     `runSkillCli` runner 隔離，不打網路。
 *   - 目標 draft 已存在同名時拒絕（不覆寫）；寫入前檢查先於 CLI 執行，
 *     避免浪費一次網路安裝。
 *
 * 已知限制（刻意）：
 *   - `--list` 不支援 `--json`（CLI 限制），preview 以 best-effort 解析
 *     人類可讀輸出的 skill 名稱，同時回傳截斷後的原始輸出供核對。
 *   - 安裝布局以實測為準：中央複本位於 `<workdir>/skills/<name>/`，
 *     另有 per-agent 複本；bundle 定位先看中央複本，找不到才遞迴搜尋
 *     第一個名為 `<name>/` 且含 SKILL.md 的目錄（淺層優先）。
 *   - 風險掃描（secret/high-risk/scripts）不在此做：匯入落在 draft root
 *     （工作區、非 discovery root），由後續 validate → promote 把關；
 *     與 skiller-draft 只做輕量驗證的定位一致。
 *
 * 限制：
 *   - 不得 import `src/index.ts`。
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../kit/define-tool.ts";
import { ContentLockBusyError } from "../../kit/write-lock.ts";
import { jsonError, jsonResult } from "../../kit/json.ts";
import { atomicWriteFile } from "../../kit/atomic-write.ts";
import {
  containedPath,
  deriveProjectSlug,
  ensureScopedFixedRoot,
  listSkillFiles,
  parseFrontmatter,
  resolveScopeRoots,
  sha256Hex,
  validateBundleRelativePath,
  validateSkillName,
  withFreshSkillerLock,
  type SkillerDeps,
} from "./skiller-common.ts";

// ─── Runner 抽象 ─────────────────────────────────────────────

/** skills CLI 單次呼叫的結果（exit code + 截獲的輸出）。 */
export interface SkillCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** CLI runner：參數陣列（含可執行檔）+ cwd；測試注入 fake，不打網路。 */
export type SkillCliRunner = (command: string[], cwd: string) => Promise<SkillCliResult>;

/** 直接 factory 測試可注入 `runSkillCli`；production registry 不注入。 */
export interface SkillerImportDeps extends SkillerDeps {
  runSkillCli?: SkillCliRunner;
}

const CLI_TIMEOUT_MS = 180_000;
const CLI_MAX_BUFFER = 8 * 1024 * 1024;

class CliSpawnError extends Error {
  readonly kind: "CLI_SPAWN_FAILED" | "CLI_TIMEOUT";
  constructor(kind: "CLI_SPAWN_FAILED" | "CLI_TIMEOUT", message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * 包裝 runner 呼叫：runner 拋出的任何非 CliSpawnError（例如測試替身或
 * 未預期的傳輸錯誤）都正規化為 CLI_SPAWN_FAILED，外層只剩真正的
 * 程式錯誤才會落到 TOOL_ERROR。
 */
async function callCli(runner: SkillCliRunner, command: string[], cwd: string): Promise<SkillCliResult> {
  try {
    return await runner(command, cwd);
  } catch (error) {
    if (error instanceof CliSpawnError) throw error;
    throw new CliSpawnError("CLI_SPAWN_FAILED", `執行 skills CLI 失敗：${(error as Error).message}`);
  }
}
async function defaultSkillCliRunner(command: string[], cwd: string): Promise<SkillCliResult> {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(command[0]!, command.slice(1), {
      cwd,
      shell: false,
      timeout: CLI_TIMEOUT_MS,
      encoding: "utf-8",
      maxBuffer: CLI_MAX_BUFFER,
    });
  } catch (error) {
    throw new CliSpawnError("CLI_SPAWN_FAILED", `啟動 skills CLI 失敗：${(error as Error).message}`);
  }
  const spawnError = result.error as (NodeJS.ErrnoException | undefined);
  if (spawnError) {
    if (spawnError.code === "ETIMEDOUT") {
      throw new CliSpawnError("CLI_TIMEOUT", `skills CLI 執行逾時（${CLI_TIMEOUT_MS}ms）`);
    }
    throw new CliSpawnError("CLI_SPAWN_FAILED", `啟動 skills CLI 失敗：${spawnError.message}`);
  }
  return {
    exitCode: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

// ─── Source 驗證 ─────────────────────────────────────────────

const OWNER_REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;

function validateSource(raw: unknown): { ok: true; source: string } | { ok: false; message: string } {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, message: "source 為必填（owner/repo 或 https URL）" };
  }
  const source = raw.trim();
  if (OWNER_REPO_PATTERN.test(source)) return { ok: true, source };
  if (source.startsWith("https://")) {
    try {
      const url = new URL(source);
      if (url.protocol === "https:" && url.hostname.length > 0) return { ok: true, source };
    } catch {
      // 落到下方的統一拒絕。
    }
  }
  return { ok: false, message: `source 格式非法：${source}（只接受 owner/repo 或 https URL）` };
}

// ─── Preview 清單解析 ────────────────────────────────────────

const ANSI_PATTERN = /\[[0-9;?]*[A-Za-z]/g;
const LIST_NAME_PATTERN = /^ {4}([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/;

/**
 * best-effort 解析 `skills add --list` 的人類可讀輸出：
 * skill 名稱是縮排 4 空格的單 token 行（實測布局），description 為 6 空格。
 * 同時回傳 "Found N skills" 的數量供呼叫端核對；解析失敗時回傳空清單
 * （不 fail closed，raw 輸出仍可供人工核對）。
 */
export function parseSkillListOutput(stdout: string): { skills: string[]; expectedCount: number | null } {
  const clean = stdout.replace(ANSI_PATTERN, "").replace(/\r/g, "");
  const found = /Found\s+(\d+)\s+skills?/i.exec(clean);
  const skills: string[] = [];
  for (const line of clean.split("\n")) {
    const match = LIST_NAME_PATTERN.exec(line);
    if (match?.[1] !== undefined && !skills.includes(match[1])) skills.push(match[1]);
  }
  return { skills, expectedCount: found?.[1] !== undefined ? Number(found[1]) : null };
}

// ─── Bundle 定位 ─────────────────────────────────────────────

function isRegularFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

const BUNDLE_SEARCH_MAX_DEPTH = 6;
const BUNDLE_SEARCH_MAX_ENTRIES = 2000;

/**
 * 在暫存 workdir 內定位安裝產出的 bundle 根目錄：
 * 1) 中央複本 `<workdir>/skills/<name>/`（實測布局）優先；
 * 2) 遞迴 fallback：第一個名為 `<name>` 且含 SKILL.md 的目錄（淺層優先，
 *    不跟隨 symlink，條目上限內 fail closed 為找不到）。
 */
export function findInstalledBundle(tempRoot: string, skill: string): string | null {
  const central = join(tempRoot, "skills", skill);
  if (isRegularFile(join(central, "SKILL.md"))) return central;

  let best: { dir: string; depth: number } | null = null;
  let visited = 0;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: tempRoot, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > BUNDLE_SEARCH_MAX_DEPTH) continue;
    let entries: string[];
    try {
      entries = readdirSync(current.dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > BUNDLE_SEARCH_MAX_ENTRIES) return best?.dir ?? null;
      if (entry === "node_modules") continue;
      const full = join(current.dir, entry);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      if (entry === skill && isRegularFile(join(full, "SKILL.md"))) {
        if (best === null || current.depth + 1 < best.depth) {
          best = { dir: full, depth: current.depth + 1 };
        }
        continue;
      }
      queue.push({ dir: full, depth: current.depth + 1 });
    }
  }
  return best?.dir ?? null;
}

// ─── Tool factory ────────────────────────────────────────────

interface ImportArgs {
  source?: string;
  skill?: string;
  mode?: "preview" | "apply";
  confirm?: boolean;
}

export function createSkillerImportTool(deps: SkillerImportDeps) {
  const runCli: SkillCliRunner = deps.runSkillCli ?? defaultSkillCliRunner;
  return defineTool({
    name: "skiller-import",
    description:
      "把外部 repo 的 skill 匯入 managed draft root，之後走既有 validate → 使用者確認 → promote 流程：preview 只做唯讀探索（CLI --list），apply 需 confirm=true，在暫存 workdir 執行 npx skills add（--copy、非互動），驗證 bundle 後搬進 managed draft root。不接受任意路徑。",
    inputSchema: z.object({
      source: z.string().optional(),
      skill: z.string().optional(),
      mode: z.enum(["preview", "apply"]).optional(),
      confirm: z.boolean().optional(),
    }),
    async execute(args: ImportArgs, context: ToolExecutionContext) {
      let tempRoot: string | null = null;
      const removeTemp = (): void => {
        if (tempRoot === null) return;
        try {
          rmSync(tempRoot, { recursive: true, force: true });
        } catch {
          // 清理失敗不遮蔽主結果；暫存位於 os.tmpdir() 下的唯一目錄。
        } finally {
          tempRoot = null;
        }
      };
      try {
        const sourceCheck = validateSource(args.source);
        if (!sourceCheck.ok) {
          return jsonError("INVALID_SOURCE", sourceCheck.message, "請改用 owner/repo（例如 vercel-labs/agent-skills）或 https URL。");
        }
        const source = sourceCheck.source;

        const mode = args.mode ?? "preview";
        if (mode !== "preview" && mode !== "apply") {
          return jsonError("INVALID_MODE", "mode 只能是 preview 或 apply", "請將 mode 改為 preview 或 apply。");
        }

        // 暫存 workdir 由工具自建；preview 與 apply 共用同一生命週期，
        // 成功或失敗後一律清理。
        try {
          tempRoot = mkdtempSync(join(tmpdir(), "skiller-import-"));
        } catch {
          return jsonError("TEMP_UNAVAILABLE", "無法建立暫存 workdir", "請確認 os.tmpdir() 可寫入後再試一次。");
        }

        // ─── preview：唯讀探索 ───
        if (mode === "preview") {
          let listed: SkillCliResult;
          try {
            listed = await callCli(runCli, ["npx", "skills", "add", source, "--list", "-y"], tempRoot);
          } catch (error) {
            if (error instanceof CliSpawnError) {
              return jsonError(error.kind, error.message, "請確認 npx 與 skills CLI 可用、網路可達後再試一次。");
            }
            throw error;
          } finally {
            removeTemp();
          }
          if (listed.exitCode !== 0) {
            return jsonError(
              "CLI_LIST_FAILED",
              `探索 skill 清單失敗（exit ${listed.exitCode}）：${listed.stderr.slice(0, 500)}`,
              "請確認 source 存在且網路可達後再試一次。",
            );
          }
          const { skills, expectedCount } = parseSkillListOutput(listed.stdout);
          return jsonResult({
            ok: true,
            summary: `探索完成：${source} 提供 ${expectedCount ?? skills.length} 個 skill（preview，未寫入任何檔案）。`,
            nextAction: "請以 mode=apply、skill=<name>、confirm=true 匯入指定的 skill。",
            data: {
              mode: "preview",
              source,
              skills,
              expectedCount,
              raw: listed.stdout.replace(ANSI_PATTERN, "").slice(0, 4000),
            },
          });
        }

        // ─── apply：前置檢查（皆在 CLI 執行之前，避免浪費網路安裝）───
        if (typeof args.skill !== "string" || args.skill.trim().length === 0) {
          return jsonError("SKILL_REQUIRED", "apply 需要指定 skill 名稱", "請以 skill=<name> 指定要匯入的 skill（可用 preview 先探索）。");
        }
        const projectSlug = deriveProjectSlug(resolve(deps.resolveProjectRoot(context)));
        const skillCheck = validateSkillName(args.skill, "managed", projectSlug);
        if (!skillCheck.ok) {
          return jsonError(skillCheck.code, skillCheck.message, "managed scope 的 skill 名稱為無 prefix 的 kebab-case，且不得使用 personal-/project- prefix。");
        }
        const skill = skillCheck.name;

        if (args.confirm !== true) {
          return jsonResult({
            ok: false,
            code: "CONFIRM_REQUIRED",
            summary: "import apply 需要明確 confirm=true；未執行 CLI、未寫入任何檔案。",
            nextAction: "請先執行 preview 確認來源，再以 confirm=true 重送。",
            data: { mode: "apply", source, skill },
          });
        }

        // 先做不改檔的 preflight，避免目標已存在時浪費一次 CLI；鎖內仍會完整重驗。
        const preflightRoots = resolveScopeRoots("managed", deps, context);
        const preflightTarget = resolve(preflightRoots.draftRoot, skill);
        if (existsSync(preflightTarget)) {
          return jsonError("ALREADY_EXISTS", `draft 已存在：${skill}`, "import 不覆寫既有草稿；如需更新請用 skiller-draft（overwrite=true）或先刪除。");
        }

        // ─── apply：CLI 安裝到暫存 workdir；目標 root 的所有檢查與建立都在鎖內完成 ───
        let installed: SkillCliResult;
        try {
          installed = await callCli(runCli, ["npx", "skills", "add", source, "--skill", skill, "--copy", "-y"], tempRoot);
        } catch (error) {
          if (error instanceof CliSpawnError) {
            return jsonError(error.kind, error.message, "請確認 npx 與 skills CLI 可用、網路可達後再試一次。");
          }
          throw error;
        }
        if (installed.exitCode !== 0) {
          return jsonError(
            "CLI_INSTALL_FAILED",
            `安裝 skill 失敗（exit ${installed.exitCode}）：${installed.stderr.slice(0, 500)}；draft root 未寫入任何檔案。`,
            "請確認 source/skill 存在且網路可達後再試一次。",
          );
        }

        // ─── apply：bundle 驗證（fail closed，draft 尚未寫入）───
        const bundleRoot = findInstalledBundle(tempRoot, skill);
        if (bundleRoot === null) {
          return jsonError("BUNDLE_NOT_FOUND", `CLI 成功但在暫存 workdir 找不到 ${skill} 的 bundle；未寫入任何檔案。`, "請回報此狀況（可能是 CLI 布局變更），改用其他來源再試一次。");
        }
        // bundle 內讀取一律以 canonical 路徑為 containment 邊界
        //（macOS 的 os.tmpdir() 經 symlink，lexical 路徑會誤判 ROOT_ESCAPE）。
        let bundleReal: string;
        try {
          bundleReal = realpathSync(bundleRoot);
        } catch {
          return jsonError("BUNDLE_INVALID", "無法解析 bundle 路徑；未寫入任何檔案。", "請確認來源 skill bundle 可完整讀取。");
        }
        const bundleSkillMd = join(bundleReal, "SKILL.md");
        if (!isRegularFile(bundleSkillMd)) {
          return jsonError("BUNDLE_INVALID", `bundle 缺少可讀的 SKILL.md；未寫入任何檔案。`, "請確認來源 repo 的 skill 結構完整後再試一次。");
        }
        let bundleRaw: string;
        try {
          bundleRaw = readFileSync(bundleSkillMd, "utf-8");
        } catch {
          return jsonError("BUNDLE_INVALID", "無法讀取 bundle 的 SKILL.md；未寫入任何檔案。", "請確認來源 repo 的 skill 結構完整後再試一次。");
        }
        const fm = parseFrontmatter(bundleRaw);
        if (!fm.ok) {
          return jsonError(fm.code, `${fm.message}；未寫入任何檔案。`, "請確認來源 skill 的 SKILL.md frontmatter 合法後再試一次。");
        }
        const fmName = fm.data.name;
        if (typeof fmName !== "string" || fmName.trim().length === 0) {
          return jsonError("NAME_REQUIRED", "bundle 的 frontmatter 缺少 name；未寫入任何檔案。", "請確認來源 skill 的 SKILL.md 含非空 name。");
        }
        if (fmName.trim() !== skill) {
          return jsonError("NAME_MISMATCH", `bundle 的 frontmatter name（${fmName.trim()}）與安裝名稱（${skill}）不一致；未寫入任何檔案。`, "請確認來源 skill 的目錄名稱與 frontmatter name 一致。");
        }
        const description = fm.data.description;
        if (typeof description !== "string" || description.trim().length === 0) {
          return jsonError("DESCRIPTION_REQUIRED", "bundle 的 frontmatter 缺少非空 description；未寫入任何檔案。", "請確認來源 skill 的 SKILL.md 含非空 description。");
        }
        const bundleNameCheck = validateSkillName(fmName.trim(), "managed", projectSlug);
        if (!bundleNameCheck.ok) {
          return jsonError(bundleNameCheck.code, `${bundleNameCheck.message}；未寫入任何檔案。`, "managed scope 只接受無 prefix 的 kebab-case 名稱。");
        }

        const listed = listSkillFiles(bundleReal, deps);
        if (!listed.ok) {
          return jsonError(listed.issue.code, `${listed.issue.message}；未寫入任何檔案。`, "請確認來源 skill bundle 不含 symlink 且可完整讀取。");
        }

        // ─── apply：鎖內重新解析目標、重讀 bundle，再搬進 managed draft root ───
        // 取鎖經統一入口並重建快照：鎖內一律用 fresh.projectSlug，不沿用鎖外的。
        return await withFreshSkillerLock("managed", skill, deps, context, async (fresh) => {
          const lockedRoots = resolveScopeRoots("managed", deps, context);
          const lockedPreRootGuard = ensureScopedFixedRoot(lockedRoots.draftRoot, "managed", deps, context);
          if (!lockedPreRootGuard.ok) {
            return jsonError(lockedPreRootGuard.code, lockedPreRootGuard.message, "請確認固定 draft root 狀態後再試一次。");
          }
          try {
            mkdirSync(lockedRoots.draftRoot, { recursive: true });
          } catch {
            return jsonError("UNKNOWN_ROOT", "無法建立固定 draft root", "請確認固定 root 位置可寫入後再試一次。");
          }
          const lockedRootGuard = ensureScopedFixedRoot(lockedRoots.draftRoot, "managed", deps, context);
          if (!lockedRootGuard.ok) {
            return jsonError(lockedRootGuard.code, lockedRootGuard.message, "請確認固定 draft root 狀態後再試一次。");
          }
          const lockedTargetDirGuard = containedPath(lockedRootGuard.value, lockedRoots.draftRoot, skill);
          if (!lockedTargetDirGuard.ok) {
            return jsonError(lockedTargetDirGuard.code, lockedTargetDirGuard.message, "請改用不含 traversal / symlink 的 skill 名稱。");
          }
          if (existsSync(lockedTargetDirGuard.value)) {
            return jsonError("ALREADY_EXISTS", `draft 已存在：${skill}`, "import 不覆寫既有草稿；如需更新請用 skiller-draft（overwrite=true）或先刪除。");
          }

          // 鎖內重讀來源 bundle，避免等待鎖期間來源 bundle 或 digest 改變。
          const lockedSkillMdGuard = containedPath(bundleReal, bundleReal, "SKILL.md");
          if (!lockedSkillMdGuard.ok || !isRegularFile(lockedSkillMdGuard.value)) {
            return jsonError("BUNDLE_INVALID", "鎖內重驗時 bundle 缺少可讀的 SKILL.md；未寫入任何檔案。", "請確認來源 skill 的 SKILL.md 含非空 name 與 description。");
          }
          let lockedBundleRaw: string;
          try {
            lockedBundleRaw = readFileSync(lockedSkillMdGuard.value, "utf-8");
          } catch {
            return jsonError("BUNDLE_INVALID", "鎖內重驗時無法讀取 bundle 的 SKILL.md；未寫入任何檔案。", "請確認來源 skill 的 SKILL.md 可讀取後再試一次。");
          }
          const lockedFm = parseFrontmatter(lockedBundleRaw);
          if (!lockedFm.ok || typeof lockedFm.data.name !== "string" || typeof lockedFm.data.description !== "string" || lockedFm.data.name.trim() !== skill || lockedFm.data.description.trim().length === 0) {
            return jsonError("BUNDLE_INVALID", "鎖內重驗時 bundle frontmatter 不符合匯入要求；未寫入任何檔案。", "請確認來源 skill 的 frontmatter name 與 description 合法。");
          }
          const lockedNameCheck = validateSkillName(lockedFm.data.name.trim(), "managed", fresh.projectSlug);
          if (!lockedNameCheck.ok) {
            return jsonError(lockedNameCheck.code, `${lockedNameCheck.message}；未寫入任何檔案。`, "managed scope 只接受無 prefix 的 kebab-case 名稱。");
          }
          const lockedListing = listSkillFiles(bundleReal, deps);
          if (!lockedListing.ok) {
            return jsonError(lockedListing.issue.code, `${lockedListing.issue.message}；未寫入任何檔案。`, "請確認來源 skill bundle 不含 symlink 且可完整讀取。");
          }

          const targetDir = lockedTargetDirGuard.value;
          const written: Array<{ relativePath: string; path: string; bytes: number; digest: string }> = [];
          try {
            for (const rel of lockedListing.files) {
              const relCheck = validateBundleRelativePath(rel);
              if (!relCheck.ok) throw new Error(`${relCheck.code}: ${relCheck.message}`);
              const sourceGuard = containedPath(bundleReal, bundleReal, rel);
              if (!sourceGuard.ok) throw new Error(`${sourceGuard.code}: ${sourceGuard.message}`);
              let content: string;
              try {
                content = readFileSync(sourceGuard.value, "utf-8");
              } catch {
                throw new Error(`BUNDLE_READ_FAILED: 無法讀取 bundle 檔案（${rel}）`);
              }
              const destGuard = containedPath(lockedRootGuard.value, lockedRoots.draftRoot, skill, ...rel.split("/"));
              if (!destGuard.ok) throw new Error(`${destGuard.code}: ${destGuard.message}`);
              mkdirSync(dirname(destGuard.value), { recursive: true });
              atomicWriteFile(destGuard.value, content);
              written.push({ relativePath: rel, path: destGuard.value, bytes: Buffer.byteLength(content, "utf-8"), digest: sha256Hex(content) });
            }
          } catch (error) {
            try {
              rmSync(targetDir, { recursive: true, force: true });
            } catch {
              // 清理失敗不遮蔽主錯誤；半套草稿位於固定 draft root，可人工刪除。
            }
            return jsonError("WRITE_FAILED", `寫入 draft 失敗，已清理半套草稿：${(error as Error).message}`, "請確認 draft root 可寫入後再試一次。");
          }

          return jsonResult({
            ok: true,
            summary: `匯入完成：${skill} → managed draft root（${written.length} 個檔案）。`,
            nextAction: "請以 skiller-validate 驗證，再經使用者確認後以 skiller-promote 晉升。",
            data: { mode: "apply", source, name: skill, path: join(targetDir, "SKILL.md"), digest: sha256Hex(lockedBundleRaw), files: written },
          });
        });
      } catch (error) {
        if (error instanceof ContentLockBusyError) {
          return jsonError("CONTENT_LOCK_BUSY", error.message, "請等待其他 skiller 寫入完成後再重試。");
        }
        return jsonError("TOOL_ERROR", `import 失敗：${(error as Error).message}`);
      } finally {
        removeTemp();
      }
    },
  });
}
