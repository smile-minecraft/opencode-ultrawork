/**
 * opencode-ultrawork — skiller-draft tool factory
 *
 * 角色：
 *   - 在固定 draft root 建立 `<name>/SKILL.md`，並可同時建立同一 bundle 內的
 *     附屬檔案（`files`）以支援漸進揭露（references/、rules/ 之類）。
 *   - 未 `confirm=true` 一律只回 preview 不寫入；confirm 後以既有 atomic write
 *     helper 逐檔寫入。
 *   - name/namespace 驗證、bundle 相對路徑驗證、fixed-root containment
 *     （lexical + realpath + symlink 拒絕）皆於寫入前執行；preview / 拒絕
 *     路徑不留任何檔案。
 *
 * 已知限制（刻意）：
 *   - 多檔寫入不做 staging 交換。draft root 是工作區、不是 discovery root，
 *     半完成的草稿不會被任何 agent 載入；因此中途失敗時如實回報已寫入的
 *     檔案清單，讓呼叫端自行決定重送或改用 skiller-draft-delete 清掉，
 *     而不是為工作區付上 staging 的複雜度。promote 進 discovery root 那一步
 *     仍然維持 staging + 一次 rename 交換。
 *
 * 限制：
 *   - 不得 import `src/index.ts`。
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../kit/define-tool.ts";
import { ContentLockBusyError } from "../../kit/write-lock.ts";
import { jsonError, jsonResult } from "../../kit/json.ts";
import { atomicWriteFile } from "../../kit/atomic-write.ts";
import {
  containedPath,
  deriveProjectSlug,
  ensureScopedFixedRoot,
  parseFrontmatter,
  resolveScopeRoots,
  resolveSkillerLockPath,
  sha256Hex,
  validateBundleRelativePath,
  validateSkillName,
  withSkillerWriteLock,
  type SkillerDeps,
  type SkillIssue,
} from "./skiller-common.ts";

/** SKILL.md 一律由 `content` 提供；`files` 只負責附屬檔案。 */
const SKILL_ENTRYPOINT = "SKILL.md";

/** 單次 draft 呼叫允許的附屬檔案數量上限。 */
const MAX_BUNDLE_FILES = 20;

interface DraftFileInput {
  path?: unknown;
  content?: unknown;
}

interface NormalizedFile {
  rel: string;
  content: string;
}

/** 對 draft 內容做輕量驗證（僅回報，不阻擋寫入；draft 是工作區）。 */
function previewIssues(content: string): SkillIssue[] {
  const fm = parseFrontmatter(content);
  if (!fm.ok) return [{ code: fm.code, message: fm.message }];
  const issues: SkillIssue[] = [];
  if (typeof fm.data.name !== "string" || fm.data.name.trim().length === 0) {
    issues.push({ code: "NAME_REQUIRED", message: "frontmatter 缺少 name" });
  }
  if (typeof fm.data.description !== "string" || fm.data.description.trim().length === 0) {
    issues.push({ code: "DESCRIPTION_REQUIRED", message: "frontmatter 缺少非空 description" });
  }
  return issues;
}

/**
 * 正規化並驗證 `files`：每個 `files[].path` 必須是 bundle 內的相對路徑，
 * 並在寫入前再次通過 fixed-root containment 保護；拒絕 SKILL.md
 * （由 `content` 專責）、拒絕重複路徑、限制檔案數量。
 */
