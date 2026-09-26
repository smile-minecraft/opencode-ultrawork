/**
 * opencode-ultrawork — skiller draft 讀取／局部更新／刪除 tool factories
 *
 * 角色：
 *   - `skiller-draft-read`：讀固定 draft root 內的草稿——bundle 清單、outline、
 *     單一 section、行級 grep 或整檔內容，並一律回傳可用於併發保護的 SHA-256。
 *   - `skiller-draft-update`：對草稿做 section 級 replace/append/prepend/delete，
 *     走 preview（回 diff + sha）→ apply（需 `expectedSha256`）兩段式，
 *     與 plan-content-update 同一套語意。
 *   - `skiller-draft-delete`：刪除單一 bundle 檔案或整份草稿，走
 *     preview → `confirm=true`。只作用於 draft root；已安裝 skill 的退場
 *     一律走 skiller-retire 的 quarantine，不由此工具刪除。
 *
 * 安全設計（與其餘 skiller 工具一致）：
 *   - 不接受任何 path/root/destination args；root 由 scope + 固定常數決定。
 *   - 目標檔案路徑先過 validateBundleRelativePath，再過 fixed-root
 *     containment（lexical + realpath + symlink 拒絕）。
 *   - 整份草稿刪除前先以 listSkillFiles 走訪；bundle 內含 symlink 或任一
 *     讀取失敗一律 fail closed，不對來路不明的內容做遞迴刪除。
 *
 * 限制：
 *   - 不得 import `src/index.ts`。
 */

import { readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../kit/define-tool.ts";
import { ContentLockBusyError } from "../../kit/write-lock.ts";
import { jsonError, jsonResult } from "../../kit/json.ts";
import { atomicWriteFile } from "../../kit/atomic-write.ts";
import { grepContent } from "./content-grep.ts";
import { unifiedLineDiff } from "./line-diff.ts";
import { findSectionBounds } from "./section-parser.ts";
import {
  applyDraftUpdate,
  buildDraftOutline,
  draftSha256,
  parseDraftDocument,
  type DraftContentOp,
} from "./skiller-draft-content.ts";
import {
  containedPath,
  deriveProjectSlug,
  listSkillFiles,
  locateSkillDir,
  normalizeScope,
  parseFrontmatter,
  resolveSkillerLockPath,
  validateBundleRelativePath,
  validateSkillName,
  withSkillerWriteLock,
  type SkillerDeps,
} from "./skiller-common.ts";

const DEFAULT_FILE = "SKILL.md";

interface ResolvedDraftFile {
  draftDir: string;
  rel: string;
  absolute: string;
}

/**
 * 共用前置：scope / name 驗證 → 定位 draft 目錄 → 驗證並 guard 目標檔案路徑。
 * `requireExists=false` 用於「檔案可以還不存在」的情境（目前沒有，但保留
 * 讓 update 的錯誤訊息與 delete 一致）。
 */
function resolveDraftFile(
  args: { scope?: "project" | "personal" | "managed"; name?: string; file?: string },
  deps: SkillerDeps,
  context: ToolExecutionContext | undefined,
  options: { requireExists?: boolean } = {},
): { ok: true; value: ResolvedDraftFile } | { ok: false; code: string; message: string; nextAction?: string } {
  const scopeCheck = normalizeScope(args.scope);
  if (!scopeCheck.ok) {
    return { ok: false, code: "INVALID_SCOPE", message: "scope 只能是 project、personal 或 managed", nextAction: "請將 scope 改為 project、personal 或 managed。" };
  }
  const scope = scopeCheck.scope;
  const projectSlug = deriveProjectSlug(resolve(deps.resolveProjectRoot(context)));
  const nameCheck = validateSkillName(args.name, scope, projectSlug);
  if (!nameCheck.ok) {
    return { ok: false, code: nameCheck.code, message: nameCheck.message, nextAction: "請修正 name 後再試一次。" };
  }
  const located = locateSkillDir("draft", scope, nameCheck.name, deps, context);
  if (!located.ok) {
    return {
      ok: false,
      code: located.code,
      message: located.code === "NOT_FOUND" ? `找不到草稿：${nameCheck.name}` : located.message,
      nextAction: "請先用 skiller-scan 確認目前的草稿，或以 skiller-draft 建立。",
    };
  }
  const pathCheck = validateBundleRelativePath(args.file ?? DEFAULT_FILE);
  if (!pathCheck.ok) {
    return { ok: false, code: pathCheck.code, message: pathCheck.message, nextAction: "請改用 bundle 內的相對檔案路徑。" };
  }
  const guard = containedPath(located.value.dir, located.value.dir, ...pathCheck.value.split("/"));
  if (!guard.ok) {
    return { ok: false, code: guard.code, message: guard.message, nextAction: "請確認檔案路徑安全後再試一次。" };
  }
  if (options.requireExists !== false) {
    let isFile = false;
    try {
      isFile = statSync(guard.value).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: `草稿內找不到檔案：${pathCheck.value}`,
        nextAction: "請先用 skiller-draft-read（list=true）確認 bundle 內有哪些檔案。",
      };
    }
  }
  return { ok: true, value: { draftDir: located.value.dir, rel: pathCheck.value, absolute: guard.value } };
}

