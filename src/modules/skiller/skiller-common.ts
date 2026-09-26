/**
 * opencode-ultrawork — Skiller lifecycle tools 共用 helper / types
 *
 * 角色：
 *   - 提供五個 skiller-*.ts factory 共用的固定 root 常數、name/namespace 驗證、
 *     fixed-root containment guard（lexical + realpath）、frontmatter 解析、
 *     內容風險掃描（secret / high-risk / workflow ID）、scripts inventory、
 *     policy digest drift 檢查與 trust tier 推導。
 *
 * 安全設計（不可放寬）：
 *   - production 固定 roots 為本檔常數；tool args 不接受任何 path/root/destination。
 *   - `SkillerDeps.roots` 僅供直接 factory 測試注入暫存 roots；production
 *     registry 一律不注入，也不得從 options / env / tool args 進入。
 *   - 所有路徑先 lexical containment，再對最近存在 ancestor 做 realpath；
 *     固定 root 本身不得為 symlink；目標元件為 dangling symlink 或解析後
 *     超出 canonical root 一律拒絕。project scope 另以 canonical project
 *     root 為 anchor（ensureScopedFixedRoot）：祖先元件是指向 anchor 外的
 *     symlink 時 fail closed。
 *   - skill bundle 走訪對 readdir / lstat 失敗 fail closed（BUNDLE_READ_FAILED），
 *     不把不完整 bundle 當成功。
  *   - skills-policy.json 預設只讀；寫入只走 skiller-policy-update
  *     的 preview/apply 流程（固定路徑、sha gate、原子寫入）。
 *
 * 限制：
 *   - 不得 import `src/index.ts`。
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolExecutionContext } from "../../kit/define-tool.ts";
import { atomicWriteFileWithOps } from "../../kit/atomic-write.ts";
import { assertContainedPath, isInsideWorktree } from "../../kit/path-guard.ts";
import { withContentWriteLock } from "../../kit/write-lock.ts";
import { resolveGlobalConfigDir, resolveGlobalUltraworkDir } from "../../settings/paths.ts";

// ─── 固定 root 設定 ──────────────────────────────────────────

/** project scope 沿用 OpenCode 專案技能探索位置。 */
export const PROJECT_SKILL_DRAFTS_DIR = ".opencode/skill-drafts";
export const PROJECT_SKILLS_DIR = ".opencode/skills";
export const PROJECT_SKILL_QUARANTINE_DIR = ".opencode/skill-quarantine";

/** personal pins registry 目前支援的 schema 版本；其他版本 fail closed。 */
export const PERSONAL_PINS_SCHEMA_VERSION = 1;

interface DefaultPersonalRoots {
  personalDraftRoot: string;
  personalSkillRoot: string;
  personalQuarantineRoot: string;
  policyPath: string;
  personalPinsPath: string;
  agentsRoot: string;
}

function defaultPersonalRoots(): DefaultPersonalRoots {
  const globalDir = resolveGlobalConfigDir(process.env as Record<string, string | undefined>, homedir());
  const ultraworkDir = resolveGlobalUltraworkDir(globalDir);
  return {
    personalDraftRoot: join(ultraworkDir, "skill-drafts"),
    personalSkillRoot: join(homedir(), ".agents", "skills"),
    personalQuarantineRoot: join(ultraworkDir, "skill-quarantine"),
    policyPath: join(ultraworkDir, "skills-policy.json"),
    personalPinsPath: join(ultraworkDir, "skills-personal.json"),
    agentsRoot: join(globalDir, "agents"),
  };
}

/** skiller `.ultrawork` I/O 的嚴格 containment；外部 symlink 一律拒絕。 */
export function assertSafeSkillerPath(targetPath: string): string {
  const target = resolve(targetPath);
  const marker = `${sep}.ultrawork${sep}`;
  const markerIndex = target.indexOf(marker);
  if (markerIndex < 0) return target;
  return assertContainedPath(target.slice(0, markerIndex), target, {
    label: "Skiller path guard",
  });
}

/**
 * 解析 agents 目錄：測試注入優先，production 由 skiller module 依 settings
 * 注入；未注入的 direct factory fallback 才使用 V2 全域路徑解析。
 */
export function resolveAgentsRoot(deps?: SkillerDeps): string {
  return deps?.roots?.agentsRoot ?? defaultPersonalRoots().agentsRoot;
}

/** 對應 scope 的跨程序寫入鎖；personal／managed 共用全域，project 用專案層。 */
export function resolveSkillerLockPath(
  scope: SkillerScope,
  deps: SkillerDeps,
  context?: ToolExecutionContext,
): string {
  if (scope === "project") {
    return join(resolve(deps.resolveProjectRoot(context)), ".ultrawork", "cache", "locks", "skiller.lock");
  }
  const personalDraftRoot = resolveScopeRoots("personal", deps, context).draftRoot;
  return join(dirname(personalDraftRoot), "cache", "locks", "skiller.lock");
}

/** policy 位於全域 .ultrawork；policy update 使用同一個全域 skiller 鎖。 */
export function resolveSkillerPolicyLockPath(deps: SkillerDeps): string {
  return join(dirname(resolvePolicyPath(deps)), "cache", "locks", "skiller.lock");
}

export async function withSkillerWriteLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  assertSafeSkillerPath(lockPath);
  mkdirSync(dirname(lockPath), { recursive: true });
  return withContentWriteLock(lockPath, fn);
}

// ─── Types ───────────────────────────────────────────────────

export type SkillerScope = "project" | "personal" | "managed";

/** 測試專用 root 覆寫；production registry 不注入任何值。 */
export interface SkillerRootOverrides {
  personalDraftRoot?: string;
  personalSkillRoot?: string;
  personalQuarantineRoot?: string;
  policyPath?: string;
  /** 僅限直接 factory 測試注入暫存 pins fixture；production 一律使用固定預設 path。 */
  personalPinsPath?: string;
  /**
   * 僅限直接 factory 測試注入暫存 agents fixture；production 一律使用
   * 設定注入的 agents 目錄，不可由 tool args / options / env 到達 production。
   */
  agentsRoot?: string;
}

export interface SkillerDeps {
  resolveProjectRoot(context?: ToolExecutionContext): string;
  /** 僅限直接 factory 測試注入；不可由 tool args / options / env 到達 production。 */
  roots?: SkillerRootOverrides;
  /**
   * 寫入單一檔案的操作 seam；僅供 direct factory 測試注入寫入失敗以驗證
   * rollback 行為。production registry 不注入，一律使用真實 fs。
   */
  writeFile?: (absolutePath: string, content: string) => void;
  /**
   * skill bundle 走訪的目錄讀取 seam；僅供 direct factory 測試注入讀取失敗
   * 以驗證 fail closed 行為。production registry 不注入，一律使用真實 fs。
   */
  readDirectory?: (absolutePath: string) => string[];
  /**
   * skill bundle 走訪的 entry lstat seam；僅供 direct factory 測試注入
   * lstat 失敗以驗證 fail closed 行為。production registry 不注入。
   */
  entryStat?: (absolutePath: string) => ReturnType<typeof lstatSync>;
}

export interface SkillIssue {
  code: string;
  message: string;
}

export type TrustTier = "approved" | "drifted" | "recorded" | "managed" | "allowlisted" | "retired" | "unreviewed" | "unknown";

export interface PolicySnapshot {
  path: string;
  managed?: Record<string, unknown>;
  approval?: {
    agentAllowlist?: string[];
    contentDigests?: Record<string, string>;
    digestAlgorithm?: string;
  };
  scriptReviews?: Record<string, unknown>;
  retired?: Record<string, string[]>;
  /** personal skill 治理 metadata：pins path、namespace、trust tiers 與語意 agent groups。 */
  personalGovernance?: PersonalGovernanceMetadata;
}

export interface PersonalGovernanceMetadata {
  pinsPath?: string;
  personalNamespace?: string;
  trustTiers?: string[];
  agentGroups?: Record<string, string[]>;
}

// ─── Personal pins registry ──────────────────────────────────

export type PersonalPinStatus = "active" | "retired";

export interface PersonalPin {
  name: string;
  digest: string;
  targetAgentGroups: string[];
  resolvedTargetAgents: string[];
  status: PersonalPinStatus;
  promotedAt: string;
  retiredAt?: string;
}

export interface PersonalPinsFile {
  schemaVersion: number;
  pins: Record<string, PersonalPin>;
}

export type PersonalPinsLoad =
  | { ok: true; pins: PersonalPinsFile }
  | {
      ok: false;
      code: "REGISTRY_UNAVAILABLE" | "REGISTRY_MALFORMED" | "REGISTRY_SCHEMA_UNSUPPORTED" | "REGISTRY_PIN_INVALID";
      message: string;
    };

function validatePinShape(name: string, value: unknown, hex64: RegExp): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `pin ${name} 必須是物件`;
  const pin = value as Record<string, unknown>;
  if (pin.name !== name) return `pin ${name} 的 name 欄位與 key 不一致`;
  if (typeof pin.digest !== "string" || !hex64.test(pin.digest)) return `pin ${name} 的 digest 必須是 64 位小寫 hex`;
  for (const field of ["targetAgentGroups", "resolvedTargetAgents"] as const) {
    const list = pin[field];
    if (!Array.isArray(list) || list.length === 0 || list.some((g) => typeof g !== "string" || g.trim().length === 0)) {
      return `pin ${name} 的 ${field} 必須是非空字串陣列`;
    }
  }
  if (pin.status !== "active" && pin.status !== "retired") return `pin ${name} 的 status 必須是 active 或 retired`;
  if (typeof pin.promotedAt !== "string" || pin.promotedAt.trim().length === 0) return `pin ${name} 缺少 promotedAt`;
  if (pin.status === "retired" && (typeof pin.retiredAt !== "string" || pin.retiredAt.trim().length === 0)) {
    return `pin ${name} 已標記 retired 但缺少 retiredAt`;
  }
  return null;
}

