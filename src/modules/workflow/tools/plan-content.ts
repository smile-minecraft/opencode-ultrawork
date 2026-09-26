import { jsonResult } from "../../../kit/json.ts";
/**
 * opencode-ultrawork — plan-content tool factories
 *
 * 角色：
 *     `plan_content_*` 公開工具定義：
 *       · `plan_content_create`：建立 plan content file in `.ultrawork/plans/`。
 *       · `plan_content_read`：讀 plan content file（可指定 task section）。
 *       · `plan_content_update`：更新 plan content（整檔或單一 task section）。
 *       · `plan_content_delete`：刪除 plan content file（保留 active
 *         section-mode task safety 與 contentRef 安全檢查）。
 *
 * 對外規則（不可破壞）：
 *   - tool name / args schema / execute 固定外層 JSON 格式必須維持一致
 *   - 透過 `UltraworkRuntimeContext` 取得 paths / registry IO，
 *     行為與 closure 原版本完全一致。
 *   - `plan_content_delete` 必須保留：
 *       · active section-mode task safety（`taskDependsOnPlanSection` 判定）
 *       · contentRef / contentPath 安全檢查（`assertSafePlansPath`）。
 *     這兩條 safety 不可破壞；對應測試 `05-content-delete.test.ts` 會在
 *     本抽離後維持 green。
 *     僅由 index.ts 反向引用；引入反向 import 會形成循環依賴。
 *
 * 設計重點：
 *   - 採 factory 形式（4 個 factory），皆接受 `UltraworkRuntimeContext`
 *     注入；tool 內所有 IO 與 path 推導皆透過 `runtime.*`，
 *     不持有 closure-scoped 狀態。
 *   - leaf 模組 `../content/content-ref.ts` 的 `writePlanContent(absolutePath,
 *     content, plansDir, createDir?)` 簽名要求顯式傳入 `plansDir` 與
 *     `createDir` callback；closure 原版包了一層 wrapper（接受
 *     `context`），本檔於每個 factory 內 inline 重建該
 *     wrapper（呼叫 `runtime.resolveProjectRoot` / `runtime.ensureDir`），
 *     以維持 factory 模組自包含、無外部 wrapper 依賴。
 *
 * @see ../../../../README.md                              — 模組一覽
 * @see ../content/content-ref.ts                         — leaf path / I/O helpers
 */

import { existsSync } from "node:fs";
import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../../kit/define-tool.ts";
type ToolContext = ToolExecutionContext;
import type { UltraworkRuntimeContext } from "../runtime/context-builder.ts";
import { getPathsForRoot } from "../runtime/context.ts";
import { isFinishedTaskState, splitFrontmatter } from "../core/helpers.ts";
import { taskDependsOnPlanSection } from "../gates/plan-link-validation.ts";
import { nowIso } from "../runtime/now.ts";
import {
  assertSafePlansPath,
  planContentPath,
  planContentRef,
  resolvePlansContentRef,
  readPlanContent,
  deletePlanContentStrict,
} from "../content/content-ref.ts";
import { join } from "node:path";
import { samePathIdentity } from "../content/path-identity.ts";
import { extractTaskSection, findSectionBounds, upsertTaskSection } from "../content/section-parser.ts";
import { renderPlanContentMarkdown } from "../content/render.ts";
import { canonicalBody, fileSha256, sectionMeta, sectionText } from "../content/content-sha.ts";
import { buildUpdatedContent, hasNonFenceH1, validateProposedBody, type UpdateTarget } from "../content/content-apply.ts";
import { atomicWriteFile } from "../../../kit/atomic-write.ts";
import {
  CONTENT_WRITE_LOCK,
  assertSafeContentPath,
  assertSafeContentRoot,
  clearInconsistentMarker,
  guardedContentWrite,
  guardedStoreMutation,
  markerPath,
  readInconsistentMarker,
} from "../content/content-store.ts";
import {
  ContentLockBusyError,
  diagnoseContentWriteLock,
  withContentWriteLock,
} from "../../../kit/write-lock.ts";
import { lineFenceState } from "../core/markdown-fence.ts";
import { normalize } from "../core/markdown-canonical.ts";
import { grepContent } from "../content/content-grep.ts";
import { unifiedLineDiff } from "../core/line-diff.ts";

/** 從 canonical frontmatter 取一個純量欄位（無則 null）。 */
function frontmatterField(raw: string, key: string): string | null {
  const { frontmatter } = splitFrontmatter(normalize(raw));
  if (!frontmatter) return null;
  const m = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m").exec(frontmatter);
  return m ? m[1]! : null;
}

/** 從 raw content 檔的 frontmatter 取 `contentVersion`（無則 null）。裸 CR 也支援。 */
function contentVersionOf(raw: string): number | null {
  const v = frontmatterField(raw, "contentVersion");
  return v !== null && /^\d+$/.test(v) ? Number(v) : null;
}