function readDraftFile(absolute: string): { ok: true; raw: string } | { ok: false; code: string; message: string } {
  let buffer: Buffer;
  try {
    buffer = readFileSync(absolute);
  } catch (error) {
    return { ok: false, code: "READ_FAILED", message: `無法讀取草稿檔案：${(error as Error).message}` };
  }
  for (const byte of buffer) {
    if (byte === 0) {
      return { ok: false, code: "BINARY_CONTENT", message: "草稿檔案含二進位內容，拒絕以文字方式處理" };
    }
  }
  return { ok: true, raw: buffer.toString("utf-8") };
}

// ─── skiller-draft-read ──────────────────────────────────────

export function createSkillerDraftReadTool(deps: SkillerDeps) {
  return defineTool({
    name: "skiller-draft-read",
    description:
      "讀固定 draft root 內的 skill 草稿：list=true 列出 bundle 檔案清單；outline=true 回標題結構；section 取單一段落；grep 做行級搜尋；都不給則回整檔內容。一律附上 SHA-256 供 skiller-draft-update 的 expectedSha256 使用。不接受任意路徑。",
    inputSchema: z.object({
      scope: z.enum(["project", "personal", "managed"]).optional(),
      name: z.string().optional(),
      file: z.string().optional(),
      list: z.boolean().optional(),
      outline: z.boolean().optional(),
      section: z.string().optional(),
      occurrence: z.number().optional(),
      grep: z.string().optional(),
      regex: z.boolean().optional(),
      context: z.number().optional(),
      maxMatches: z.number().optional(),
    }),
    async execute(
      args: {
        scope?: "project" | "personal" | "managed";
        name?: string;
        file?: string;
        list?: boolean;
        outline?: boolean;
        section?: string;
        occurrence?: number;
        grep?: string;
        regex?: boolean;
        context?: number;
        maxMatches?: number;
      },
      context: ToolExecutionContext,
    ) {
      try {
        const resolved = resolveDraftFile(args, deps, context, { requireExists: args.list !== true });
        if (!resolved.ok) return jsonError(resolved.code, resolved.message, resolved.nextAction);
        const { draftDir, rel, absolute } = resolved.value;

        // list：只回 bundle 檔案清單，不讀任何內容。
        if (args.list === true) {
          const listing = listSkillFiles(draftDir, deps);
          if (!listing.ok) {
            return jsonError(listing.issue.code, listing.issue.message, "請先修正 bundle 內容後再試一次。");
          }
          return jsonResult({
            ok: true,
            summary: `草稿 bundle 共 ${listing.files.length} 個檔案。`,
            data: { path: draftDir, files: listing.files },
          });
        }

        const read = readDraftFile(absolute);
        if (!read.ok) return jsonError(read.code, read.message);
        const doc = parseDraftDocument(read.raw);
        const sha256 = draftSha256(read.raw);
        const base = {
          path: absolute,
          relativePath: rel,
          sha256,
          bytes: Buffer.byteLength(doc.raw, "utf-8"),
        };

        if (args.outline === true) {
          const fm = parseFrontmatter(doc.raw);
          return jsonResult({
            ok: true,
            summary: `outline：${rel}（${buildDraftOutline(doc.body).length} 個標題）。`,
            data: {
              ...base,
              frontmatter: fm.ok
                ? { name: fm.data.name ?? null, description: fm.data.description ?? null }
                : { error: fm.message },
              outline: buildDraftOutline(doc.body),
            },
          });
        }

        if (typeof args.grep === "string" && args.grep.length > 0) {
          const result = grepContent(doc.body, {
            pattern: args.grep,
            regex: args.regex === true,
            context: args.context,
            maxMatches: args.maxMatches,
          });
          if ("error" in result) return jsonError(result.code, result.error);
          return jsonResult({
            ok: true,
            summary: `grep：${rel} 命中 ${result.matchCount} 行${result.truncated ? "（已截斷）" : ""}。`,
            data: { ...base, grep: args.grep, ...result },
          });
        }

        if (typeof args.section === "string" && args.section.trim().length > 0) {
          const heading = args.section.trim();
          const occurrence = Number.isInteger(args.occurrence) ? Number(args.occurrence) : 0;
          const bounds = findSectionBounds(doc.body, { kind: "heading", heading, occurrence });
          if (bounds === null) {
            return jsonError(
              "SECTION_NOT_FOUND",
              `找不到 section：${heading}（occurrence=${occurrence}）`,
              "請先用 outline=true 取得可用的標題清單。",
            );
          }
          const text = doc.body.split("\n").slice(bounds.start, bounds.end).join("\n");
          return jsonResult({
            ok: true,
            summary: `section：${rel} → ${heading}。`,
            data: { ...base, section: heading, occurrence, level: bounds.level, content: text },
          });
        }

        return jsonResult({
          ok: true,
          summary: `讀取完成：${rel}。`,
          data: { ...base, content: doc.raw },
        });
      } catch (error) {
        return jsonError("TOOL_ERROR", `草稿讀取失敗：${(error as Error).message}`);
      }
    },
  });
}