function normalizeFiles(
  rawFiles: unknown,
): { ok: true; files: NormalizedFile[] } | { ok: false; code: string; message: string } {
  if (rawFiles === undefined || rawFiles === null) return { ok: true, files: [] };
  if (!Array.isArray(rawFiles)) {
    return { ok: false, code: "INVALID_FILES", message: "files 必須是 { path, content } 物件陣列" };
  }
  if (rawFiles.length > MAX_BUNDLE_FILES) {
    return { ok: false, code: "INVALID_FILES", message: `files 一次最多 ${MAX_BUNDLE_FILES} 個附屬檔案` };
  }
  const seen = new Set<string>();
  const files: NormalizedFile[] = [];
  for (const entry of rawFiles as DraftFileInput[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, code: "INVALID_FILES", message: "files 的每一項都必須是 { path, content } 物件" };
    }
    const pathCheck = validateBundleRelativePath(entry.path);
    if (!pathCheck.ok) {
      return { ok: false, code: pathCheck.code, message: pathCheck.message };
    }
    const rel = pathCheck.value;
    if (rel === SKILL_ENTRYPOINT) {
      return {
        ok: false,
        code: "INVALID_FILES",
        message: `${SKILL_ENTRYPOINT} 一律由 content 參數提供，不得放進 files`,
      };
    }
    if (seen.has(rel)) {
      return { ok: false, code: "INVALID_FILES", message: `files 含重複路徑：${rel}` };
    }
    if (typeof entry.content !== "string" || entry.content.length === 0) {
      return { ok: false, code: "INVALID_FILES", message: `files 的 ${rel} 缺少非空 content` };
    }
    seen.add(rel);
    files.push({ rel, content: entry.content });
  }
  return { ok: true, files };
}

