/**
 * opencode-ultrawork — skiller-policy-update tool factory
 *
 * 角色：
 *   - 讓 Skiller 在匯入並晉升 managed skill 之後，把來源、核准與 digest
 *     登記進 skills-policy.json，完成 managed external 的治理閉環。
 *   - preview（預設）：讀取現行 policy、套用請求的變更、回傳 diff 與
 *     expectedSha256，不寫檔。
 *   - apply：需 `mode="apply"` + `confirm=true` + 新鮮 `expectedSha256`，
 *     以原子寫入更新 policy；sha 不符（檔案已被外部改動）fail closed。
 *   - 可寫範圍限四個區塊：managed（新增／更新 entry）、
 *     approval.agentAllowlist（新增名稱）、approval.contentDigests
 *     （新增／更新 64 hex digest）、scriptReviews（新增／更新 entry）；
 *     其他區塊逐字保留（值不變）。
 *   - 防禦性驗證：JSON 可解析、schemaVersion 存在、digest 為 64 hex、
 *     不得刪除既有 managed entry；結構異常一律 fail closed 不寫。
 *
 * 安全設計（不可放寬）：
 *   - tool args 不接受任何 path/root；policy 路徑由 skiller settings 注入，
 *     僅 direct factory 測試經 deps 注入覆寫。
 *   - 任何結構異常、sha 不符、越界區塊、刪除既有 managed entry 的嘗試
 *     都拒絕且不寫；apply 必須 confirm:true。
 *   - 寫入用 atomicWriteFileWithOps（temp + rename）：成功才替換原檔，
 *     失敗時原檔不變且 temp 被清理，不留半寫入狀態。
 *
 * 限制：
 *   - 不得 import `src/index.ts`。
 */