/**
 * 讀取 personal pins registry。missing / malformed / unknown schemaVersion /
 * pin 欄位缺損或 status drift 一律 fail closed，不提供寬鬆 fallback。
 */
export function loadPersonalPins(pinsPath: string): PersonalPinsLoad {
  let raw: string;
  try {
    assertSafeSkillerPath(pinsPath);
    raw = readFileSync(pinsPath, "utf-8");
  } catch (error) {
    return { ok: false, code: "REGISTRY_UNAVAILABLE", message: `無法讀取 personal pins registry（${pinsPath}）：${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, code: "REGISTRY_MALFORMED", message: `personal pins registry 解析失敗：${(error as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "REGISTRY_MALFORMED", message: "personal pins registry 必須是 JSON 物件" };
  }
  const file = parsed as Record<string, unknown>;
  if (file.schemaVersion !== PERSONAL_PINS_SCHEMA_VERSION) {
    return { ok: false, code: "REGISTRY_SCHEMA_UNSUPPORTED", message: `personal pins registry schemaVersion 不支援：${String(file.schemaVersion)}` };
  }
  if (!file.pins || typeof file.pins !== "object" || Array.isArray(file.pins)) {
    return { ok: false, code: "REGISTRY_MALFORMED", message: "personal pins registry 缺少 pins 物件" };
  }
  const hex64 = /^[0-9a-f]{64}$/;
  for (const [name, value] of Object.entries(file.pins as Record<string, unknown>)) {
    const issue = validatePinShape(name, value, hex64);
    if (issue !== null) return { ok: false, code: "REGISTRY_PIN_INVALID", message: issue };
  }
  return { ok: true, pins: parsed as PersonalPinsFile };
}

export function serializePersonalPins(pins: PersonalPinsFile): string {
  return `${JSON.stringify(pins, null, 2)}\n`;
}

/**
 * 以 atomic write（temp + rename）更新 pins registry。deps.writeFile 僅供
 * 直接 factory 測試注入寫入失敗以驗證 rollback；production 使用真實 fs。
 */
export function writePersonalPinsAtomic(pinsPath: string, pins: PersonalPinsFile, deps?: SkillerDeps): void {
  assertSafeSkillerPath(pinsPath);
  const content = serializePersonalPins(pins);
  const injected = deps?.writeFile;
  atomicWriteFileWithOps(pinsPath, content, {
    writeFileSync: (path, data, options) => {
      if (typeof path !== "string") {
        throw new TypeError("personal pins registry path 必須是字串");
      }
      if (injected) {
        injected(path, typeof data === "string" ? data : Buffer.from(String(data)).toString("utf-8"));
        return;
      }
      writeFileSync(path, data, options);
    },
    renameSync,
    existsSync,
    unlinkSync,
  });
}

// ─── 語意 agent group 解析 ───────────────────────────────────

export type AgentGroupResolution =
  | { ok: true; groups: string[]; agents: string[] }
  | { ok: false; code: "GOVERNANCE_METADATA_MISSING" | "UNKNOWN_AGENT_GROUP"; message: string };

/** 將請求的語意 group 對應到 policy 定義的 agent 成員；未知 group fail closed。 */
export function resolveAgentGroups(requested: string[], policy: PolicySnapshot | null): AgentGroupResolution {
  const agentGroups = policy?.personalGovernance?.agentGroups;
  if (!agentGroups || Object.keys(agentGroups).length === 0) {
    return { ok: false, code: "GOVERNANCE_METADATA_MISSING", message: "skills-policy.json 缺少 personalGovernance.agentGroups；無法解析語意 agent group" };
  }
  for (const group of requested) {
    if (!(group in agentGroups)) {
      const allowed = Object.keys(agentGroups).sort().join(", ");
      return { ok: false, code: "UNKNOWN_AGENT_GROUP", message: `未知的語意 agent group：${group}。合法值：${allowed}` };
    }
  }
  const agents = [...new Set(requested.flatMap((group) => agentGroups[group]))].sort();
  return { ok: true, groups: [...requested].sort(), agents };
}

function wildcardMatches(pattern: string, value: string): boolean {
  const source = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`).test(value);
}

/**
 * 檢查 agents/<agent>.md 是否讓 personal namespace skill 解析得到可載入的路由。
 *
 * `ask` 與 `allow` 都算通過：兩者都代表該 agent 實際載入得到 personal skill，
 * 差別只在要不要先問使用者。只認 `ask` 會讓「路由設得更寬鬆」反而被判成
 * 缺路由，把 promote 卡在一個呼叫端無法自行修復的錯誤上。
 *
 * 持久規則：
 * - project-local agents/<agent>.md 優先；若存在（含 malformed / 缺 route）則以其
 *   內容為準並 fail closed，不 fallback 以免掩蓋明確 deny。
 * - 只有 ENOENT（不存在）才 fallback 到 V2 全域設定資料夾下的 agents root，
 *   不接受 caller 提供的任意路徑。
 * - global fallback 僅讀取固定 <globalRoot>/agents/<agent>.md。
 */
export function agentHasPersonalAskRoute(projectRoot: string, agent: string, deps?: SkillerDeps): boolean {
  const hasAskRoute = (raw: string): boolean => {
    const fm = parseFrontmatter(raw);
    if (!fm.ok) return false;
    const permission = fm.data.permission;
    if (!permission || typeof permission !== "object" || Array.isArray(permission)) return false;
    const skill = (permission as Record<string, unknown>).skill;
    if (!skill || typeof skill !== "object" || Array.isArray(skill)) return false;
    return Object.entries(skill as Record<string, unknown>).some(
      ([pattern, action]) =>
        pattern.includes("*") && wildcardMatches(pattern, "personal-probe-capability") && (action === "ask" || action === "allow"),
    );
  };

  // 1) 優先檢查 project-local；存在時（含 malformed）直接以其結果為準
  try {
    const raw = readFileSync(join(projectRoot, "agents", `${agent}.md`), "utf-8");
    return hasAskRoute(raw);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    // 只有 ENOENT 表示「不存在」才允許查 global；其他錯誤（權限、EISDIR 等）fail closed
    if (code !== "ENOENT") return false;
  }

  // 2) Fallback 到 V2 全域設定資料夾下的 agents root，避免任意路徑注入
  const globalAgentsRoot = resolveAgentsRoot(deps);
  let rawGlobal: string;
  try {
    rawGlobal = readFileSync(join(globalAgentsRoot, `${agent}.md`), "utf-8");
  } catch {
    return false;
  }
  return hasAskRoute(rawGlobal);
}

/**
 * 解析 personal pins registry 位置：測試注入 > 固定預設。
 * policy.personalGovernance.pinsPath 僅作為 contract / documentation metadata；
 * production 的寫入目的地一律由固定常數決定，不因 policy drift 而變成 caller-controlled destination。
 */
export function resolvePersonalPinsPath(deps: SkillerDeps, _policy: PolicySnapshot | null): string {
  return deps.roots?.personalPinsPath ?? defaultPersonalRoots().personalPinsPath;
}

export interface ScopeRoots {
  draftRoot: string;
  skillRoot: string;
  quarantineRoot: string;
}

// ─── Scope / roots ───────────────────────────────────────────

export function normalizeScope(value: unknown): { ok: true; scope: SkillerScope } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, scope: "project" };
  if (value === "project" || value === "personal" || value === "managed") return { ok: true, scope: value };
  return { ok: false };
}

export function resolveScopeRoots(scope: SkillerScope, deps: SkillerDeps, context?: ToolExecutionContext): ScopeRoots {
  const overrides = deps.roots ?? {};
  if (scope === "personal" || scope === "managed") {
    // managed 與 personal 共用同一組實體固定 roots（skill root 本來就是
    // skills-policy.json skillRoot 指向的 ~/.agents/skills）；語意差異由
    // name validation 與 trust tier 推導承載，不新增 root 常數。
    return {
      draftRoot: overrides.personalDraftRoot ?? defaultPersonalRoots().personalDraftRoot,
      skillRoot: overrides.personalSkillRoot ?? defaultPersonalRoots().personalSkillRoot,
      quarantineRoot: overrides.personalQuarantineRoot ?? defaultPersonalRoots().personalQuarantineRoot,
    };
  }
  const projectRoot = resolve(deps.resolveProjectRoot(context));
  return {
    draftRoot: join(projectRoot, PROJECT_SKILL_DRAFTS_DIR),
    skillRoot: join(projectRoot, PROJECT_SKILLS_DIR),
    quarantineRoot: join(projectRoot, PROJECT_SKILL_QUARANTINE_DIR),
  };
}

export function resolvePolicyPath(deps: SkillerDeps): string {
  return deps.roots?.policyPath ?? defaultPersonalRoots().policyPath;
}

// ─── Name / namespace 驗證 ───────────────────────────────────

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function deriveProjectSlug(projectRoot: string): string {
  const base = basename(resolve(projectRoot)).toLowerCase();
  const slug = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "project";
}

export type NameValidation =
  | { ok: true; name: string }
  | { ok: false; code: "INVALID_NAME" | "INVALID_NAMESPACE"; message: string };

/**
 * 驗證 skill name：lowercase hyphenated、≤64 字元、無 slash / `..` / 絕對路徑；
 * project scope 必須為 `project-<current-project-slug>-<capability>`；
 * personal scope 必須為 `personal-<domain>-<capability>`；
 * managed scope 為無 prefix 的 kebab-case（≤64 字元），且不得以
 * `personal-` / `project-` 開頭（name validation 不查 managed catalog；
 * 撞名由 promote 的既有目標檢查處理）。
 */
export function validateSkillName(rawName: unknown, scope: SkillerScope, projectSlug: string): NameValidation {
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    return { ok: false, code: "INVALID_NAME", message: "name 為必填且必須是字串" };
  }
  const name = rawName.trim();
  if (name.length > 64) {
    return { ok: false, code: "INVALID_NAME", message: "name 長度不得超過 64 字元" };
  }
  if (isAbsolute(name) || name.includes("/") || name.includes("\\") || name.split("-").includes("..")) {
    return { ok: false, code: "INVALID_NAME", message: "name 不得包含路徑分隔符、.. 或絕對路徑" };
  }
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, code: "INVALID_NAME", message: "name 只能使用小寫英數字與連字號，且不得以連字號開頭或結尾" };
  }
  if (scope === "project") {
    const prefix = `project-${projectSlug}-`;
    const rest = name.slice(prefix.length);
    if (!name.startsWith(prefix) || rest.length === 0 || !NAME_PATTERN.test(rest)) {
      return {
        ok: false,
        code: "INVALID_NAMESPACE",
        message: `project scope 的 name 必須符合 project-${projectSlug}-<capability>`,
      };
    }
    return { ok: true, name };
  }
  if (scope === "managed") {
    if (name.startsWith("personal-") || name.startsWith("project-")) {
      return {
        ok: false,
        code: "INVALID_NAMESPACE",
        message: "managed scope 的 name 不得使用 personal- 或 project- prefix",
      };
    }
    return { ok: true, name };
  }
  const parts = name.split("-");
  if (parts[0] !== "personal" || parts.length < 3) {
    return {
      ok: false,
      code: "INVALID_NAMESPACE",
      message: "personal scope 的 name 必須符合 personal-<domain>-<capability>",
    };
  }
  return { ok: true, name };
}

// ─── Fixed-root containment guard ────────────────────────────

export type GuardResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/**
 * 確認固定 root 可用：必須存在、是目錄、且最後一段元件不得為 symlink。
 * 回傳 canonical（realpath）root 作為 containment 邊界。
 */
export function ensureFixedRoot(rootPath: string): GuardResult<string> {
  let lst: ReturnType<typeof lstatSync>;
  try {
    lst = lstatSync(rootPath);
  } catch {
    return { ok: false, code: "UNKNOWN_ROOT", message: `固定 root 不存在或不可存取` };
  }
  if (lst.isSymbolicLink()) {
    return { ok: false, code: "SYMLINK_REJECTED", message: "固定 root 不得是 symlink" };
  }
  if (!lst.isDirectory()) {
    return { ok: false, code: "UNKNOWN_ROOT", message: "固定 root 不是目錄" };
  }
  try {
    return { ok: true, value: realpathSync(rootPath) };
  } catch {
    return { ok: false, code: "UNKNOWN_ROOT", message: "無法解析固定 root" };
  }
}

/**
 * 以 scope 決定固定 root 的 containment 規則：
 *   - project scope：以 canonical project root 為 anchor。祖先元件（含
 *     `.opencode`）是指向 anchor 外的 symlink、anchor 無法解析、或 root
 *     本身不通過 fixed-root 檢查時，一律 fail closed。root 尚不存在時，
 *     以最近存在祖先的 realpath 驗證未來建立位置不會落在 anchor 外，
 *     讓 caller 能在 mkdir 前先擋下對 root 外部位置的寫入。
 *   - personal / managed scope：不綁 project anchor，行為與 ensureFixedRoot 一致。
 */
export function ensureScopedFixedRoot(
  rootPath: string,
  scope: SkillerScope,
  deps: SkillerDeps,
  context?: ToolExecutionContext,
): GuardResult<string> {
  const lexicalRoot = resolve(rootPath);
  if (scope !== "project") assertSafeSkillerPath(lexicalRoot);

  let anchorReal: string | null = null;
  if (scope === "project") {
    try {
      anchorReal = realpathSync(resolve(deps.resolveProjectRoot(context)));
    } catch {
      return { ok: false, code: "UNKNOWN_ROOT", message: "無法解析 project root" };
    }
  }

  // 最近存在祖先：lstat 判斷存在；dangling symlink 於下一步 realpath 拒絕。
  let probe = lexicalRoot;
  for (let guard = 0; guard < 64; guard += 1) {
    try {
      lstatSync(probe);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { ok: false, code: "UNKNOWN_ROOT", message: "固定 root 不存在或不可存取" };
      }
      const parent = dirname(probe);
      if (parent === probe) {
        return { ok: false, code: "UNKNOWN_ROOT", message: "固定 root 不存在或不可存取" };
      }
      probe = parent;
    }
  }

  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    return { ok: false, code: "SYMLINK_REJECTED", message: "固定 root 路徑包含 dangling symlink" };
  }
  if (anchorReal !== null && !isInsideWorktree(realProbe, anchorReal)) {
    return { ok: false, code: "ROOT_ESCAPE", message: "固定 root 解析後超出 project root 範圍" };
  }

  // root 本身已存在時，最後元件仍須通過 fixed-root 檢查（非 symlink、是目錄）。
  if (probe === lexicalRoot) {
    return ensureFixedRoot(lexicalRoot);
  }
  return { ok: true, value: realProbe };
}

/**
 * 在 canonical root 下解析相對 segments：
 *   1. lexical containment（相對 lexical root）。
 *   2. 以 lstat 找出最近存在 ancestor 並 realpath；dangling symlink 於此拒絕。
 *   3. ancestor 與組合後的最終路徑都必須落在 canonical root 內。
 *   4. 最終目標本身不得為 symlink。
 */
export function containedPath(realRoot: string, lexicalRoot: string, ...segments: string[]): GuardResult<string> {
  const lexicalTarget = resolve(lexicalRoot, ...segments);
  if (!isInsideWorktree(lexicalTarget, lexicalRoot)) {
    return { ok: false, code: "PATH_OUTSIDE_ROOT", message: "路徑超出固定 root 範圍" };
  }

  // 最近存在 ancestor：lstat 判斷存在（dangling symlink 也算「存在」，
  // 會在下一步 realpath 時被拒絕）。
  let probe = lexicalTarget;
  for (let guard = 0; guard < 64; guard += 1) {
    try {
      lstatSync(probe);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { ok: false, code: "PATH_CHECK_FAILED", message: "無法檢查路徑元件" };
      }
      const parent = dirname(probe);
      if (parent === probe) {
        return { ok: false, code: "PATH_OUTSIDE_ROOT", message: "路徑超出固定 root 範圍" };
      }
      probe = parent;
    }
  }

  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    return { ok: false, code: "SYMLINK_REJECTED", message: "路徑包含 dangling symlink" };
  }
  if (!isInsideWorktree(realProbe, realRoot)) {
    return { ok: false, code: "ROOT_ESCAPE", message: "symlink 解析後超出固定 root" };
  }

  const suffix = relative(probe, lexicalTarget);
  const finalPath = suffix ? join(realProbe, suffix) : realProbe;
  if (!isInsideWorktree(finalPath, realRoot)) {
    return { ok: false, code: "ROOT_ESCAPE", message: "路徑解析後超出固定 root" };
  }

  try {
    const st = lstatSync(finalPath);
    if (st.isSymbolicLink()) {
      return { ok: false, code: "SYMLINK_REJECTED", message: "目標不得是 symlink" };
    }
  } catch {
    // 目標不存在 → 可安全建立
  }
  return { ok: true, value: finalPath };
}

// ─── Frontmatter 解析 ────────────────────────────────────────

export type FrontmatterResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; code: "FRONTMATTER_MISSING" | "FRONTMATTER_PARSE_ERROR"; message: string };

export function parseFrontmatter(raw: string): FrontmatterResult {
  const normalized = raw.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) {
    return { ok: false, code: "FRONTMATTER_MISSING", message: "缺少合法的 SKILL.md frontmatter" };
  }
  try {
    const data = Bun.YAML.parse(match[1]) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("frontmatter 必須是物件");
    }
    return { ok: true, data: data as Record<string, unknown> };
  } catch (error) {
    return { ok: false, code: "FRONTMATTER_PARSE_ERROR", message: `frontmatter 解析失敗：${(error as Error).message}` };
  }
}

// ─── 內容風險掃描 ────────────────────────────────────────────

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/AKIA[0-9A-Z]{16}/, "AWS access key id"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
  [/\bghp_[A-Za-z0-9]{20,}\b/, "GitHub token"],
  [/\bgho_[A-Za-z0-9]{20,}\b/, "GitHub token"],
  [/\bsk-[A-Za-z0-9]{20,}\b/, "API key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
];

const HIGH_RISK_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\b/, "遞迴刪除指令"],
  [/git\s+push\s+(?:--force\b|-f\b)/i, "force push"],
  [/curl\s+[^|;&]*\|\s*(?:ba|z)?sh\b/i, "遠端腳本執行"],
  [/wget\s+[^&;&]*&&\s*(?:ba|z)?sh\b/i, "遠端腳本執行"],
  [/chmod\s+777\b/, "chmod 777"],
  [/\bsudo\s+/i, "sudo 權限提升"],
  [/DROP\s+TABLE\b/i, "破壞性 SQL"],
  [/\bdeploy\s+(?:to\s+)?prod/i, "production deploy"],
];

const WORKFLOW_ID_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:task|plan)-\d{8}-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\b/i, "workflow task/plan ID"],
  [/\bses_[A-Za-z0-9]{8,}\b/, "session ID"],
];

function scanPatterns(content: string, patterns: Array<[RegExp, string]>, code: string): SkillIssue[] {
  const issues: SkillIssue[] = [];
  for (const [pattern, label] of patterns) {
    if (pattern.test(content)) {
      issues.push({ code, message: `偵測到${label}（${code}）` });
    }
  }
  return issues;
}

function isTextContent(buffer: Buffer): boolean {
  for (const byte of buffer) {
    if (byte === 0) return false;
  }
  return true;
}

// ─── Scripts inventory ───────────────────────────────────────

export interface ScriptInventory {
  files: string[];
  executables: string[];
}

/**
 * 走訪 skill 目錄收集相對檔案路徑（排序、跳過隱藏檔）。
 * 安全 invariant：
 *   - bundle 內任何 symlink（含名稱以 . 開頭的 hidden symlink）都必須
 *     fail closed——靜默略過會讓掃描與複製看到被截斷的檔案清單，回傳
 *     第一個 symlink 的 structured issue；回傳 null 表示走訪完成且沒有
 *     symlink。判斷順序：先 lstat 拒絕 symlink，再跳過 hidden 非 symlink
 *     entry；順序顛倒會讓 hidden symlink 逃過檢查。
 *   - 任何 nested directory 的 readdir 或 entry 的 lstat 失敗都必須回傳
 *     structured issue（BUNDLE_READ_FAILED）——把失敗當成功會讓 validate /
 *     promote / scan 把不完整 bundle 當成合法內容靜默截斷。
 */
function bundleReadIssue(baseDir: string, path: string, error: unknown): SkillIssue {
  const rel = relative(baseDir, path).split("\\").join("/");
  const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
  return {
    code: "BUNDLE_READ_FAILED",
    message: `無法讀取 skill bundle 內容（${rel || "."}）：${reason}；fail closed 拒絕處理不完整 bundle`,
  };
}

function walkFiles(dir: string, baseDir: string, out: string[], deps?: SkillerDeps): SkillIssue | null {
  const readDir = deps?.readDirectory ?? ((path: string) => readdirSync(path));
  const statEntry = deps?.entryStat ?? ((path: string) => lstatSync(path));
  let entries: string[];
  try {
    entries = readDir(dir);
  } catch (error) {
    return bundleReadIssue(baseDir, dir, error);
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = statEntry(full);
    } catch (error) {
      return bundleReadIssue(baseDir, full, error);
    }
    if (st === undefined) {
      return bundleReadIssue(baseDir, full, new Error("LSTAT_EMPTY_RESULT"));
    }
    if (st.isSymbolicLink()) {
      // 不論 dangling 或指向 root 外，一律拒絕；不得讀取或追蹤 target。
      return {
        code: "SYMLINK_REJECTED",
        message: `skill bundle 含 symlink（${relative(baseDir, full).split("\\").join("/")}），fail closed 拒絕處理`,
      };
    }
    if (entry.startsWith(".")) continue;
    if (st.isDirectory()) {
      const nested = walkFiles(full, baseDir, out, deps);
      if (nested !== null) return nested;
      continue;
    }
    if (!st.isFile()) continue;
    out.push(relative(baseDir, full).split("\\").join("/"));
  }
  return null;
}

export type ListSkillFilesResult =
  | { ok: true; files: string[] }
  | { ok: false; issue: SkillIssue };

/**
 * 列出 skill 目錄內全部相對檔案路徑；含 symlink 或任一 filesystem 讀取
 * 失敗時 fail closed。deps 僅供 direct factory 測試注入讀取 fault seam。
 */
export function listSkillFiles(skillDir: string, deps?: SkillerDeps): ListSkillFilesResult {
  const files: string[] = [];
  const issue = walkFiles(skillDir, skillDir, files, deps);
  if (issue !== null) return { ok: false, issue };
  return { ok: true, files: files.sort() };
}

/** scripts inventory：由已驗證的檔案清單推導 scripts/ 清單與 executable bit。 */
export function scriptInventoryFromFiles(files: string[], skillDir: string): ScriptInventory {
  return {
    files: files.filter((rel) => rel === "scripts" || rel.startsWith("scripts/")),
    executables: files.filter((rel) => {
      const guarded = containedPath(skillDir, skillDir, rel);
      if (!guarded.ok) return false;
      try {
        return (lstatSync(guarded.value).mode & 0o111) !== 0;
      } catch {
        return false;
      }
    }),
  };
}

// ─── Policy snapshot（唯讀） ─────────────────────────────────

export function loadPolicySnapshot(policyPath: string): { ok: true; policy: PolicySnapshot } | { ok: false; message: string } {
  let raw: string;
  try {
    assertSafeSkillerPath(policyPath);
    raw = readFileSync(policyPath, "utf-8");
  } catch (error) {
    return { ok: false, message: `無法讀取 skills policy：${(error as Error).message}` };
  }
  try {
    const parsed = JSON.parse(raw) as PolicySnapshot;
    return { ok: true, policy: { ...parsed, path: policyPath } };
  } catch (error) {
    return { ok: false, message: `skills policy 解析失敗：${(error as Error).message}` };
  }
}

export function sha256Hex(content: string): string {
  return createSha256(Buffer.from(content, "utf-8"));
}

function createSha256(buffer: Buffer): string {
  // 以 Bun / Node 相容方式計算 SHA-256
  return hashBuffer(buffer);
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * 推導信任等級（trust tier）。
 *
 * Precedence（由高到低，明確且與既有 managed/policy retired 相容）：
 * 1. policy.retired 名單包含 name → retired（policy retired 優先）
 * 2. personal pins 含該 name：
 *    - status retired → retired
 *    - status active + actualDigest 相符 → approved
 *    - status active + actualDigest 不符 → drifted
 *    - status active + actualDigest 為 null → recorded
 * 3. policy.approval.contentDigests 含該 name → approved / drifted / recorded
 * 4. policy.managed → managed
 * 5. policy.approval.agentAllowlist → allowlisted
 * 6. 其他 → unreviewed（若 policy 與 pins 都缺席則 unknown）
 *
 * personalPins 為 null 時略過 pins 檢查，維持既有 policy 行為。
 * 當 personal registry 無法讀取或驗證失敗時（personalRegistryUnavailable=true），
 * 即使 policy 含有相符的 contentDigest，也不得回傳 policy-derived approved/drifted/recorded；
 * 此時僅保留 policy retired 優先，其餘回退為 unreviewed/unknown，確保 fail-closed。
 *
 * managed scope（第六個可選參數）：pins 與 agentAllowlist 一律忽略。
 *   - policy.retired 命中 → retired（與其他 scope 一致）。
 *   - policy 缺席 → unknown。
 *   - name 不在 policy.managed catalog → unreviewed。
 *   - name 在 catalog 內：有 approval.contentDigests 條目時以其驗證 digest，
 *     一致 → managed、不一致 → drifted、actualDigest 為 null → managed；
 *     無 digest 條目時直接 → managed。
 */
export function deriveTrustTier(
  name: string,
  actualDigest: string | null,
  policy: PolicySnapshot | null,
  personalPins: PersonalPinsFile | null = null,
  personalRegistryUnavailable = false,
  scope?: SkillerScope,
): TrustTier {
  if (scope === "managed") {
    if (policy) {
      const retiredLists = Object.values(policy.retired ?? {}).flat();
      if (retiredLists.includes(name)) return "retired";
      if (!(policy.managed && name in policy.managed)) return "unreviewed";
      const recorded = policy.approval?.contentDigests?.[name];
      if (recorded !== undefined) {
        if (actualDigest === null) return "managed";
        return recorded === actualDigest ? "managed" : "drifted";
      }
      return "managed";
    }
    return "unknown";
  }
  if (policy) {
    const retiredLists = Object.values(policy.retired ?? {}).flat();
    if (retiredLists.includes(name)) return "retired";
  }
  if (personalPins) {
    const pin = personalPins.pins[name];
    if (pin) {
      if (pin.status === "retired") return "retired";
      if (pin.status === "active") {
        if (actualDigest === null) return "recorded";
        return pin.digest === actualDigest ? "approved" : "drifted";
      }
    }
  }
  if (personalRegistryUnavailable) {
    // fail-closed：registry 無法使用時不 fallback 到 policy-derived tiers（approved/drifted/recorded/managed/allowlisted）
    if (policy) return "unreviewed";
    if (personalPins) return "unreviewed";
    return "unknown";
  }
  if (policy) {
    const recorded = policy.approval?.contentDigests?.[name];
    if (recorded !== undefined) {
      if (actualDigest === null) return "recorded";
      return recorded === actualDigest ? "approved" : "drifted";
    }
    if (policy.managed && name in policy.managed) return "managed";
    if (policy.approval?.agentAllowlist?.includes(name)) return "allowlisted";
    return "unreviewed";
  }
  // policy 缺席且 pins 無匹配 → unknown（若 pins 有 retired/active 則已在上一步回傳）
  if (personalPins) return "unreviewed";
  return "unknown";
}

// ─── 完整 skill 驗證 ─────────────────────────────────────────

export interface ValidateSkillInput {
  /** skill 目錄（已通過 containment guard）。 */
  skillDir: string;
  /** 目錄名稱／請求名稱。 */
  declaredName: string;
  scope: SkillerScope;
  projectSlug: string;
  policy: PolicySnapshot | null;
  /** personal pins registry（僅 personal scope 有效；null 表示不參與判定）。 */
  personalPins?: PersonalPinsFile | null;
  /** 僅供 direct factory 測試注入 bundle 走訪 fault seam；production 不注入。 */
  deps?: SkillerDeps;
}

export interface SkillValidationResult {
  hasSkillMd: boolean;
  parseOk: boolean;
  frontmatterName: string | null;
  descriptionPresent: boolean;
  namespaceValid: boolean;
  digest: string | null;
  blockers: SkillIssue[];
  warnings: SkillIssue[];
  scripts: ScriptInventory;
  trustTier: TrustTier;
  readiness: "ready" | "blocked";
}

/**
 * 對單一 skill 目錄執行完整驗證。
 * personal / managed scope：所有風險項都是 blocker（fail closed）。
 * project scope：結構問題（frontmatter/name/description/namespace/binary）為 blocker，
 * 風險項（secret/high-risk/workflow/scripts/digest drift）為 warning。
 */
export function validateSkillDir(input: ValidateSkillInput): SkillValidationResult {
  const { skillDir, declaredName, scope, projectSlug, policy, personalPins, deps } = input;
  const blockers: SkillIssue[] = [];
  const warnings: SkillIssue[] = [];

  // bundle 檔案清單：含 symlink 或任一讀取失敗時 fail closed（blocker），
  // 不做任何內容掃描。
  const listed = listSkillFiles(skillDir, deps);
  let scripts: ScriptInventory = { files: [], executables: [] };
  const guardedFiles = new Map<string, string>();
  if (!listed.ok) {
    blockers.push(listed.issue);
  } else {
    for (const rel of listed.files) {
      const guard = containedPath(skillDir, skillDir, rel);
      if (!guard.ok) {
        blockers.push({
          code: "BUNDLE_READ_FAILED",
          message: `無法安全讀取 bundle 檔案（${rel}）：${guard.code}`,
        });
        continue;
      }
      guardedFiles.set(rel, guard.value);
    }
    scripts = scriptInventoryFromFiles(listed.files, skillDir);
  }

  let raw: string | null = null;
  let buffer: Buffer | null = null;
  if (listed.ok) {
    if (!listed.files.includes("SKILL.md")) {
      blockers.push({ code: "BUNDLE_READ_FAILED", message: "缺少 bundle 內受 guard 的 SKILL.md" });
    } else {
      const skillMdPath = guardedFiles.get("SKILL.md");
      if (skillMdPath !== undefined) {
        try {
          buffer = readFileSync(skillMdPath);
          raw = buffer.toString("utf-8");
        } catch {
          blockers.push({ code: "BUNDLE_READ_FAILED", message: "無法讀取受 guard 的 SKILL.md" });
        }
      }
    }
  }

  let frontmatterName: string | null = null;
  let descriptionPresent = false;
  let namespaceValid = false;
  let parseOk = false;

  if (raw === null || buffer === null) {
    blockers.push({ code: "FRONTMATTER_MISSING", message: "缺少 SKILL.md" });
  } else {
    if (!isTextContent(buffer)) {
      blockers.push({ code: "BINARY_CONTENT", message: "SKILL.md 含二進位內容" });
    }
    const fm = parseFrontmatter(raw);
    if (!fm.ok) {
      blockers.push({ code: fm.code, message: fm.message });
    } else {
      parseOk = true;
      const nameValue = fm.data.name;
      if (typeof nameValue !== "string" || nameValue.trim().length === 0) {
        blockers.push({ code: "NAME_REQUIRED", message: "frontmatter 缺少 name" });
      } else {
        frontmatterName = nameValue.trim();
        if (frontmatterName !== declaredName) {
          blockers.push({ code: "NAME_MISMATCH", message: `frontmatter name（${frontmatterName}）與目錄名稱（${declaredName}）不一致` });
        }
      }
      const description = fm.data.description;
      descriptionPresent = typeof description === "string" && description.trim().length > 0;
      if (!descriptionPresent) {
        blockers.push({ code: "DESCRIPTION_REQUIRED", message: "frontmatter 缺少非空 description" });
      }
      const expectedPrefix = scope === "project" ? `project-${projectSlug}-` : scope === "managed" ? null : "personal-";
      namespaceValid = typeof frontmatterName === "string" &&
        (scope === "managed"
          ? validateSkillName(frontmatterName, "managed", projectSlug).ok
          : frontmatterName.startsWith(expectedPrefix!));
      if (!namespaceValid) {
        blockers.push({ code: "NAMESPACE_INVALID", message: `name namespace 不符 ${scope} scope 規範` });
      }

      blockers.push(...scanPatterns(raw, SECRET_PATTERNS, "SECRET_MARKER"));
      blockers.push(...scanPatterns(raw, HIGH_RISK_PATTERNS, "HIGH_RISK_MARKER"));
      blockers.push(...scanPatterns(raw, WORKFLOW_ID_PATTERNS, "WORKFLOW_ID_MARKER"));
    }
  }

  if (scripts.files.length > 0) {
    const issue: SkillIssue = { code: "SCRIPTS_PRESENT", message: `skill 包含 scripts（${scripts.files.join(", ")}），需逐檔審查` };
    (scope === "project" ? warnings : blockers).push(issue);
  }
  if (scripts.executables.length > 0) {
    const issue: SkillIssue = { code: "EXECUTABLE_SCRIPT", message: `scripts 帶 executable bit（${scripts.executables.join(", ")}）` };
    (scope === "project" ? warnings : blockers).push(issue);
  }

  // bundle 級風險掃描：SKILL.md 以外的可讀文字檔同樣可能挾帶 secret /
  // high-risk / workflow ID marker；只掃 SKILL.md 會讓風險藏在附帶檔案裡。
  // 二進位與不可讀檔案不掃描內容，由 scripts inventory 與複製階段把關。
  if (listed.ok) {
    for (const rel of listed.files) {
      if (rel === "SKILL.md") continue;
      const guardedPath = guardedFiles.get(rel);
      if (guardedPath === undefined) continue;
      let buffer: Buffer;
      try {
        buffer = readFileSync(guardedPath);
      } catch {
        blockers.push({ code: "BUNDLE_READ_FAILED", message: `無法讀取受 guard 的 bundle 檔案（${rel}）` });
        continue;
      }
      if (!isTextContent(buffer)) continue;
      const text = buffer.toString("utf-8");
      const withFile = (issues: SkillIssue[]): void => {
        for (const issue of issues) blockers.push({ ...issue, message: `${issue.message}（檔案：${rel}）` });
      };
      withFile(scanPatterns(text, SECRET_PATTERNS, "SECRET_MARKER"));
      withFile(scanPatterns(text, HIGH_RISK_PATTERNS, "HIGH_RISK_MARKER"));
      withFile(scanPatterns(text, WORKFLOW_ID_PATTERNS, "WORKFLOW_ID_MARKER"));
    }
  }

  const digest = raw !== null ? sha256Hex(raw) : null;
  const tier = deriveTrustTier(declaredName, digest, policy, personalPins ?? null, false, scope);
  if (tier === "drifted") {
    const issue: SkillIssue = { code: "POLICY_DIGEST_DRIFT", message: "內容與既有 policy 核准 digest 不一致，需重新審查" };
    (scope === "project" ? warnings : blockers).push(issue);
  }

  // 注意：風險項（secret/high-risk/workflow ID/scripts）在 validate 層一律以
  // blocker 如實回報；scope 分級（project 降級為 warning）由 promote 在 apply
  // 決策時處理，避免 validate 低估發現。

  return {
    hasSkillMd: raw !== null,
    parseOk,
    frontmatterName,
    descriptionPresent,
    namespaceValid,
    digest,
    blockers,
    warnings,
    scripts,
    trustTier: tier,
    readiness: blockers.length === 0 ? "ready" : "blocked",
  };
}

// ─── Bundle 相對路徑驗證 ─────────────────────────────────────

/** bundle 內單一檔案的相對路徑上限：深度與長度都收斂，避免病態路徑。 */
const BUNDLE_PATH_MAX_LENGTH = 200;
const BUNDLE_PATH_MAX_DEPTH = 4;
const BUNDLE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 驗證 bundle 內的相對檔案路徑（供 skiller-draft 的多檔 bundle 與
 * draft-read / draft-update / draft-delete 的單檔定位共用）。
 *
 * 規則（fail closed，與 containedPath 互補而非取代）：
 *   - 必須是非空字串，長度 ≤ 200，深度 ≤ 4。
 *   - 一律使用 `/` 分隔；不接受絕對路徑、`\`、`.`、`..` 或空 segment。
 *   - 每個 segment 必須以英數字開頭，只允許英數字與 `._-`；隱藏檔
 *     （`.` 開頭）被排除，因為 listSkillFiles 會略過隱藏檔，寫進去會
 *     變成 scan / promote 看不見的幽靈檔案。
 */
export function validateBundleRelativePath(rawPath: unknown): GuardResult<string> {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return { ok: false, code: "INVALID_BUNDLE_PATH", message: "bundle 檔案路徑必須是非空字串" };
  }
  const rel = rawPath.trim();
  if (rel.length > BUNDLE_PATH_MAX_LENGTH) {
    return { ok: false, code: "INVALID_BUNDLE_PATH", message: `bundle 檔案路徑長度不得超過 ${BUNDLE_PATH_MAX_LENGTH} 字元` };
  }
  if (isAbsolute(rel) || rel.includes("\\")) {
    return { ok: false, code: "INVALID_BUNDLE_PATH", message: "bundle 檔案路徑不得是絕對路徑或含反斜線" };
  }
  const segments = rel.split("/");
  if (segments.length > BUNDLE_PATH_MAX_DEPTH) {
    return { ok: false, code: "INVALID_BUNDLE_PATH", message: `bundle 檔案路徑深度不得超過 ${BUNDLE_PATH_MAX_DEPTH} 層` };
  }
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      return { ok: false, code: "INVALID_BUNDLE_PATH", message: "bundle 檔案路徑不得含空 segment、. 或 .." };
    }
    if (!BUNDLE_SEGMENT_PATTERN.test(segment)) {
      return {
        ok: false,
        code: "INVALID_BUNDLE_PATH",
        message: `bundle 檔案路徑的每一段只能以英數字開頭並使用英數字與 ._-（違規：${segment}）`,
      };
    }
  }
  return { ok: true, value: rel };
}

// ─── Skill 目錄定位（draft / skill / quarantine 共用） ───────

export type SkillSourceKind = "draft" | "skill" | "quarantine";

export interface LocatedSkillDir {
  kind: SkillSourceKind;
  /** 已通過 containment guard 的 skill 目錄絕對路徑。 */
  dir: string;
  /** 對應 root 的 canonical（realpath）路徑。 */
  rootReal: string;
  /** 對應 root 的 lexical 路徑（containedPath 的 lexical anchor）。 */
  rootLexical: string;
}

export function rootForKind(roots: ScopeRoots, kind: SkillSourceKind): string {
  if (kind === "draft") return roots.draftRoot;
  if (kind === "skill") return roots.skillRoot;
  return roots.quarantineRoot;
}

/**
 * 在指定 root 下定位一個既有 skill 目錄。
 *
 * 安全順序不可調換：先 scoped fixed-root guard，再 containedPath，最後才
 * 對目標做 statSync。root guard 失敗時如實回傳 escape / symlink 代碼，
 * 只有「root 不存在」才折算成 NOT_FOUND，避免把安全異常靜默吞成找不到。
 */
export function locateSkillDir(
  kind: SkillSourceKind,
  scope: SkillerScope,
  name: string,
  deps: SkillerDeps,
  context?: ToolExecutionContext,
): GuardResult<LocatedSkillDir> {
  const roots = resolveScopeRoots(scope, deps, context);
  const rootLexical = rootForKind(roots, kind);
  const rootGuard = ensureScopedFixedRoot(rootLexical, scope, deps, context);
  if (!rootGuard.ok) {
    if (rootGuard.code === "UNKNOWN_ROOT") {
      return { ok: false, code: "NOT_FOUND", message: `找不到 ${kind}：${name}` };
    }
    return rootGuard;
  }
  const guard = containedPath(rootGuard.value, rootLexical, name);
  if (!guard.ok) return guard;
  try {
    if (!statSync(guard.value).isDirectory()) {
      return { ok: false, code: "NOT_FOUND", message: `找不到 ${kind}：${name}` };
    }
  } catch {
    return { ok: false, code: "NOT_FOUND", message: `找不到 ${kind}：${name}` };
  }
  return { ok: true, value: { kind, dir: guard.value, rootReal: rootGuard.value, rootLexical } };
}

// ─── Managed agent 路由（agents/*.md permission.skill exact 行） ──

/**
 * managed 路由閉環共用的 agent 檔行級編輯器。
 *
 * 只動既有 `permission.skill` 區塊內的單行插入／移除，frontmatter 其他
 * 內容與正文逐字保留（含原始行尾 LF／CRLF）；結構異常（缺 frontmatter、
 * 缺 skill 區塊、縮排不符預期、孤立 CR、混合行尾）一律 fail closed 回報
 * skipped/malformed，不猜測結構、不建立結構。
 *
 * 區塊邊界：第一個空行即視為區塊結束，其後的 key 行不屬於區塊；
 * 空行本身保留。插入位置：最後一條 glob 之後、按 key 排序應屬的位置，
 * 保證後面沒有 glob 能在 last-match 下蓋掉這條 exact allow。
 */

const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_BLOCK_KEY_LINE = "  skill:";
const SKILL_ENTRY_PATTERN = /^    ("[^"]+"|[^\s:]+):\s*(\S+)\s*$/;
const DEDENTED_LINE_PATTERN = /^ {0,2}\S/;

export type AgentSkillEditStatus =
  | "inserted"
  | "already-present"
  | "removed"
  | "absent"
  | "skipped-no-skill-block"
  | "malformed";

export interface AgentSkillEdit {
  status: AgentSkillEditStatus;
  /** 套用編輯後的新全文；skipped/malformed/already-present/absent 時為 null。 */
  content: string | null;
  /** 目前該 skill 在區塊內的值（insert/remove 前）；沒有時為 null。 */
  currentValue: string | null;
}

function splitFrontmatter(raw: string): { head: string; fmText: string; tail: string; eol: "\n" | "\r\n" } | null {
  // 孤立 CR（不屬於 CRLF 的一部分）一律 fail closed，不猜測行尾。
  if (/\r(?!\n)/.test(raw)) return null;
  const eol: "\n" | "\r\n" = raw.includes("\r\n") ? "\r\n" : "\n";
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(raw);
  if (!match) return null;
  const fmText = match[1]!;
  // 混合行尾 fail closed：CRLF 文件的 frontmatter 區內不得出現裸 LF。
  // tail（含結尾 `---` 與正文）一律以原始 slice 保留，不參與判定。
  if (eol === "\r\n" && /(?<!\r)\n/.test(fmText)) return null;
  const openNl = raw.startsWith("---\r\n") ? "---\r\n".length : "---\n".length;
  const fmStart = openNl;
  const fmEnd = fmStart + fmText.length;
  return { head: raw.slice(0, fmStart), fmText, tail: raw.slice(fmEnd), eol };
}

function unquoteKey(key: string): string {
  return key.length >= 2 && key.startsWith('"') && key.endsWith('"') ? key.slice(1, -1) : key;
}

interface SkillBlockSpan {
  keyLineIdx: number;
  firstEntryIdx: number;
  endEntryIdx: number;
}

/** 定位 skill 區塊；回傳 null 表示缺區塊，拋錯表示結構異常。 */
function locateSkillBlock(lines: string[]): SkillBlockSpan | null {
  const keyIdx = lines.findIndex((line) => line === SKILL_BLOCK_KEY_LINE);
  if (keyIdx === -1) return null;
  let cursor = keyIdx + 1;
  while (cursor < lines.length) {
    const line = lines[cursor]!;
    if (SKILL_ENTRY_PATTERN.exec(line)) {
      cursor += 1;
      continue;
    }
    // 空行視為區塊結束（空行本身保留，不視為異常）。
    if (line.trim().length === 0) break;
    if (!DEDENTED_LINE_PATTERN.test(line) && line.startsWith(" ")) {
      throw new Error("skill 區塊後出現非預期的縮排行");
    }
    break;
  }
  return { keyLineIdx: keyIdx, firstEntryIdx: keyIdx + 1, endEntryIdx: cursor };
}

/** frontmatter 區的行切分（行尾已由 splitFrontmatter 把關一致性）。 */
function splitFmLines(fmText: string): string[] {
  return fmText.split(/\r?\n/);
}

/** 插入 `    <skillName>: allow`；已存在同名 exact 行時冪等回報。 */
export function insertAgentSkillAllow(raw: string, skillName: string): AgentSkillEdit {
  const split = splitFrontmatter(raw);
  if (!split) return { status: "malformed", content: null, currentValue: null };
  const lines = splitFmLines(split.fmText);
  let span: SkillBlockSpan | null;
  try {
    span = locateSkillBlock(lines);
  } catch {
    return { status: "malformed", content: null, currentValue: null };
  }
  if (!span) return { status: "skipped-no-skill-block", content: null, currentValue: null };
  for (let i = span.firstEntryIdx; i < span.endEntryIdx; i += 1) {
    const entry = SKILL_ENTRY_PATTERN.exec(lines[i]!)!;
    if (unquoteKey(entry[1]!) === skillName) {
      return { status: "already-present", content: null, currentValue: entry[2]! };
    }
  }
  // 插入位置：最後一條 glob 之後、按 key 排序應屬的位置。既有 exact 區段
  // 本來就是排序好的（契約測試要求檔內順序即排序），這樣新行落在排序位置；
  // 同時保證後面沒有 glob 能在 last-match 下蓋掉這條 exact allow。
  let insertAt = span.endEntryIdx;
  let lastGlobIdx = span.firstEntryIdx - 1;
  for (let i = span.firstEntryIdx; i < span.endEntryIdx; i += 1) {
    const entry = SKILL_ENTRY_PATTERN.exec(lines[i]!)!;
    if (unquoteKey(entry[1]!).includes("*")) lastGlobIdx = i;
  }
  for (let i = lastGlobIdx + 1; i < span.endEntryIdx; i += 1) {
    const entry = SKILL_ENTRY_PATTERN.exec(lines[i]!)!;
    if (unquoteKey(entry[1]!) > skillName) {
      insertAt = i;
      break;
    }
  }
  const next = [...lines];
  next.splice(insertAt, 0, `    ${skillName}: allow`);
  // 以原檔行尾重組：head 與 tail 皆為原始 slice，只動目標行。
  return { status: "inserted", content: `${split.head}${next.join(split.eol)}${split.tail}`, currentValue: null };
}

/** 移除 key 為 skillName 的 exact 行（無論值為 allow/ask/deny）。 */
export function removeAgentSkillLine(raw: string, skillName: string): AgentSkillEdit {
  const split = splitFrontmatter(raw);
  if (!split) return { status: "malformed", content: null, currentValue: null };
  const lines = splitFmLines(split.fmText);
  let span: SkillBlockSpan | null;
  try {
    span = locateSkillBlock(lines);
  } catch {
    return { status: "malformed", content: null, currentValue: null };
  }
  if (!span) return { status: "skipped-no-skill-block", content: null, currentValue: null };
  let currentValue: string | null = null;
  const next = lines.filter((line, idx) => {
    if (idx < span!.firstEntryIdx || idx >= span!.endEntryIdx) return true;
    const entry = SKILL_ENTRY_PATTERN.exec(line)!;
    if (unquoteKey(entry[1]!) === skillName) {
      currentValue = entry[2]!;
      return false;
    }
    return true;
  });
  if (currentValue === null) return { status: "absent", content: null, currentValue: null };
  return { status: "removed", content: `${split.head}${next.join(split.eol)}${split.tail}`, currentValue };
}

export type AgentRoutingFileStatus = "updated" | "already-present" | "absent" | "skipped" | "failed";

export interface AgentRoutingFileResult {
  agent: string;
  file: string;
  status: AgentRoutingFileStatus;
  detail?: string;
}

/** 驗證 targetAgents 名稱形狀；回傳去空白後的乾淨清單或第一個非法名稱。 */
export function normalizeTargetAgents(raw: unknown): { ok: true; agents: string[] } | { ok: false; invalid: string } {
  if (!Array.isArray(raw)) return { ok: true, agents: [] };
  const agents: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim().length === 0) return { ok: false, invalid: String(item) };
    const name = item.trim();
    if (!AGENT_NAME_PATTERN.test(name)) return { ok: false, invalid: item };
    if (!agents.includes(name)) agents.push(name);
  }
  return { ok: true, agents };
}

/**
 * 在任何 mutation 之前預檢 targetAgents：名稱形狀＋檔案存在＋非 symlink。
 * 回傳第一個未知 agent；缺 skill 區塊不在此階段判定（edit 時回報 skipped）。
 */
export function prevalidateTargetAgents(agentsRoot: string, agents: string[]): { ok: true } | { ok: false; unknownAgent: string; reason: string } {
  for (const agent of agents) {
    const file = resolve(join(agentsRoot, `${agent}.md`));
    if (!isInsideWorktree(file, resolve(agentsRoot))) {
      return { ok: false, unknownAgent: agent, reason: "路徑超出 agents 目錄範圍" };
    }
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(file);
    } catch {
      return { ok: false, unknownAgent: agent, reason: `找不到 agents/${agent}.md` };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, unknownAgent: agent, reason: `agents/${agent}.md 是 symlink，拒絕寫入` };
    }
    if (!st.isFile()) {
      return { ok: false, unknownAgent: agent, reason: `agents/${agent}.md 不是一般檔案` };
    }
  }
  return { ok: true };
}

function writeAgentFileAtomic(file: string, content: string, deps?: SkillerDeps): void {
  const injected = deps?.writeFile;
  atomicWriteFileWithOps(file, content, {
    writeFileSync: ((path: unknown, data: unknown, options: unknown) => {
      if (typeof path !== "string") throw new TypeError("agent 檔案路徑必須是字串");
      const text = typeof data === "string" ? data : Buffer.from(String(data)).toString("utf-8");
      if (injected) {
        injected(path, text);
        return;
      }
      writeFileSync(path, text, { encoding: "utf-8", flag: "wx" });
    }) as unknown as typeof writeFileSync,
    renameSync,
    existsSync,
    unlinkSync,
  });
}

function editOneAgentFile(
  agentsRoot: string,
  agent: string,
  skillName: string,
  mode: "insert" | "remove",
  deps?: SkillerDeps,
): AgentRoutingFileResult {
  const file = resolve(join(agentsRoot, `${agent}.md`));
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (error) {
    return { agent, file, status: "failed", detail: `讀取失敗：${(error as Error).message}` };
  }
  const edit = mode === "insert" ? insertAgentSkillAllow(raw, skillName) : removeAgentSkillLine(raw, skillName);
  if (edit.status === "already-present") return { agent, file, status: "already-present", detail: `已存在（${edit.currentValue}），未重複插入` };
  if (edit.status === "absent") return { agent, file, status: "absent", detail: "沒有該 skill 的 exact 行，無需變更" };
  if (edit.status === "skipped-no-skill-block") {
    return { agent, file, status: "skipped", detail: "缺少 permission.skill 區塊，不建立結構" };
  }
  if (edit.status === "malformed" || edit.content === null) {
    return { agent, file, status: "skipped", detail: "frontmatter 結構異常，fail closed 不寫入" };
  }
  try {
    writeAgentFileAtomic(file, edit.content, deps);
  } catch (error) {
    return { agent, file, status: "failed", detail: `原子寫入失敗，原檔不變：${(error as Error).message}` };
  }
  return { agent, file, status: "updated", detail: mode === "insert" ? "已插入 exact allow 行" : `已移除 exact 行（原值 ${edit.currentValue}）` };
}

/**
 * 對指定 agent 清單（insert／remove）或全部 agent 檔（remove 全掃描）套用
 * 路由編輯。每檔獨立原子寫入；單檔失敗不影響其他檔，原檔不變。
 *
 * agents 為 null 時掃描 agentsRoot 內全部 *.md（retire 用）；目錄不可讀時
 * 回傳單筆 failed，不拋錯——呼叫端的主流程（quarantine 移動）不受影響，
 * 路由結果如實回報即可。
 */
export function applyAgentSkillRouting(
  agentsRoot: string,
  skillName: string,
  mode: "insert" | "remove",
  agents: string[] | null,
  deps?: SkillerDeps,
): AgentRoutingFileResult[] {
  let targets = agents;
  if (targets === null) {
    let entries: string[];
    try {
      entries = readdirSync(agentsRoot);
    } catch (error) {
      return [{ agent: "(scan)", file: agentsRoot, status: "failed", detail: `無法列舉 agents 目錄：${(error as Error).message}` }];
    }
    targets = entries
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => entry.slice(0, -3))
      .sort();
  }
  return targets.map((agent) => editOneAgentFile(agentsRoot, agent, skillName, mode, deps));
}

/**
 * 唯讀預覽路由編輯：回傳每個目標檔會發生什麼事，不寫入任何檔案。
 * 讀取失敗的檔案回報 failed；agents 為 null 時掃描全部 *.md。
 */
export function previewAgentSkillRouting(
  agentsRoot: string,
  skillName: string,
  mode: "insert" | "remove",
  agents: string[] | null,
): Array<{ agent: string; file: string; planned: AgentRoutingFileStatus; detail?: string }> {
  let targets = agents;
  if (targets === null) {
    let entries: string[];
    try {
      entries = readdirSync(agentsRoot);
    } catch (error) {
      return [{ agent: "(scan)", file: agentsRoot, planned: "failed", detail: `無法列舉 agents 目錄：${(error as Error).message}` }];
    }
    targets = entries
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => entry.slice(0, -3))
      .sort();
  }
  return targets.map((agent) => {
    const file = resolve(join(agentsRoot, `${agent}.md`));
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch (error) {
      return { agent, file, planned: "failed" as const, detail: `讀取失敗：${(error as Error).message}` };
    }
    const edit = mode === "insert" ? insertAgentSkillAllow(raw, skillName) : removeAgentSkillLine(raw, skillName);
    switch (edit.status) {
      case "inserted":
        return { agent, file, planned: "updated" as const, detail: `將插入 \`    ${skillName}: allow\`` };
      case "removed":
        return { agent, file, planned: "updated" as const, detail: `將移除 exact 行（現值 ${edit.currentValue}）` };
      case "already-present":
        return { agent, file, planned: "already-present" as const, detail: "已存在，不重複插入" };
      case "absent":
        return { agent, file, planned: "absent" as const, detail: "沒有該 skill 的 exact 行" };
      case "skipped-no-skill-block":
        return { agent, file, planned: "skipped" as const, detail: "缺少 permission.skill 區塊" };
      default:
        return { agent, file, planned: "skipped" as const, detail: "frontmatter 結構異常" };
    }
  });
}

