/**
 * search 模組共用 helper：工作階段根目錄解析、路徑檢查、敏感路徑、二進位檢查。
 *
 * 路徑檢查的順序、錯誤碼、訊息與舊外掛 search-tool-utils 逐字一致；
 * 唯一的介面差異是呼叫端先把根目錄解析成字串再傳進來，
 * 本檔不再碰 ToolContext、process.cwd 或環境變數。
 */

import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { ToolExecutionContext } from "../../kit/define-tool.ts";
import { jsonError } from "../../kit/json.ts";
import {
  AssertPathOutsideWorktree,
  assertSafeWorktreePath,
  resolveInsideWorktree,
} from "../../kit/path-guard.ts";

export interface ReadableTarget {
  absolutePath: string;
  relativePath: string;
  worktreeRoot: string;
  isDirectory: boolean;
}

/** 工具執行時解析根目錄的方式：傳工具 context 進來，回傳已解析好的字串。 */
export type RootResolver = (toolCtx: ToolExecutionContext) => Promise<string>;

/**
 * 每次工具執行時解析工作階段位置：先問 session 的 location.directory，
 * 取不到才退回外掛位置（project 目錄優先）。
 */
export async function resolveWorktreeRoot(ctx: Plugin.Context, toolCtx: ToolExecutionContext): Promise<string> {
  try {
    const get = (ctx.session as unknown as { get: (args: { sessionID: string }) => Promise<unknown> }).get;
    const session = (await get({ sessionID: toolCtx.sessionID })) as
      | { location?: { directory?: unknown } }
      | undefined;
    const directory = session?.location?.directory;
    if (typeof directory === "string" && directory.length > 0) return directory;
  } catch {
    // 讀不到工作階段就退回外掛位置，不讓工具直接失敗。
  }
  return ctx.location.project?.directory ?? ctx.location.directory;
}

/**
 * 黑名單：根目錄或系統關鍵目錄不能當搜尋起點。
 *
 * 自舊 runtime/context.ts 逐字搬入，黑名單項目完全一致；
 * lexical 檢查之外，另對 realpath 後的真實路徑再套一次，
 * symlink alias（如指向 / 的連結）才不會溜過去。
 */
export function isUnsafeRoot(path: string): boolean {
  if (!path) return true;
  const resolved = resolve(path);
  // 嚴禁在根目錄或系統關鍵目錄建立 .opencode
  if (resolved === "/" || resolved === "" || resolved === "." || resolved === ".." || resolved === "/Users" || resolved === "/Volumes") {
    return true;
  }
  const real = resolveExistingRealpath(resolved);
  // 無法解析出任何存在祖先 → 無法確認 containment → fail closed。
  if (!real) return true;
  return real === "/" || real === "/Users" || real === "/Volumes";
}

/**
 * 回傳 target 的真實路徑；target 不存在時逐層向上找最近的存在祖先解析，
 * 讓「root 尚未建立但其父鏈含 symlink」的情況也能被 containment 檢查涵蓋。
 * 連檔案系統根都無法解析時回傳 undefined（呼叫端 fail closed）。
 */
function resolveExistingRealpath(target: string): string | undefined {
  let current = target;
  for (;;) {
    try {
      return realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

export function normalizeRelativePath(value: string): string {
  const normalized = value.split("\\").join("/");
  return normalized || ".";
}

export function isSensitivePath(relativePath: string): boolean {
  const parts = normalizeRelativePath(relativePath).split("/").filter(Boolean);
  return parts.some((part) => {
    const lower = part.toLowerCase();
    if (lower === ".env.example") return false;
    if (lower === ".env" || lower.startsWith(".env.")) return true;
    if (["id_rsa", "id_ed25519", "credentials.json", "service-account.json"].includes(lower)) return true;
    return /\.(?:pem|key|p12|pfx)$/i.test(lower);
  });
}

export function resolveReadableTarget(
  inputPath: string,
  rawRoot: string,
): { ok: true; target: ReadableTarget } | { ok: false; result: string } {
  // rawRoot 是呼叫端先解析好的工作階段位置；這裡只做 containment，
  // 不再 fallback 到其他位置，root 的來源單一才好追。
  const lexicalRoot = resolve(rawRoot);
  if (isUnsafeRoot(lexicalRoot)) {
    return { ok: false, result: jsonError("UNSAFE_ROOT", "Refusing to use unsafe project root as search root") };
  }

  // 先 canonical 化 root 並再次檢查 unsafe：lexical 黑名單只擋 resolve()
  // 結果，symlink alias（如 /tmp/link -> /）必須在 realpath 後再次檢查，
  // 否則 alias 下的 lexical path 會先以 FILE_NOT_FOUND 誤報。
  let worktreeRoot: string;
  try {
    worktreeRoot = realpathSync(lexicalRoot);
  } catch {
    // 不回傳 rawRoot：不存在或不可讀的 project root 絕對路徑不應洩漏給 caller。
    return { ok: false, result: jsonError("WORKTREE_NOT_FOUND", "Project root is unavailable") };
  }
  if (isUnsafeRoot(worktreeRoot)) {
    return { ok: false, result: jsonError("UNSAFE_ROOT", "Refusing to use unsafe project root as search root") };
  }

  let lexicalPath: string;
  try {
    lexicalPath = resolveInsideWorktree(inputPath, lexicalRoot);
  } catch {
    return { ok: false, result: jsonError("PATH_OUTSIDE_WORKTREE", "Target must stay inside the active worktree") };
  }
  if (!existsSync(lexicalPath)) {
    return { ok: false, result: jsonError("FILE_NOT_FOUND", `Target not found: ${inputPath}`) };
  }
  const relativePath = normalizeRelativePath(relative(lexicalRoot, lexicalPath));

  let absolutePath: string;
  try {
    absolutePath = realpathSync(lexicalPath);
    assertSafeWorktreePath(absolutePath, worktreeRoot);
  } catch (error) {
    if (error instanceof AssertPathOutsideWorktree) {
      return { ok: false, result: jsonError("PATH_OUTSIDE_WORKTREE", "Target resolves outside the active worktree") };
    }
    // realpath 的權限錯誤（例如 Bun 對 chmod 000 檔案 lstat 失敗）不是
    // traversal，必須回傳結構化 read error 而非誤報 PATH_OUTSIDE_WORKTREE。
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === "EACCES" || errno === "EPERM") {
      return { ok: false, result: jsonError("FILE_READ_ERROR", `Cannot read target: ${relativePath}`) };
    }
    return { ok: false, result: jsonError("PATH_OUTSIDE_WORKTREE", "Target resolves outside the active worktree") };
  }

  const canonicalRelativePath = normalizeRelativePath(relative(worktreeRoot, absolutePath));
  if (isSensitivePath(relativePath) || isSensitivePath(canonicalRelativePath)) {
    return { ok: false, result: jsonError("SENSITIVE_PATH", `Refusing to read sensitive path: ${relativePath}`) };
  }

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(absolutePath);
  } catch {
    return { ok: false, result: jsonError("FILE_READ_ERROR", `Cannot stat target: ${relativePath}`) };
  }
  return {
    ok: true,
    target: { absolutePath, relativePath, worktreeRoot, isDirectory: stats.isDirectory() },
  };
}

export function isBinaryFile(filePath: string): boolean {
  const descriptor = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] === 0) return true;
    }
    return false;
  } finally {
    closeSync(descriptor);
  }
}

export function validateBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): string | undefined {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    return `${name} must be an integer between ${minimum} and ${maximum}`;
  }
  return undefined;
}