import { readFileSync, renameSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../kit/define-tool.ts";
import { ContentLockBusyError } from "../../kit/write-lock.ts";
import { jsonError, jsonResult } from "../../kit/json.ts";
import { atomicWriteFileWithOps } from "../../kit/atomic-write.ts";
import {
  deriveProjectSlug,
  resolvePolicyPath,
  resolveSkillerPolicyLockPath,
  assertSafeSkillerPath,
  sha256Hex,
  validateSkillName,
  withSkillerWriteLock,
  type SkillerDeps,
} from "./skiller-common.ts";

// ─── Args 型別 ───────────────────────────────────────────────

interface ManagedUpsertInput {
  name?: unknown;
  source?: unknown;
  maintainer?: unknown;
  curation?: unknown;
}

interface ContentDigestUpsertInput {
  name?: unknown;
  digest?: unknown;
}

interface ScriptReviewUpsertInput {
  name?: unknown;
  status?: unknown;
  files?: unknown;
  note?: unknown;
}

interface PolicyUpdateArgs {
  mode?: "preview" | "apply";
  confirm?: boolean;
  expectedSha256?: string;
  managedUpsert?: ManagedUpsertInput[];
  managedRemove?: string[];
  allowlistAdd?: string[];
  contentDigestUpsert?: ContentDigestUpsertInput[];
  scriptReviewUpsert?: ScriptReviewUpsertInput[];
}

/** 一次呼叫允許的 arg keys；其他一律視為越界區塊寫入嘗試。 */
const ALLOWED_ARG_KEYS: ReadonlySet<string> = new Set([
  "mode",
  "confirm",
  "expectedSha256",
  "managedUpsert",
  "managedRemove",
  "allowlistAdd",
  "contentDigestUpsert",
  "scriptReviewUpsert",
]);

const HEX64_PATTERN = /^[0-9a-f]{64}$/;

interface PolicyDiffEntry {
  block: "managed" | "approval.agentAllowlist" | "approval.contentDigests" | "scriptReviews";
  name: string;
  action: "added" | "updated" | "unchanged";
}

// ─── 小 helper ───────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 輕量名稱檢查：非空、無空白、長度收斂（catalog 級的 namespace 由 managedUpsert 另行把關）。 */
function checkLightName(raw: unknown): { ok: true; name: string } | { ok: false } {
  if (!nonEmptyString(raw)) return { ok: false };
  const name = raw.trim();
  if (name.length > 64 || /\s/.test(name)) return { ok: false };
  return { ok: true, name };
}

function loadPolicyRaw(policyPath: string):
  | { ok: true; raw: string }
  | { ok: false; code: "POLICY_READ_FAILED" | "POLICY_MALFORMED"; message: string } {
  try {
    assertSafeSkillerPath(policyPath);
    return { ok: true, raw: readFileSync(policyPath, "utf-8") };
  } catch (error) {
    return { ok: false, code: "POLICY_READ_FAILED", message: `無法讀取 skills policy：${(error as Error).message}` };
  }
}

function parsePolicy(raw: string):
  | { ok: true; policy: Record<string, unknown> }
  | { ok: false; code: "POLICY_MALFORMED" | "POLICY_SCHEMA_INVALID" | "POLICY_NESTED_INVALID"; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, code: "POLICY_MALFORMED", message: `skills policy 解析失敗：${(error as Error).message}` };
  }
  if (!isRecord(parsed)) {
    return { ok: false, code: "POLICY_MALFORMED", message: "skills policy 必須是 JSON 物件" };
  }
  if (parsed.schemaVersion === undefined || parsed.schemaVersion === null) {
    return { ok: false, code: "POLICY_SCHEMA_INVALID", message: "skills policy 缺少 schemaVersion；拒絕寫入" };
  }
  // 既有可寫區塊若存在必須是物件，否則結構已損壞，fail closed。
  for (const key of ["managed", "approval", "scriptReviews"] as const) {
    if (parsed[key] !== undefined && !isRecord(parsed[key])) {
      return { ok: false, code: "POLICY_SCHEMA_INVALID", message: `skills policy 的 ${key} 必須是物件；拒絕寫入` };
    }
  }

  const approval = parsed.approval as Record<string, unknown> | undefined;
  if (approval !== undefined) {
    const agentAllowlist = approval.agentAllowlist;
    if (
      agentAllowlist !== undefined &&
      (!Array.isArray(agentAllowlist) || agentAllowlist.some((name) => !checkLightName(name).ok))
    ) {
      return {
        ok: false,
        code: "POLICY_NESTED_INVALID",
        message: "skills policy 的 approval.agentAllowlist 必須是正規名稱字串陣列；拒絕寫入",
      };
    }
    const contentDigests = approval.contentDigests;
    if (
      contentDigests !== undefined &&
      (!isRecord(contentDigests) || Object.values(contentDigests).some((digest) => typeof digest !== "string" || !HEX64_PATTERN.test(digest)))
    ) {
      return {
        ok: false,
        code: "POLICY_NESTED_INVALID",
        message: "skills policy 的 approval.contentDigests 必須是 64 位小寫 hex digest 物件；拒絕寫入",
      };
    }
  }

  const scriptReviews = parsed.scriptReviews as Record<string, unknown> | undefined;
  if (scriptReviews !== undefined) {
    for (const [name, review] of Object.entries(scriptReviews)) {
      if (
        !isRecord(review) ||
        !nonEmptyString(review.status) ||
        (review.files !== undefined && (!Array.isArray(review.files) || review.files.some((file) => !nonEmptyString(file)))) ||
        (review.note !== undefined && typeof review.note !== "string")
      ) {
        return {
          ok: false,
          code: "POLICY_NESTED_INVALID",
          message: `skills policy 的 scriptReviews.${name} 形狀不完整；拒絕寫入`,
        };
      }
    }
  }
  return { ok: true, policy: parsed };
}

function serializePolicy(policy: Record<string, unknown>): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

// ─── Tool factory ────────────────────────────────────────────