/**
 * 進 discovery root 前可依 scope 降級的風險代碼。
 *
 * personal / managed scope 一律維持 blocker（fail closed）；project scope 把這些降級為
 * 回報用 warning，結構性問題（frontmatter / name / namespace / bundle 讀取
 * 失敗）則不分 scope 都擋。
 */
export const SCOPE_DOWNGRADABLE_RISK_CODES: ReadonlySet<string> = new Set([
  "SECRET_MARKER",
  "HIGH_RISK_MARKER",
  "WORKFLOW_ID_MARKER",
  "SCRIPTS_PRESENT",
  "EXECUTABLE_SCRIPT",
  "POLICY_DIGEST_DRIFT",
]);

/**
 * 檢查 policy.scriptReviews 是否以 status "reviewed" 的紀錄完整覆蓋目前
 * scripts inventory 的每一個檔案。覆蓋以「inventory ⊆ 審查清單」為準：
 * 審查之後新增任何未審查的 script 都會讓覆蓋失敗、維持阻擋，舊紀錄
 * 無法冒用於已漂移的內容。
 */
function scriptsFullyReviewed(
  policy: PolicySnapshot | null,
  skillName: string | null,
  scripts: ScriptInventory,
): boolean {
  if (scripts.files.length === 0) return true;
  if (!policy || !skillName) return false;
  const entry = policy.scriptReviews?.[skillName];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  if (record.status !== "reviewed") return false;
  const files = Array.isArray(record.files) ? record.files : [];
  const reviewed = new Set(files.filter((file): file is string => typeof file === "string"));
  return scripts.files.every((file) => reviewed.has(file));
}

