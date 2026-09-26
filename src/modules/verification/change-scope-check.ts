/**
 * 建立與比較一次性檔案範圍快照。
 *
 * 完整快照（每個檔案的路徑、大小與 sha256）存在工作階段位置下的
 * `.ultrawork/cache/change-scope/`，呼叫端只拿到 baselineId 與摘要。
 * 快照一旦要經過模型轉手，就會在建立時被輸出截斷、在比較時被逐字重打，
 * 兩者都讓比較失真，所以不回傳全文。不寫入 Git index 或任務紀錄；
 * Git 只作補充，檔案內容摘要才是比較依據。
 */

import type { Plugin } from "@opencode/plugin";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { defineTool, type DefinedTool, type ToolExecutionContext } from "../../kit/define-tool.ts";
import { jsonResult } from "../../kit/json.ts";
import { isInsideWorktree, resolveInsideWorktree } from "../../kit/path-guard.ts";
import { isChangeScopeCheckAllowedAgent, CHANGE_SCOPE_CHECK_ALLOWED_AGENTS } from "./scope-check-policy.ts";
import { isUnsafeRoot, resolveSessionDirectory } from "./session-root.ts";

export const CHANGE_SCOPE_BASELINE_SCHEMA = "change-scope-baseline-v1" as const;
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_DEPTH = 50;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const BASELINE_ID_PATTERN = /^csb_[0-9a-z]+_[0-9a-f]{8}$/;
const BASELINE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REPORTED_ISSUES = 20;

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".gradle",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "generated",
  "gen",
]);

const EXCLUDED_PATH_PREFIXES = [
  ".opencode/memory",
  ".opencode/plans",
  ".playwright-mcp",
  "skill-quarantine",
  "skill-drafts",
  // 快照改存專案 `.ultrawork/cache/change-scope/` 後，掃描必須排除外掛自己的
  // 資料目錄，否則每次建立的快照會污染下一次的 Git 完整掃描。
  ".ultrawork",
];

export type ScopePathKind = "file" | "directory";

export interface ScopePathSpec {
  path: string;
  kind: ScopePathKind;
}

type FileState = "file" | "missing" | "symlink" | "unreadable" | "too_large" | "special";

export interface ScopeFileSummary {
  path: string;
  state: FileState;
  comparable: boolean;
  baselineDirty: boolean;
  sizeBytes?: number;
  sha256?: string;
  reason?: string;
}

export interface ScopeIssue {
  code: string;
  path?: string;
  detail?: string;
}

export interface ScopeCoverage {
  requestedPaths: ScopePathSpec[];
  scope: "git-plus-requested" | "requested-paths-only";
  scopeDescription: string;
  scannedFileCount: number;
  skippedFileCount: number;
  excludedPaths: string[];
  issues: ScopeIssue[];
  complete: boolean;
  limits: {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxDepth: number;
  };
}

export interface ScopeGitSummary {
  available: boolean;
  statusAvailable: boolean;
  head: string | null;
  trackedFileCount: number;
  untrackedFileCount: number;
}

export interface ChangeScopeBaseline {
  schema: typeof CHANGE_SCOPE_BASELINE_SCHEMA;
  version: 1;
  projectPath: string;
  requestedPaths: ScopePathSpec[];
  includeGitFiles: boolean;
  createdAt: string;
  git: ScopeGitSummary;
  coverage: ScopeCoverage;
  files: ScopeFileSummary[];
}

interface GitSnapshot {
  summary: ScopeGitSummary;
  trackedPaths: Set<string>;
  untrackedPaths: Set<string>;
  statusByPath: Map<string, string>;
}

interface ScanResult {
  files: ScopeFileSummary[];
  coverage: ScopeCoverage;
}

interface ResolvedRoot {
  ok: true;
  root: string;
}

interface FailedRoot {
  ok: false;
  code: string;
  error: string;
}

/** 相對路徑正規化（沿用舊版 search-tool-utils 語意）。 */
function normalizeRelativePath(value: string): string {
  const normalized = value.split("\\").join("/");
  return normalized || ".";
}