export function createSkillerPolicyUpdateTool(deps: SkillerDeps) {
  return defineTool({
    name: "skiller-policy-update",
    description:
      "把來源、核准與 digest 登記進 skills-policy.json：preview 回 diff 與 expectedSha256 不寫檔；apply 需 confirm=true 與新鮮 expectedSha256，原子寫入。可寫範圍限 managed、approval.agentAllowlist、approval.contentDigests、scriptReviews；其他區塊逐字保留。不接受任意路徑。",
    inputSchema: z.object({
      mode: z.enum(["preview", "apply"]).optional(),
      confirm: z.boolean().optional(),
      expectedSha256: z.string().optional(),
      managedUpsert: z
        .array(
          z.object({
            name: z.string(),
            source: z.string(),
            maintainer: z.string().optional(),
            curation: z.string().optional(),
          }),
        )
        .optional(),
      managedRemove: z.array(z.string()).optional(),
      allowlistAdd: z.array(z.string()).optional(),
      contentDigestUpsert: z
        .array(
          z.object({
            name: z.string(),
            digest: z.string(),
          }),
        )
        .optional(),
      scriptReviewUpsert: z
        .array(
          z.object({
            name: z.string(),
            status: z.string(),
            files: z.array(z.string()).optional(),
            note: z.string().optional(),
          }),
        )
        .optional(),
    }).passthrough(),
    async execute(rawArgs: PolicyUpdateArgs & Record<string, unknown>, context: ToolExecutionContext) {
      try {
        const args = rawArgs ?? {};
        const mode = args.mode ?? "preview";
        if (mode !== "preview" && mode !== "apply") {
          return jsonError("INVALID_MODE", "mode 只能是 preview 或 apply", "請將 mode 改為 preview 或 apply。");
        }

        // 越界區塊：任何非白名單 key（例如 personalGovernance、retired、
        // schemaVersion）都視為超出可寫範圍的寫入嘗試，直接拒絕。
        for (const key of Object.keys(args)) {
          if (args[key] === undefined) continue;
          if (!ALLOWED_ARG_KEYS.has(key)) {
            return jsonError(
              "OUT_OF_SCOPE",
              `不支援的變更區塊：${key}。可寫範圍限 managed、approval.agentAllowlist、approval.contentDigests、scriptReviews。`,
              "請只使用白名單內的四個區塊參數；退役走 skiller-retire，personalGovernance 不由本工具變更。",
            );
          }
        }

        // 刪除既有 managed entry 一律拒絕（merge-only，不提供刪除語意）。
        if (Array.isArray(args.managedRemove) && args.managedRemove.length > 0) {
          return jsonError(
            "MANAGED_ENTRY_DELETION",
            `不得刪除既有 managed entry：${args.managedRemove.join(", ")}；未寫入任何檔案。`,
            "managed entry 只允許新增或更新；如下架請走 skiller-retire（退役另有 retired 規則）。",
          );
        }

        const policyPath = resolvePolicyPath(deps);
        const loaded = loadPolicyRaw(policyPath);
        if (!loaded.ok) return jsonError(loaded.code, `${loaded.message}；未寫入任何檔案。`);
        const parsed = parsePolicy(loaded.raw);
        if (!parsed.ok) return jsonError(parsed.code, `${parsed.message}；未寫入任何檔案。`);
        const currentSha256 = sha256Hex(loaded.raw);

        const projectSlug = deriveProjectSlug(resolve(deps.resolveProjectRoot(context)));

        // ─── 驗證請求的變更（寫入前全量驗證，任一失敗即整批拒絕）───
        interface PendingManaged { name: string; entry: Record<string, unknown> }
        const pendingManaged: PendingManaged[] = [];
        if (args.managedUpsert !== undefined) {
          if (!Array.isArray(args.managedUpsert)) {
            return jsonError("MANAGED_ENTRY_INVALID", "managedUpsert 必須是陣列；未寫入任何檔案。");
          }
          for (const item of args.managedUpsert) {
            if (!isRecord(item)) {
              return jsonError("MANAGED_ENTRY_INVALID", "managedUpsert 的每項必須是物件；未寫入任何檔案。");
            }
            const nameCheck = validateSkillName((item as ManagedUpsertInput).name, "managed", projectSlug);
            if (!nameCheck.ok) {
              return jsonError(nameCheck.code, `${nameCheck.message}；未寫入任何檔案。`, "managed entry 的 name 須為無 prefix 的 kebab-case。");
            }
            const source = (item as ManagedUpsertInput).source;
            const maintainer = (item as ManagedUpsertInput).maintainer;
            const curation = (item as ManagedUpsertInput).curation;
            if (!nonEmptyString(source)) {
              return jsonError("MANAGED_ENTRY_INVALID", `managed entry ${nameCheck.name} 缺少非空 source；未寫入任何檔案。`);
            }
            if (!nonEmptyString(maintainer)) {
              return jsonError("MANAGED_ENTRY_INVALID", `managed entry ${nameCheck.name} 缺少非空 maintainer；未寫入任何檔案。`);
            }
            if (curation !== undefined && typeof curation !== "string") {
              return jsonError("MANAGED_ENTRY_INVALID", `managed entry ${nameCheck.name} 的 curation 必須是字串；未寫入任何檔案。`);
            }
            const entry: Record<string, unknown> = {
              source: (source as string).trim(),
              maintainer: (maintainer as string).trim(),
            };
            if (typeof curation === "string" && curation.trim().length > 0) entry.curation = (curation as string).trim();
            pendingManaged.push({ name: nameCheck.name, entry });
          }
        }

        const pendingAllowlist: string[] = [];
        if (args.allowlistAdd !== undefined) {
          if (!Array.isArray(args.allowlistAdd)) {
            return jsonError("ALLOWLIST_ENTRY_INVALID", "allowlistAdd 必須是字串陣列；未寫入任何檔案。");
          }
          for (const rawName of args.allowlistAdd) {
            const checked = checkLightName(rawName);
            if (!checked.ok) {
              return jsonError("ALLOWLIST_ENTRY_INVALID", "allowlistAdd 的每項必須是非空字串；未寫入任何檔案。");
            }
            pendingAllowlist.push(checked.name);
          }
        }

        const pendingDigests: Array<{ name: string; digest: string }> = [];
        if (args.contentDigestUpsert !== undefined) {
          if (!Array.isArray(args.contentDigestUpsert)) {
            return jsonError("INVALID_DIGEST", "contentDigestUpsert 必須是陣列；未寫入任何檔案。");
          }
          for (const item of args.contentDigestUpsert) {
            if (!isRecord(item)) {
              return jsonError("INVALID_DIGEST", "contentDigestUpsert 的每項必須是物件；未寫入任何檔案。");
            }
            const checked = checkLightName((item as ContentDigestUpsertInput).name);
            const digest = (item as ContentDigestUpsertInput).digest;
            if (!checked.ok || typeof digest !== "string" || !HEX64_PATTERN.test(digest)) {
              return jsonError(
                "INVALID_DIGEST",
                `contentDigest 非法（name=${String((item as ContentDigestUpsertInput).name)}）：digest 必須是 64 位小寫 hex；未寫入任何檔案。`,
                "請提供 skiller-validate 回傳的完整 SHA-256 digest。",
              );
            }
            pendingDigests.push({ name: checked.name, digest });
          }
        }

        interface PendingReview { name: string; entry: Record<string, unknown> }
        const pendingReviews: PendingReview[] = [];
        if (args.scriptReviewUpsert !== undefined) {
          if (!Array.isArray(args.scriptReviewUpsert)) {
            return jsonError("SCRIPT_REVIEW_INVALID", "scriptReviewUpsert 必須是陣列；未寫入任何檔案。");
          }
          for (const item of args.scriptReviewUpsert) {
            if (!isRecord(item)) {
              return jsonError("SCRIPT_REVIEW_INVALID", "scriptReviewUpsert 的每項必須是物件；未寫入任何檔案。");
            }
            const input = item as ScriptReviewUpsertInput;
            const checked = checkLightName(input.name);
            if (!checked.ok) {
              return jsonError("SCRIPT_REVIEW_INVALID", "scriptReview 的 name 必須是非空字串；未寫入任何檔案。");
            }
            if (!nonEmptyString(input.status)) {
              return jsonError("SCRIPT_REVIEW_INVALID", `scriptReview ${checked.name} 缺少非空 status；未寫入任何檔案。`);
            }
            if (input.files !== undefined) {
              if (!Array.isArray(input.files) || input.files.some((f) => !nonEmptyString(f))) {
                return jsonError("SCRIPT_REVIEW_INVALID", `scriptReview ${checked.name} 的 files 必須是字串陣列；未寫入任何檔案。`);
              }
            }
            if (input.note !== undefined && typeof input.note !== "string") {
              return jsonError("SCRIPT_REVIEW_INVALID", `scriptReview ${checked.name} 的 note 必須是字串；未寫入任何檔案。`);
            }
            const entry: Record<string, unknown> = { status: (input.status as string).trim() };
            if (Array.isArray(input.files)) entry.files = [...(input.files as string[])];
            if (typeof input.note === "string") entry.note = input.note;
            pendingReviews.push({ name: checked.name, entry });
          }
        }

        // ─── 套用變更（只動四個區塊，其餘逐字保留）───
        const buildNext = (base: Record<string, unknown>): { next: Record<string, unknown>; diff: PolicyDiffEntry[] } => {
          const next = base as Record<string, unknown>;
          const diff: PolicyDiffEntry[] = [];
          if (pendingManaged.length > 0) {
            if (!isRecord(next.managed)) next.managed = {};
            const managed = next.managed as Record<string, unknown>;
            for (const { name, entry } of pendingManaged) {
              if (!(name in managed)) {
                managed[name] = entry;
                diff.push({ block: "managed", name, action: "added" });
              } else if (JSON.stringify(managed[name]) === JSON.stringify(entry)) {
                diff.push({ block: "managed", name, action: "unchanged" });
              } else {
                managed[name] = entry;
                diff.push({ block: "managed", name, action: "updated" });
              }
            }
          }
          if (pendingAllowlist.length > 0) {
            if (!isRecord(next.approval)) next.approval = {};
            const approval = next.approval as Record<string, unknown>;
            if (!Array.isArray(approval.agentAllowlist)) approval.agentAllowlist = [];
            const allowlist = approval.agentAllowlist as string[];
            for (const name of pendingAllowlist) {
              if (allowlist.includes(name)) {
                diff.push({ block: "approval.agentAllowlist", name, action: "unchanged" });
              } else {
                allowlist.push(name);
                diff.push({ block: "approval.agentAllowlist", name, action: "added" });
              }
            }
          }
          if (pendingDigests.length > 0) {
            if (!isRecord(next.approval)) next.approval = {};
            const approval = next.approval as Record<string, unknown>;
            if (!isRecord(approval.contentDigests)) approval.contentDigests = {};
            const digests = approval.contentDigests as Record<string, unknown>;
            for (const { name, digest } of pendingDigests) {
              if (!(name in digests)) {
                digests[name] = digest;
                diff.push({ block: "approval.contentDigests", name, action: "added" });
              } else if (digests[name] === digest) {
                diff.push({ block: "approval.contentDigests", name, action: "unchanged" });
              } else {
                digests[name] = digest;
                diff.push({ block: "approval.contentDigests", name, action: "updated" });
              }
            }
          }
          if (pendingReviews.length > 0) {
            if (!isRecord(next.scriptReviews)) next.scriptReviews = {};
            const reviews = next.scriptReviews as Record<string, unknown>;
            for (const { name, entry } of pendingReviews) {
              if (!(name in reviews)) {
                reviews[name] = entry;
                diff.push({ block: "scriptReviews", name, action: "added" });
              } else {
                const merged = { ...(reviews[name] as Record<string, unknown>), ...entry };
                if (JSON.stringify(reviews[name]) === JSON.stringify(merged)) {
                  diff.push({ block: "scriptReviews", name, action: "unchanged" });
                } else {
                  reviews[name] = merged;
                  diff.push({ block: "scriptReviews", name, action: "updated" });
                }
              }
            }
          }
          return { next, diff };
        };

        // 注意：buildNext 直接 mutate 傳入的 parsed 物件；preview 與 apply
        // 各自從新讀取的 raw 重新 parse，避免 preview 的物件被重用。
        const fresh = parsePolicy(loaded.raw);
        if (!fresh.ok) return jsonError(fresh.code, `${fresh.message}；未寫入任何檔案。`);
        const { next, diff } = buildNext(fresh.policy);
        const changed = diff.some((d) => d.action === "added" || d.action === "updated");
        const serialized = serializePolicy(next);
        const proposedSha256 = sha256Hex(serialized);

        // ─── preview：不寫入任何檔案 ───
        if (mode === "preview") {
          return jsonResult({
            ok: true,
            summary: changed
              ? `policy preview：${diff.filter((d) => d.action !== "unchanged").length} 項變更（未寫入任何檔案）。`
              : "policy preview：無變更（未寫入任何檔案）。",
            data: {
              mode: "preview",
              path: policyPath,
              changed,
              diff,
              expectedSha256: currentSha256,
              currentSha256,
              proposedSha256,
              hint: "帶 expectedSha256 與 confirm=true、mode=apply 寫入。",
            },
          });
        }

        // ─── apply：confirm gate + sha gate ───
        if (args.confirm !== true) {
          return jsonResult({
            ok: false,
            code: "CONFIRM_REQUIRED",
            summary: "policy apply 需要明確 confirm=true；未寫入任何檔案。",
            nextAction: "請先執行 preview 確認 diff，再以 confirm=true 與新鮮 expectedSha256 重送。",
            data: { mode: "apply", path: policyPath, changed, diff, currentSha256 },
          });
        }
        if (typeof args.expectedSha256 !== "string" || args.expectedSha256.length === 0) {
          return jsonResult({
            ok: false,
            code: "EXPECTED_SHA256_REQUIRED",
            summary: "policy apply 需要 fresh preview 的 expectedSha256；未寫入任何檔案。",
            nextAction: "請先執行 preview 取得 expectedSha256 後再重送。",
            data: { mode: "apply", path: policyPath, currentSha256 },
          });
        }

        // 鎖內重讀等價：apply 前重新讀取並比對 sha，外部改動即 fail closed。
        return await withSkillerWriteLock(resolveSkillerPolicyLockPath(deps), async () => {
          const latest = loadPolicyRaw(policyPath);
        if (!latest.ok) return jsonError(latest.code, `${latest.message}；未寫入任何檔案。`);
        const latestSha256 = sha256Hex(latest.raw);
        if (args.expectedSha256 !== latestSha256) {
          return jsonResult({
            ok: false,
            code: "POLICY_HASH_CONFLICT",
            summary: "skills policy 在 preview 之後已被外部改動；未寫入任何檔案。",
            nextAction: "請重新執行 preview 取得新 diff 與 expectedSha256，確認後再 apply。",
            data: { mode: "apply", path: policyPath, expectedSha256: args.expectedSha256, currentSha256: latestSha256 },
          });
        }
        const latestParsed = parsePolicy(latest.raw);
        if (!latestParsed.ok) return jsonError(latestParsed.code, `${latestParsed.message}；未寫入任何檔案。`);
        const rebuilt = buildNext(latestParsed.policy);
        const rebuiltSerialized = serializePolicy(rebuilt.next);
        const rebuiltChanged = rebuilt.diff.some((d) => d.action === "added" || d.action === "updated");
        if (!rebuiltChanged) {
          return jsonResult({
            ok: true,
            summary: "policy 無變更，不需寫入。",
            data: {
              mode: "apply",
              path: policyPath,
              applied: false,
              changed: false,
              diff: rebuilt.diff,
              currentSha256: latestSha256,
              proposedSha256: sha256Hex(rebuiltSerialized),
            },
          });
        }
        try {
          assertSafeSkillerPath(policyPath);
          const injected = deps.writeFile;
          atomicWriteFileWithOps(policyPath, rebuiltSerialized, {
            writeFileSync: (path, data, options) => {
              if (typeof path !== "string") {
                throw new TypeError("policy path 必須是字串");
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
        } catch (error) {
          // atomic write 保證：原檔維持不變（temp 已清理），不留半寫入狀態。
          return jsonError(
            "WRITE_FAILED",
            `policy 寫入失敗，原檔未動：${(error as Error).message}`,
            "請確認 policy 檔案可寫入後，以新鮮 preview 重試。",
          );
        }

        return jsonResult({
          ok: true,
          summary: `policy 更新完成：${rebuilt.diff.filter((d) => d.action !== "unchanged").length} 項變更已原子寫入。`,
          data: {
            mode: "apply",
            path: policyPath,
            applied: true,
            changed: true,
            diff: rebuilt.diff,
            currentSha256: latestSha256,
            proposedSha256: sha256Hex(rebuiltSerialized),
          },
        });
        });
      } catch (error) {
        if (error instanceof ContentLockBusyError) {
          return jsonError("CONTENT_LOCK_BUSY", error.message, "請等待其他 skiller 寫入完成後再重試。");
        }
        return jsonError("TOOL_ERROR", `policy update 失敗：${(error as Error).message}`);
      }
    },
  });
}