const SCRIPT_PROCESS_BLOCKER_CODES = new Set(["SCRIPTS_PRESENT", "EXECUTABLE_SCRIPT"]);

/**
 * 依 scope 把 validate 的發現重新分成實際阻擋用的 blockers 與回報用 warnings。
 * validate 層一律以 blocker 如實回報，分級只發生在「要寫進 discovery root」
 * 的決策點，避免 validate 低估發現。
 *
 * managed / personal：scripts 相關 blocker（SCRIPTS_PRESENT / EXECUTABLE_SCRIPT）
 * 在 policy.scriptReviews 的審查紀錄完整覆蓋目前全部 scripts 時降級為 warning；
 * 內容層風險（secret / high-risk / workflow ID / digest drift）一律維持 blocker。
 */
export function partitionIssuesForScope(
  validation: Pick<SkillValidationResult, "blockers" | "warnings" | "scripts">,
  scope: SkillerScope,
  context?: { policy?: PolicySnapshot | null; skillName?: string },
): { blockers: SkillIssue[]; warnings: SkillIssue[] } {
  if (scope !== "project") {
    if (!scriptsFullyReviewed(context?.policy ?? null, context?.skillName ?? null, validation.scripts)) {
      return { blockers: validation.blockers, warnings: validation.warnings };
    }
    const blockers = validation.blockers.filter((issue) => !SCRIPT_PROCESS_BLOCKER_CODES.has(issue.code));
    const downgraded = validation.blockers.filter((issue) => SCRIPT_PROCESS_BLOCKER_CODES.has(issue.code));
    return { blockers, warnings: [...validation.warnings, ...downgraded] };
  }
  const blockers: SkillIssue[] = [];
  const warnings: SkillIssue[] = [...validation.warnings];
  for (const issue of validation.blockers) {
    if (SCOPE_DOWNGRADABLE_RISK_CODES.has(issue.code)) warnings.push(issue);
    else blockers.push(issue);
  }
  return { blockers, warnings };
}

