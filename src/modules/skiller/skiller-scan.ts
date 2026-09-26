/**
 * opencode-ultrawork — skiller-scan tool factory
 *
 * 角色：
 *   - 掃描固定 project/personal skill roots（draft + skill + quarantine），
 *     列出每個 skill 目錄的 frontmatter 解析狀態、namespace、trust tier 與
 *     完整 SHA-256 digest。quarantine 一併列出，呼叫端才看得見退役後佔位的
 *     目錄——看不見它就無從診斷 skiller-retire 的 QUARANTINE_EXISTS。
 *   - 不接受任何 path/root/destination args；root 由 scope + 固定常數決定。
 *
 * 限制：
 *   - 不得 import `src/index.ts`。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../kit/define-tool.ts";
import { jsonError, jsonResult } from "../../kit/json.ts";
import {
  containedPath,
  deriveProjectSlug,
  deriveTrustTier,
  ensureScopedFixedRoot,
  listSkillFiles,
  loadPersonalPins,
  loadPolicySnapshot,
  normalizeScope,
  parseFrontmatter,
  resolvePersonalPinsPath,
  resolvePolicyPath,
  resolveScopeRoots,
  sha256Hex,
  validateSkillName,
  type PersonalPinsFile,
  type SkillerDeps,
  type SkillIssue,
  type SkillSourceKind,
} from "./skiller-common.ts";

interface ScanEntry {
  name: string;
  sourceKind: SkillSourceKind;
  hasSkillMd: boolean;
  parseOk: boolean;
  frontmatterName: string | null;
  descriptionPresent: boolean;
  namespaceValid: boolean;
  digest: string | null;
  trustTier: string;
  error?: string;
}

export function createSkillerScanTool(deps: SkillerDeps) {
  return defineTool({
    name: "skiller-scan",
    description:
      "掃描固定 project/personal/managed skill roots（draft、已安裝 skills 與 quarantine）：列出目錄、frontmatter 解析狀態、namespace、trust tier 與 SHA-256 digest；不接受任意路徑。",
    inputSchema: z.object({
      scope: z.enum(["project", "personal", "managed"]).optional(),
    }),
    async execute(args: { scope?: "project" | "personal" | "managed" }, context: ToolExecutionContext) {
      try {
        const scopeCheck = normalizeScope(args.scope);
        if (!scopeCheck.ok) {
          return jsonError("INVALID_SCOPE", "scope 只能是 project、personal 或 managed", "請將 scope 改為 project、personal 或 managed。");
        }
        const scope = scopeCheck.scope;
        const roots = resolveScopeRoots(scope, deps, context);
        const policyLoad = loadPolicySnapshot(resolvePolicyPath(deps));
        const policy = policyLoad.ok ? policyLoad.policy : null;
        const warnings: SkillIssue[] = policyLoad.ok ? [] : [{ code: "POLICY_UNAVAILABLE", message: policyLoad.message }];

        // personal pins：僅 personal scope 需要；載入失敗時以 warning 呈現並標記 registry unavailable，禁止 fallback 到 policy-derived tiers（fail closed）。
        let personalPins: PersonalPinsFile | null = null;
        let personalRegistryUnavailable = false;
        if (scope === "personal") {
          const pinsPath = resolvePersonalPinsPath(deps, policy);
          const pinsLoad = loadPersonalPins(pinsPath);
          if (!pinsLoad.ok) {
            warnings.push({ code: pinsLoad.code, message: pinsLoad.message });
            personalRegistryUnavailable = true;
          } else {
            personalPins = pinsLoad.pins;
          }
        }

        // namespace 檢查用的 project slug：與 resolveScopeRoots 相同的 project root 推導。
        const projectSlug = deriveProjectSlug(resolve(deps.resolveProjectRoot(context)));

        const entries: ScanEntry[] = [];
        const rootPairs: Array<readonly [SkillSourceKind, string]> = [
          ["draft", roots.draftRoot],
          ["skill", roots.skillRoot],
          ["quarantine", roots.quarantineRoot],
        ];
        for (const [sourceKind, root] of rootPairs) {
          // scoped fixed-root guard 必須先於任何 filesystem 讀取：guard 失敗
          // （含祖先 symlink escape）時只回 warning，不列舉、不讀取該 root。
          const rootGuard = ensureScopedFixedRoot(root, scope, deps, context);
          if (!rootGuard.ok) {
            // quarantine root 不存在是常態（從未退役過任何 skill），不列為 warning
            // 以免每次掃描都帶噪音；安全類代碼（escape / symlink）仍如實回報。
            if (!(sourceKind === "quarantine" && rootGuard.code === "UNKNOWN_ROOT")) {
              warnings.push({ code: rootGuard.code, message: `${sourceKind} root 無法使用：${rootGuard.message}` });
            }
            continue;
          }
          let names: string[];
          try {
            names = readdirSync(rootGuard.value);
          } catch {
            warnings.push({ code: "ROOT_READ_FAILED", message: `無法讀取 ${sourceKind} root` });
            continue;
          }
          for (const entryName of names.sort()) {
            if (entryName.startsWith(".")) continue;
            const dirGuard = containedPath(rootGuard.value, root, entryName);
            if (!dirGuard.ok) {
              entries.push({
                name: entryName,
                sourceKind,
                hasSkillMd: false,
                parseOk: false,
                frontmatterName: null,
                descriptionPresent: false,
                namespaceValid: false,
                digest: null,
                trustTier: "unknown",
                error: `${dirGuard.code}: ${dirGuard.message}`,
              });
              continue;
            }
            let isDir = false;
            try {
              isDir = statSync(dirGuard.value).isDirectory();
            } catch {
              isDir = false;
            }
            if (!isDir) continue;

            // bundle 檔案清單檢查：含 symlink 或任一讀取失敗時 fail closed，
            // 不讀取任何內容。
            const listing = listSkillFiles(dirGuard.value, deps);
            if (!listing.ok) {
              entries.push({
                name: entryName,
                sourceKind,
                hasSkillMd: false,
                parseOk: false,
                frontmatterName: null,
                descriptionPresent: false,
                namespaceValid: false,
                digest: null,
                trustTier: "unknown",
                error: `${listing.issue.code}: ${listing.issue.message}`,
              });
              continue;
            }

            const skillMdGuard = containedPath(dirGuard.value, dirGuard.value, "SKILL.md");
            if (!skillMdGuard.ok || !listing.files.includes("SKILL.md")) {
              entries.push({
                name: entryName,
                sourceKind,
                hasSkillMd: false,
                parseOk: false,
                frontmatterName: null,
                descriptionPresent: false,
                namespaceValid: false,
                digest: null,
                trustTier: "unknown",
                error: `BUNDLE_READ_FAILED: ${skillMdGuard.ok ? "缺少 SKILL.md" : skillMdGuard.message}`,
              });
              continue;
            }
            let raw: string;
            try {
              raw = readFileSync(skillMdGuard.value, "utf-8");
            } catch {
              entries.push({
                name: entryName,
                sourceKind,
                hasSkillMd: false,
                parseOk: false,
                frontmatterName: null,
                descriptionPresent: false,
                namespaceValid: false,
                digest: null,
                trustTier: "unknown",
                error: "BUNDLE_READ_FAILED: 無法讀取受 guard 的 SKILL.md",
              });
              continue;
            }
            const fm = parseFrontmatter(raw);
            const digest = sha256Hex(raw);
            const frontmatterName = fm?.ok && typeof fm.data.name === "string" ? fm.data.name.trim() : null;
            const descriptionPresent = Boolean(
              fm?.ok && typeof fm.data.description === "string" && fm.data.description.trim().length > 0,
            );
            const expectedPrefix = scope === "project" ? `project-${projectSlug}-` : scope === "managed" ? null : "personal-";
            entries.push({
              name: entryName,
              sourceKind,
              hasSkillMd: true,
              parseOk: Boolean(fm?.ok),
              frontmatterName,
              descriptionPresent,
              namespaceValid: frontmatterName !== null &&
                (scope === "managed"
                  ? validateSkillName(frontmatterName, "managed", projectSlug).ok
                  : frontmatterName.startsWith(expectedPrefix!)),
              digest,
              trustTier: deriveTrustTier(entryName, digest, policy, personalPins, personalRegistryUnavailable, scope),
            });
          }
        }

        return jsonResult({
          ok: true,
          summary: `掃描完成：${scope} scope 共 ${entries.length} 個 skill 目錄。`,
          data: {
            scope,
            roots: { draft: roots.draftRoot, skill: roots.skillRoot, quarantine: roots.quarantineRoot },
            entries,
            ...(warnings.length > 0 ? { warnings } : {}),
          },
        });
      } catch (error) {
        return jsonError("TOOL_ERROR", `掃描失敗：${(error as Error).message}`);
      }
    },
  });
}

// 名稱驗證規則由 skiller-common.validateSkillName 提供；此處保留型別參照。
type SkillerNameValidation = ReturnType<typeof validateSkillName>;
export type { SkillerNameValidation };
