/**
 * opencode-ultrawork — skiller-retire tool factory
 *
 * 角色：
 *   - 把固定 skill root 內的已安裝 skill 移到固定 quarantine root。
 *   - 預設 preview 不移動；`mode="apply"` 必須 `confirm===true`。
 *   - 只 quarantine：禁止直接刪除；拒絕覆蓋既有 quarantine；拒絕 symlink source；
 *     回傳 digest 與 metadata 供後續審查。
 *   - personal apply 在 quarantine 成功後以 atomic write 把 personal pins
 *     registry 的 pin 標記 retired；pins 寫入失敗時把 skill 移回原位置，
 *     維持 discovery root 與 pins 狀態一致。
 *
 * 限制：
 *   - 不得 import `src/index.ts`。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../kit/define-tool.ts";
import { ContentLockBusyError } from "../../kit/write-lock.ts";
import { jsonError, jsonResult } from "../../kit/json.ts";
import {
  applyAgentSkillRouting,
  containedPath,
  deriveProjectSlug,
  deriveTrustTier,
  ensureScopedFixedRoot,
  loadPersonalPins,
  loadPolicySnapshot,
  listSkillFiles,
  locateFreshSource,
  normalizeScope,
  parseFrontmatter,
  previewAgentSkillRouting,
  resolveAgentsRoot,
  resolvePersonalPinsPath,
  resolvePolicyPath,
  resolveScopeRoots,
  sha256Hex,
  validateSkillName,
  withFreshSkillerLock,
  writePersonalPinsAtomic,
  type AgentRoutingFileResult,
  type PersonalPinsFile,
  type PolicySnapshot,
  type SkillerDeps,
} from "./skiller-common.ts";

interface RetireArgs {
  scope?: "project" | "personal" | "managed";
  name?: string;
  mode?: "preview" | "apply";
  confirm?: boolean;
}

export function createSkillerRetireTool(deps: SkillerDeps) {
  return defineTool({
    name: "skiller-retire",
    description:
      "把固定 skill root 內的已安裝 skill 移到固定 quarantine root：預設 preview 不移動；apply 需 confirm=true。只 quarantine、不刪除、不覆蓋既有 quarantine、拒絕 symlink source；回傳 digest 與 metadata。managed scope apply 另掃描全部 agent 檔並移除該 skill 的 permission.skill exact 行。",
    inputSchema: z.object({
      scope: z.enum(["project", "personal", "managed"]).optional(),
      name: z.string().optional(),
      mode: z.enum(["preview", "apply"]).optional(),
      confirm: z.boolean().optional(),
    }),
    async execute(args: RetireArgs, context: ToolExecutionContext) {
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

        const roots = resolveScopeRoots(scope, deps, context);
        const policyLoad = loadPolicySnapshot(resolvePolicyPath(deps));
        const policy = policyLoad.ok ? policyLoad.policy : null;

        // 定位已安裝 skill（必須存在、是目錄、非 symlink）。
        // scoped fixed-root guard 必須先於任何 filesystem 讀取；guard 失敗
        // （含祖先 symlink escape）時不得對 root 或 name target 做任何讀取。
        // symlink 判定使用 containedPath 的結構化結果，不做額外 fallback lstat。
        let sourceDir: string | null = null;
        let symlinkRejected = false;
        const skillRootGuard = ensureScopedFixedRoot(roots.skillRoot, scope, deps, context);
        if (skillRootGuard.ok) {
          const guard = containedPath(skillRootGuard.value, roots.skillRoot, name);
          if (guard.ok) {
            try {
              const st = statSync(guard.value);
              if (st.isDirectory()) sourceDir = guard.value;
            } catch {
              sourceDir = null;
            }
          } else if (guard.code === "SYMLINK_REJECTED" || guard.code === "ROOT_ESCAPE") {
            // lexical containment 已通過，此二者只可能由 target 的 symlink 造成。
            symlinkRejected = true;
          }
        }
        if (sourceDir === null) {
          if (symlinkRejected) {
            return jsonError("SYMLINK_REJECTED", "skill 目錄是 symlink，拒絕 retire", "請先人工檢查此 symlink 後再試一次。");
          }
          return jsonError("NOT_FOUND", `找不到已安裝 skill：${name}`, "請先用 skiller-scan 確認目前已安裝的 skill。");
        }

        // bundle 內任何 symlink 或走訪失敗都必須在 metadata read 前拒絕，避免
        // readFileSync 追蹤 bundle 外部內容，或把不完整 bundle 移入 quarantine。
        const bundleFiles = listSkillFiles(sourceDir, deps);
        if (!bundleFiles.ok) {
          return jsonError(bundleFiles.issue.code, bundleFiles.issue.message, "請先檢查 skill bundle 後再試一次。");
        }
        const metadataGuard = containedPath(sourceDir, sourceDir, "SKILL.md");
        if (!metadataGuard.ok || !bundleFiles.files.includes("SKILL.md")) {
          return jsonError("SKILL_READ_FAILED", "無法讀取 skill 的 SKILL.md；拒絕 retire。", "請確認 SKILL.md 是固定 bundle 內可讀取的 regular file。");
        }

        // 讀取已通過 bundle 與 path guard 的 metadata（digest / frontmatter summary）。
        let raw: string;
        try {
          raw = readFileSync(metadataGuard.value, "utf-8");
        } catch {
          return jsonError("SKILL_READ_FAILED", "無法讀取 skill 的 SKILL.md；拒絕 retire。", "請確認 SKILL.md 可讀取後再試一次。");
        }
        const digest = sha256Hex(raw);
        const fm = parseFrontmatter(raw);
        const frontmatterName = fm?.ok && typeof fm.data.name === "string" ? fm.data.name.trim() : null;
        const description = fm?.ok && typeof fm.data.description === "string" ? fm.data.description.trim() : null;

        const quarantineTargetLexical = resolve(roots.quarantineRoot, name);

        // ─── preview：不移動（registry 失敗時不 fallback 到 policy digest，維持 fail-closed）───
        if (mode === "preview") {
          let previewPins: PersonalPinsFile | null = null;
          let previewRegistryUnavailable = false;
          if (scope === "personal") {
            const previewPinsPath = resolvePersonalPinsPath(deps, policy);
            const previewPinsLoad = loadPersonalPins(previewPinsPath);
            if (previewPinsLoad.ok) {
              previewPins = previewPinsLoad.pins;
            } else {
              previewRegistryUnavailable = true;
            }
          }
          return jsonResult({
            ok: true,
            summary: `retire preview：${name} 將移至 quarantine（未移動）。`,
            data: {
              mode: "preview",
              scope,
              name,
              sourcePath: sourceDir,
              quarantinePath: quarantineTargetLexical,
              digest,
              trustTier: deriveTierForRetire(name, digest, policy, previewPins, previewRegistryUnavailable, scope),
              requirements: ["mode=apply", "confirm=true"],
              ...(scope === "managed"
                ? {
                    agentRouting: {
                      planned: previewAgentSkillRouting(resolveAgentsRoot(deps), name, "remove", null),
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
            summary: "retire apply 需要明確 confirm=true；未移動任何目錄。",
            nextAction: "請先執行 preview 確認，再以 confirm=true 重送。",
            data: { mode: "apply", scope, name },
          });
        }

        // personal：在任何 mutation 前載入 pins registry 並檢查 pin 狀態，
        // missing / malformed / 無 pin / 非 active pin 一律 fail closed
        //（鎖前 fail-fast；鎖內以新鮮 pins 重做一次）。
        if (scope === "personal") {
          const prePinsPath = resolvePersonalPinsPath(deps, policy);
          const loadedPins = loadPersonalPins(prePinsPath);
          if (!loadedPins.ok) {
            return jsonError(loadedPins.code, loadedPins.message, "請先修復 personal pins registry 後再試一次。");
          }
          const pin = loadedPins.pins.pins[name];
          if (!pin) {
            return jsonError("PIN_NOT_FOUND", `personal pins registry 沒有此 skill 的紀錄：${name}`, "請先用 skiller-promote 建立 pin，或人工確認此 skill 的來源。");
          }
          if (pin.status !== "active") {
            return jsonError("PIN_STATUS_DRIFT", `pin 狀態為 ${pin.status}，只有 active pin 可以 retire：${name}`, "請先人工確認 pin 狀態後再試一次。");
          }
        }

        // 鎖內唯一可信狀態是 fresh 快照：roots／pins 全部重載。
        // retire 只搬運、不進入 discovery root，所以不跑內容驗證，但來源定位、
        // bundle 走訪、SKILL.md 重讀一律新鮮；quarantine 目標也必須用新鮮 roots。
        // 鎖前的 sourceDir／digest／metadata 只做 preview 與早期拒絕。
        return await withFreshSkillerLock(scope, name, deps, context, async (fresh) => {
        if (scope === "personal") {
          if (fresh.pinsError !== null || fresh.pinsFile === null) {
            const code = fresh.pinsError?.code ?? "REGISTRY_UNAVAILABLE";
            const message = fresh.pinsError?.message ?? "無法讀取 personal pins registry";
            return jsonError(code, message, "請先修復 personal pins registry 後再試一次。");
          }
          const lockedPin = fresh.pinsFile.pins[name];
          if (!lockedPin || lockedPin.status !== "active") {
            return jsonError("PIN_STATUS_DRIFT", `personal pins registry 的 pin 狀態已變更：${name}`, "請先人工確認 pin 狀態後再試一次。");
          }
        }
        const sourceResult = locateFreshSource("skill", fresh, deps, context);
        if (!sourceResult.ok) return jsonError(sourceResult.code, sourceResult.message, "請重新執行 skiller-retire。");
        const freshSource = sourceResult.source;
        const preQuarantineGuard = ensureScopedFixedRoot(fresh.roots.quarantineRoot, scope, deps, context);
        if (!preQuarantineGuard.ok) {
          return jsonError(preQuarantineGuard.code, preQuarantineGuard.message, "請確認固定 quarantine root 狀態後再試一次。");
        }
        try {
          mkdirSync(fresh.roots.quarantineRoot, { recursive: true });
        } catch {
          return jsonError("UNKNOWN_ROOT", "無法建立固定 quarantine root", "請確認固定 quarantine root 可寫入後再試一次。");
        }
        const quarantineGuard = ensureScopedFixedRoot(fresh.roots.quarantineRoot, scope, deps, context);
        if (!quarantineGuard.ok) {
          return jsonError(quarantineGuard.code, quarantineGuard.message, "請確認固定 quarantine root 狀態後再試一次。");
        }
        const targetGuard = containedPath(quarantineGuard.value, fresh.roots.quarantineRoot, name);
        if (!targetGuard.ok) {
          return jsonError(targetGuard.code, targetGuard.message, "請確認 quarantine 目標路徑安全後再試一次。");
        }
        if (existsSync(targetGuard.value)) {
          return jsonError(
            "QUARANTINE_EXISTS",
            `quarantine 已存在同名目錄：${name}`,
            "請先處理既有 quarantine：用 skiller-scan 看內容，再以 skiller-restore 復原或人工確認後移除，然後重試。",
          );
        }

        // rename 是 move 不是 delete；來源一律用鎖內新鮮定位。跨裝置時回結構化錯誤而非改用刪除。
        try {
          renameSync(freshSource.sourceDir, targetGuard.value);
        } catch (error) {
          return jsonError("QUARANTINE_MOVE_FAILED", `無法移動到 quarantine：${(error as Error).message}`);
        }

        // personal：quarantine 成功後以新鮮 pins 為基底原子寫入 retired 標記；
        // 寫入失敗時把 skill 移回 discovery root，維持 quarantine 與 pins 一致。
        if (scope === "personal" && fresh.pinsFile !== null && fresh.pinsPath !== null) {
          const previousPin = fresh.pinsFile.pins[name];
          const updatedPins: PersonalPinsFile = {
            schemaVersion: fresh.pinsFile.schemaVersion,
            pins: {
              ...fresh.pinsFile.pins,
              [name]: {
                ...previousPin,
                status: "retired",
                retiredAt: new Date().toISOString(),
              },
            },
          };
          try {
            writePersonalPinsAtomic(fresh.pinsPath, updatedPins, deps);
          } catch (error) {
            try {
              renameSync(targetGuard.value, freshSource.sourceDir);
            } catch (rollbackError) {
              return jsonError(
                "REGISTRY_WRITE_FAILED",
                `pins registry 寫入失敗且回滾失敗，skill 留在 quarantine：${(rollbackError as Error).message}；請人工檢查 ${targetGuard.value}`,
              );
            }
            return jsonError("REGISTRY_WRITE_FAILED", `pins registry 寫入失敗，已把 skill 移回原位置：${(error as Error).message}`);
          }
        }

        return jsonResult({
          ok: true,
          summary: `retire 完成：${name} 已移至 quarantine。`,
          data: {
            mode: "apply",
            scope,
            name,
            digest: freshSource.digest,
            frontmatterName: freshSource.frontmatterName,
            description: freshSource.description,
            movedFrom: freshSource.sourceDir,
            movedTo: targetGuard.value,
            // managed 路由閉環：quarantine 成功後掃描全部 agent 檔，移除該
            // skill 的 exact 行（無論 allow/ask/deny）。每檔獨立原子寫入；
            // 單檔失敗只如實回報，不把 skill 移回 skill root。
            ...(scope === "managed"
              ? {
                  agentRouting: applyAgentSkillRouting(
                    resolveAgentsRoot(deps),
                    name,
                    "remove",
                    null,
                    deps,
                  ) as AgentRoutingFileResult[],
                }
              : {}),
          },
        });
        });
      } catch (error) {
        if (error instanceof ContentLockBusyError) {
          return jsonError("CONTENT_LOCK_BUSY", error.message, "請等待其他 skiller 寫入完成後再重試。");
        }
        return jsonError("TOOL_ERROR", `retire 失敗：${(error as Error).message}`);
      }
    },
  });
}

function deriveTierForRetire(
  name: string,
  digest: string | null,
  policy: PolicySnapshot | null,
  personalPins: PersonalPinsFile | null = null,
  personalRegistryUnavailable = false,
  scope?: "project" | "personal" | "managed",
): string {
  return deriveTrustTier(name, digest, policy, personalPins, personalRegistryUnavailable, scope);
}