// ─── skiller-draft-update ────────────────────────────────────

export function createSkillerDraftUpdateTool(deps: SkillerDeps) {
  return defineTool({
    name: "skiller-draft-update",
    description:
      "對固定 draft root 內的草稿做局部更新：section 指定段落（省略則為整份 body），op 為 replace/append/prepend/delete。預設 mode=preview 回 diff 與 sha 不寫入；mode=apply 需帶先前讀到的 expectedSha256，內容已被改動時 fail closed。frontmatter 逐字保留，要改 frontmatter 請用 skiller-draft 整檔覆寫。",
    inputSchema: z.object({
      scope: z.enum(["project", "personal", "managed"]).optional(),
      name: z.string().optional(),
      file: z.string().optional(),
      section: z.string().optional(),
      occurrence: z.number().optional(),
      op: z.enum(["replace", "append", "prepend", "delete"]).optional(),
      content: z.string().optional(),
      mode: z.enum(["preview", "apply"]).optional(),
      expectedSha256: z.string().optional(),
    }),
    async execute(
      args: {
        scope?: "project" | "personal" | "managed";
        name?: string;
        file?: string;
        section?: string;
        occurrence?: number;
        op?: DraftContentOp;
        content?: string;
        mode?: "preview" | "apply";
        expectedSha256?: string;
      },
      context: ToolExecutionContext,
    ) {
      try {
        const mode = args.mode ?? "preview";
        if (mode !== "preview" && mode !== "apply") {
          return jsonError("INVALID_MODE", "mode 只能是 preview 或 apply", "請將 mode 改為 preview 或 apply。");
        }
        const op = args.op ?? "replace";
        const resolved = resolveDraftFile(args, deps, context);
        if (!resolved.ok) return jsonError(resolved.code, resolved.message, resolved.nextAction);
        const { rel, absolute } = resolved.value;

        const read = readDraftFile(absolute);
        if (!read.ok) return jsonError(read.code, read.message);
        const currentSha = draftSha256(read.raw);

        const applied = applyDraftUpdate({
          raw: read.raw,
          section: args.section,
          occurrence: args.occurrence,
          op,
          content: args.content,
        });
        if (!applied.ok) {
          return jsonError(applied.code, applied.message, "請依錯誤修正 section／op／content 後重試。");
        }

        const before = parseDraftDocument(read.raw).raw;
        const proposedSha = draftSha256(applied.proposed);
        const diff = unifiedLineDiff(before, applied.proposed);
        const unchanged = proposedSha === currentSha;

        if (mode === "preview") {
          return jsonResult({
            ok: true,
            summary: `update preview：${rel}${args.section ? ` → ${args.section}` : "（整份 body）"}，op=${op}${unchanged ? "（內容無變化）" : ""}。`,
            data: {
              mode: "preview",
              path: absolute,
              relativePath: rel,
              op,
              section: args.section ?? null,
              currentSha256: currentSha,
              proposedSha256: proposedSha,
              unchanged,
              diff,
              nextAction: `確認後以 mode:"apply" 與 expectedSha256:"${currentSha}" 寫入。`,
            },
          });
        }

        if (typeof args.expectedSha256 !== "string" || args.expectedSha256.length === 0) {
          return jsonResult({
            ok: false,
            code: "EXPECTED_SHA_REQUIRED",
            summary: "apply 需要 expectedSha256；未寫入任何檔案。",
            nextAction: `請先執行 mode:"preview"，再帶回 expectedSha256:"${currentSha}"。`,
            data: { mode: "apply", path: absolute, relativePath: rel, currentSha256: currentSha },
          });
        }
        if (args.expectedSha256 !== currentSha) {
          return jsonResult({
            ok: false,
            code: "STALE_SHA",
            summary: "expectedSha256 與草稿目前內容不符；檔案在預覽之後被改過，未寫入任何檔案。",
            nextAction: "請重新讀取草稿並重新 preview，取得新的 expectedSha256 後再 apply。",
            data: { mode: "apply", path: absolute, relativePath: rel, currentSha256: currentSha, provided: args.expectedSha256 },
          });
        }

        return await withSkillerWriteLock(resolveSkillerLockPath(args.scope ?? "project", deps, context), async () => {
          // 鎖內重新定位與重讀；等待鎖期間若檔案被改動，SHA gate 必須失效。
          const lockedResolved = resolveDraftFile(args, deps, context);
          if (!lockedResolved.ok) return jsonError(lockedResolved.code, lockedResolved.message, lockedResolved.nextAction);
          const lockedRead = readDraftFile(lockedResolved.value.absolute);
          if (!lockedRead.ok) return jsonError(lockedRead.code, lockedRead.message);
          const lockedSha = draftSha256(lockedRead.raw);
          if (args.expectedSha256 !== lockedSha) {
            return jsonResult({
              ok: false,
              code: "STALE_SHA",
              summary: "等待寫入鎖期間草稿已被改動；未寫入任何檔案。",
              nextAction: "請重新讀取草稿並重新 preview，取得新的 expectedSha256 後再 apply。",
              data: {
                mode: "apply",
                path: lockedResolved.value.absolute,
                relativePath: lockedResolved.value.rel,
                currentSha256: lockedSha,
                provided: args.expectedSha256,
              },
            });
          }
          try {
            atomicWriteFile(lockedResolved.value.absolute, applied.proposed);
          } catch (error) {
            return jsonError("WRITE_FAILED", `atomic 寫入失敗：${(error as Error).message}`);
          }

          return jsonResult({
            ok: true,
            summary: `update 完成：${lockedResolved.value.rel}${args.section ? ` → ${args.section}` : "（整份 body）"}，op=${op}。`,
            data: {
              mode: "apply",
              path: lockedResolved.value.absolute,
              relativePath: lockedResolved.value.rel,
              op,
              section: args.section ?? null,
              previousSha256: lockedSha,
              sha256: proposedSha,
              bytes: Buffer.byteLength(applied.proposed, "utf-8"),
            },
          });
        });
      } catch (error) {
        if (error instanceof ContentLockBusyError) {
          return jsonError("CONTENT_LOCK_BUSY", error.message, "請等待其他 skiller 寫入完成後再重試。");
        }
        return jsonError("TOOL_ERROR", `草稿更新失敗：${(error as Error).message}`);
      }
    },
  });
}