// ─── 統一 mutation 框架：鎖內全量 fresh-load＋全量重驗 ────────
//
// 不變條件（全 skiller mutation 工具共用，逐點補丁不得繞過）：
//   - 每個 mutation 一律經 `withFreshSkillerLock` 取對應 scope 鎖；鎖內第一件事
//     就是 `loadFreshSkillerSnapshot`：重解 roots、重推 projectSlug、重載 policy、
//     重讀 pins。鎖內決策只准用 `fresh` 的欄位與其純函式推導。
//   - 允許在鎖內重用的只有兩類：(a) 不可變的 tool args（正規化後的 scope／name／
//     mode／confirm／overwrite／原始字串陣列）；(b) 由 fresh 快照算出的值。
//     任何鎖前讀到的 filesystem 狀態（roots、policy、pins、listing、digest、
//     validation、partition 結果、存在性判斷、guard 路徑）都不得在鎖內使用。
//   - 進入 discovery root 的操作（promote、restore）一律經 `validateLockedBundle`
//     跑完整 `validateSkillDir`＋`partitionIssuesForScope`；只比 SKILL.md digest
//     不算重驗。promote 刻意不把 pins 餵進 validate（新內容會自己判自己 drift），
//     改以回報用 tier＋warning 呈現，見 promote 內的說明。
//   - preview／fail-fast 用的鎖前讀取照舊（不取鎖、不寫入），但它們的結果只做
//     回報與早期拒絕，不作為鎖內寫入的依據。

