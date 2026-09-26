/**
 * 工作區路徑防護：解析後的目標必須留在專案目錄內。
 *
 * 相對路徑的 .. 逃逸、 worktree 之外的絕對路徑一律丟錯，
 * 不可降級為警告。純函式，不碰檔案系統。
 */

import { lstatSync, realpathSync, type Stats } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** assert 失敗時丟出的錯誤，帶 filePath／worktreeRoot 方便診斷。 */
export class AssertPathOutsideWorktree extends Error {
  public readonly filePath: string;
  public readonly worktreeRoot: string;

  constructor(filePath: string, worktreeRoot: string, message?: string) {
    // 預設訊息沿用舊版英文逐字：舊測試用 /Path traversal/ 與 /outside worktree/ 釘住它。
    super(message ?? `Path traversal attempt detected: ${filePath} is outside worktree ${worktreeRoot}`);
    this.name = "AssertPathOutsideWorktree";
    this.filePath = filePath;
    this.worktreeRoot = worktreeRoot;
  }
}

/** 判斷路徑是否在工作區內；參數不合法回傳 false，不丟錯。 */
export function isInsideWorktree(absolutePath: string, worktreeRoot: string): boolean {
  if (!absolutePath || typeof absolutePath !== "string") return false;
  if (!worktreeRoot || typeof worktreeRoot !== "string") return false;
  const resolvedTarget = resolve(absolutePath).split("\\").join("/");
  const resolvedRoot = resolve(worktreeRoot).split("\\").join("/");
  if (resolvedTarget === resolvedRoot) return true;
  return resolvedTarget.startsWith(`${resolvedRoot}/`);
}

/** 強制要求路徑在工作區內，否則丟 AssertPathOutsideWorktree。 */
export function assertSafeWorktreePath(absolutePath: string, worktreeRoot: string): void {
  if (!isInsideWorktree(absolutePath, worktreeRoot)) {
    throw new AssertPathOutsideWorktree(absolutePath, worktreeRoot);
  }
}

/** 以工作區為基準解析路徑，並檢查結果仍在工作區內。 */
export function resolveInsideWorktree(filePath: string, worktreeRoot: string): string {
  const resolved = resolve(worktreeRoot, filePath);
  assertSafeWorktreePath(resolved, worktreeRoot);
  return resolved;
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isOutside(anchorPath: string, targetPath: string): boolean {
  const rel = relative(anchorPath, targetPath);
  return rel === ".." || rel.startsWith(`..${sep}`);
}

/**
 * 由 path 逐層向上找最近存在的祖先，回傳它的 realpath（目標不存在時不含不存在的尾段）。
 *
 * `trustSymlink` 是呼叫端宣告的信任根（錨點）本身。錨點是 symlink 時同樣用 realpathSync
 * 跟隨，與 canonicalAnchor 的語意一致，讓「目標整段尚未建立」不會被誤判；信任根以外的
 * symlink、dangling symlink 或解析失敗都回 undefined，交由呼叫端 fail closed。
 */
function nearestExistingRealPath(path: string, trustSymlink?: string): string | undefined {
  const trusted = trustSymlink === undefined ? undefined : resolve(trustSymlink);
  let current = resolve(path);
  for (;;) {
    const stat = lstatIfPresent(current);
    if (stat) {
      if (stat.isSymbolicLink() && current !== trusted) return undefined;
      try {
        return realpathSync(current);
      } catch {
        return undefined;
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function guardMessage(label: string | undefined, message: string): string {
  return label ? `${label}: ${message}` : message;
}

export interface ContainedPathOptions {
  /** 錯誤訊息前綴；不提供時沿用共用英文訊息。 */
  label?: string;
  /** 額外要求目標的 lexical 路徑位於此目錄內。 */
  lexicalRoot?: string;
  /** 允許錨本身尚未存在；仍會從最近存在祖先推導 canonical 位置。 */
  allowMissingAnchor?: boolean;
  /** 若此路徑已存在，必須是目錄；不存在時維持建立情境可用。 */
  directoryPath?: string;
}

/**
 * 單次完成 lexical containment、逐段 symlink 檢查與 canonical containment。
 * 回傳解析後的絕對路徑；尾端尚未存在時仍允許通過。
 *
 * 錨點是信任根：它本身即使是 symlink 也跟隨解析（與 canonicalAnchor 同語意），
 * 但錨與目標之間的每一段、目標自身、dangling symlink 與 canonical 逃出錨都 fail closed。
 */
export function assertContainedPath(
  anchorRoot: string,
  targetPath: string,
  options: ContainedPathOptions = {},
): string {
  const anchor = resolve(anchorRoot);
  const target = resolve(targetPath);
  if (isOutside(anchor, target)) {
    throw new AssertPathOutsideWorktree(targetPath, anchorRoot);
  }

  if (options.lexicalRoot !== undefined) {
    const lexicalRoot = resolve(options.lexicalRoot);
    if (isOutside(lexicalRoot, target)) {
      throw new Error(guardMessage(options.label, `path escapes guarded root: ${target}`));
    }
  }

  const canonicalAnchor = options.allowMissingAnchor
    ? nearestExistingRealPath(anchor, anchor)
    : (() => {
        try {
          return realpathSync(anchor);
        } catch {
          return undefined;
        }
      })();
  if (canonicalAnchor === undefined) {
    throw new Error(guardMessage(options.label, `cannot resolve guarded root: ${anchorRoot}`));
  }

  let current = anchor;
  for (const segment of relative(anchor, target).split(sep)) {
    if (!segment) continue;
    current = join(current, segment);
    const stat = lstatIfPresent(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(guardMessage(options.label, `symlink path is not allowed: ${current}`));
    }
  }

  if (options.directoryPath !== undefined) {
    const directory = resolve(options.directoryPath);
    if (isOutside(anchor, directory)) {
      throw new Error(guardMessage(options.label, `path escapes guarded root: ${directory}`));
    }
    const stat = lstatIfPresent(directory);
    if (stat && !stat.isDirectory()) {
      throw new Error(guardMessage(options.label, `guarded root is not a directory: ${directory}`));
    }
  }

  const canonicalTarget = nearestExistingRealPath(target, anchor);
  if (canonicalTarget === undefined) {
    throw new Error(guardMessage(options.label, `cannot resolve path: ${targetPath}`));
  }
  if (isOutside(canonicalAnchor, canonicalTarget)) {
    throw new AssertPathOutsideWorktree(targetPath, anchorRoot, guardMessage(options.label, `canonical path escapes guarded root: ${targetPath}`));
  }
  return target;
}

