/**
 * opencode-ultrawork — skiller-promote tool factory
 *
 * 角色：
 *   - 把固定 draft root 內的 skill 草稿升級到對應固定 skill root。
 *   - 預設 preview 不寫入；`mode="apply"` 必須 `confirm===true`。
 *   - project apply 只寫 project `.opencode/skills`；personal apply 只寫
 *     canonical global root，且必須有非空 `targetAgentGroups`，並對 scripts /
 *     executable / high-risk / secret / workflow ID / frontmatter / digest drift
 *     等 blocker fail closed。managed apply 與 personal 共用 global root，
 *     同樣 fail closed，但不要求 `targetAgentGroups`、不寫 personal pins。
 *     成功回傳完整 SHA-256。
 *   - 多檔複製採 staging 後一次 rename 交換：先在固定 target root 內的隱藏
 *     staging 目錄完整寫入，成功才交換目標；中途失敗清理 staging 並還原
 *     backup，既有目標不得被部分新內容污染。
 *   - personal apply 在 bundle 交換成功後以 atomic write 同步 personal pins
 *     registry（digest、語意 groups、resolved agents、active status）；pins
 *     寫入失敗時回滾 bundle 交換，不留未記錄的 active personal skill。
 *   - 本工具群唯讀 skills-policy.json；personal apply 不寫 policy。
 *
 * 限制：
 *   - 不得 import `src/index.ts`。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../kit/define-tool.ts";
import { ContentLockBusyError } from "../../kit/write-lock.ts";
import { jsonError, jsonResult } from "../../kit/json.ts";
import {
  agentHasPersonalAskRoute,
  applyAgentSkillRouting,
  containedPath,
  deriveProjectSlug,
  deriveTrustTier,
  ensureScopedFixedRoot,
  loadPersonalPins,
  loadPolicySnapshot,
  normalizeScope,
  normalizeTargetAgents,
  partitionIssuesForScope,
  PERSONAL_PINS_SCHEMA_VERSION,
  previewAgentSkillRouting,
  prevalidateTargetAgents,
  resolveAgentGroups,
  resolveAgentsRoot,
  resolvePersonalPinsPath,
  resolvePolicyPath,
  resolveScopeRoots,
  sha256Hex,
  validateLockedBundle,
  validateSkillDir,
  validateSkillName,
  withFreshSkillerLock,
  writePersonalPinsAtomic,
  type AgentRoutingFileResult,
  type GuardResult,
  type PersonalPinsFile,
  type SkillerDeps,
  type SkillIssue,
  type TrustTier,
} from "./skiller-common.ts";

interface PromoteArgs {
  scope?: "project" | "personal" | "managed";
  name?: string;
  mode?: "preview" | "apply";
  confirm?: boolean;
  targetAgentGroups?: string[];
  targetAgents?: string[];
  overwrite?: boolean;
}

export function createSkillerPromoteTool(deps: SkillerDeps) {
  return defineTool({
    name: "skiller-promote",
    description:
      "把固定 draft root 的 skill 草稿升級到固定 skill root：預設 preview 不寫入；apply 需 confirm=true。personal apply 另需非空 targetAgentGroups，並對 scripts/high-risk/secret/workflow ID/frontmatter/digest drift fail closed；回傳完整 SHA-256。managed scope 可選 targetAgents，在 apply 成功後同步更新指定 agent 的 permission.skill exact 行。",
    inputSchema: z.object({
      scope: z.enum(["project", "personal", "managed"]).optional(),
      name: z.string().optional(),
      mode: z.enum(["preview", "apply"]).optional(),
      confirm: z.boolean().optional(),
      targetAgentGroups: z.array(z.string()).optional(),
      targetAgents: z.array(z.string()).optional(),
      overwrite: z.boolean().optional(),
    }),
    async execute(args: PromoteArgs, context: ToolExecutionContext) {
      try {
        const scopeCheck = normalizeScope(args.scope);
        if (!scopeCheck.ok) {
          return jsonError("INVALID_SCOPE", "scope 只能是 project、personal 或 managed", "請將 scope 改為 project、personal 或 managed。");
        }
        const scope = scopeCheck.scope;
        const mode = args.mode ?? "preview";
        if (mode !== "preview" && mode !== "apply") {
          return jsonError("INVALID_MODE", "mode 只能是 preview 或 apply", "請將 mode 改為 preview 或 apply。");
        }
        const projectSlug = deriveProjectSlug(resolve(deps.resolveProjectRoot(context)));
        const nameCheck = validateSkillName(args.name, scope, projectSlug);
        if (!nameCheck.ok) {
          return jsonError(nameCheck.code, nameCheck.message, "請修正 name 後再試一次。");
        }
        const name = nameCheck.name;

        // managed 路由閉環：targetAgents 只支援 managed scope。personal 走
        // targetAgentGroups 語意群組、project 走 project-* ask 路由，兩者
        // 帶 targetAgents 一律拒絕。檢查放在任何 mutation 之前。
        const targetAgentsCheck = normalizeTargetAgents(args.targetAgents);
        if (!targetAgentsCheck.ok) {
          return jsonError("INVALID_TARGET_AGENTS", `targetAgents 含非法 agent 名稱：${targetAgentsCheck.invalid}`, "請提供 kebab-case 的 agent 名稱（對應 agents/<name>.md）。");
        }
        const targetAgents = targetAgentsCheck.agents;
        if (targetAgents.length > 0 && scope !== "managed") {
          return jsonResult({
            ok: false,
            code: "TARGET_AGENTS_SCOPE",
            summary: "targetAgents 只支援 managed scope；personal 請用 targetAgentGroups，project 請用 project-* ask 路由。",
            nextAction: "請改用 scope=managed，或移除 targetAgents 後重試。",
            data: { mode, scope, name },
          });
        }
        // 未知 agent 在任何 mutation 之前拒絕；缺 skill 區塊則在 edit 時
        // 回報 skipped（不建立結構）。
        if (targetAgents.length > 0) {
          const agentsRoot = resolveAgentsRoot(deps);
          const pre = prevalidateTargetAgents(agentsRoot, targetAgents);
          if (!pre.ok) {
            return jsonError("UNKNOWN_AGENT", `未知的 agent：${pre.unknownAgent}（${pre.reason}）`, "請確認 agents/<name>.md 存在後再試一次。");
          }
        }

        const roots = resolveScopeRoots(scope, deps, context);
        const policyLoad = loadPolicySnapshot(resolvePolicyPath(deps));
        const policy = policyLoad.ok ? policyLoad.policy : null;

        // 定位 draft（必須存在、是目錄、非 symlink；root guard 失敗時
        // 如實回報 escape/symlink，不把外部位置當成合法 draft root）。
        let draftDir: string | null = null;
        let draftRootReal: string | null = null;
        let draftRootGuardError: GuardResult<string> | null = null;
        const draftRootGuard = ensureScopedFixedRoot(roots.draftRoot, scope, deps, context);
        if (draftRootGuard.ok) {
          const guard = containedPath(draftRootGuard.value, roots.draftRoot, name);
          if (guard.ok) {
            try {
              if (statSync(guard.value).isDirectory()) {
                draftDir = guard.value;
                draftRootReal = draftRootGuard.value;
              }
            } catch {
              draftDir = null;
            }
          }
        } else {
          draftRootGuardError = draftRootGuard;
        }
        if (draftDir === null) {
          // root 缺席（UNKNOWN_ROOT）維持既有 NOT_FOUND 語意；
          // escape / symlink 等安全狀態必須如實回報，不得靜默吞掉。
          if (draftRootGuardError !== null && draftRootGuardError.code !== "UNKNOWN_ROOT") {
            return jsonError(
              draftRootGuardError.code,
              draftRootGuardError.message,
              "請先人工檢查固定 draft root 狀態後再試一次。",
            );
          }
          return jsonError("NOT_FOUND", `找不到 draft：${name}`, "請先用 skiller-draft 建立草稿，或以 skiller-scan 確認。");
        }

        // 完整驗證（scope 決定 blocker 分級）。
        //
        // 這裡刻意不把 personal pins 餵進 validateSkillDir：pin 的 digest 記的是
        // 「上一次晉升的內容」，而 promote 的工作就是把新內容寫成新的 pin digest。
        // 若把 pin 納入判定，任何一次 personal skill 更新都會自己判自己
        // POLICY_DIGEST_DRIFT 而 fail closed，personal skill 將永遠無法更新。
        // pin 漂移改為下面的 informational tier + warning，讓呼叫端看得見卻不被擋。
        // policy contentDigests 造成的漂移（managed catalog）仍然照舊阻擋。
        const validation = validateSkillDir({
          skillDir: draftDir,
          declaredName: name,
          scope,
          projectSlug,
          policy,
          deps,
        });
        const files = validation.scripts.files;

        // personal pins 只用於回報：讓 preview / apply 看得到這份草稿相對於
        // 既有 pin 是 approved 還是 drifted，而不是一律顯示 unreviewed。
        let reportedTier: TrustTier = validation.trustTier;
        const pinWarnings: SkillIssue[] = [];
        if (scope === "personal") {
          const pinsPreload = loadPersonalPins(resolvePersonalPinsPath(deps, policy));
          if (pinsPreload.ok) {
            reportedTier = deriveTrustTier(name, validation.digest, policy, pinsPreload.pins);
            const pin = pinsPreload.pins.pins[name];
            if (pin && pin.status === "active" && validation.digest !== null && pin.digest !== validation.digest) {
              pinWarnings.push({
                code: "PIN_DIGEST_DRIFT",
                message: `內容與 registry 中既有 active pin 的 digest 不同（pin: ${pin.digest.slice(0, 12)}…，草稿: ${validation.digest.slice(0, 12)}…）；apply 會把 pin 更新成草稿的 digest`,
              });
            }
          }
        }

        // managed 與 personal 共用同一組實體固定 roots；只有 project 走
        // project-local 的 `.opencode/skills`。managed 不寫 pins、不要求
        // targetAgentGroups（以下 personal 分支一律以 scope === "personal" 把關）。
        const targetRoot = scope === "project" ? resolve(deps.resolveProjectRoot(context), ".opencode/skills") : roots.skillRoot;

        // ─── preview：不寫入任何檔案 ───
        if (mode === "preview") {
          let groupInfo: Record<string, unknown> = {};
          if (scope === "personal") {
            const requested = args.targetAgentGroups;
            if (Array.isArray(requested) && requested.length > 0 && requested.every((g) => typeof g === "string" && g.trim().length > 0)) {
              const resolution = resolveAgentGroups(requested.map((g) => g.trim()), policy);
              groupInfo = resolution.ok
                ? { targetAgentGroups: resolution.groups, resolvedTargetAgents: resolution.agents }
                : { groupErrors: [{ code: resolution.code, message: resolution.message }] };
            }
          }
          return jsonResult({
            ok: true,
            summary: `promote preview：${name} → ${scope} skill root（readiness=${validation.readiness}）。`,
            data: {
              mode: "preview",
              scope,
              name,
              sourcePath: draftDir,
              targetPath: resolve(targetRoot, name),
              files,
              trustTier: reportedTier,
              blockers: validation.blockers,
              warnings: [...validation.warnings, ...pinWarnings],
              readiness: validation.readiness,
              requirements: scope === "personal"
                ? ["mode=apply", "confirm=true", "targetAgentGroups 非空且為 policy 定義的語意 group"]
                : ["mode=apply", "confirm=true"],
              ...groupInfo,
              ...(targetAgents.length > 0
                ? {
                    agentRouting: {
                      targetAgents,
                      planned: previewAgentSkillRouting(resolveAgentsRoot(deps), name, "insert", targetAgents),
                    },
                  }
                : {}),
            },
          });
        }

        // ─── apply：confirm gate ───
        if (args.confirm !== true) {
          return jsonResult({
            ok: false,
            code: "CONFIRM_REQUIRED",
            summary: "promote apply 需要明確 confirm=true；未寫入任何檔案。",
            nextAction: "請先執行 preview 確認內容，再以 confirm=true 重送。",
            data: { mode: "apply", scope, name },
          });
        }

        // personal apply：非空 targetAgentGroups gate。
        // rawTargetAgentGroups 保留正規化後的原始輸入：鎖內以新鮮 policy 重解，
        // 不沿用鎖前解析出的 groups／agents（統一 mutation 框架不變條件）。
        let targetAgentGroups: string[] | undefined;
        let rawTargetAgentGroups: string[] | undefined;
        if (scope === "personal") {
          const groups = args.targetAgentGroups;
          if (!Array.isArray(groups) || groups.length === 0 || groups.some((g) => typeof g !== "string" || g.trim().length === 0)) {
            return jsonResult({
              ok: false,
              code: "TARGET_GROUPS_REQUIRED",
              summary: "personal promotion 需要非空的 targetAgentGroups。",
              nextAction: "請提供要套用此 skill 的語意 agent groups 後重試。",
              data: { mode: "apply", scope, name },
            });
          }
          targetAgentGroups = groups.map((g) => g.trim());
          rawTargetAgentGroups = [...targetAgentGroups];
        }

        // fail closed：任何 blocker 都拒絕 apply。
        // project scope 的風險項（secret/high-risk/workflow ID/scripts/digest drift）
        // 依規範降級為回報用 warning；結構 blocker（frontmatter/name/namespace）仍阻擋。
        // 分級規則與 skiller-restore 共用同一個 helper，避免兩條寫入 discovery
        // root 的路徑各自維護一份會漂移的風險清單。
        const { blockers, warnings: partitionedWarnings } = partitionIssuesForScope(validation, scope, { policy, skillName: name });
        const warnings = [...partitionedWarnings, ...pinWarnings];
        if (blockers.length > 0) {
          return jsonResult({
            ok: false,
            code: "PROMOTION_BLOCKED",
            summary: `promotion 被 ${blockers.length} 個 blocker 阻擋；未寫入任何檔案。`,
            nextAction: "請依 blockers 清單修正草稿後重新驗證。",
            data: { mode: "apply", scope, name, blockers, warnings },
          });
        }

        // personal：語意 group 解析、成員路由檢查與 pins registry 載入，
        // 全部在任何 filesystem mutation 之前 fail closed。
        let resolvedTargetAgents: string[] | undefined;
        let pinsFile: PersonalPinsFile | null = null;
        let pinsPath: string | null = null;
        if (scope === "personal") {
          const resolution = resolveAgentGroups(targetAgentGroups!, policy);
          if (!resolution.ok) {
            // 從 resolution.message 已含合法 group 列表（由 skiller-common 補上）。
            // nextAction 直接重述一次，避免 caller 還要再 parse summary。
            const hint = resolution.message.includes("合法值：")
              ? resolution.message.split("合法值：").pop()!.trim()
              : "請看 summary 列出的合法值";
            return jsonResult({
              ok: false,
              code: resolution.code,
              summary: resolution.message,
              nextAction: `請使用 skills-policy.json personalGovernance.agentGroups 定義的語意 group（合法值：${hint}）。`,
              data: { mode: "apply", scope, name },
            });
          }
          const projectRoot = resolve(deps.resolveProjectRoot(context));
          const missingRoute = resolution.agents.filter((agent) => !agentHasPersonalAskRoute(projectRoot, agent, deps));
          if (missingRoute.length > 0) {
            return jsonResult({
              ok: false,
              code: "GROUP_ROUTE_INVALID",
              summary: `group 成員缺少 personal-* ask 路由：${missingRoute.join(", ")}`,
              nextAction: "請先為這些 agent 加入 personal-*: ask skill 路由後再重試。",
              data: { mode: "apply", scope, name, agents: resolution.agents },
            });
          }
          resolvedTargetAgents = resolution.agents;
          targetAgentGroups = resolution.groups;
          pinsPath = resolvePersonalPinsPath(deps, policy);
          const loadedPins = loadPersonalPins(pinsPath);
          if (!loadedPins.ok) {
            return jsonError(loadedPins.code, loadedPins.message, "請先修復 personal pins registry 後再試一次。");
          }
          pinsFile = loadedPins.pins;
        }

        // 鎖內唯一可信狀態是 fresh 快照：roots／projectSlug／policy／pins 全部重載。
        // 鎖前的 validation／partition／group 解析／pins 只做 preview 與早期拒絕，
        // 不作為寫入依據（統一 mutation 框架不變條件，見 skiller-common）。
        return await withFreshSkillerLock(scope, name, deps, context, async (fresh) => {
        // personal pins gate（新鮮）：載入失敗 fail closed。
        if (scope === "personal" && fresh.pinsError !== null) {
          return jsonError(fresh.pinsError.code, fresh.pinsError.message, "請先修復 personal pins registry 後再試一次。");
        }
        // 語意 group 以新鮮 policy 重解＋路由重查；等待鎖期間 policy 變更必須被看見。
        let freshTargetAgentGroups: string[] | undefined;
        let freshResolvedTargetAgents: string[] | undefined;
        if (scope === "personal") {
          const lockedResolution = resolveAgentGroups(rawTargetAgentGroups!, fresh.policy);
          if (!lockedResolution.ok) {
            const lockedHint = lockedResolution.message.includes("合法值：")
              ? lockedResolution.message.split("合法值：").pop()!.trim()
              : "請看 summary 列出的合法值";
            return jsonResult({
              ok: false,
              code: lockedResolution.code,
              summary: lockedResolution.message,
              nextAction: `請使用 skills-policy.json personalGovernance.agentGroups 定義的語意 group（合法值：${lockedHint}）。`,
              data: { mode: "apply", scope, name },
            });
          }
          const freshProjectRoot = resolve(deps.resolveProjectRoot(context));
          const lockedMissingRoute = lockedResolution.agents.filter((agent) => !agentHasPersonalAskRoute(freshProjectRoot, agent, deps));
          if (lockedMissingRoute.length > 0) {
            return jsonResult({
              ok: false,
              code: "GROUP_ROUTE_INVALID",
              summary: `group 成員缺少 personal-* ask 路由：${lockedMissingRoute.join(", ")}`,
              nextAction: "請先為這些 agent 加入 personal-*: ask skill 路由後再重試。",
              data: { mode: "apply", scope, name, agents: lockedResolution.agents },
            });
          }
          freshResolvedTargetAgents = lockedResolution.agents;
          freshTargetAgentGroups = lockedResolution.groups;
        }
        // 鎖內重新定位 draft 並以新鮮 policy／projectSlug 重跑完整驗證；
        // 等待鎖期間附屬檔案改動與 policy 變更都必須被看見。pins 刻意不餵進
        // validate（新內容會自己判自己 drift），漂移改走下面的回報用 tier。
        const verdictResult = validateLockedBundle("draft", fresh, deps, null, context);
        if (!verdictResult.ok) return jsonError(verdictResult.code, verdictResult.message, "請重新執行 skiller-promote。");
        const verdict = verdictResult.verdict;
        if (verdict.blockers.length > 0) {
          return jsonResult({
            ok: false,
            code: "PROMOTION_BLOCKED",
            summary: `鎖內重驗發現 ${verdict.blockers.length} 個 blocker；未寫入任何檔案。`,
            nextAction: "請修正 draft 後重新驗證並 promote。",
            data: { mode: "apply", scope, name, blockers: verdict.blockers, warnings: verdict.warnings },
          });
        }
        // 回報用 tier 與 pin 漂移 warning（新鮮 pins，不做阻擋）。
        let freshReportedTier: TrustTier = verdict.validation.trustTier;
        const freshPinWarnings: SkillIssue[] = [];
        if (scope === "personal" && fresh.pinsFile !== null) {
          freshReportedTier = deriveTrustTier(name, verdict.digest, fresh.policy, fresh.pinsFile);
          const freshPin = fresh.pinsFile.pins[name];
          if (freshPin && freshPin.status === "active" && freshPin.digest !== verdict.digest) {
            freshPinWarnings.push({
              code: "PIN_DIGEST_DRIFT",
              message: `內容與 registry 中既有 active pin 的 digest 不同（pin: ${freshPin.digest.slice(0, 12)}…，草稿: ${verdict.digest.slice(0, 12)}…）；apply 會把 pin 更新成草稿的 digest`,
            });
          }
        }
        const freshWarnings: SkillIssue[] = [...verdict.warnings, ...freshPinWarnings];
        // 目標 root（新鮮）：先驗證路徑安全（祖先 symlink escape 在 mkdir 前擋下），
        // 建立後再通過完整 fixed-root guard。
        const freshTargetRoot = scope === "project" ? resolve(deps.resolveProjectRoot(context), ".opencode/skills") : fresh.roots.skillRoot;
        const preTargetGuard = ensureScopedFixedRoot(freshTargetRoot, scope, deps, context);
        if (!preTargetGuard.ok) {
          return jsonError(preTargetGuard.code, preTargetGuard.message, "請確認固定 skill root 狀態後再試一次。");
        }
        try {
          mkdirSync(freshTargetRoot, { recursive: true });
        } catch {
          return jsonError("UNKNOWN_ROOT", "無法建立固定 skill root", "請確認固定 skill root 位置可寫入後再試一次。");
        }
        const targetRootGuard = ensureScopedFixedRoot(freshTargetRoot, scope, deps, context);
        if (!targetRootGuard.ok) {
          return jsonError(targetRootGuard.code, targetRootGuard.message, "請確認固定 skill root 狀態後再試一次。");
        }
        const targetDirGuard = containedPath(targetRootGuard.value, freshTargetRoot, name);
        if (!targetDirGuard.ok) {
          return jsonError(targetDirGuard.code, targetDirGuard.message, "請確認目標路徑安全後再試一次。");
        }
        if (existsSync(targetDirGuard.value) && args.overwrite !== true) {
          return jsonError("ALREADY_EXISTS", `skill 已存在於目標 root：${name}`, "如需覆蓋請加 overwrite=true。");
        }

        // 完整 staging 後一次交換：先在固定 target root 內把整個草稿寫進
        // 隱藏 staging 目錄，全部成功後才以 rename 交換目標；任何中途失敗
        // 都必須清理 staging 並還原既有目標，不得留下部分新內容。
        // 完整 staging 後一次交換：來源一律用鎖內 verdict 的新鮮定位。
        const listing = verdict.listing;
        const writeFile = deps.writeFile ?? ((path: string, content: string) => writeFileSync(path, content, "utf-8"));
        const targetDir = targetDirGuard.value;
        const uniqueSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
        const stagingPath = join(targetRootGuard.value, `.promote-staging-${name}-${uniqueSuffix}`);
        const backupPath = join(targetRootGuard.value, `.promote-backup-${name}-${uniqueSuffix}`);
        const removeTree = (path: string): void => {
          try {
            rmSync(path, { recursive: true, force: true });
          } catch {
            // 清理失敗不遮蔽主錯誤；staging/backup 位於固定 root 的隱藏目錄。
          }
        };

        mkdirSync(stagingPath, { recursive: true });
        let copyError: Error | null = null;
        // Digest must use the guarded copy snapshot; the draft source may change after copying.
        let skillMdSnapshot: string | null = null;
        try {
          for (const rel of listing) {
            const sourceGuard = containedPath(verdict.rootReal, fresh.roots.draftRoot, name, rel);
            if (!sourceGuard.ok) {
              throw new Error(`${sourceGuard.code}: ${sourceGuard.message}`);
            }
            const content = readFileSync(sourceGuard.value, "utf-8");
            if (rel === "SKILL.md") skillMdSnapshot = content;
            const stagingDest = join(stagingPath, rel);
            mkdirSync(dirname(stagingDest), { recursive: true });
            writeFile(stagingDest, content);
          }
        } catch (error) {
          copyError = error as Error;
        }
        if (copyError !== null) {
          removeTree(stagingPath);
          return jsonError("WRITE_FAILED", `複製草稿失敗：${copyError.message}`);
        }
        if (skillMdSnapshot === null) {
          removeTree(stagingPath);
          return jsonError("WRITE_FAILED", "複製草稿後找不到 SKILL.md snapshot；未完成目標交換。");
        }

        const hadTarget = existsSync(targetDir);
        if (hadTarget) {
          try {
            renameSync(targetDir, backupPath);
          } catch (error) {
            removeTree(stagingPath);
            return jsonError("WRITE_FAILED", `無法備份既有目標：${(error as Error).message}`);
          }
        }
        try {
          renameSync(stagingPath, targetDir);
        } catch (error) {
          if (hadTarget) {
            try {
              renameSync(backupPath, targetDir);
            } catch {
              // 還原失敗時保留 backup 供人工救援，不再嘗試覆蓋。
            }
          }
          removeTree(stagingPath);
          return jsonError("WRITE_FAILED", `無法完成目標交換：${(error as Error).message}`);
        }

        // personal：bundle 交換成功後以新鮮 pins 為基底原子寫入；寫入失敗時
        // 回滾 bundle 交換，不留未記錄的 active personal skill。
        if (scope === "personal" && fresh.pinsFile !== null && fresh.pinsPath !== null) {
          const newPins: PersonalPinsFile = {
            schemaVersion: PERSONAL_PINS_SCHEMA_VERSION,
            pins: {
              ...fresh.pinsFile.pins,
              [name]: {
                name,
                digest: sha256Hex(skillMdSnapshot),
                targetAgentGroups: freshTargetAgentGroups!,
                resolvedTargetAgents: freshResolvedTargetAgents!,
                status: "active",
                promotedAt: new Date().toISOString(),
              },
            },
          };
          try {
            writePersonalPinsAtomic(fresh.pinsPath, newPins, deps);
          } catch (error) {
            try {
              renameSync(targetDir, stagingPath);
            } catch {
              // 無法移回 staging 時仍嘗試還原 backup；失敗則保留現場供人工救援。
            }
            if (hadTarget) {
              try {
                renameSync(backupPath, targetDir);
              } catch {
                // 同上：還原失敗時保留 backup。
              }
            }
            removeTree(stagingPath);
            return jsonError(
              "REGISTRY_WRITE_FAILED",
              `bundle 交換完成但 personal pins registry 寫入失敗，已回滾目標交換：${(error as Error).message}`,
            );
          }
        }

        if (hadTarget) removeTree(backupPath);

        // managed 路由閉環：bundle 交換成功後才寫 agent 檔。每檔獨立原子
        // 寫入；單檔 skipped/failed 只記入 warnings 與回報，不回滾已成功的
        // bundle 晉升（回滾會讓已生效的 skill 憑空消失）。呼叫端可用
        // overwrite=true 重送同樣的 targetAgents 補寫路由。
        let agentRouting: AgentRoutingFileResult[] | undefined;
        if (targetAgents.length > 0) {
          agentRouting = applyAgentSkillRouting(resolveAgentsRoot(deps), name, "insert", targetAgents, deps);
          for (const entry of agentRouting) {
            if (entry.status === "failed" || entry.status === "skipped") {
              freshWarnings.push({ code: "AGENT_ROUTING_INCOMPLETE", message: `${entry.agent}：${entry.detail}` });
            }
          }
        }

        return jsonResult({
          ok: true,
          summary: `promotion 完成：${name} → ${scope} skill root（${listing.length} 個檔案）。`,
          data: {
            mode: "apply",
            scope,
            name,
            digest: sha256Hex(skillMdSnapshot),
            trustTier: freshReportedTier,
            filesWritten: [...listing].sort(),
            targetPath: targetDir,
            ...(freshTargetAgentGroups ? { targetAgentGroups: freshTargetAgentGroups } : {}),
            ...(freshResolvedTargetAgents ? { resolvedTargetAgents: freshResolvedTargetAgents } : {}),
            ...(agentRouting ? { agentRouting } : {}),
            ...(freshWarnings.length > 0 ? { warnings: freshWarnings } : {}),
          },
        });
        });
      } catch (error) {
        if (error instanceof ContentLockBusyError) {
          return jsonError("CONTENT_LOCK_BUSY", error.message, "請等待其他 skiller 寫入完成後再重試。");
        }
        return jsonError("TOOL_ERROR", `promote 失敗：${(error as Error).message}`);
      }
    },
  });
}