/** 鎖內唯一可信的狀態快照：全部欄位都在取鎖成功後當場從磁碟讀出。 */
export interface SkillerFreshSnapshot {
  scope: SkillerScope;
  /** 正規化後的 skill 名稱（不可變 args 的回音，供 helper 免重傳）。 */
  name: string;
  /** 鎖內重推的 project slug（取代鎖外算好的值）。 */
  projectSlug: string;
  /** 鎖內重解的 scope roots（取代鎖外的 roots）。 */
  roots: ScopeRoots;
  /** 鎖內重載的 policy；讀不到或 parse 失敗時為 null（validate 照舊處理）。 */
  policy: PolicySnapshot | null;
  /** personal scope 鎖內重讀的 pins；載入失敗時為 null 並以 pinsError 回報。 */
  pinsFile: PersonalPinsFile | null;
  /** personal scope 的 pins 路徑（固定常數或測試注入，非 policy 內容）。 */
  pinsPath: string | null;
  /** personal scope pins 載入失敗的結構化原因；其他 scope 一律為 null。 */
  pinsError: { code: string; message: string } | null;
}

/**
 * 在鎖內從磁碟重建全量快照。呼叫位置必須在 `withContentWriteLock` 臨界區內；
 * 放在鎖外呼叫只會拿到與既有鎖前讀取同等陳舊的資料，框架不為此背書。
 */