/** 敏感路徑判斷（沿用舊版 search-tool-utils 語意）。 */
function isSensitivePath(relativePath: string): boolean {
  const parts = normalizeRelativePath(relativePath).split("/").filter(Boolean);
  return parts.some((part) => {
    const lower = part.toLowerCase();
    if (lower === ".env.example") return false;
    if (lower === ".env" || lower.startsWith(".env.")) return true;
    if (["id_rsa", "id_ed25519", "credentials.json", "service-account.json"].includes(lower)) return true;
    return /\.(?:pem|key|p12|pfx)$/i.test(lower);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePath(root: string, raw: string): string | null {
  if (!raw || raw.includes("*") || raw.includes("?") || raw.includes("[")) return null;
  if (isAbsolute(raw)) return null;
  let absolute: string;
  try {
    absolute = resolveInsideWorktree(raw, root);
  } catch {
    return null;
  }
  const result = normalizeRelativePath(relative(root, absolute));
  if (result === "." || result.startsWith("../") || result.includes("/../")) return null;
  return result;
}

function excludedReason(relativePath: string): string | null {
  if (isSensitivePath(relativePath)) return "SENSITIVE_PATH";
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.some((part) => EXCLUDED_DIRECTORY_NAMES.has(part))) return "EXCLUDED_DEPENDENCY_OR_BUILD_PATH";
  if (EXCLUDED_PATH_PREFIXES.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`))) {
    return "EXCLUDED_RUNTIME_PATH";
  }
  return null;
}

function parsePathList(raw: unknown, field: string):
  | { ok: true; specs: ScopePathSpec[] }
  | { ok: false; code: string; error: string } {
  if (raw === undefined) return { ok: true, specs: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, code: "INVALID_PATH_SPEC", error: `${field} 必須是 {path, kind} 陣列；不接受 glob。` };
  }
  const specs: ScopePathSpec[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) {
      return { ok: false, code: "INVALID_PATH_SPEC", error: `${field} 的每項都必須是 {path, kind}。` };
    }
    const path = asText(item.path);
    const kind = item.kind;
    if (!path || (kind !== "file" && kind !== "directory")) {
      return { ok: false, code: "INVALID_PATH_SPEC", error: `${field} 的 path 必須是相對檔案路徑，kind 只能是 file 或 directory。` };
    }
    if (path.includes("*") || path.includes("?") || path.includes("[")) {
      return { ok: false, code: "INVALID_PATH_SPEC", error: `${field} 不支援 glob，只接受精確檔案路徑或明確目錄前綴。` };
    }
    const key = `${kind}:${path}`;
    if (!seen.has(key)) {
      specs.push({ path, kind });
      seen.add(key);
    }
  }
  return { ok: true, specs };
}

function runGit(root: string, args: string[]): { ok: true; stdout: string } | { ok: false; unavailable: boolean } {
  try {
    const result = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error) return { ok: false, unavailable: (result.error as NodeJS.ErrnoException).code === "ENOENT" };
    if (result.status !== 0) return { ok: false, unavailable: false };
    return { ok: true, stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? "") };
  } catch {
    return { ok: false, unavailable: false };
  }
}

function parseNulSeparated(raw: string): string[] {
  return raw.split("\0").filter(Boolean).map(normalizeRelativePath);
}

function collectGitSnapshot(root: string): GitSnapshot {
  const unavailable: ScopeGitSummary = {
    available: false,
    statusAvailable: false,
    head: null,
    trackedFileCount: 0,
    untrackedFileCount: 0,
  };
  const headResult = runGit(root, ["rev-parse", "--verify", "HEAD"]);
  const trackedResult = runGit(root, ["ls-files", "-z"]);
  const statusResult = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!trackedResult.ok && !statusResult.ok) {
    return { summary: unavailable, trackedPaths: new Set(), untrackedPaths: new Set(), statusByPath: new Map() };
  }
  const trackedPaths = new Set(trackedResult.ok ? parseNulSeparated(trackedResult.stdout) : []);
  const untrackedResult = runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const untrackedPaths = untrackedResult.ok ? new Set(parseNulSeparated(untrackedResult.stdout)) : new Set<string>();
  const statusByPath = new Map<string, string>();
  if (statusResult.ok) {
    const chunks = statusResult.stdout.split("\0").filter(Boolean);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      if (chunk.length < 3) continue;
      const status = chunk.slice(0, 2);
      const path = normalizeRelativePath(chunk.slice(3));
      statusByPath.set(path, status === "??" ? "untracked" : status);
      if (status.startsWith("R") || status.startsWith("C")) {
        const renamedPath = chunks[index + 1];
        if (renamedPath) {
          statusByPath.set(normalizeRelativePath(renamedPath), status);
          index += 1;
        }
      }
    }
  }
  return {
    summary: {
      available: true,
      statusAvailable: statusResult.ok,
      head: headResult.ok ? headResult.stdout.trim() || null : null,
      trackedFileCount: trackedPaths.size,
      untrackedFileCount: untrackedPaths.size,
    },
    trackedPaths,
    untrackedPaths,
    statusByPath,
  };
}

function addIssue(coverage: ScopeCoverage, issue: ScopeIssue): void {
  const key = `${issue.code}:${issue.path ?? ""}:${issue.detail ?? ""}`;
  if (!coverage.issues.some((candidate) => `${candidate.code}:${candidate.path ?? ""}:${candidate.detail ?? ""}` === key)) {
    coverage.issues.push(issue);
  }
}

function createCoverage(requestedPaths: ScopePathSpec[]): ScopeCoverage {
  return {
    requestedPaths,
    scope: "requested-paths-only",
    scopeDescription: "只核對呼叫端指定的精確檔案／目錄；沒有專案全域涵蓋宣稱。",
    scannedFileCount: 0,
    skippedFileCount: 0,
    excludedPaths: [],
    issues: [],
    complete: true,
    limits: { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, maxDepth: MAX_DEPTH },
  };
}

function markExcluded(coverage: ScopeCoverage, path: string, reason: string): void {
  if (!coverage.excludedPaths.includes(path)) coverage.excludedPaths.push(path);
  coverage.complete = false;
  addIssue(coverage, { code: reason, path, detail: "此路徑被明確排除，沒有讀取內容。" });
}

function addCandidate(candidates: Set<string>, root: string, raw: string, coverage: ScopeCoverage): void {
  const relativePath = normalizePath(root, raw);
  if (!relativePath) {
    addIssue(coverage, { code: "INVALID_PATH_SPEC", path: raw, detail: "路徑必須留在 project root 內，且不得使用 glob。" });
    coverage.complete = false;
    return;
  }
  const excluded = excludedReason(relativePath);
  if (excluded) {
    markExcluded(coverage, relativePath, excluded);
    return;
  }
  candidates.add(relativePath);
}

function walkDirectory(
  root: string,
  relativeDirectory: string,
  candidates: Set<string>,
  coverage: ScopeCoverage,
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    coverage.complete = false;
    addIssue(coverage, { code: "PROCESSING_LIMIT", path: relativeDirectory, detail: `目錄深度超過 ${MAX_DEPTH}。` });
    return;
  }
  const absoluteDirectory = resolve(root, relativeDirectory);
  let entries: Dirent[];
  try {
    entries = readdirSync(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    coverage.complete = false;
    addIssue(coverage, {
      code: "READ_FAILED",
      path: relativeDirectory,
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const childPath = normalizeRelativePath(relative(root, resolve(absoluteDirectory, entry.name)));
    const excluded = excludedReason(childPath);
    if (excluded) {
      markExcluded(coverage, childPath, excluded);
      continue;
    }
    if (entry.isDirectory()) {
      walkDirectory(root, childPath, candidates, coverage, depth + 1);
    } else {
      // symlink 與特殊檔案也先列入 candidate，scanFileSummary 會保留無法比較的證據。
      candidates.add(childPath);
    }
  }
}

function addRequestedPaths(root: string, specs: ScopePathSpec[], candidates: Set<string>, coverage: ScopeCoverage): void {
  for (const spec of specs) {
    const relativePath = normalizePath(root, spec.path);
    if (!relativePath) {
      addIssue(coverage, { code: "INVALID_PATH_SPEC", path: spec.path, detail: "路徑必須留在 project root 內，且不得使用 glob。" });
      coverage.complete = false;
      continue;
    }
    const excluded = excludedReason(relativePath);
    if (excluded) {
      markExcluded(coverage, relativePath, excluded);
      continue;
    }
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(resolve(root, relativePath));
    } catch {
      coverage.complete = false;
      addIssue(coverage, { code: "PATH_NOT_FOUND", path: relativePath });
      if (spec.kind === "file") candidates.add(relativePath);
      continue;
    }
    if (spec.kind === "file") {
      if (stats.isDirectory()) {
        coverage.complete = false;
        addIssue(coverage, { code: "PATH_KIND_MISMATCH", path: relativePath, detail: "指定 file 但目標是目錄。" });
      } else {
        candidates.add(relativePath);
      }
    } else if (stats.isDirectory()) {
      walkDirectory(root, relativePath, candidates, coverage, 0);
    } else {
      coverage.complete = false;
      addIssue(coverage, { code: "PATH_KIND_MISMATCH", path: relativePath, detail: "指定 directory 但目標不是目錄。" });
    }
  }
}

function gitStatusIsDirty(status: string | undefined): boolean {
  return Boolean(status && status !== "  ");
}

function scanFileSummary(
  root: string,
  relativePath: string,
  baselineDirty: boolean,
  coverage: ScopeCoverage,
  totalBytes: { value: number },
): ScopeFileSummary {
  const absolutePath = resolve(root, relativePath);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(absolutePath);
  } catch (error) {
    return {
      path: relativePath,
      state: "missing",
      comparable: false,
      baselineDirty,
      reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "FILE_NOT_FOUND" : "LSTAT_FAILED",
    };
  }
  if (stats.isSymbolicLink()) {
    coverage.complete = false;
    addIssue(coverage, { code: "SYMLINK_NOT_FOLLOWED", path: relativePath, detail: "不追蹤 symbolic link，避免讀到 project 外內容。" });
    return { path: relativePath, state: "symlink", comparable: false, baselineDirty, reason: "SYMLINK_NOT_FOLLOWED" };
  }
  if (!stats.isFile()) {
    coverage.complete = false;
    addIssue(coverage, { code: "UNSUPPORTED_FILE_TYPE", path: relativePath });
    return { path: relativePath, state: "special", comparable: false, baselineDirty, reason: "UNSUPPORTED_FILE_TYPE" };
  }
  if (stats.size > MAX_FILE_BYTES) {
    coverage.complete = false;
    addIssue(coverage, { code: "PROCESSING_LIMIT", path: relativePath, detail: `檔案超過 ${MAX_FILE_BYTES} bytes。` });
    return { path: relativePath, state: "too_large", comparable: false, baselineDirty, sizeBytes: stats.size, reason: "FILE_TOO_LARGE" };
  }
  if (totalBytes.value + stats.size > MAX_TOTAL_BYTES) {
    coverage.complete = false;
    addIssue(coverage, { code: "PROCESSING_LIMIT", path: relativePath, detail: `總讀取量超過 ${MAX_TOTAL_BYTES} bytes。` });
    return { path: relativePath, state: "too_large", comparable: false, baselineDirty, sizeBytes: stats.size, reason: "TOTAL_BYTES_LIMIT" };
  }
  try {
    const bytes = readFileSync(absolutePath);
    totalBytes.value += bytes.byteLength;
    coverage.scannedFileCount += 1;
    return {
      path: relativePath,
      state: "file",
      comparable: true,
      baselineDirty,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    coverage.complete = false;
    addIssue(coverage, { code: "READ_FAILED", path: relativePath, detail: error instanceof Error ? error.message : String(error) });
    return { path: relativePath, state: "unreadable", comparable: false, baselineDirty, sizeBytes: stats.size, reason: "READ_FAILED" };
  }
}

function scanProject(
  root: string,
  requestedPaths: ScopePathSpec[],
  git: GitSnapshot,
  includeGitFiles: boolean,
  extraCandidates: string[] = [],
): ScanResult {
  const coverage = createCoverage(requestedPaths);
  if (git.summary.available && includeGitFiles) {
    coverage.scope = "git-plus-requested";
    coverage.scopeDescription = "核對 Git tracked、非 ignored untracked 與呼叫端指定路徑；依賴、產物、敏感和 ignored 路徑仍被排除。這不是整個專案的涵蓋宣稱。";
  }
  if (git.summary.available && !git.summary.statusAvailable) {
    coverage.complete = false;
    addIssue(coverage, { code: "GIT_STATUS_UNAVAILABLE", detail: "Git status 無法取得，baseline-existing 分類可能不完整。" });
  }
  if (includeGitFiles && !git.summary.available) {
    coverage.complete = false;
    addIssue(coverage, { code: "GIT_SCAN_UNAVAILABLE", detail: "已要求完整 Git 掃描，但目前無法取得 Git 檔案清單。" });
  }
  const candidates = new Set<string>();
  addRequestedPaths(root, requestedPaths, candidates, coverage);
  for (const path of extraCandidates) addCandidate(candidates, root, path, coverage);
  if (includeGitFiles) {
    for (const path of [...git.trackedPaths, ...git.untrackedPaths]) {
      const excluded = excludedReason(path);
      if (excluded) {
        coverage.skippedFileCount += 1;
        continue;
      }
      candidates.add(path);
    }
  }
  if (requestedPaths.length === 0 && extraCandidates.length === 0 && (!includeGitFiles || !git.summary.available)) {
    coverage.complete = false;
    addIssue(coverage, { code: "INSUFFICIENT_SCOPE", detail: "沒有指定檔案或目錄，也沒有可用的完整 Git 掃描範圍。" });
  }
  if (candidates.size > MAX_FILES) {
    coverage.complete = false;
    addIssue(coverage, { code: "PROCESSING_LIMIT", detail: `候選檔案超過 ${MAX_FILES} 個。` });
  }
  const files: ScopeFileSummary[] = [];
  const totalBytes = { value: 0 };
  for (const path of [...candidates].sort()) {
    if (files.length >= MAX_FILES) {
      coverage.skippedFileCount += 1;
      continue;
    }
    const status = git.statusByPath.get(path);
    files.push(scanFileSummary(root, path, gitStatusIsDirty(status), coverage, totalBytes));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  coverage.excludedPaths.sort();
  coverage.issues.sort((a, b) => `${a.code}:${a.path ?? ""}`.localeCompare(`${b.code}:${b.path ?? ""}`));
  return { files, coverage };
}

/** 以本次呼叫的工作階段位置為專案根目錄；unsafe 或無法解析時 fail closed。 */
async function resolveRoot(ctx: Plugin.Context, toolCtx: ToolExecutionContext): Promise<ResolvedRoot | FailedRoot> {
  const lexical = await resolveSessionDirectory(ctx, toolCtx);
  if (isUnsafeRoot(lexical)) {
    return { ok: false, code: "INVALID_PROJECT_ROOT", error: "unsafe project root，拒絕建立或比較檔案摘要。" };
  }
  try {
    const root = realpathSync(lexical);
    if (isUnsafeRoot(root)) {
      return { ok: false, code: "INVALID_PROJECT_ROOT", error: "解析後的專案根目錄是 unsafe root，拒絕建立或比較檔案摘要。" };
    }
    return { ok: true, root };
  } catch {
    return { ok: false, code: "INVALID_PROJECT_ROOT", error: "無法解析 project root。" };
  }
}

function isValidPathSpec(value: unknown): value is ScopePathSpec {
  return isRecord(value)
    && typeof value.path === "string"
    && value.path.trim().length > 0
    && !isAbsolute(value.path)
    && !value.path.includes("*")
    && !value.path.includes("?")
    && !value.path.includes("[")
    && (value.kind === "file" || value.kind === "directory");
}

function isValidPathSpecList(value: unknown): value is ScopePathSpec[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isValidPathSpec(item)) return false;
    const key = `${item.kind}:${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidGitSummary(value: unknown): value is ScopeGitSummary {
  return isRecord(value)
    && typeof value.available === "boolean"
    && typeof value.statusAvailable === "boolean"
    && (value.head === null || typeof value.head === "string")
    && isNonNegativeInteger(value.trackedFileCount)
    && isNonNegativeInteger(value.untrackedFileCount);
}

function isValidScopeIssue(value: unknown): value is ScopeIssue {
  return isRecord(value)
    && typeof value.code === "string"
    && value.code.trim().length > 0
    && (value.path === undefined || typeof value.path === "string")
    && (value.detail === undefined || typeof value.detail === "string");
}

function isValidScopeCoverage(value: unknown): value is ScopeCoverage {
  if (!isRecord(value)) return false;
  if (!isValidPathSpecList(value.requestedPaths)) return false;
  if (value.scope !== "git-plus-requested" && value.scope !== "requested-paths-only") return false;
  if (typeof value.scopeDescription !== "string" || typeof value.complete !== "boolean") return false;
  if (!isNonNegativeInteger(value.scannedFileCount) || !isNonNegativeInteger(value.skippedFileCount)) return false;
  if (!Array.isArray(value.excludedPaths) || !value.excludedPaths.every((path) => typeof path === "string")) return false;
  if (!Array.isArray(value.issues) || !value.issues.every(isValidScopeIssue)) return false;
  if (!isRecord(value.limits)) return false;
  return value.limits.maxFiles === MAX_FILES
    && value.limits.maxFileBytes === MAX_FILE_BYTES
    && value.limits.maxTotalBytes === MAX_TOTAL_BYTES
    && value.limits.maxDepth === MAX_DEPTH;
}

function isValidFileSummary(value: unknown): value is ScopeFileSummary {
  if (!isRecord(value)) return false;
  const states: FileState[] = ["file", "missing", "symlink", "unreadable", "too_large", "special"];
  if (
    typeof value.path !== "string"
    || value.path.trim().length === 0
    || !states.includes(value.state as FileState)
    || typeof value.comparable !== "boolean"
    || typeof value.baselineDirty !== "boolean"
  ) return false;
  if (value.sizeBytes !== undefined && !isNonNegativeInteger(value.sizeBytes)) return false;
  if (value.sha256 !== undefined && (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sha256))) return false;
  return value.reason === undefined || typeof value.reason === "string";
}

function validateBaseline(value: unknown): value is ChangeScopeBaseline {
  if (!isRecord(value) || value.schema !== CHANGE_SCOPE_BASELINE_SCHEMA || value.version !== 1) return false;
  if (
    typeof value.projectPath !== "string"
    || !isAbsolute(value.projectPath)
    || !isValidPathSpecList(value.requestedPaths)
    || (value.includeGitFiles !== undefined && typeof value.includeGitFiles !== "boolean")
    || typeof value.createdAt !== "string"
    || !isValidGitSummary(value.git)
    || !isValidScopeCoverage(value.coverage)
    || !Array.isArray(value.files)
    || value.files.length > MAX_FILES
  ) return false;
  const paths = new Set<string>();
  for (const item of value.files) {
    if (!isValidFileSummary(item) || paths.has(item.path)) return false;
    paths.add(item.path);
  }
  return true;
}

function baselineIncludesGitFiles(baseline: ChangeScopeBaseline): boolean {
  return baseline.includeGitFiles ?? baseline.coverage.scope === "git-plus-requested";
}

function sameComparableFile(left: ScopeFileSummary, right: ScopeFileSummary): boolean {
  return left.state === "file" && right.state === "file" && left.comparable && right.comparable
    && typeof left.sha256 === "string" && left.sha256 === right.sha256;
}

function allowedPathMatch(path: string, specs: ScopePathSpec[]): boolean {
  return specs.some((spec) => spec.kind === "file" ? path === spec.path : path === spec.path || path.startsWith(`${spec.path}/`));
}

function classifyChange(path: string, baseline: ScopeFileSummary | undefined, allowedPaths: ScopePathSpec[]) {
  const scope = allowedPathMatch(path, allowedPaths) ? "allowed" : "out-of-scope";
  const baselineExisting = baseline?.baselineDirty === true;
  const classification = baselineExisting ? "baseline-existing" : scope;
  return { scope, baselineExisting, classification };
}

function compareBaseline(
  baseline: ChangeScopeBaseline,
  current: ScopeFileSummary[],
  coverage: ScopeCoverage,
  currentGit: GitSnapshot,
  allowedPaths: ScopePathSpec[],
) {
  const before = new Map(baseline.files.map((file) => [file.path, file]));
  const after = new Map(current.map((file) => [file.path, file]));
  const added: Array<Record<string, unknown>> = [];
  const modified: Array<Record<string, unknown>> = [];
  const deleted: Array<Record<string, unknown>> = [];
  const unableToDetermine: string[] = [];
  const classificationSets = {
    allowed: new Set<string>(),
    outOfScope: new Set<string>(),
    baselineExisting: new Set<string>(),
  };
  const scopeViolations = new Set<string>();
  const allPaths = [...new Set([...before.keys(), ...after.keys()])].sort();

  for (const path of allPaths) {
    const oldFile = before.get(path);
    const newFile = after.get(path);
    let change: "added" | "modified" | "deleted" | "unable" | null = null;
    if (!oldFile && newFile) {
      change = newFile.comparable ? "added" : "unable";
    } else if (oldFile && !newFile) {
      change = oldFile.state === "missing" ? null : oldFile.comparable ? "deleted" : "unable";
    } else if (oldFile && newFile) {
      if (newFile.state === "missing") {
        change = oldFile.state === "missing" ? null : oldFile.comparable ? "deleted" : "unable";
      } else if (oldFile.state === "missing") {
        change = newFile.comparable ? "added" : "unable";
      } else if (oldFile.state === "symlink" || newFile.state === "symlink" || !oldFile.comparable || !newFile.comparable) {
        change = "unable";
      } else if (!sameComparableFile(oldFile, newFile)) {
        change = "modified";
      }
    }
    if (!change) continue;
    const classification = classifyChange(path, oldFile, allowedPaths);
    if (change === "unable") {
      unableToDetermine.push(path);
      if (classification.scope === "out-of-scope") scopeViolations.add(path);
      continue;
    }
    const item = {
      path,
      classification: classification.classification,
      scope: classification.scope,
      baselineExisting: classification.baselineExisting,
    };
    if (change === "added") added.push(item);
    if (change === "modified") modified.push(item);
    if (change === "deleted") deleted.push(item);
    if (classification.scope === "allowed") classificationSets.allowed.add(path);
    else {
      classificationSets.outOfScope.add(path);
      scopeViolations.add(path);
    }
    if (classification.baselineExisting) classificationSets.baselineExisting.add(path);
  }

  const issues: ScopeIssue[] = [...coverage.issues];
  if (!baseline.coverage.complete || baseline.coverage.issues.length > 0) {
    issues.push({
      code: "BASELINE_COVERAGE_INCOMPLETE",
      detail: `比較起點的檔案範圍檢查不完整，保留 ${baseline.coverage.issues.length} 個原始問題；不能把這次比較當成完整的無越界變更證據。`,
    });
  }
  if (baseline.git.available && currentGit.summary.available && baseline.git.head !== currentGit.summary.head) {
    issues.push({ code: "HEAD_CHANGED", detail: "比較起點與目前的 Git HEAD 不同；檔案摘要仍已比較，但歷史基準已改變。" });
  }
  if (baseline.git.available !== currentGit.summary.available) {
    issues.push({ code: "GIT_AVAILABILITY_CHANGED", detail: "比較起點與目前的 Git 可用性不同。" });
  }
  const uniqueIssues = issues.filter((issue, index, all) => all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(issue)) === index);
  const unable = [...new Set(unableToDetermine)].sort();
  const hasUnstableEvidence = uniqueIssues.length > 0 || unable.length > 0;
  return {
    changes: {
      added: added.sort((a, b) => String(a.path).localeCompare(String(b.path))),
      modified: modified.sort((a, b) => String(a.path).localeCompare(String(b.path))),
      deleted: deleted.sort((a, b) => String(a.path).localeCompare(String(b.path))),
    },
    classifications: {
      allowed: [...classificationSets.allowed].sort(),
      outOfScope: [...classificationSets.outOfScope].sort(),
      baselineExisting: [...classificationSets.baselineExisting].sort(),
      unableToDetermine: unable,
    },
    scopeViolations: [...scopeViolations].sort(),
    issues: uniqueIssues,
    baselineCoverage: baseline.coverage,
    coverage,
    safeToClaimNoOutOfScopeChanges: !hasUnstableEvidence && scopeViolations.size === 0,
    note: "這份比較只能證明檔案前後不同，不能證明是哪個代理修改；並行修改的歸屬要由主代理判斷。",
  };
}

function invalidInput(error: string) {
  return jsonResult({ ok: false, code: "INVALID_INPUT", error }, undefined, "請修正 action、path spec、baselineId 或 allowedPaths 後重試。");
}

/**
 * 快照存放目錄：工作階段位置下的 `.ultrawork/cache/change-scope/`（扁平，
 * 不再按專案雜湊分子目錄）。可重建的資料，不做舊 XDG 位置的搬遷。
 */
export function changeScopeStoreDirForRoot(root: string): string {
  return join(root, ".ultrawork", "cache", "change-scope");
}

function newBaselineId(): string {
  return `csb_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function pruneExpiredBaselines(dir: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > BASELINE_RETENTION_MS) unlinkSync(path);
    } catch {
      // 清理失敗不影響這次建立；下次建立會再試。
    }
  }
}

function saveBaseline(
  dir: string,
  baselineId: string,
  baseline: ChangeScopeBaseline,
): { ok: true } | { ok: false; error: string } {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    pruneExpiredBaselines(dir, Date.now());
    const target = join(dir, `${baselineId}.json`);
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(baseline), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, target);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function loadBaseline(
  dir: string,
  baselineId: string,
): { ok: true; baseline: unknown } | { ok: false; code: "BASELINE_NOT_FOUND" | "INVALID_BASELINE" } {
  let raw: string;
  try {
    raw = readFileSync(join(dir, `${baselineId}.json`), "utf8");
  } catch {
    return { ok: false, code: "BASELINE_NOT_FOUND" };
  }
  try {
    return { ok: true, baseline: JSON.parse(raw) };
  } catch {
    return { ok: false, code: "INVALID_BASELINE" };
  }
}

/** 回傳給模型的涵蓋範圍摘要：保留判斷所需的欄位，長清單只給數量與前幾項。 */
function summarizeCoverage(coverage: ScopeCoverage) {
  return {
    scope: coverage.scope,
    scopeDescription: coverage.scopeDescription,
    complete: coverage.complete,
    scannedFileCount: coverage.scannedFileCount,
    skippedFileCount: coverage.skippedFileCount,
    excludedPathCount: coverage.excludedPaths.length,
    issueCount: coverage.issues.length,
    issues: coverage.issues.slice(0, MAX_REPORTED_ISSUES),
  };
}

export interface ChangeScopeCheckInput {
  action?: string;
  paths?: unknown;
  includeGitFiles?: boolean;
  baselineId?: unknown;
  allowedPaths?: unknown;
}

// 參數 schema 保持寬鬆，沿用舊版做法由執行邏輯逐項驗證並回傳精準錯誤碼
// （例如未知 runner、非法 script 不能在解析層就變成籠統的輸入錯誤）。
const changeScopeCheckInputSchema: z.ZodType<ChangeScopeCheckInput> = z.object({
  action: z.string().optional(),
  paths: z.unknown().optional(),
  includeGitFiles: z.boolean().optional(),
  baselineId: z.unknown().optional(),
  allowedPaths: z.unknown().optional(),
});

export function createChangeScopeCheckTool(moduleCtx: Plugin.Context): DefinedTool {
  return defineTool({
    name: "change-scope-check",
    description: [
      "建立或比較一次性檔案範圍摘要；快照存在工作階段位置下的 .ultrawork/cache/change-scope，不寫入 Git index、任務或記憶紀錄。",
      "action=create 回傳 baselineId 與涵蓋範圍摘要；action=compare 帶 baselineId 與 allowedPaths。快照 7 天後自動清除。",
      "path spec 只接受精確檔案路徑或 {path, kind:\"directory\"} 的明確目錄前綴，不接受 glob。",
      "預設只核對呼叫端指定的路徑；要把 Git tracked 與非 ignored untracked 檔案納入，必須明確傳 includeGitFiles:true。",
      "結果只說明檔案內容是否改變，不能歸因到特定代理；symlink、敏感路徑、讀取失敗與處理上限會 fail closed。",
    ].join("\n"),
    inputSchema: changeScopeCheckInputSchema,
    execute: async (input: ChangeScopeCheckInput, toolCtx: ToolExecutionContext) => {
      if (!isChangeScopeCheckAllowedAgent(toolCtx.agent)) {
        return jsonResult({
          ok: false,
          code: "AGENT_NOT_ALLOWED",
          error: `change-scope-check 僅限 ${CHANGE_SCOPE_CHECK_ALLOWED_AGENTS.join("／")} 使用。`,
        });
      }
      const action = input?.action;
      if (action !== "create" && action !== "compare") return invalidInput("action 只能是 create 或 compare。");
      const rootResult = await resolveRoot(moduleCtx, toolCtx);
      if (!rootResult.ok) return jsonResult({ ok: false, code: rootResult.code, error: rootResult.error });
      const storeDir = changeScopeStoreDirForRoot(rootResult.root);
      const pathResult = parsePathList(input.paths, "paths");
      if (!pathResult.ok) return jsonResult({ ok: false, code: pathResult.code, error: pathResult.error });
      const allowedResult = parsePathList(input.allowedPaths, "allowedPaths");
      if (!allowedResult.ok) return jsonResult({ ok: false, code: allowedResult.code, error: allowedResult.error });

      if (action === "create") {
        const git = collectGitSnapshot(rootResult.root);
        const includeGitFiles = input.includeGitFiles === true;
        const scan = scanProject(rootResult.root, pathResult.specs, git, includeGitFiles);
        const baseline: ChangeScopeBaseline = {
          schema: CHANGE_SCOPE_BASELINE_SCHEMA,
          version: 1,
          projectPath: rootResult.root,
          requestedPaths: pathResult.specs,
          includeGitFiles,
          createdAt: new Date().toISOString(),
          git: git.summary,
          coverage: scan.coverage,
          files: scan.files,
        };
        const baselineId = newBaselineId();
        const saved = saveBaseline(storeDir, baselineId, baseline);
        if (!saved.ok) {
          return jsonResult(
            { ok: false, code: "BASELINE_STORE_FAILED", error: `無法保存比較起點：${saved.error}` },
            undefined,
            "確認資料目錄可寫入後重新 create。",
          );
        }
        return jsonResult({
          ok: true,
          action,
          schema: CHANGE_SCOPE_BASELINE_SCHEMA,
          baselineId,
          projectPath: baseline.projectPath,
          requestedPaths: baseline.requestedPaths,
          includeGitFiles,
          createdAt: baseline.createdAt,
          git: baseline.git,
          fileCount: baseline.files.length,
          baselineDirtyCount: baseline.files.filter((file) => file.baselineDirty).length,
          coverage: summarizeCoverage(baseline.coverage),
          note: "完整快照由工具保存；compare 時只要帶 baselineId。",
        }, "比較起點已建立；驗收前用同一個 baselineId 呼叫 compare。");
      }

      const baselineId = typeof input.baselineId === "string" ? input.baselineId.trim() : "";
      if (!baselineId) return invalidInput("compare 需要 create 回傳的 baselineId。");
      if (!BASELINE_ID_PATTERN.test(baselineId)) return invalidInput("baselineId 格式不正確，請使用 create 回傳的原值。");
      const loaded = loadBaseline(storeDir, baselineId);
      if (!loaded.ok) {
        return loaded.code === "BASELINE_NOT_FOUND"
          ? jsonResult(
            { ok: false, code: "BASELINE_NOT_FOUND", error: "找不到這個 baselineId 的比較起點；可能來自其他專案、已過期或已被清除。" },
            undefined,
            "重新 create 一個比較起點；已經發生的修改無法回溯比較，要改用 Git 或其他證據判斷。",
          )
          : jsonResult({ ok: false, code: "INVALID_BASELINE", error: "保存的比較起點無法解析。" });
      }
      const baseline = loaded.baseline;
      if (!validateBaseline(baseline)) return jsonResult({ ok: false, code: "INVALID_BASELINE", error: "變更摘要格式不受支援。" });
      let baselineRoot: string;
      try {
        baselineRoot = realpathSync(baseline.projectPath);
      } catch {
        return jsonResult({ ok: false, code: "CROSS_PROJECT", error: "變更摘要的專案路徑無法解析，拒絕把它當成目前專案。" });
      }
      if (baselineRoot !== rootResult.root || !isInsideWorktree(rootResult.root, baselineRoot) || !isInsideWorktree(baselineRoot, rootResult.root)) {
        return jsonResult({ ok: false, code: "CROSS_PROJECT", error: "變更摘要來自其他專案，不能拿來比較目前狀態。" });
      }
      const git = collectGitSnapshot(rootResult.root);
      const baselinePaths = baseline.files.map((file) => file.path);
      const scan = scanProject(
        rootResult.root,
        [...baseline.requestedPaths, ...allowedResult.specs],
        git,
        baselineIncludesGitFiles(baseline),
        baselinePaths,
      );
      const comparison = compareBaseline(baseline, scan.files, scan.coverage, git, allowedResult.specs);
      return jsonResult({
        ok: true,
        action,
        baselineId,
        ...comparison,
        baselineCoverage: summarizeCoverage(comparison.baselineCoverage),
        coverage: summarizeCoverage(comparison.coverage),
      }, "已完成檔案內容比較；請依 scopeViolations、unableToDetermine 與 coverage 判斷是否需要主代理處置。");
    },
  });
}

export interface TrackedFileSnapshot {
  path: string;
  state: "file" | "missing" | "symlink" | "unreadable" | "outside" | "sensitive" | "directory";
  comparable: boolean;
  sizeBytes?: number;
  sha256?: string;
  reason?: string;
}

/** verification_run 共用的精確檔案摘要；不接受目錄或 glob，也不讀 symlink target。 */
export function captureTrackedFileSnapshots(root: string, rawPaths: string[]): TrackedFileSnapshot[] {
  return rawPaths.map((rawPath) => {
    const path = normalizePath(root, rawPath);
    if (!path) return { path: rawPath, state: "outside", comparable: false, reason: "PATH_OUTSIDE_WORKTREE_OR_GLOB" };
    if (isSensitivePath(path)) return { path, state: "sensitive", comparable: false, reason: "SENSITIVE_PATH" };
    const absolute = resolve(root, path);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(absolute);
    } catch (error) {
      return { path, state: "missing", comparable: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "FILE_NOT_FOUND" : "LSTAT_FAILED" };
    }
    if (stats.isSymbolicLink()) return { path, state: "symlink", comparable: false, reason: "SYMLINK_NOT_FOLLOWED" };
    if (stats.isDirectory()) return { path, state: "directory", comparable: false, reason: "TRACKED_PATH_MUST_BE_FILE" };
    if (!stats.isFile()) return { path, state: "unreadable", comparable: false, reason: "UNSUPPORTED_FILE_TYPE" };
    if (stats.size > MAX_FILE_BYTES) return { path, state: "unreadable", comparable: false, sizeBytes: stats.size, reason: "FILE_TOO_LARGE" };
    try {
      const bytes = readFileSync(absolute);
      return { path, state: "file", comparable: true, sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch {
      return { path, state: "unreadable", comparable: false, sizeBytes: stats.size, reason: "READ_FAILED" };
    }
  });
}