export function createSkillerDraftTool(deps: SkillerDeps) {
  return defineTool({
    name: "skiller-draft",
    description:
      "在固定 project/personal/managed draft root 建立 skill 草稿：content 寫 <name>/SKILL.md，選填 files 可同時建立同 bundle 的附屬檔案（references/ 之類，支援漸進揭露）。未 confirm=true 只回 preview 不寫入；confirm 後 atomic 寫入。不接受任意路徑。",
    inputSchema: z.object({
      scope: z.enum(["project", "personal", "managed"]).optional(),
      name: z.string().optional(),
      content: z.string().optional(),
      files: z
        .array(
          z.object({
            path: z.string(),
            content: z.string(),
          }),
        )
        .optional(),
      confirm: z.boolean().optional(),
      overwrite: z.boolean().optional(),
    }),
    async execute(
      args: {
        scope?: "project" | "personal" | "managed";
        name?: string;
        content?: string;
        files?: DraftFileInput[];
        confirm?: boolean;
        overwrite?: boolean;
      },
      context: ToolExecutionContext,
    ) {
      try {
        if (args.scope !== undefined && args.scope !== "project" && args.scope !== "personal" && args.scope !== "managed") {
          return jsonError("INVALID_SCOPE", "scope 只能是 project、personal 或 managed", "請將 scope 改為 project、personal 或 managed。");
        }
        const scope = args.scope ?? "project";
        const projectSlug = deriveProjectSlug(resolve(deps.resolveProjectRoot(context)));
        const nameCheck = validateSkillName(args.name, scope, projectSlug);
        if (!nameCheck.ok) {
          return jsonError(nameCheck.code, nameCheck.message, "請修正 name 後再試一次。");
        }
        const name = nameCheck.name;
        if (typeof args.content !== "string" || args.content.length === 0) {
          return jsonError("INVALID_CONTENT", "content 為必填且必須是非空字串", "請提供完整的 SKILL.md 內容。");
        }
        const draftContent = args.content;
        const filesCheck = normalizeFiles(args.files);
        if (!filesCheck.ok) {
          return jsonError(filesCheck.code, filesCheck.message, "請修正 files 後再試一次。");
        }
        const extraFiles = filesCheck.files;

        const roots = resolveScopeRoots(scope, deps, context);
        const validation = previewIssues(draftContent);
        const plannedWrites: NormalizedFile[] = [
          { rel: SKILL_ENTRYPOINT, content: draftContent },
          ...extraFiles,
        ];

        // 未 confirm：只回 preview，不建立任何目錄或檔案。
        if (args.confirm !== true) {
          return jsonResult({
            ok: false,
            code: "CONFIRM_REQUIRED",
            summary: `draft 寫入需要明確 confirm=true；目前僅回傳 preview，未寫入任何檔案（共 ${plannedWrites.length} 個檔案）。`,
            nextAction: "請確認內容後以 confirm=true 重送。",
            data: {
              scope,
              name,
              preview: {
                path: resolve(roots.draftRoot, name, SKILL_ENTRYPOINT),
                bytes: Buffer.byteLength(draftContent, "utf-8"),
                files: plannedWrites.map((file) => ({
                  path: resolve(roots.draftRoot, name, file.rel),
                  relativePath: file.rel,
                  bytes: Buffer.byteLength(file.content, "utf-8"),
                })),
                validation,
              },
            },
          });
        }

        return await withSkillerWriteLock(resolveSkillerLockPath(scope, deps, context), async () => {
          // 鎖內重新解析 roots 與 guard，避免等待鎖期間 root 或 bundle 狀態改變。
          const lockedRoots = resolveScopeRoots(scope, deps, context);
          const preRootGuard = ensureScopedFixedRoot(lockedRoots.draftRoot, scope, deps, context);
          if (!preRootGuard.ok) {
            return jsonError(preRootGuard.code, preRootGuard.message, "請確認固定 draft root 狀態後再試一次。");
          }
          try {
            mkdirSync(lockedRoots.draftRoot, { recursive: true });
          } catch {
            return jsonError("UNKNOWN_ROOT", "無法建立固定 draft root", "請確認固定 root 位置可寫入後再試一次。");
          }
          const rootGuard = ensureScopedFixedRoot(lockedRoots.draftRoot, scope, deps, context);
          if (!rootGuard.ok) {
            return jsonError(rootGuard.code, rootGuard.message, "請確認固定 draft root 狀態後再試一次。");
          }

          // 鎖內重新檢查所有目標；任一項被其他寫入者搶先建立就整批拒絕。
          const targets: Array<{ rel: string; absolute: string; content: string }> = [];
          for (const file of plannedWrites) {
            const guard = containedPath(rootGuard.value, lockedRoots.draftRoot, name, ...file.rel.split("/"));
            if (!guard.ok) {
              return jsonError(guard.code, guard.message, "請改用不含 traversal / symlink 的 skill 名稱與檔案路徑。");
            }
            if (existsSync(guard.value) && args.overwrite !== true) {
              return jsonError(
                "ALREADY_EXISTS",
                file.rel === SKILL_ENTRYPOINT ? `draft 已存在：${name}` : `draft 檔案已存在：${name}/${file.rel}`,
                "如需覆蓋請加 overwrite=true。",
              );
            }
            targets.push({ rel: file.rel, absolute: guard.value, content: file.content });
          }

          const written: string[] = [];
          for (const target of targets) {
            try {
              mkdirSync(dirname(target.absolute), { recursive: true });
              atomicWriteFile(target.absolute, target.content);
            } catch (error) {
              return jsonError(
                "WRITE_FAILED",
                `atomic 寫入失敗（${target.rel}）：${(error as Error).message}；已寫入：${written.join(", ") || "（無）"}`,
                "draft root 是工作區，可直接重送或用 skiller-draft-delete 清掉這份草稿後重建。",
              );
            }
            written.push(target.rel);
          }

          return jsonResult({
            ok: true,
            summary: `草稿已寫入：${name}（${written.length} 個檔案）。`,
            data: {
              scope,
              name,
              path: targets[0]!.absolute,
              bytes: Buffer.byteLength(draftContent, "utf-8"),
              digest: sha256Hex(draftContent),
              filesWritten: targets.map((target) => ({
                relativePath: target.rel,
                path: target.absolute,
                bytes: Buffer.byteLength(target.content, "utf-8"),
                digest: sha256Hex(target.content),
              })),
              validation,
            },
          });
        });
      } catch (error) {
        if (error instanceof ContentLockBusyError) {
          return jsonError("CONTENT_LOCK_BUSY", error.message, "請等待其他 skiller 寫入完成後再重試。");
        }
        return jsonError("TOOL_ERROR", `draft 失敗：${(error as Error).message}`);
      }
    },
  });
}