/** canonical body 的 outline：每個 H2/H3 與 task section 一筆。 */
function buildOutline(raw: string) {
  const body = canonicalBody(raw);
  const lines = body.split("\n");
  const fence = lineFenceState(lines);
  const headingCounts = new Map<string, number>();
  const sections: Array<Record<string, unknown>> = [];
  for (let i = 0; i < lines.length; i++) {
    if (fence[i]) continue;
    const taskMatch = /^### task:\s+(\S+)\s*$/.exec(lines[i]!.trim());
    const headingMatch = /^(#{2,3})\s+(.+?)\s*$/.exec(lines[i]!);
    if (taskMatch) {
      const meta = sectionMeta(raw, { kind: "task", taskId: taskMatch[1]! });
      if (meta) sections.push({ selector: `task:${taskMatch[1]}`, taskId: taskMatch[1], ...meta });
    } else if (headingMatch && !headingMatch[2]!.trim().startsWith("task:")) {
      const heading = headingMatch[2]!.trim();
      const occurrence = headingCounts.get(heading) ?? 0;
      headingCounts.set(heading, occurrence + 1);
      const meta = sectionMeta(raw, { kind: "heading", heading, occurrence });
      if (meta) {
        sections.push({
          selector: occurrence === 0 ? heading : `${heading}[${occurrence}]`,
          ...meta,
        });
      }
    }
  }
  // 標記重複標題
  for (const s of sections) {
    const sel = String(s.selector).replace(/\[\d+\]$/, "");
    if (!String(s.selector).startsWith("task:") && (headingCounts.get(sel) ?? 0) > 1) {
      s.ambiguous = true;
      s.occurrences = headingCounts.get(sel);
    }
  }
  return sections;
}

/**
 * 建立 `plan_content_create` tool。
 *
 * 檔案不存在 → 直接建立（走全域 lock + snapshot/rollback）。
 * `overwrite:true` 且檔案已存在 → 整檔重置，走 preview→apply + `expectedSha256`。
 */
export function createPlanContentCreateTool(runtime: UltraworkRuntimeContext) {
  return defineTool({
    name: "plan-content-create",
    description:
      "建立計畫文件，內容會儲存在 .ultrawork/plans/。content 正文必須有一個 non-fence 的 H1（只給 title 時自動加）。檔案不存在 → 直接建立。overwrite:true 且檔案已存在 → 整檔重置（自訂 frontmatter 會被 template 取代）：預設 mode:preview（回 diff + sha），mode:apply 需帶 expectedSha256（整檔 sha，先讀取取得）。overwrite 省略且檔案已存在 → CONTENT_EXISTS，不寫。",
    inputSchema: z.object({
      planId: z.string(),
      title: z.string().optional(),
      content: z.string().optional(),
      overwrite: z.boolean().optional(),
      mode: z.enum(["preview", "apply"]).optional(),
      expectedSha256: z.string().optional(),
    }),
    async execute({ planId, title, content, overwrite, mode = "preview", expectedSha256 }, context) {
      const root = runtime.resolveProjectRoot(context);
      const { PLANS_DIR, TASKS_JSON, PLANS_JSON } = getPathsForRoot(root);
      assertSafeContentRoot(root, PLANS_DIR);
      const lockPath = join(PLANS_DIR, CONTENT_WRITE_LOCK);
      const planRegistry = runtime.readPlansRegistry(context, false);
      const plan = planRegistry.plans[planId];

      if (!plan) return jsonResult({ ok: false, code: "PLAN_NOT_FOUND", error: `找不到計畫 ${planId}` });

      const targetPath = planContentPath(planId, PLANS_DIR);
      assertSafePlansPath(targetPath, PLANS_DIR);

      const fileAlreadyExists = existsSync(targetPath);

      // Check for existing file
      if (!overwrite && fileAlreadyExists) {
        return jsonResult({ ok: false, code: "CONTENT_EXISTS", error: `計畫 ${planId} 的內容檔已經存在。要取代的話帶 overwrite=true。` });
      }

      // Ensure plans directory exists
      runtime.ensureDir(PLANS_DIR, context);

      // Generate body content
      const planTitle = title || plan.title || planId;
      const bodyContent = content || [
        `# ${planTitle}`,
        "",
        "## Overview",
        "",
        "TODO: Fill in overview",
        "",
        "## Goals",
        "",
        "- [ ] ",
        "",
        "## Non-Goals",
        "",
        "- ",
        "",
        "## Architecture",
        "",
        "TODO: Describe architecture",
        "",
        "## Data Model",
        "",
        "TODO: Document data model",
        "",
        "## Task Details",
        "",
        plan.taskIds.length > 0
          ? plan.taskIds.map(tid => `### task: ${tid}\n<!-- task-anchor: ${tid} -->\n\nTODO: Document task\n`).join("\n")
          : "No tasks linked yet.",
      ].join("\n");

      const contentVersion = (plan.contentVersion || 0) + 1;
      const markdown = renderPlanContentMarkdown(plan, bodyContent, contentVersion);
      const proposedFile = normalize(markdown);

      // 建立時就要求 H1（與 update 的正文結構驗證一致）——避免「建立成功、
      // 之後 update 卻因缺 H1 被拒」的斷層。重複 H2 是既有檔容許的情況
      //（read 用 `[n]` 消歧），create 不擋。
      if (!hasNonFenceH1(splitFrontmatter(proposedFile).body)) {
        return jsonResult({
          ok: false,
          code: "PROPOSED_BODY_NO_H1",
          error: "plan content 正文缺少 non-fence 的 H1 標題。",
          hint: "正文需要一個 `# 標題` 行。只傳 title 時工具會自動加；傳 content 時要自己帶。",
        });
      }

      // ── fresh create（檔案不存在）：不需 preview，但仍屬 content writer，
      //    走全域 lock + marker 檢查 + snapshot/rollback（§6.2 統一鎖）──
      if (!fileAlreadyExists) {
        try {
          assertSafeContentPath(root, PLANS_DIR, join(PLANS_DIR, CONTENT_WRITE_LOCK));
         return await withContentWriteLock<string>(lockPath, async (): Promise<string> => {
            const planReg = runtime.readPlansRegistry(context, false);
            const p = planReg.plans[planId];
            if (!p) return jsonResult({ ok: false, code: "PLAN_NOT_FOUND", error: `找不到計畫 ${planId}` });

            if (readInconsistentMarker(root, PLANS_DIR)) {
              return jsonResult({ ok: false, code: "CONTENT_STORE_INCONSISTENT", error: `content store 處於待修復狀態（${markerPath(PLANS_DIR)}）。人工修復後用 plan-content-read({clearInconsistent:true}) 清除 marker。` });
            }
            // lock 內重檢：可能有另一個 writer 在我等鎖時建了檔
            if (existsSync(targetPath)) {
              return jsonResult({ ok: false, code: "CONTENT_EXISTS", error: `計畫 ${planId} 的內容檔已經存在。要取代的話帶 overwrite=true。` });
            }

            const nextVersion = (p.contentVersion || 0) + 1;
            const fresh = normalize(renderPlanContentMarkdown(p, bodyContent, nextVersion));
            const writeResult = await guardedStoreMutation({
              projectRoot: root,
             plansDir: PLANS_DIR,
              extraSnapshotPaths: [TASKS_JSON, PLANS_JSON],
              op: "plan-content-create fresh",
              detail: { planId, targetPath, before: null, after: { fileSha256: fileSha256(fresh), contentVersion: nextVersion } },
              mutate: async () => {
                assertSafeContentPath(root, PLANS_DIR, targetPath);
                 atomicWriteFile(targetPath, fresh);
                p.contentRef = planContentRef(planId);
                p.contentVersion = nextVersion;
                p.updatedAt = nowIso();
                p.history.push(`| ${nowIso()} | CONTENT_CREATE | system | version=${nextVersion} |`);
                await runtime.writePlansRegistry(planReg, context);
              },
            });
            if (writeResult.kind === "rolled_back") {
              return jsonResult({ ok: false, code: "REGISTRY_WRITE_FAILED_ROLLED_BACK", error: `建檔失敗，已全還原成原始位元組，可安全重試。（${writeResult.error}）` });
            }
            if (writeResult.kind === "partial") {
              return jsonResult({ ok: false, code: "PARTIAL_WRITE", error: "檔案已建立但 registry 未同步且還原失敗。不可直接重試——人工修復後清 marker。", marker: writeResult.marker });
            }
            return jsonResult({
              ok: true,
              planId,
              contentRef: p.contentRef,
              contentPath: targetPath,
              contentVersion: nextVersion,
            }, null, 2);
          });
        } catch (err) {
          if (err instanceof ContentLockBusyError) {
            return jsonResult({ ok: false, code: err.code, error: err.message, heldByPid: err.heldByPid, ageSeconds: err.ageSeconds });
          }
          throw err;
        }
      }

      // ── overwrite 既有檔案：整檔重置，走 §5.5 lock + TOCTOU + preview ──
      const rawExisting = readPlanContent(root, PLANS_DIR, targetPath) || "";
      const currentSha = rawExisting ? fileSha256(rawExisting) : null;

      if (mode === "preview") {
        return jsonResult({
          ok: true,
          mode: "preview",
          planId,
          op: "overwrite",
          changed: normalize(rawExisting) !== proposedFile,
          diff: unifiedDiff(normalize(rawExisting), proposedFile),
          currentSha256: currentSha,
          proposedFileSha256: fileSha256(proposedFile),
          currentContentVersion: contentVersionOf(rawExisting),
          nextContentVersion: contentVersion,
          hint: `整檔重置會用 template 取代自訂 frontmatter。帶 expectedSha256:"${currentSha}" 與 mode:"apply" 寫入。`,
        }, null, 2);
      }

      if (!expectedSha256) {
        return jsonResult({ ok: false, code: "EXPECTED_SHA256_REQUIRED", error: "overwrite 既有檔案的 mode:apply 需要 expectedSha256（整檔 sha，從一次新的讀取取得）。", currentSha256: currentSha });
      }

      try {
        assertSafeContentPath(root, PLANS_DIR, join(PLANS_DIR, CONTENT_WRITE_LOCK));
         return await withContentWriteLock<string>(lockPath, async (): Promise<string> => {
          const planReg = runtime.readPlansRegistry(context, false);
          const p = planReg.plans[planId];
          if (!p) return jsonResult({ ok: false, code: "PLAN_NOT_FOUND", error: `找不到計畫 ${planId}` });

          if (readInconsistentMarker(root, PLANS_DIR)) {
            return jsonResult({ ok: false, code: "CONTENT_STORE_INCONSISTENT", error: `content store 處於待修復狀態（${markerPath(PLANS_DIR)}）。人工修復後用 plan-content-read({clearInconsistent:true}) 清除 marker。` });
          }

          const raw = readPlanContent(root, PLANS_DIR, targetPath) || "";
          const sha = raw ? fileSha256(raw) : null;
          if (expectedSha256 !== sha) {
            return jsonResult({ ok: false, code: "CONTENT_SHA_CONFLICT", error: "content 自讀取以來已變更，重讀後再試。", expectedSha256, currentSha256: sha });
          }
          const nextVersion = (contentVersionOf(raw) ?? p.contentVersion ?? 0) + 1;
          const proposed = normalize(renderPlanContentMarkdown(p, bodyContent, nextVersion));

          const raw2 = readPlanContent(root, PLANS_DIR, targetPath) || "";
          if (fileSha256(raw2) !== fileSha256(raw)) {
            return jsonResult({ ok: false, code: "CONTENT_SHA_CONFLICT", error: "content 在寫入前一刻變了，什麼都沒寫。" });
          }

          const writeResult = await guardedContentWrite({
            projectRoot: root,
            plansDir: PLANS_DIR,
            contentPath: targetPath,
            proposedFile: proposed,
            extraSnapshotPaths: [TASKS_JSON, PLANS_JSON],
            op: "plan-content-create overwrite",
            shaBefore: { file: fileSha256(raw), contentVersion: contentVersionOf(raw) },
            shaAfter: { file: fileSha256(proposed), contentVersion: nextVersion },
            writeRegistry: async () => {
              p.contentRef = planContentRef(planId);
              p.contentVersion = nextVersion;
              p.updatedAt = nowIso();
              p.history.push(`| ${nowIso()} | CONTENT_CREATE | system | version=${nextVersion} | overwrite |`);
              await runtime.writePlansRegistry(planReg, context);
            },
          });

          if (writeResult.kind === "rolled_back") {
            return jsonResult({ ok: false, code: "REGISTRY_WRITE_FAILED_ROLLED_BACK", error: `registry 寫入失敗，content 與 registry 都已還原成原始位元組，可安全重試。（${writeResult.error}）` });
          }
          if (writeResult.kind === "partial") {
            return jsonResult({ ok: false, code: "PARTIAL_WRITE", error: "content 已寫入但 registry 未同步，且還原失敗。不可直接重試——人工修復後用 clearInconsistent 清 marker。", marker: writeResult.marker });
          }

          const written = readPlanContent(root, PLANS_DIR, targetPath) || "";
          return jsonResult({
            ok: true,
            mode: "apply",
            applied: true,
            planId,
            contentRef: p.contentRef,
            contentPath: targetPath,
            contentVersion: nextVersion,
            fileSha256: fileSha256(written),
          }, null, 2);
        });
      } catch (err) {
        if (err instanceof ContentLockBusyError) {
          return jsonResult({ ok: false, code: err.code, error: err.message, heldByPid: err.heldByPid, ageSeconds: err.ageSeconds });
        }
        throw err;
      }
    }
  });
}

/**
 * 建立 `plan_content_read` tool。
 *
 * behavior-preserving extraction：行為、args schema、固定外層 JSON 回覆
 * 完全等價。
 */
export function createPlanContentReadTool(runtime: UltraworkRuntimeContext) {
  return defineTool({
    name: "plan-content-read",
    description:
      "讀取計畫文件。不給 selector = 整檔。outline:true 只回目錄索引（每個 H2/H3 與 task section 的 selector / 行範圍 / 大小 / sha256），最省 token。section:\"標題\" 或 taskId:\"t-1\" 只回該區塊。grep:\"pattern\" 只回符合的行（literal 預設，regex:true 改用正則；context 前後文行數預設 2；maxMatches 預設 20）——可搭配 section/taskId 縮小範圍。所有回應帶 fileSha256 與 contentVersion，供後續 update 的 expectedSha256。",
    inputSchema: z.object({
      planId: z.string().optional(),
      contentRef: z.string().optional(),
      taskId: z.string().optional(),
      section: z.string().optional(),
      outline: z.boolean().optional(),
      grep: z.string().optional(),
      regex: z.boolean().optional(),
      context: z.number().optional(),
      maxMatches: z.number().optional(),
      unlockStale: z.boolean().optional(),
      clearInconsistent: z.boolean().optional(),
    }),
    async execute({ planId, contentRef, taskId, section, outline, grep, regex, context: grepContextLines, maxMatches, unlockStale, clearInconsistent }, context) {
      const root = runtime.resolveProjectRoot(context);
      const { PLANS_DIR } = getPathsForRoot(root);

      // ── 復原操作（顯式）──
      if (unlockStale) {
        assertSafeContentPath(root, PLANS_DIR, join(PLANS_DIR, CONTENT_WRITE_LOCK));
        const d = diagnoseContentWriteLock(join(PLANS_DIR, CONTENT_WRITE_LOCK));
        return jsonResult({ ok: true, action: "diagnoseLock", ...d });
      }
      if (clearInconsistent) {
        // content write lock 內執行：marker 只由持鎖的 writer 產生，取鎖即可
        // 完全序列化，避免刪掉另一個 writer 剛產生的新 marker。identity 檢查
        // （`at` 比對）是額外雙保險。
        try {
          assertSafeContentPath(root, PLANS_DIR, join(PLANS_DIR, CONTENT_WRITE_LOCK));
         return await withContentWriteLock<string>(join(PLANS_DIR, CONTENT_WRITE_LOCK), async (): Promise<string> => {
            const m = readInconsistentMarker(root, PLANS_DIR);
            if (!m) return jsonResult({ ok: true, action: "clearInconsistent", removed: false, clearedMarker: null });
            const removed = clearInconsistentMarker(root, PLANS_DIR, m.at);
            return jsonResult({ ok: true, action: "clearInconsistent", removed, clearedMarker: m });
          });
        } catch (err) {
          if (err instanceof ContentLockBusyError) {
            return jsonResult({ ok: false, code: err.code, error: `另一個 content 寫入正在進行，稍後再清 marker。（${err.message}）`, heldByPid: err.heldByPid, ageSeconds: err.ageSeconds });
          }
          throw err;
        }
      }

      // Locator：planId / contentRef 擇一
      if (planId && contentRef) {
        return jsonResult({ ok: false, code: "AMBIGUOUS_LOCATOR", error: "planId 和 contentRef 只能給其中一個。" });
      }
      // Read mode：outline / section / taskId 互斥
      const readModes = [outline ? "outline" : null, section !== undefined ? "section" : null, taskId ? "taskId" : null].filter(Boolean);
      if (readModes.length > 1) {
        return jsonResult({ ok: false, code: "AMBIGUOUS_READ_MODE", error: `outline / section / taskId 最多只能給一個（收到：${readModes.join(", ")}）。` });
      }
      if (grep !== undefined && outline) {
        return jsonResult({ ok: false, code: "AMBIGUOUS_READ_MODE", error: "grep 與 outline 不能同時使用。" });
      }

      let targetPath = "";
      if (contentRef) {
        targetPath = resolvePlansContentRef(contentRef, root, PLANS_DIR);
      } else if (planId) {
        targetPath = planContentPath(planId, PLANS_DIR);
      } else {
        return jsonResult({ ok: false, code: "LOCATOR_REQUIRED", error: "planId 和 contentRef 至少要給一個。" });
      }

      const raw = readPlanContent(root, PLANS_DIR, targetPath);
      if (!raw) return jsonResult({ ok: false, code: "CONTENT_FILE_NOT_FOUND", error: `找不到內容檔：${targetPath}` });

      const base = {
        ok: true as const,
        planId: planId ?? frontmatterField(raw, "planId"),
        contentRef: contentRef || planContentRef(planId || ""),
        fileSha256: fileSha256(raw),
        contentVersion: contentVersionOf(raw),
      };

      if (outline) {
        return jsonResult({ ...base, sections: buildOutline(raw) }, null, 2);
      }

      if (grep !== undefined) {
        const body = canonicalBody(raw);
        // section / taskId 給定時，只在該區塊的行區間內搜；行號、selector、
        // 前後文仍以完整 body 為準（縮範圍不改座標）。
        let within: [number, number] | undefined;
        let scopeSelector: string | null = null;
        if (taskId) {
          const b = findSectionBounds(body, { kind: "task", taskId });
          if (!b) return jsonResult({ ...base, grep, exists: false, error: `找不到段落：task:${taskId}` });
          within = [b.start, b.end];
          scopeSelector = `task:${taskId}`;
        } else if (section !== undefined) {
          const occ = /\[(\d+)\]$/.exec(section);
          const sel = { kind: "heading" as const, heading: occ ? section.slice(0, section.length - occ[0].length) : section, occurrence: occ ? Number(occ[1]) : 0 };
          const b = findSectionBounds(body, sel);
          if (!b) return jsonResult({ ...base, grep, exists: false, error: `找不到段落：${section}` });
          within = [b.start, b.end];
          scopeSelector = section;
        }
        const res = grepContent(body, { pattern: grep, regex, context: grepContextLines, maxMatches, within });
        if ("code" in res) return jsonResult({ ok: false, ...res });
        return jsonResult({
          ...base,
          grep,
          ...(scopeSelector ? { scope: scopeSelector } : {}),
          matchCount: res.matchCount,
          truncated: res.truncated,
          matches: res.matches,
        }, null, 2);
      }

      if (taskId) {
        const meta = sectionMeta(raw, { kind: "task", taskId });
        return jsonResult({
          ...base,
          taskId,
          exists: meta !== null,
          sectionContent: extractTaskSection(raw, taskId) ?? "",
          ...(meta ? { sectionSha256: meta.sha256, lineRange: meta.lineRange } : {}),
        }, null, 2);
      }

      if (section !== undefined) {
        const occ = /\[(\d+)\]$/.exec(section);
        const selector = {
          kind: "heading" as const,
          heading: occ ? section.slice(0, section.length - occ[0].length) : section,
          occurrence: occ ? Number(occ[1]) : 0,
        };
        const body = canonicalBody(raw);
        const bounds = findSectionBounds(body, selector);
        if (!bounds) return jsonResult({ ...base, section, exists: false, error: `找不到段落：${section}` });
        const meta = sectionMeta(raw, selector)!;
        return jsonResult({
          ...base,
          section,
          exists: true,
          sectionContent: sectionText(body, bounds).replace(/\n$/, ""),
          sectionSha256: meta.sha256,
          lineRange: meta.lineRange,
          level: meta.level,
        }, null, 2);
      }

      return jsonResult({ ...base, content: raw }, null, 2);
    }
  });
}

/**
 * 建立 `plan_content_update` tool。
 *
 * behavior-preserving extraction：行為、args schema、固定外層 JSON 回覆
 * 完全等價。
 */
export function createPlanContentUpdateTool(runtime: UltraworkRuntimeContext) {
  return defineTool({
    name: "plan-content-update",
    description:
      "更新計畫文件。預設 mode:preview（回 diff + 兩個 sha，不寫）；mode:apply 需帶 expectedSha256（從一次新的 preview 或 read 取得 currentSha256：定址且 section 已存在 = section sha、section 尚未建立或整份 = 整檔 sha）。section:\"標題\" 或 taskId:\"t-1\" 只改該區塊、其他區塊逐字保留；都不給 = 整份 body。整檔 sha 也是合法的更強比對值：apply 鎖內重讀若與給的整檔 sha 一致即視為有效，回應以 shaAccepted 標記是「section」還是「file」。content 可直接用 read 回的 sectionContent（含 `## 標題` 那行會自動剝掉）。op: replace(預設)/append/prepend/delete（delete 只限 H2 section）。",
    inputSchema: z.object({
      planId: z.string(),
      content: z.string().optional(),
      taskId: z.string().optional(),
      section: z.string().optional(),
      op: z.enum(["replace", "append", "prepend", "delete"]).optional(),
      mode: z.enum(["preview", "apply"]).optional(),
      expectedSha256: z.string().optional(),
    }),
    async execute(
      { planId, content, taskId, section, op = "replace", mode = "preview", expectedSha256 },
      context,
    ) {
      const root = runtime.resolveProjectRoot(context);
      const { PLANS_DIR, TASKS_JSON, PLANS_JSON } = getPathsForRoot(root);
      assertSafeContentRoot(root, PLANS_DIR);
      const lockPath = join(PLANS_DIR, CONTENT_WRITE_LOCK);

      if (taskId && section !== undefined) {
        return jsonResult({ ok: false, code: "AMBIGUOUS_TARGET", error: "taskId / section 最多只能給一個。" });
      }
      if (op === "delete" && !section) {
        return jsonResult({ ok: false, code: "DELETE_TARGET_INVALID", error: "op:delete 只能作用在 H2 section（帶 section:\"標題\"）。task section 不可刪除。" });
      }
      if (op !== "delete" && content === undefined) {
        return jsonResult({ ok: false, code: "CONTENT_REQUIRED", error: "op 非 delete 時需要 content。" });
      }

      // plan / targetPath 解析（apply 會在 lock 內重解析一次以拿最新 registry）。
      // 回傳 string = 錯誤的 jsonResult；否則 { plan, targetPath }。
      type PlanEntry = ReturnType<typeof runtime.readPlansRegistry>["plans"][string];
      const resolvePlanTarget = (
        registry: ReturnType<typeof runtime.readPlansRegistry>,
      ): string | { plan: PlanEntry; targetPath: string } => {
        const plan = registry.plans[planId];
        if (!plan) return jsonResult({ ok: false, code: "PLAN_NOT_FOUND", error: `找不到計畫 ${planId}` });
        let targetPath: string;
        if (plan.contentRef) {
          targetPath = resolvePlansContentRef(plan.contentRef, root, PLANS_DIR);
        } else if (plan.contentPath) {
          assertSafePlansPath(plan.contentPath, PLANS_DIR);
          targetPath = plan.contentPath;
        } else {
          targetPath = planContentPath(planId, PLANS_DIR);
        }
        return { plan, targetPath };
      };

      // target selector
      const target: UpdateTarget = taskId
        ? { kind: "task", taskId }
        : section !== undefined
        ? headingSelectorFromString(section)
        : { kind: "full" };

      const build = (raw: string, nextVersion: number) =>
        buildUpdatedContent({
          rawFile: raw,
          nextContentVersion: nextVersion,
          updatedAt: nowIso(),
          target,
          op,
          newBody: content ?? "",
          taskMarkers: taskId
            ? { heading: `### task: ${taskId}`, anchor: `<!-- task-anchor: ${taskId} -->` }
            : undefined,
        });

      // 定址時比對 section sha；section 尚未建立時退回比對整檔 sha，讓「新建
      // section」的 preview→apply 之間仍有競態保護。
      const currentExpectedFor = (raw: string): string | null => {
        if (target.kind === "full") return fileSha256(raw);
        const s = sectionMeta(raw, target as { kind: "task"; taskId: string } | { kind: "heading"; heading: string; occurrence?: number })?.sha256;
        return s ?? fileSha256(raw);
      };
      const targetExistsIn = (raw: string): boolean =>
        target.kind === "full" ||
        sectionMeta(raw, target as { kind: "task"; taskId: string } | { kind: "heading"; heading: string; occurrence?: number }) !== null;

      // ── preview（不寫、不取 lock；registry 只用來拿版本 fallback 與路徑）──
      if (mode === "preview") {
        const rt = resolvePlanTarget(runtime.readPlansRegistry(context, false));
        if (typeof rt === "string") return rt;
        const raw = readPlanContent(root, PLANS_DIR, rt.targetPath) || "";
        if (!raw) return jsonResult({ ok: false, code: "CONTENT_FILE_NOT_FOUND", error: `找不到內容檔：${rt.targetPath}` });
        const nextVersion = (contentVersionOf(raw) ?? rt.plan.contentVersion ?? 0) + 1;
        const built = build(raw, nextVersion);
        if ("code" in built) return jsonResult({ ok: false, ...built });
        const valErr = validateProposedBody(normalize(raw), built.proposed);
        if (valErr) return jsonResult({ ok: false, ...valErr });
        const currentSha = currentExpectedFor(raw);
        return jsonResult({
          ok: true,
          mode: "preview",
          planId,
          target: taskId ? `task:${taskId}` : section ?? "full",
          op,
          changed: normalize(raw) !== built.proposed,
          diff: unifiedDiff(normalize(raw), built.proposed),
          currentSha256: currentSha,
          proposedFileSha256: fileSha256(built.proposed),
          currentContentVersion: contentVersionOf(raw),
          nextContentVersion: nextVersion,
          exists: targetExistsIn(raw),
          hint: targetExistsIn(raw)
            ? `帶 expectedSha256:\"${currentSha}\" 與 mode:\"apply\" 寫入（定址比對 section sha）。`
            : `新 section：帶 expectedSha256:\"${currentSha}\" 與 mode:\"apply\" 寫入（比對整個 plan 檔 sha）。`,
        }, null, 2);
      }

      // ── apply ──
      if (!expectedSha256) {
        const rt = resolvePlanTarget(runtime.readPlansRegistry(context, false));
        const raw = typeof rt === "string" ? "" : readPlanContent(root, PLANS_DIR, rt.targetPath) || "";
        return jsonResult({
          ok: false,
          code: "EXPECTED_SHA256_REQUIRED",
          error: "mode:apply 需要 expectedSha256（從一次新的讀取取得）。",
          currentSha256: raw ? currentExpectedFor(raw) : null,
        });
      }

      try {
        assertSafeContentPath(root, PLANS_DIR, join(PLANS_DIR, CONTENT_WRITE_LOCK));
         return await withContentWriteLock<string>(lockPath, async (): Promise<string> => {
          // lock 內重讀 registry —— 不沿用 lock 外的 object（否則會覆蓋
          // 另一個 writer 在我取得 lock 之前對 plans.json 做的更新）。
          const planRegistry = runtime.readPlansRegistry(context, false);
          const rt = resolvePlanTarget(planRegistry);
          if (typeof rt === "string") return rt;
          const { plan, targetPath } = rt;
          if (!plan.contentRef) plan.contentRef = planContentRef(planId);

          // lock 內重檢 marker —— 另一個 writer 可能在 lock 外檢查與取得 lock
          // 之間產生了 PARTIAL_WRITE marker。
          if (readInconsistentMarker(root, PLANS_DIR)) {
            return jsonResult({
              ok: false,
              code: "CONTENT_STORE_INCONSISTENT",
              error: `content store 處於待修復狀態（${markerPath(PLANS_DIR)}）。人工修復後用 plan-content-read({clearInconsistent:true}) 清除 marker。`,
            });
          }

          const raw = readPlanContent(root, PLANS_DIR, targetPath) || "";
          if (!raw) return jsonResult({ ok: false, code: "CONTENT_FILE_NOT_FOUND", error: `找不到內容檔：${targetPath}` });
          // 鎖內重讀：定址時比 sectionSha256（fallback 整檔 sha）；整份目標用整檔 sha。
          // 額外允許「給整檔 sha 且鎖內整檔 sha 相符」——整檔逐字相同比 section
          // 匹配的保證更強，足以涵蓋 section 比對。必須用鎖內這次 readPlanContent
          // 算的 fileSha256 比對，不可用鎖外先算的值。
          const currentSha = currentExpectedFor(raw);
          const lockFileSha = fileSha256(raw);
          const acceptedAsFileSha =
            currentSha !== lockFileSha && expectedSha256 === lockFileSha;
          if (expectedSha256 !== currentSha && !acceptedAsFileSha) {
            return jsonResult({
              ok: false,
              code: "CONTENT_SHA_CONFLICT",
              error: "content 自讀取以來已變更，重讀後再試。",
              expectedSha256,
              currentSha256: currentSha,
            });
          }
          // shaAccepted 必須反映實際比對層級：
          //   - file target（kind === "full"）一律是 file
          //   - section 不存在 → fallback 整檔 sha → file
          //   - section 存在 + 用 section sha 通過 → section
          //   - section 存在 + 用整檔 sha 相容接受 → file
          const sectionExists = target.kind !== "full"
            && sectionMeta(
                raw,
                target as { kind: "task"; taskId: string } | { kind: "heading"; heading: string; occurrence?: number },
              ) !== null;
          let shaAccepted: "file" | "section";
          if (target.kind === "full") {
            shaAccepted = "file";
          } else if (!sectionExists) {
            shaAccepted = "file";
          } else if (acceptedAsFileSha) {
            shaAccepted = "file";
          } else {
            shaAccepted = "section";
          }
          const nextVersion = (contentVersionOf(raw) ?? plan.contentVersion ?? 0) + 1;
          const built = build(raw, nextVersion);
          if ("code" in built) return jsonResult({ ok: false, ...built });
          const valErr = validateProposedBody(normalize(raw), built.proposed);
          if (valErr) return jsonResult({ ok: false, ...valErr });

          // TOCTOU：寫入前再讀一次確認沒變
          const raw2 = readPlanContent(root, PLANS_DIR, targetPath) || "";
          if (fileSha256(raw2) !== fileSha256(raw)) {
            return jsonResult({ ok: false, code: "CONTENT_SHA_CONFLICT", error: "content 在寫入前一刻變了，什麼都沒寫。" });
          }

          const writeResult = await guardedContentWrite({
            projectRoot: root,
            plansDir: PLANS_DIR,
            contentPath: targetPath,
            proposedFile: built.proposed,
            extraSnapshotPaths: [TASKS_JSON, PLANS_JSON],
            op: `plan-content-update ${op} ${target.kind}`,
            shaBefore: { file: fileSha256(raw), contentVersion: contentVersionOf(raw) },
            shaAfter: { file: fileSha256(built.proposed), contentVersion: nextVersion },
            writeRegistry: async () => {
              plan.contentVersion = nextVersion;
              plan.updatedAt = nowIso();
              plan.history.push(
                `| ${nowIso()} | CONTENT_UPDATE | system | version=${nextVersion} | target=${taskId ? `task:${taskId}` : section ?? "full"} op=${op} |`,
              );
              await runtime.writePlansRegistry(planRegistry, context);
            },
          });

          if (writeResult.kind === "rolled_back") {
            return jsonResult({
              ok: false,
              code: "REGISTRY_WRITE_FAILED_ROLLED_BACK",
              error: `registry 寫入失敗，content 與 registry 都已還原成原始位元組，可安全重試。（${writeResult.error}）`,
            });
          }
          if (writeResult.kind === "partial") {
            return jsonResult({
              ok: false,
              code: "PARTIAL_WRITE",
              error: "content 已寫入但 registry 未同步，且還原失敗。不可直接重試——人工修復後用 clearInconsistent 清 marker。",
              marker: writeResult.marker,
            });
          }

          const written = readPlanContent(root, PLANS_DIR, targetPath) || "";
          const meta = target.kind === "full" ? null : sectionMeta(written, target as never);
          return jsonResult({
            ok: true,
            mode: "apply",
            applied: true,
            planId,
            contentVersion: nextVersion,
            contentRef: plan.contentRef,
            fileSha256: fileSha256(written),
            shaAccepted,
            ...(meta ? { sectionSha256: meta.sha256 } : {}),
          }, null, 2);
        });
      } catch (err) {
        if (err instanceof ContentLockBusyError) {
          return jsonResult({ ok: false, code: err.code, error: err.message, heldByPid: err.heldByPid, ageSeconds: err.ageSeconds });
        }
        throw err;
      }
    }
  });
}

/** `"Heading"` 或 `"Heading[2]"` → heading selector。 */
function headingSelectorFromString(s: string): { kind: "heading"; heading: string; occurrence: number } {
  const occ = /\[(\d+)\]$/.exec(s);
  return {
    kind: "heading",
    heading: occ ? s.slice(0, s.length - occ[0].length) : s,
    occurrence: occ ? Number(occ[1]) : 0,
  };
}

/** preview 用的行級 diff：LCS + 共同前後綴，供人工審核。 */
function unifiedDiff(before: string, after: string): string {
  return unifiedLineDiff(before, after);
}

/**
 * 建立 `plan_content_delete` tool。
 *
 * behavior-preserving extraction：行為、args schema、回傳 JSON 字串、
 * active section-mode task safety 與 contentRef/contentPath 安全檢查
 * 完全等價。
 *
 * 安全保證（不可破壞）：
 *   - 實作準備階段 hardening：找出仍依賴本 plan section-mode 內容的 active tasks。
 *     只要它們仍存在，plan content file 就是它們的 backing file，
 *     不得刪除，否則 active task 會變成 dangling ref。
 *     這個保護對 force=true 一樣生效——force 只允許清理 finished task files，
 *     不能犧牲 active section-mode task 的可讀性。
 *     `planContentPath(planId, PLANS_DIR)` 進行 path traversal 防護。
 */
export function createPlanContentDeleteTool(runtime: UltraworkRuntimeContext) {
  return defineTool({
    name: "plan-content-delete",
    description:
      "刪除計畫文件；需要時一併刪除相關任務文件。預設 mode:preview（回報會刪哪些檔、會保留哪些檔，不動磁碟）；mode:apply 才真的刪。force 和 mode 各自獨立：force 只放行清理已完成任務的檔案，不會為此犧牲進行中 section-mode 任務的可讀性。",
    inputSchema: z.object({
      planId: z.string(),
      deleteTaskFiles: z.boolean().optional(),
      force: z.boolean().optional(),
      mode: z.enum(["preview", "apply"]).optional(),
    }),
    async execute({ planId, deleteTaskFiles, force = false, mode = "preview" }, context) {
      const root = runtime.resolveProjectRoot(context);
      const { PLANS_DIR, TASKS_JSON, PLANS_JSON } = getPathsForRoot(root);
      assertSafeContentRoot(root, PLANS_DIR);
      const lockPath = join(PLANS_DIR, CONTENT_WRITE_LOCK);

      // 實作準備階段 hardening：找出仍依賴本 plan section-mode 內容的 active tasks。
      // 只要它們仍存在，plan content file 就是它們的 backing file，不得刪除，
      // 否則 active task 會變成 dangling ref。force=true 也適用——force 只放行
      // 清理 finished task files。
      const analyze = (
        planReg: ReturnType<typeof runtime.readPlansRegistry>,
        taskReg: ReturnType<typeof runtime.readRegistry>,
      ) => {
        const plan = planReg.plans[planId];
        const affectedActiveTasks = Object.values(taskReg.tasks)
          .filter((task) => task.planId === planId && !isFinishedTaskState(task.state) && taskDependsOnPlanSection(task, planId))
          .map((task) => ({
            taskId: task.taskId,
            state: task.state,
            contentRef: task.contentRef || null,
            taskContentMode: task.taskContentMode || null,
          }));
        const wouldCleanTaskFiles = deleteTaskFiles
          ? Object.values(taskReg.tasks)
              .filter((t) => t.planId === planId && t.taskContentPath && isFinishedTaskState(t.state))
              .map((t) => t.taskContentPath!)
          : [];
        return { plan, affectedActiveTasks, hasActiveSectionDependents: affectedActiveTasks.length > 0, wouldCleanTaskFiles };
      };

      const planRegistry = runtime.readPlansRegistry(context, false);
      const taskRegistry = runtime.readRegistry(context, false);
      const pre = analyze(planRegistry, taskRegistry);
      if (!pre.plan) return jsonResult({ ok: false, code: "PLAN_NOT_FOUND", error: `找不到計畫 ${planId}` });
      const targetPath = pre.plan.contentRef
        ? resolvePlansContentRef(pre.plan.contentRef, root, PLANS_DIR)
        : pre.plan.contentPath
          ? pre.plan.contentPath
          : planContentPath(planId, PLANS_DIR);
      const sharedPlans = Object.values(planRegistry.plans).filter((candidate) => {
        if (candidate.planId === planId) return false;
        const candidatePath = candidate.contentRef
          ? resolvePlansContentRef(candidate.contentRef, root, PLANS_DIR)
          : candidate.contentPath;
        return !!candidatePath && samePathIdentity(candidatePath, targetPath);
      });
      if (sharedPlans.length > 0) {
        return jsonResult({
          ok: false,
          code: "CONTENT_IN_USE",
          error: `計畫內容仍被其他存活計畫引用：${sharedPlans.map((candidate) => candidate.planId).join(", ")}`,
          sharedPlanIds: sharedPlans.map((candidate) => candidate.planId),
          preservedPlanContent: true,
        }, null, 2);
      }

      // 1) force=false + active section dependents → 維持既有行為。
      if (pre.hasActiveSectionDependents && !force) {
        return jsonResult({
          ok: false,
          code: "ACTIVE_TASKS_DEPEND",
          planId,
          affectedActiveTasks: pre.affectedActiveTasks,
          preservedPlanContent: true,
          hint: "還有進行中的 section-mode 任務依賴這個計畫。帶 force=true 可以保留計畫內容檔（進行中的參照還讀得到），同時照樣清掉已完成任務的檔案。",
        }, null, 2);
      }

      // 1.5) preview：不動磁碟、不寫 registry，只回報會刪 / 會保留哪些檔。
      if (mode === "preview") {
        return jsonResult({
          ok: true,
          mode: "preview",
          planId,
          wouldDeletePlanContent: !pre.hasActiveSectionDependents,
          wouldPreservePlanContent: pre.hasActiveSectionDependents,
          wouldCleanTaskFiles: pre.wouldCleanTaskFiles,
          affectedActiveTasks: pre.affectedActiveTasks,
          force,
          hint: pre.hasActiveSectionDependents
            ? "plan content 檔會保留（active section-mode task 仍依賴）；帶 mode:\"apply\" 執行清理。"
            : "帶 mode:\"apply\" 真的刪除。",
        }, null, 2);
      }

      // ── apply：全程在全域 lock 內，marker fail-closed，snapshot/rollback ──
      try {
        assertSafeContentPath(root, PLANS_DIR, join(PLANS_DIR, CONTENT_WRITE_LOCK));
         return await withContentWriteLock<string>(lockPath, async (): Promise<string> => {
          const planReg = runtime.readPlansRegistry(context, false);
          const taskReg = runtime.readRegistry(context, false);
          const { plan, affectedActiveTasks, hasActiveSectionDependents } = analyze(planReg, taskReg);
          if (!plan) return jsonResult({ ok: false, code: "PLAN_NOT_FOUND", error: `找不到計畫 ${planId}` });

          if (readInconsistentMarker(root, PLANS_DIR)) {
            return jsonResult({ ok: false, code: "CONTENT_STORE_INCONSISTENT", error: `content store 處於待修復狀態（${markerPath(PLANS_DIR)}）。人工修復後用 plan-content-read({clearInconsistent:true}) 清除 marker。` });
          }
          // lock 內重檢：等鎖期間 task 可能被推進成 active section 依賴
          if (hasActiveSectionDependents && !force) {
            return jsonResult({ ok: false, code: "ACTIVE_TASKS_DEPEND", planId, affectedActiveTasks, preservedPlanContent: true }, null, 2);
          }

          const cleanedTaskFiles: string[] = [];
          const planContentPreserved = hasActiveSectionDependents;
          let planContentDeleted = false;

          const planFileForSha = plan.contentRef
            ? resolvePlansContentRef(plan.contentRef, root, PLANS_DIR)
            : planContentPath(planId, PLANS_DIR);
          const planRawBefore = readPlanContent(root, PLANS_DIR, planFileForSha) || "";

          const writeResult = await guardedStoreMutation({
            projectRoot: root,
            plansDir: PLANS_DIR,
            extraSnapshotPaths: [TASKS_JSON, PLANS_JSON],
            op: `plan-content-delete force=${force}`,
            detail: {
              planId,
              deleteTaskFiles: !!deleteTaskFiles,
              before: { planContentSha256: planRawBefore ? fileSha256(planRawBefore) : null, contentVersion: contentVersionOf(planRawBefore) },
            },
            mutate: async () => {
              // 2) 清掉「已完成 + 有專用檔」task 的 content file。
              //    用 strict 版：檔案存在卻刪不掉 → throw → guardedStoreMutation
              //    從快照全還原，不會留下「檔還在、registry 忘了它」的狀態。
              if (deleteTaskFiles) {
                for (const task of Object.values(taskReg.tasks)) {
                  if (task.planId !== planId || !task.taskContentPath || !isFinishedTaskState(task.state)) continue;
                  const taskPath = resolvePlansContentRef(task.taskContentPath, root, PLANS_DIR);
                  if (deletePlanContentStrict(root, taskPath, PLANS_DIR)) cleanedTaskFiles.push(task.taskContentPath);
                }
              }

              // 3) plan content file 命運
              if (!planContentPreserved) {
                if (plan.contentRef) {
                  deletePlanContentStrict(root, resolvePlansContentRef(plan.contentRef, root, PLANS_DIR), PLANS_DIR);
                } else if (plan.contentPath) {
                  assertSafePlansPath(plan.contentPath, PLANS_DIR);
                  deletePlanContentStrict(root, plan.contentPath, PLANS_DIR);
                }
                deletePlanContentStrict(root, planContentPath(planId, PLANS_DIR), PLANS_DIR);
                planContentDeleted = true;
                plan.contentRef = undefined;
                plan.contentPath = undefined;
                plan.contentVersion = undefined;
              }

              plan.updatedAt = nowIso();
              const tag = planContentPreserved ? "CONTENT_DELETE_PRESERVED" : "CONTENT_DELETE";
              plan.history.push(`| ${nowIso()} | ${tag} | system | deletedPlanContent=${planContentDeleted} preservedPlanContent=${planContentPreserved} force=${force} affectedActiveTasks=${affectedActiveTasks.map((t) => t.taskId).join(",") || "-"} cleanedTaskFiles=${cleanedTaskFiles.join(",") || "-"} |`);

              // 4) registry bookkeeping：清 finished task 的 content refs
              if (deleteTaskFiles && cleanedTaskFiles.length > 0) {
                for (const task of Object.values(taskReg.tasks)) {
                  if (task.planId !== planId || !task.taskContentPath) continue;
                  if (!cleanedTaskFiles.includes(task.taskContentPath) || !isFinishedTaskState(task.state)) continue;
                  const cleaned = task.taskContentPath;
                  task.contentRef = undefined;
                  task.taskContentPath = undefined;
                  task.taskContentMode = undefined;
                  task.history.push(`| ${nowIso()} | CONTENT_DELETE_AUDIT | system | cleanedTaskFile=${cleaned} planDelete=${planId} force=${force} |`);
                }
              }

              // 5) 保留 backing file 時記錄 forced-preserved
              if (planContentPreserved) {
                for (const dep of affectedActiveTasks) {
                  const task = taskReg.tasks[dep.taskId];
                  if (!task) continue;
                  task.history.push(`| ${nowIso()} | CONTENT_DELETE_FORCED_PRESERVED | system | planContentFile preserved for active section-mode task; refs remain readable force=${force} planId=${planId} |`);
                }
              }

              await runtime.transactRegistries(context, (draft, control) => {
                 const targetPlan = draft.plans.plans[planId];
                 if (targetPlan) {
                   targetPlan.contentRef = plan.contentRef;
                   targetPlan.contentPath = plan.contentPath;
                   targetPlan.contentVersion = plan.contentVersion;
                   targetPlan.updatedAt = plan.updatedAt;
                   targetPlan.history = [...plan.history];
                 }
                 for (const current of Object.values(draft.tasks.tasks)) {
                   if (current.planId !== planId) continue;
                   if (current.taskContentPath && cleanedTaskFiles.includes(current.taskContentPath)) {
                     current.contentRef = undefined;
                     current.taskContentPath = undefined;
                     current.taskContentMode = undefined;
                     current.history.push(`| ${nowIso()} | CONTENT_DELETE_AUDIT | system | cleanedTaskFile=${current.taskContentPath} planDelete=${planId} force=${force} |`);
                   }
                   if (planContentPreserved && affectedActiveTasks.some((dep) => dep.taskId === current.taskId)) {
                     current.history.push(`| ${nowIso()} | CONTENT_DELETE_FORCED_PRESERVED | system | planContentFile preserved for active section-mode task; refs remain readable force=${force} planId=${planId} |`);
                   }
                 }
                 control.commit();
               });
            },
          });

          if (writeResult.kind === "rolled_back") {
            return jsonResult({ ok: false, code: "REGISTRY_WRITE_FAILED_ROLLED_BACK", error: `刪除過程失敗，content 與 registry 都已還原成原始位元組，可安全重試。（${writeResult.error}）` });
          }
          if (writeResult.kind === "partial") {
            return jsonResult({ ok: false, code: "PARTIAL_WRITE", error: "部分檔案已刪除但 registry 未同步且還原失敗。不可直接重試——人工修復後清 marker。", marker: writeResult.marker });
          }

          return jsonResult({
            ok: true,
            mode: "apply",
            planId,
            deleted: planContentDeleted,
            preservedPlanContent: planContentPreserved,
            affectedActiveTasks,
            cleanedTaskFiles,
            force,
          }, null, 2);
        });
      } catch (err) {
        if (err instanceof ContentLockBusyError) {
          return jsonResult({ ok: false, code: err.code, error: err.message, heldByPid: err.heldByPid, ageSeconds: err.ageSeconds });
        }
        throw err;
      }
    }
  });
}