// ─── skiller-draft-delete ────────────────────────────────────

export function createSkillerDraftDeleteTool(deps: SkillerDeps) {
  return defineTool({
    name: "skiller-draft-delete",
    description:
      "刪除固定 draft root 內的草稿：給 file 只刪該檔案，省略 file 則刪整份草稿目錄。預設 mode=preview 不刪除；apply 需 confirm=true。只作用於 draft root——已安裝 skill 的退場一律走 skiller-retire 的 quarantine。",
    inputSchema: z.object({
      scope: z.enum(["project", "personal", "managed"]).optional(),
      name: z.string().optional(),
      file: z.string().optional(),
      mode: z.enum(["preview", "apply"]).optional(),
      confirm: z.boolean().optional(),
    }),
    async execute(
      args: { scope?: "project" | "personal" | "managed"; name?: string; file?: string; mode?: "preview" | "apply"; confirm?: boolean },
      context: ToolExecutionContext,
    ) {
      try {
        const mode = args.mode ?? "preview";
        if (mode !== "preview" && mode !== "apply") {
          return jsonError("INVALID_MODE", "mode 只能是 preview 或 apply", "請將 mode 改為 preview 或 apply。");
        }
        const wholeDraft = args.file === undefined || args.file === null;
        const resolved = resolveDraftFile(args, deps, context, { requireExists: !wholeDraft });
        if (!resolved.ok) return jsonError(resolved.code, resolved.message, resolved.nextAction);
        const { draftDir, rel, absolute } = resolved.value;

        // 整份刪除前先走訪 bundle：含 symlink 或任一讀取失敗一律 fail closed，
        // 不對來路不明的內容做遞迴刪除。
        const listing = listSkillFiles(draftDir, deps);
        if (!listing.ok) {
          return jsonError(listing.issue.code, listing.issue.message, "請先人工檢查草稿 bundle 後再試一次。");
        }
        const targets = wholeDraft ? listing.files : [rel];

        if (mode === "preview") {
          return jsonResult({
            ok: true,
            summary: wholeDraft
              ? `delete preview：整份草稿將被刪除（${targets.length} 個檔案，未刪除）。`
              : `delete preview：${rel} 將被刪除（未刪除）。`,
            data: {
              mode: "preview",
              path: wholeDraft ? draftDir : absolute,
              scopeOfDeletion: wholeDraft ? "draft-directory" : "single-file",
              files: targets,
              requirements: ["mode=apply", "confirm=true"],
            },
          });
        }

        if (args.confirm !== true) {
          return jsonResult({
            ok: false,
            code: "CONFIRM_REQUIRED",
            summary: "delete apply 需要明確 confirm=true；未刪除任何檔案。",
            nextAction: "請先執行 preview 確認，再以 confirm=true 重送。",
            data: { mode: "apply", path: wholeDraft ? draftDir : absolute, files: targets },
          });
        }

        return await withSkillerWriteLock(resolveSkillerLockPath(args.scope ?? "project", deps, context), async () => {
          // 鎖內重新定位並重驗 bundle；不能沿用鎖外的 listing 或 target path。
          const lockedResolved = resolveDraftFile(args, deps, context, { requireExists: !wholeDraft });
          if (!lockedResolved.ok) return jsonError(lockedResolved.code, lockedResolved.message, lockedResolved.nextAction);
          const lockedDraftDir = lockedResolved.value.draftDir;
          const lockedRel = lockedResolved.value.rel;
          const lockedAbsolute = lockedResolved.value.absolute;
          let lockedTargets = [lockedRel];
          if (wholeDraft) {
            const lockedListing = listSkillFiles(lockedDraftDir, deps);
            if (!lockedListing.ok) return jsonError(lockedListing.issue.code, lockedListing.issue.message, "請先人工檢查草稿 bundle 後再試一次。");
            lockedTargets = lockedListing.files;
          }
          try {
            if (wholeDraft) {
              rmSync(lockedDraftDir, { recursive: true, force: false });
            } else {
              unlinkSync(lockedAbsolute);
            }
          } catch (error) {
            return jsonError("DELETE_FAILED", `刪除失敗：${(error as Error).message}`);
          }

          return jsonResult({
            ok: true,
            summary: wholeDraft
              ? `delete 完成：整份草稿已刪除（${lockedTargets.length} 個檔案）。`
              : `delete 完成：${lockedRel} 已刪除。`,
            data: {
              mode: "apply",
              deleted: wholeDraft ? lockedDraftDir : lockedAbsolute,
              scopeOfDeletion: wholeDraft ? "draft-directory" : "single-file",
              files: lockedTargets,
            },
          });
        });
      } catch (error) {
        if (error instanceof ContentLockBusyError) {
          return jsonError("CONTENT_LOCK_BUSY", error.message, "請等待其他 skiller 寫入完成後再重試。");
        }
        return jsonError("TOOL_ERROR", `草稿刪除失敗：${(error as Error).message}`);
      }
    },
  });
}
