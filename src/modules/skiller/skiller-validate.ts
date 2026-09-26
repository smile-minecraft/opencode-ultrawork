/**
 * opencode-ultrawork — skiller-validate tool factory
 *
 * 角色：
 *   - 對固定 root 內的單一 skill 目錄執行完整驗證：frontmatter、name/dirname、
 *     description、namespace、UTF-8 文字、secret / high-risk / workflow ID marker、
 *     scripts inventory、policy digest drift；回傳 blockers/warnings/readiness。
 *   - `source` 省略（或 "auto"）時：優先 draft，draft 不存在退回已安裝 skill，
 *     再退回 quarantine。指定 source 時只查該 root——晉升之後要核對「實際
 *     安裝的那一份」就必須指定 source:"skill"，否則同名草稿會一直遮住它。
 *   - 不接受任意路徑 args。
 *
 * 限制：
 *   - 不得 import `src/index.ts`。
 */

import { resolve } from "node:path";
import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../kit/define-tool.ts";
import { jsonError, jsonResult } from "../../kit/json.ts";
import {
  deriveProjectSlug,
  loadPersonalPins,
  loadPolicySnapshot,
  normalizeScope,
  resolvePersonalPinsPath,
  resolvePolicyPath,
  locateSkillDir,
  validateSkillDir,
  validateSkillName,
  type PersonalPinsFile,
  type SkillerDeps,
  type SkillSourceKind,
} from "./skiller-common.ts";

export function createSkillerValidateTool(deps: SkillerDeps) {
  return defineTool({
    name: "skiller-validate",
    description:
      "驗證固定 root 內的單一 skill：frontmatter、name/dirname 一致、description、namespace、secret/high-risk/workflow ID marker、scripts inventory 與 policy digest drift；回傳 blockers/warnings/readiness。source 指定要驗哪一份（draft / skill / quarantine），省略時依 draft → skill → quarantine 順序自動挑第一個存在的。",
    inputSchema: z.object({
      scope: z.enum(["project", "personal", "managed"]).optional(),
      name: z.string().optional(),
      source: z.enum(["auto", "draft", "skill", "quarantine"]).optional(),
    }),
    async execute(
      args: { scope?: "project" | "personal" | "managed"; name?: string; source?: "auto" | "draft" | "skill" | "quarantine" },
      context: ToolExecutionContext,
    ) {
      try {
        const scopeCheck = normalizeScope(args.scope);
        if (!scopeCheck.ok) {
          return jsonError("INVALID_SCOPE", "scope 只能是 project、personal 或 managed", "請將 scope 改為 project、personal 或 managed。");
        }
        const scope = scopeCheck.scope;
        const projectSlug = deriveProjectSlug(resolve(deps.resolveProjectRoot(context)));
        const nameCheck = validateSkillName(args.name, scope, projectSlug);
        if (!nameCheck.ok) {
          return jsonError(nameCheck.code, nameCheck.message, "請修正 name 後再試一次。");
        }
        const name = nameCheck.name;
        const policyLoad = loadPolicySnapshot(resolvePolicyPath(deps));
        const policy = policyLoad.ok ? policyLoad.policy : null;
        let personalPins: PersonalPinsFile | null = null;
        if (scope === "personal") {
          const pinsPath = resolvePersonalPinsPath(deps, policy);
          const pinsLoad = loadPersonalPins(pinsPath);
          if (!pinsLoad.ok) {
            return jsonError(pinsLoad.code, pinsLoad.message, "請先修復 personal pins registry 後再試一次。");
          }
          personalPins = pinsLoad.pins;
        }

        // source 指定時只查該 root；auto 依 draft → skill → quarantine 挑第一個存在的。
        const requestedSource = args.source ?? "auto";
        const candidates: SkillSourceKind[] = requestedSource === "auto"
          ? ["draft", "skill", "quarantine"]
          : [requestedSource];
        let sourceKind: SkillSourceKind | null = null;
        let dirGuardValue: string | null = null;
        let securityIssue: { code: string; message: string } | null = null;
        for (const kind of candidates) {
          // locateSkillDir 內含 scoped fixed-root guard → containedPath → statSync
          // 的固定順序；guard 失敗（含祖先 symlink escape）時不得對該 root 讀取。
          const located = locateSkillDir(kind, scope, name, deps, context);
          if (located.ok) {
            sourceKind = kind;
            dirGuardValue = located.value.dir;
            break;
          }
          // 安全類代碼必須如實回報，不得被「換下一個 root」靜默吞掉。
          if (located.code !== "NOT_FOUND" && securityIssue === null) {
            securityIssue = { code: located.code, message: located.message };
          }
        }
        if (sourceKind === null || dirGuardValue === null) {
          if (securityIssue !== null) {
            return jsonError(securityIssue.code, securityIssue.message, "請先人工檢查固定 root 狀態後再試一次。");
          }
          return jsonError(
            "NOT_FOUND",
            requestedSource === "auto" ? `找不到 skill：${name}` : `找不到 ${requestedSource} 內的 skill：${name}`,
            "請先用 skiller-scan 確認目前可用的 skill 目錄。",
          );
        }

        const validation = validateSkillDir({
          skillDir: dirGuardValue,
          declaredName: name,
          scope,
          projectSlug,
          policy,
          personalPins,
          deps,
        });

        return jsonResult({
          ok: true,
          summary: `驗證完成：${name}（${sourceKind}）readiness=${validation.readiness}。`,
          data: {
            scope,
            name,
            requestedSource,
            sourceKind,
            path: dirGuardValue,
            digest: validation.digest,
            frontmatterName: validation.frontmatterName,
            descriptionPresent: validation.descriptionPresent,
            namespaceValid: validation.namespaceValid,
            trustTier: validation.trustTier,
            blockers: validation.blockers,
            warnings: validation.warnings,
            scripts: validation.scripts,
            readiness: validation.readiness,
          },
        });
      } catch (error) {
        return jsonError("TOOL_ERROR", `驗證失敗：${(error as Error).message}`);
      }
    },
  });
}