export function loadFreshSkillerSnapshot(
  scope: SkillerScope,
  name: string,
  deps: SkillerDeps,
  context?: ToolExecutionContext,
): SkillerFreshSnapshot {
  const roots = resolveScopeRoots(scope, deps, context);
  const projectSlug = deriveProjectSlug(resolve(deps.resolveProjectRoot(context)));
  const policyLoad = loadPolicySnapshot(resolvePolicyPath(deps));
  const policy = policyLoad.ok ? policyLoad.policy : null;
  let pinsFile: PersonalPinsFile | null = null;
  let pinsPath: string | null = null;
  let pinsError: SkillerFreshSnapshot["pinsError"] = null;
  if (scope === "personal") {
    pinsPath = resolvePersonalPinsPath(deps, policy);
    const loaded = loadPersonalPins(pinsPath);
    if (loaded.ok) pinsFile = loaded.pins;
    else pinsError = { code: loaded.code, message: loaded.message };
  }
  return { scope, name, projectSlug, roots, policy, pinsFile, pinsPath, pinsError };
}

/**
 * 單一取鎖入口：取 scope 對應的寫入鎖，鎖內重建快照後才執行 mutation。
 * callback 只接收 `fresh`；外層鎖前變數在型別上仍可見，約束靠本檔不變條件、
 * 各工具的審查對照表與 51 號鎖新鮮度測試共同保證。
 */
