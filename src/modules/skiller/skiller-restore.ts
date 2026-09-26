/**
 * opencode-ultrawork — skiller-restore tool factory
 *
 * 角色：
 *   - 把固定 quarantine root 內的 skill 移回對應的固定 skill root，作為
 *     `skiller-retire` 的反向操作。沒有這一支的話，quarantine 只出不進：
 *     退役後想復原只能人工開 shell，而且 quarantine 佔位還會讓同名 skill
 *     再也退役不了（QUARANTINE_EXISTS）。
 *   - 預設 preview 不移動；`mode="apply"` 必須 `confirm===true`。
 *   - 復原等同重新進入 discovery root，所以套用與 promote 完全相同的驗證與
 *     風險分級（personal scope 一律 fail closed，project scope 風險項降為
 *     警告），不因為「這份以前裝過」就跳過檢查。
 *   - personal scope 需要 pins registry 內有該 skill 的 retired pin；復原後
 *     以 atomic write 把 pin 改回 active 並更新 digest。pins 寫入失敗時把
 *     skill 移回 quarantine，維持 discovery root 與 pins 狀態一致。
 *
 * 刻意不提供的行為：
 *   - 目標 skill root 已有同名目錄時一律拒絕，沒有 overwrite 旁路。復原覆蓋
 *     一份正在生效的 skill 是語意不明的操作；正確順序是先 retire 現行那份。
 *
 * 限制：
 *   - 不得 import `src/index.ts`。
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../kit/define-tool.ts";
import { ContentLockBusyError } from "../../kit/write-lock.ts";
import { jsonError, jsonResult } from "../../kit/json.ts";
import {
  agentHasPersonalAskRoute,
  applyAgentSkillRouting,
  containedPath,
  deriveProjectSlug,
  ensureScopedFixedRoot,
  listSkillFiles,
  loadPersonalPins,
  loadPolicySnapshot,
  locateSkillDir,
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
  type PersonalPin,
  type PersonalPinsFile,
  type SkillerDeps,
} from "./skiller-common.ts";

interface RestoreArgs {
  scope?: "project" | "personal" | "managed";
  name?: string;
  mode?: "preview" | "apply";
  confirm?: boolean;
  targetAgentGroups?: string[];
  targetAgents?: string[];
}

export function createSkillerRestoreTool(deps: SkillerDeps) {
  return defineTool({
    name: "skiller-restore",
    description:
      "把固定 quarantine root 內的 skill 移回固定 skill root（skiller-retire 的反向操作）：預設 preview 不移動；apply 需 confirm=true。復原會重跑與 promote 相同的驗證與風險分級；personal scope 需要 registry 內的 retired pin，成功後把 pin 改回 active。目標已存在同名 skill 時一律拒絕。managed scope 可選 targetAgents，在復原成功後重新插入指定 agent 的 permission.skill exact 行。",
    inputSchema: z.object({
      scope: z.enum(["project", "personal", "managed"]).optional(),
      name: z.string().optional(),
      mode: z.enum(["preview", "apply"]).optional(),
      confirm: z.boolean().optional(),
      targetAgentGroups: z.array(z.string()).optional(),
      targetAgents: z.array(z.string()).optional(),
    }),
    async execute(args: RestoreArgs, context: ToolExecutionContext) {
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

        // managed 路由閉環：targetAgents 只支援 managed scope（personal 走
        // targetAgentGroups、project 走 project-* ask）。檢查放在任何
        // mutation 之前。
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

        const roots = resolveScopeRoots(scope, deps, context);
        const policyLoad = loadPolicySnapshot(resolvePolicyPath(deps));
        const policy = policyLoad.ok ? policyLoad.policy : null;

        // 定位 quarantine 來源（含 scoped fixed-root guard 與 symlink 拒絕）。
        const located = locateSkillDir("quarantine", scope, name, deps, context);
        if (!located.ok) {
          if (located.code === "NOT_FOUND") {
            return jsonError("NOT_FOUND", `quarantine 內找不到 skill：${name}`, "請先用 skiller-scan 確認 quarantine 內容。");
          }
          return jsonError(located.code, located.message, "請先人工檢查固定 quarantine root 狀態後再試一次。");
        }
        const sourceDir = located.value.dir;

        // bundle 走訪：含 symlink 或任一讀取失敗一律 fail closed，不把不完整
        // bundle 移回 discovery root。
        const listing = listSkillFiles(sourceDir, deps);
        if (!listing.ok) {
          return jsonError(listing.issue.code, listing.issue.message, "請先檢查 quarantine 內的 bundle 後再試一次。");
        }
        if (!listing.files.includes("SKILL.md")) {
          return jsonError("SKILL_READ_FAILED", "quarantine 內的 bundle 缺少 SKILL.md；拒絕復原。", "請確認 bundle 完整後再試一次。");
        }
        const skillMdGuard = containedPath(sourceDir, sourceDir, "SKILL.md");
        if (!skillMdGuard.ok) {
          return jsonError(skillMdGuard.code, skillMdGuard.message, "請確認 SKILL.md 路徑安全後再試一次。");
        }
        let raw: string;
        try {
          raw = readFileSync(skillMdGuard.value, "utf-8");
        } catch {
          return jsonError("SKILL_READ_FAILED", "無法讀取 quarantine 內的 SKILL.md；拒絕復原。", "請確認 SKILL.md 可讀取後再試一次。");
        }
        const digest = sha256Hex(raw);

        // personal pins：先載入以便驗證 trust tier 與 pin 狀態。
        let pinsFile: PersonalPinsFile | null = null;
        let pinsPath: string | null = null;
        let existingPin: PersonalPin | undefined;
        if (scope === "personal") {
          pinsPath = resolvePersonalPinsPath(deps, policy);
          const loadedPins = loadPersonalPins(pinsPath);
          if (!loadedPins.ok) {
            return jsonError(loadedPins.code, loadedPins.message, "請先修復 personal pins registry 後再試一次。");
          }
          pinsFile = loadedPins.pins;
          existingPin = pinsFile.pins[name];
        }

        // 復原 = 重新進 discovery root，套用與 promote 相同的完整驗證。
        const validation = validateSkillDir({
          skillDir: sourceDir,
          declaredName: name,
          scope,
          projectSlug,
          policy,
          personalPins: pinsFile,
          deps,
        });
        const { blockers, warnings } = partitionIssuesForScope(validation, scope, { policy, skillName: name });

        // managed 與 personal 共用 global skill root；只有 project 走 project-local。
        const targetRoot = scope === "project"
          ? resolve(deps.resolveProjectRoot(context), ".opencode/skills")
          : roots.skillRoot;
        const targetLexical = resolve(targetRoot, name);

        // 復原後要生效的語意 group 原始輸入（可能為空；為空時鎖內沿用新鮮 pin 上記錄的那組）。
        const rawRequestedGroups = Array.isArray(args.targetAgentGroups) && args.targetAgentGroups.length > 0
          ? args.targetAgentGroups.map((group) => String(group).trim()).filter((group) => group.length > 0)
          : [];
        // 鎖前 fail-fast 與 preview 用的有效 groups（鎖外 pin 可能是舊的，僅供回報；
        // 寫入依據一律在鎖內以新鮮 pin 重算）。
        const preRequestedGroups = rawRequestedGroups.length > 0
          ? rawRequestedGroups
          : existingPin?.targetAgentGroups ?? [];

        // ─── preview：不移動任何目錄 ───
        if (mode === "preview") {
          let groupInfo: Record<string, unknown> = {};
          if (scope === "personal" && preRequestedGroups.length > 0) {
            const resolution = resolveAgentGroups(preRequestedGroups, policy);
            groupInfo = resolution.ok
              ? { targetAgentGroups: resolution.groups, resolvedTargetAgents: resolution.agents }
              : { groupErrors: [{ code: resolution.code, message: resolution.message }] };
          }
          // managed preview：未知 agent 直接拒絕，其餘顯示計畫寫入。
          if (targetAgents.length > 0) {
            const agentsRoot = resolveAgentsRoot(deps);
            const pre = prevalidateTargetAgents(agentsRoot, targetAgents);
            if (!pre.ok) {
              return jsonError("UNKNOWN_AGENT", `未知的 agent：${pre.unknownAgent}（${pre.reason}）`, "請確認 agents/<name>.md 存在後再試一次。");
            }
            groupInfo = {
              ...groupInfo,
              agentRouting: {
                targetAgents,
                planned: previewAgentSkillRouting(agentsRoot, name, "insert", targetAgents),
              },
            };
          }
          return jsonResult({
            ok: true,
            summary: `restore preview：${name} 將由 quarantine 移回 ${scope} skill root（readiness=${validation.readiness}）。`,
            data: {
              mode: "preview",
              scope,
              name,
              sourcePath: sourceDir,
              targetPath: targetLexical,
              digest,
              files: listing.files,
              trustTier: validation.trustTier,
              blockers,
              warnings,
              readiness: validation.readiness,
              ...(scope === "personal"
                ? {
                    pinStatus: existingPin?.status ?? null,
                    requirements: ["mode=apply", "confirm=true", "registry 內有此 skill 的 retired pin"],
                  }
                : { requirements: ["mode=apply", "confirm=true"] }),
              ...groupInfo,
            },
          });
        }

        // ─── apply：confirm gate ───
        if (args.confirm !== true) {
          return jsonResult({
            ok: false,
            code: "CONFIRM_REQUIRED",
            summary: "restore apply 需要明確 confirm=true；未移動任何目錄。",
            nextAction: "請先執行 preview 確認，再以 confirm=true 重送。",
            data: { mode: "apply", scope, name },
          });
        }

        if (blockers.length > 0) {
          return jsonResult({
            ok: false,
            code: "RESTORE_BLOCKED",
            summary: `復原被 ${blockers.length} 個 blocker 阻擋；未移動任何目錄。`,
            nextAction: "請依 blockers 清單處理 quarantine 內的內容後再試一次。",
            data: { mode: "apply", scope, name, blockers, warnings },
          });
        }

        // personal：pin 必須存在且為 retired；group 解析與路由檢查全部在任何
        // filesystem mutation 之前 fail closed（鎖前 fail-fast；鎖內以新鮮 pin 重做一次）。
        if (scope === "personal") {
          if (!existingPin) {
            return jsonError(
              "PIN_NOT_FOUND",
              `personal pins registry 沒有此 skill 的紀錄：${name}`,
              "請確認此 skill 的來源，或改用 skiller-draft + skiller-promote 重新建立。",
            );
          }
          if (existingPin.status !== "retired") {
            return jsonError(
              "PIN_STATUS_DRIFT",
              `pin 狀態為 ${existingPin.status}，只有 retired pin 可以復原：${name}`,
              "請先人工確認 pin 狀態後再試一次。",
            );
          }
          if (preRequestedGroups.length === 0) {
            return jsonResult({
              ok: false,
              code: "TARGET_GROUPS_REQUIRED",
              summary: "pin 上沒有可沿用的 targetAgentGroups，復原需要明確指定。",
              nextAction: "請提供要套用此 skill 的語意 agent groups 後重試。",
              data: { mode: "apply", scope, name },
            });
          }
          const resolution = resolveAgentGroups(preRequestedGroups, policy);
          if (!resolution.ok) {
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
              summary: `group 成員缺少 personal-* 路由：${missingRoute.join(", ")}`,
              nextAction: "請先為這些 agent 加入 personal-*: ask（或 allow）的 skill 路由後再重試。",
              data: { mode: "apply", scope, name, agents: resolution.agents },
            });
          }
          // 解析結果只供鎖前 fail-fast；寫入依據在鎖內以新鮮 policy 重算。
        }

        // managed：未知 agent 在任何 mutation 之前拒絕。
        if (targetAgents.length > 0) {
          const agentsRoot = resolveAgentsRoot(deps);
          const pre = prevalidateTargetAgents(agentsRoot, targetAgents);
          if (!pre.ok) {
            return jsonError("UNKNOWN_AGENT", `未知的 agent：${pre.unknownAgent}（${pre.reason}）`, "請確認 agents/<name>.md 存在後再試一次。");
          }
        }

        // 鎖內唯一可信狀態是 fresh 快照：roots／projectSlug／policy／pins 全部重載。
        // 復原等同重新進入 discovery root，鎖內跑與 promote 相同的完整驗證
        // （validateSkillDir＋partition），只比 SKILL.md digest 不算重驗。
        // 鎖前的 listing／digest／validation／group 解析只做 preview 與早期拒絕。
        return await withFreshSkillerLock(scope, name, deps, context, async (fresh) => {
        // personal pins gate（新鮮）：pin 必須存在且為 retired。
        let freshPin: PersonalPin | undefined;
        if (scope === "personal") {
          if (fresh.pinsError !== null || fresh.pinsFile === null) {
            const code = fresh.pinsError?.code ?? "REGISTRY_UNAVAILABLE";
            const message = fresh.pinsError?.message ?? "無法讀取 personal pins registry";
            return jsonError(code, message, "請先修復 personal pins registry 後再試一次。");
          }
          const pin = fresh.pinsFile.pins[name];
          if (!pin) {
            return jsonError(
              "PIN_NOT_FOUND",
              `personal pins registry 沒有此 skill 的紀錄：${name}`,
              "請確認此 skill 的來源，或改用 skiller-draft + skiller-promote 重新建立。",
            );
          }
          if (pin.status !== "retired") {
            return jsonError(
              "PIN_STATUS_DRIFT",
              `personal pins registry 的 pin 狀態已變更：${name}`,
              "請先人工確認 pin 狀態後再試一次。",
            );
          }
          freshPin = pin;
        }
        // 有效 groups（新鮮）：明確輸入優先，否則沿用新鮮 pin 上的紀錄。
        const freshRequestedGroups = rawRequestedGroups.length > 0
          ? rawRequestedGroups
          : freshPin?.targetAgentGroups ?? [];
        // personal：group 解析與路由檢查以新鮮 policy 重跑，全部在任何
        // filesystem mutation 之前 fail closed。
        let freshResolvedGroups: string[] | undefined;
        let freshResolvedTargetAgents: string[] | undefined;
        if (scope === "personal") {
          if (freshRequestedGroups.length === 0) {
            return jsonResult({
              ok: false,
              code: "TARGET_GROUPS_REQUIRED",
              summary: "pin 上沒有可沿用的 targetAgentGroups，復原需要明確指定。",
              nextAction: "請提供要套用此 skill 的語意 agent groups 後重試。",
              data: { mode: "apply", scope, name },
            });
          }
          const lockedResolution = resolveAgentGroups(freshRequestedGroups, fresh.policy);
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
              summary: `group 成員缺少 personal-* 路由：${lockedMissingRoute.join(", ")}`,
              nextAction: "請先為這些 agent 加入 personal-*: ask（或 allow）的 skill 路由後再重試。",
              data: { mode: "apply", scope, name, agents: lockedResolution.agents },
            });
          }
          freshResolvedGroups = lockedResolution.groups;
          freshResolvedTargetAgents = lockedResolution.agents;
        }

        // managed：未知 agent 在任何 mutation 之前拒絕（新鮮 agents 目錄）。
        if (targetAgents.length > 0) {
          const lockedAgentsRoot = resolveAgentsRoot(deps);
          const lockedPre = prevalidateTargetAgents(lockedAgentsRoot, targetAgents);
          if (!lockedPre.ok) {
            return jsonError("UNKNOWN_AGENT", `未知的 agent：${lockedPre.unknownAgent}（${lockedPre.reason}）`, "請確認 agents/<name>.md 存在後再試一次。");
          }
        }

        // quarantine bundle 全量重驗（新鮮 policy＋新鮮 pins＋新鮮 projectSlug）。
        const verdictResult = validateLockedBundle("quarantine", fresh, deps, fresh.pinsFile, context);
        if (!verdictResult.ok) return jsonError(verdictResult.code, verdictResult.message, "請重新執行 skiller-restore。");
        const verdict = verdictResult.verdict;
        if (verdict.blockers.length > 0) {
          return jsonResult({
            ok: false,
            code: "RESTORE_BLOCKED",
            summary: `鎖內重驗發現 ${verdict.blockers.length} 個 blocker；未移動任何目錄。`,
            nextAction: "請依 blockers 清單處理 quarantine 內的內容後再試一次。",
            data: { mode: "apply", scope, name, blockers: verdict.blockers, warnings: verdict.warnings },
          });
        }
        // 目標 root（新鮮）：先驗證路徑安全（祖先 symlink escape 在 mkdir 前擋下），
        // 建立後再通過完整 fixed-root guard。
        const freshTargetRoot = scope === "project"
          ? resolve(deps.resolveProjectRoot(context), ".opencode/skills")
          : fresh.roots.skillRoot;
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
        const targetGuard = containedPath(targetRootGuard.value, freshTargetRoot, name);
        if (!targetGuard.ok) {
          return jsonError(targetGuard.code, targetGuard.message, "請確認目標路徑安全後再試一次。");
        }
        if (existsSync(targetGuard.value)) {
          return jsonError(
            "ALREADY_EXISTS",
            `skill root 已存在同名 skill：${name}`,
            "復原不覆蓋生效中的 skill；請先用 skiller-retire 把現行那份退役後再復原。",
          );
        }

        // rename 是 move 不是複製；來源一律用鎖內 verdict 的新鮮定位。跨裝置時回結構化錯誤。
        try {
          renameSync(verdict.sourceDir, targetGuard.value);
        } catch (error) {
          return jsonError("RESTORE_MOVE_FAILED", `無法從 quarantine 移回 skill root：${(error as Error).message}`);
        }

        // personal：移動成功後把 pin 改回 active 並更新 digest／routing；
        // 寫入失敗時把 skill 移回 quarantine，維持兩邊狀態一致。
        if (scope === "personal" && fresh.pinsFile !== null && fresh.pinsPath !== null && freshPin) {
          const { retiredAt: _retiredAt, ...pinWithoutRetiredAt } = freshPin;
          const updatedPins: PersonalPinsFile = {
            schemaVersion: PERSONAL_PINS_SCHEMA_VERSION,
            pins: {
              ...fresh.pinsFile.pins,
              [name]: {
                ...pinWithoutRetiredAt,
                digest: verdict.digest,
                targetAgentGroups: freshResolvedGroups!,
                resolvedTargetAgents: freshResolvedTargetAgents!,
                status: "active",
                promotedAt: new Date().toISOString(),
              },
            },
          };
          try {
            writePersonalPinsAtomic(fresh.pinsPath, updatedPins, deps);
          } catch (error) {
            try {
              renameSync(targetGuard.value, verdict.sourceDir);
            } catch (rollbackError) {
              return jsonError(
                "REGISTRY_WRITE_FAILED",
                `pins registry 寫入失敗且回滾失敗，skill 留在 skill root：${(rollbackError as Error).message}；請人工檢查 ${targetGuard.value}`,
              );
            }
            return jsonError("REGISTRY_WRITE_FAILED", `pins registry 寫入失敗，已把 skill 移回 quarantine：${(error as Error).message}`);
          }
        }

        return jsonResult({
          ok: true,
          summary: `restore 完成：${name} 已由 quarantine 移回 ${scope} skill root。`,
          data: {
            mode: "apply",
            scope,
            name,
            digest: verdict.digest,
            filesRestored: [...verdict.listing].sort(),
            movedFrom: verdict.sourceDir,
            movedTo: targetGuard.value,
            warnings: verdict.warnings,
            ...(freshResolvedGroups ? { targetAgentGroups: freshResolvedGroups } : {}),
            ...(freshResolvedTargetAgents ? { resolvedTargetAgents: freshResolvedTargetAgents } : {}),
            // managed 路由閉環：復原成功後重新插入 exact 行，與 retire 對稱。
            // 單檔 skipped/failed 只記入 warnings，不把 skill 移回 quarantine。
            ...(targetAgents.length > 0
              ? (() => {
                  const agentRouting = applyAgentSkillRouting(
                    resolveAgentsRoot(deps),
                    name,
                    "insert",
                    targetAgents,
                    deps,
                  ) as AgentRoutingFileResult[];
                  const routingWarnings = agentRouting
                    .filter((entry) => entry.status === "failed" || entry.status === "skipped")
                    .map((entry) => ({ code: "AGENT_ROUTING_INCOMPLETE", message: `${entry.agent}：${entry.detail}` }));
                  return { agentRouting, warnings: [...verdict.warnings, ...routingWarnings] };
                })()
              : {}),
          },
        });
        });
      } catch (error) {
        if (error instanceof ContentLockBusyError) {
          return jsonError("CONTENT_LOCK_BUSY", error.message, "請等待其他 skiller 寫入完成後再重試。");
        }
        return jsonError("TOOL_ERROR", `restore 失敗：${(error as Error).message}`);
      }
    },
  });
}