export async function withFreshSkillerLock<T>(
  scope: SkillerScope,
  name: string,
  deps: SkillerDeps,
  context: ToolExecutionContext | undefined,
  fn: (fresh: SkillerFreshSnapshot) => Promise<T>,
): Promise<T> {
  return withSkillerWriteLock(resolveSkillerLockPath(scope, deps, context), async () => {
    return fn(loadFreshSkillerSnapshot(scope, name, deps, context));
  });
}

/** 鎖內 bundle 驗證的完整結論：定位＋走訪＋digest＋全量驗證＋分級，一次到位。 */
export interface SkillerBundleVerdict {
  /** 鎖內定位的來源目錄（mutation 必須用此路徑，不得用鎖外的）。 */
  sourceDir: string;
  /** 來源 root 的 canonical 路徑（staging 複製的 containment anchor）。 */
  rootReal: string;
  /** 鎖內重建的 bundle 檔案清單（排序後）。 */
  listing: string[];
  /** SKILL.md 的 SHA-256（快照內容算出，非鎖外沿用）。 */
  digest: string;
  validation: SkillValidationResult;
  blockers: SkillIssue[];
  warnings: SkillIssue[];
}

export type BundleVerdictError = { ok: false; code: string; message: string };

/**
 * 鎖內全量重驗：定位來源 → 重建 listing → 重讀 SKILL.md → 跑完整
 * `validateSkillDir`（policy 與 pins 一律用 fresh 快照的）→ 依 scope 分級。
 *
 * `pinsForValidation`：要餵進 validate 的 pins。promote 傳 null（新內容不與
 * 舊 pin 比 digest，漂移改走回報用 tier）；restore 傳 `fresh.pinsFile`。
 * 呼叫端不得拿鎖外的 validation／partition 結果來代替本函式的回傳。
 */
export function validateLockedBundle(
  kind: SkillSourceKind,
  fresh: SkillerFreshSnapshot,
  deps: SkillerDeps,
  pinsForValidation: PersonalPinsFile | null,
  context?: ToolExecutionContext,
): { ok: true; verdict: SkillerBundleVerdict } | BundleVerdictError {
  const located = locateSkillDir(kind, fresh.scope, fresh.name, deps, context);
  if (!located.ok) {
    if (located.code === "NOT_FOUND") {
      return { ok: false, code: "CONTENT_CHANGED", message: "等待寫入鎖期間來源已改變；未寫入任何檔案。" };
    }
    return { ok: false, code: located.code, message: located.message };
  }
  const listing = listSkillFiles(located.value.dir, deps);
  if (!listing.ok) {
    return { ok: false, code: "CONTENT_CHANGED", message: "等待寫入鎖期間 bundle 已改變；未寫入任何檔案。" };
  }
  if (!listing.files.includes("SKILL.md")) {
    return { ok: false, code: "CONTENT_CHANGED", message: "等待寫入鎖期間 bundle 缺少 SKILL.md；未寫入任何檔案。" };
  }
  const metaGuard = containedPath(located.value.dir, located.value.dir, "SKILL.md");
  if (!metaGuard.ok) {
    return { ok: false, code: "CONTENT_CHANGED", message: "等待寫入鎖期間 SKILL.md 路徑已改變；未寫入任何檔案。" };
  }
  let raw: string;
  try {
    raw = readFileSync(metaGuard.value, "utf-8");
  } catch {
    return { ok: false, code: "CONTENT_CHANGED", message: "等待寫入鎖期間 SKILL.md 已改變；未寫入任何檔案。" };
  }
  const digest = sha256Hex(raw);
  const validation = validateSkillDir({
    skillDir: located.value.dir,
    declaredName: fresh.name,
    scope: fresh.scope,
    projectSlug: fresh.projectSlug,
    policy: fresh.policy,
    personalPins: pinsForValidation,
    deps,
  });
  const { blockers, warnings } = partitionIssuesForScope(validation, fresh.scope, {
    policy: fresh.policy,
    skillName: fresh.name,
  });
  return {
    ok: true,
    verdict: {
      sourceDir: located.value.dir,
      rootReal: located.value.rootReal,
      listing: [...listing.files].sort(),
      digest,
      validation,
      blockers,
      warnings,
    },
  };
}

/**
 * 鎖內新鮮來源定位（不跑內容驗證）：給 retire 這種「只搬運、不進入
 * discovery root」的操作用。回傳鎖內重讀的 digest 與 frontmatter 摘要，
 * 呼叫端不得沿用鎖外的 digest／metadata。
 */
export interface SkillerFreshSource {
  sourceDir: string;
  rootReal: string;
  listing: string[];
  digest: string;
  frontmatterName: string | null;
  description: string | null;
}

export function locateFreshSource(
  kind: SkillSourceKind,
  fresh: SkillerFreshSnapshot,
  deps: SkillerDeps,
  context?: ToolExecutionContext,
): { ok: true; source: SkillerFreshSource } | BundleVerdictError {
  const located = locateSkillDir(kind, fresh.scope, fresh.name, deps, context);
  if (!located.ok) {
    if (located.code === "NOT_FOUND") {
      return { ok: false, code: "CONTENT_CHANGED", message: "等待寫入鎖期間來源已改變；未移動任何檔案。" };
    }
    return { ok: false, code: located.code, message: located.message };
  }
  const listing = listSkillFiles(located.value.dir, deps);
  if (!listing.ok || !listing.files.includes("SKILL.md")) {
    return { ok: false, code: "CONTENT_CHANGED", message: "等待寫入鎖期間 bundle 已改變；未移動任何檔案。" };
  }
  const metaGuard = containedPath(located.value.dir, located.value.dir, "SKILL.md");
  if (!metaGuard.ok) {
    return { ok: false, code: metaGuard.code, message: metaGuard.message };
  }
  let raw: string;
  try {
    raw = readFileSync(metaGuard.value, "utf-8");
  } catch {
    return { ok: false, code: "CONTENT_CHANGED", message: "等待寫入鎖期間 SKILL.md 已改變；未移動任何檔案。" };
  }
  const fm = parseFrontmatter(raw);
  return {
    ok: true,
    source: {
      sourceDir: located.value.dir,
      rootReal: located.value.rootReal,
      listing: [...listing.files].sort(),
      digest: sha256Hex(raw),
      frontmatterName: fm.ok && typeof fm.data.name === "string" ? fm.data.name.trim() : null,
      description: fm.ok && typeof fm.data.description === "string" ? fm.data.description.trim() : null,
    },
  };
}
