import { jsonResult } from "../../../kit/json.ts";
/**
 * opencode-ultrawork — task-content tool factories
 *
 * 角色：
 *     `task_content_*` 公開工具定義：
 *       · `task_content_read`：讀 task content（file mode 或 plan section mode）。
 *       · `task_content_update`：更新 task content（file mode 或 plan section mode）。
 *
 * 對外規則（不可破壞）：
 *   - tool name / args schema / execute 固定外層 JSON 格式必須維持一致
 *   - 透過 `UltraworkRuntimeContext` 取得 paths / registry IO，
 *     行為與 closure 原版本完全一致。
 *   - `task_content_update` 的 file mode 分支會更新 task 的
 *     `taskContentPath` / `taskContentMode` / `contentRef`，並遞增
 *     plan 的 `contentVersion`；section mode 分支會更新 task 的
 *     `contentRef` / `taskContentMode` 並清空 `taskContentPath`，
 *     同步遞增 plan 的 `contentVersion`。兩種模式行為必須與原 closure
 *     一致。
 *     僅由 index.ts 反向引用；引入反向 import 會形成循環依賴。
 *
 * 設計重點：
 *   - 採 factory 形式（2 個 factory），皆接受 `UltraworkRuntimeContext`
 *     注入；tool 內所有 IO 與 path 推導皆透過 `runtime.*`，
 *     不持有 closure-scoped 狀態。
 *   - leaf 模組 `../content/content-ref.ts` 的 `writePlanContent(absolutePath,
 *     content, plansDir, createDir?)` 簽名要求顯式傳入 `plansDir` 與
 *     `createDir` callback；closure 原版包了一層 wrapper（接受
 *     `context`），本檔於 factory 內 inline 重建該 wrapper
 *     （呼叫 `runtime.resolveProjectRoot` / `runtime.ensureDir`），
 *     以維持 factory 模組自包含、無外部 wrapper 依賴。
 *
 * @see ../../../../README.md                              — 模組一覽
 * @see ../content/content-ref.ts                         — leaf path / I/O helpers
 */

import { dirname, join } from "node:path";
import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../../kit/define-tool.ts";
type ToolContext = ToolExecutionContext;
import type { UltraworkRuntimeContext } from "../runtime/context-builder.ts";
import { getPathsForRoot } from "../runtime/context.ts";
import { nowIso } from "../runtime/now.ts";
import {
  assertSafePlansPath,
  planContentPath,
  planContentRef,
  taskContentFilePath,
  taskFileContentRef,
  taskSectionContentRef,
  resolvePlansContentRef,
  readPlanContent,
} from "../content/content-ref.ts";
import { extractTaskSection, findSectionBounds } from "../content/section-parser.ts";
import { renderTaskContentMarkdown, renderStandaloneTaskContentMarkdown } from "../content/render.ts";
import { canonicalBody, fileSha256, frontmatterContentVersion, sectionMeta } from "../content/content-sha.ts";
import { grepContent } from "../content/content-grep.ts";
import { buildUpdatedContent, validateProposedBody, type UpdateTarget } from "../content/content-apply.ts";
import {
  CONTENT_WRITE_LOCK,
  assertSafeContentPath,
  assertSafeContentRoot,
  guardedContentWrite,
  markerPath,
  readInconsistentMarker,
} from "../content/content-store.ts";
import { ContentLockBusyError, withContentWriteLock } from "../../../kit/write-lock.ts";
import { normalize } from "../core/markdown-canonical.ts";
import { unifiedLineDiff } from "../core/line-diff.ts";

/**
 * 建立 `task_content_read` tool。
 *
 * behavior-preserving extraction：行為、args schema、固定外層 JSON 回覆
 * 完全等價。
 */
export function createTaskContentReadTool(runtime: UltraworkRuntimeContext) {
  return defineTool({
    name: "task-content-read",
    description:
      "讀取任務內容。source 省略 = 依 task.taskContentMode 推導；section = 讀 plan content 內的 task section；file = 讀專用 task 檔。grep:\"pattern\" 只回符合的行（literal 預設，regex:true 改用正則；context 預設 2；maxMatches 預設 20），在 section／file 範圍內搜。回應帶 fileSha256 或 sectionSha256 與 contentVersion,供 task-content-update 的 expectedSha256。",
    inputSchema: z.object({
      taskId: z.string(),
      source: z.enum(["section", "file"]).optional(),
      grep: z.string().optional(),
      regex: z.boolean().optional(),
      context: z.number().optional(),
      maxMatches: z.number().optional(),
    }),
    async execute({ taskId, source, grep, regex, context: grepContextLines, maxMatches }, context) {
      const mode: "auto" | "section" | "file" = source ?? "auto";
      const root = runtime.resolveProjectRoot(context);
      const { PLANS_DIR } = getPathsForRoot(root);
      const taskRegistry = runtime.readRegistry(context, false);
      const task = taskRegistry.tasks[taskId];

      if (!task) return jsonResult({ ok: false, code: "TASK_NOT_FOUND", error: `找不到任務 ${taskId}` });

      // Determine read mode
      //   - explicit mode wins
      //   - auto mode for standalone Task (no planId)：
      //     · consistent file metadata（`taskContentMode === "file"` 且有
      //       `taskContentPath`，由 explicit `mode="file"` update 建立）→
      //       解析回 file content，不可靜默拒絕。
      //     · stale section metadata（`taskContentMode="section"` +
      //       path）或無 metadata → 拒絕，不可靜默 fallback。
      //   - auto mode for linked Task 沿用 taskContentMode → taskContentPath
      //     → section fallback 既有語意。
      let effectiveMode: "file" | "section";
      if (mode === "file") {
        // 顯式 source:file 但沒有 task 檔 → 錯誤,不靜默落回 section。
        if (!task.taskContentPath) {
          return jsonResult({
            ok: false,
            code: "TASK_FILE_NOT_FOUND",
            error: `任務 ${taskId} 沒有專用的 task 檔（taskContentPath 未設）。用 source:section 或省略 source。`,
          });
        }
        effectiveMode = "file";
      } else if (mode === "section") {
        effectiveMode = "section";
      } else if (!task.planId) {
        if (task.taskContentMode === "file" && task.taskContentPath) {
          effectiveMode = "file";
        } else {
          return jsonResult({
            ok: false,
            code: "NO_PLAN_ID", error: `任務 ${taskId} 沒有 planId，呼叫時也沒帶 planId，無法自動判斷內容來源`,
          });
        }
      } else {
        effectiveMode = task.taskContentMode === "section" || !task.taskContentPath
          ? "section"
          : "file";
      }

      if (effectiveMode === "file" && task.taskContentPath) {
        // Read from dedicated task file - use resolvePlansContentRef for safety
        const targetPath = resolvePlansContentRef(task.taskContentPath, root, PLANS_DIR);
        const raw = readPlanContent(root, PLANS_DIR, targetPath);
        if (grep !== undefined) {
          const res = grepContent(raw ? canonicalBody(raw) : "", { pattern: grep, regex, context: grepContextLines, maxMatches });
          if ("code" in res) return jsonResult({ ok: false, ...res });
          return jsonResult({
            ok: true, taskId, source: "file", grep, taskContentPath: task.taskContentPath,
            ...(raw ? { fileSha256: fileSha256(raw), contentVersion: frontmatterContentVersion(raw) } : {}),
            matchCount: res.matchCount, truncated: res.truncated, matches: res.matches,
          }, null, 2);
        }
        return jsonResult({
          ok: true,
          taskId,
          source: "file",
          content: raw,
          taskContentPath: task.taskContentPath,
          ...(raw ? { fileSha256: fileSha256(raw), contentVersion: frontmatterContentVersion(raw) } : {}),
        }, null, 2);
      }

      // Read from plan section
      if (!task.planId) {
        return jsonResult({ ok: false, code: "NO_PLAN_ID", error: `任務 ${taskId} 既沒有 planId 也沒有 taskContentPath，無法判斷內容來源` });
      }

      const planRegistry = runtime.readPlansRegistry(context, false);
      const plan = planRegistry.plans[task.planId];
      if (!plan) return jsonResult({ ok: false, code: "PLAN_NOT_FOUND", error: `找不到計畫 ${task.planId}` });

      // Read from plan section - use contentRef resolution
      const planPath = plan.contentRef
        ? resolvePlansContentRef(plan.contentRef, root, PLANS_DIR)
        : planContentPath(task.planId, PLANS_DIR);
      const raw = readPlanContent(root, PLANS_DIR, planPath);

      if (!raw) return jsonResult({ ok: false, code: "PLAN_CONTENT_MISSING", error: `找不到計畫的內容檔：${planPath}` });

      const sectionContent = extractTaskSection(raw, taskId);
      const meta = sectionMeta(raw, { kind: "task", taskId });

      // 舊 plan：只有帶 task id 的一般 H3（沒有 canonical `### task: <id>` +
      // anchor）→ sectionMeta 找不到，回 exists:false。給遷移提示。
      const migrationHint = meta === null && new RegExp(`^#{2,3}\\s.*\\b${taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m").test(raw)
        ? `plan 內有提到 ${taskId} 的標題，但不是 canonical 的 '### task: ${taskId}' + '<!-- task-anchor: ${taskId} -->'。用 task-content-update({taskId:"${taskId}", source:"section", mode:"apply"}) 寫一次即可建立 canonical 標記。`
        : undefined;

      if (grep !== undefined) {
        // 在 plan 完整 body 上搜、限定 task section 行區間；行號 / selector 以
        // 完整 body 為準（match selector = `task:<id>`）。
        const body = canonicalBody(raw);
        const bounds = findSectionBounds(body, { kind: "task", taskId });
        const res = grepContent(body, {
          pattern: grep, regex, context: grepContextLines, maxMatches,
          within: bounds ? [bounds.start, bounds.end] : [0, 0],
        });
        if ("code" in res) return jsonResult({ ok: false, ...res });
        return jsonResult({
          ok: true, taskId, planId: task.planId, source: "section", grep,
          exists: meta !== null,
          fileSha256: fileSha256(raw),
          contentVersion: frontmatterContentVersion(raw),
          ...(meta ? { sectionSha256: meta.sha256 } : {}),
          matchCount: res.matchCount, truncated: res.truncated, matches: res.matches,
        }, null, 2);
      }

      return jsonResult({
        ok: true,
        taskId,
        planId: task.planId,
        source: "section",
        sectionContent: sectionContent ?? "",
        exists: meta !== null,
        contentRef: task.contentRef || taskSectionContentRef(task.planId, taskId),
        fileSha256: fileSha256(raw),
        contentVersion: frontmatterContentVersion(raw),
        ...(meta ? { sectionSha256: meta.sha256, lineRange: meta.lineRange } : {}),
        ...(migrationHint ? { hint: migrationHint } : {}),
      }, null, 2);
    }
  });
}

/**
 * 建立 `task_content_update` tool。
 *
 * behavior-preserving extraction：行為、args schema、固定外層 JSON 回覆
 * 完全等價。
 *
 * 模式：
 *   - `file` (effectiveMode === "file")：寫入 `.ultrawork/plans/tasks/{taskId}.md`，
 *     更新 task 的 `taskContentPath` / `taskContentMode` / `contentRef`，
 *     遞增 plan 的 `contentVersion`。
 *   - `section` (effectiveMode === "section")：寫入 plan content file 的
 *     task section，更新 task 的 `contentRef` / `taskContentMode`，清空
 *     `taskContentPath`，遞增 plan 的 `contentVersion`，並 push
 *     `TASK_CONTENT_UPDATE` history 事件。
 */
export function createTaskContentUpdateTool(runtime: UltraworkRuntimeContext) {
  return defineTool({
    name: "task-content-update",
    description:
      "更新任務內容。source: section(寫 plan content 內的 task section) / file(寫專用 task 檔)；缺省沿用 task.taskContentMode。standalone task(無 planId)必為 file。mode: preview(預設,回 diff+sha,不寫) / apply 需帶 expectedSha256 防止競態：比對的是 preview 或 read 回的 currentSha256（section 已存在 = sectionSha256；section 尚未建立 = plan 檔 fileSha256；file 模式 = 整檔 sha）。若目標所在的內容檔本身還不存在（只有新建獨立任務檔會落在這個情況）才可省略 expectedSha256。整檔 sha 也是合法的更強比對值：apply 鎖內重讀若與給的整檔 sha 一致即視為有效，回應以 shaAccepted 標記是「section」還是「file」。content 可直接用 read 回的 sectionContent(marker 行會自動剝掉)。op: replace(預設)/append/prepend。",
    inputSchema: z.object({
      taskId: z.string(),
      content: z.string(),
      source: z.enum(["section", "file"]).optional(),
      op: z.enum(["replace", "append", "prepend"]).optional(),
      mode: z.enum(["preview", "apply"]).optional(),
      planId: z.string().optional(),
      expectedSha256: z.string().optional(),
    }),
    async execute({ taskId, content, source, op = "replace", mode = "preview", planId, expectedSha256 }, context) {
      const root = runtime.resolveProjectRoot(context);
      const { PLANS_DIR, TASKS_JSON, PLANS_JSON } = getPathsForRoot(root);
      const lockPath = join(PLANS_DIR, CONTENT_WRITE_LOCK);

      const taskRegistry = runtime.readRegistry(context, false);
      const task = taskRegistry.tasks[taskId];
      if (!task) return jsonResult({ ok: false, code: "TASK_NOT_FOUND", error: `找不到任務 ${taskId}` });

      const effectivePlanId = planId || task.planId;

      // source 推導：
      //   - explicit source 優先。
      //   - standalone task（無 effectivePlanId）：**不從 task.taskContentMode 推導**
      //     （舊版會在 explicit file 寫過一次後以 taskContentMode="file" 靜默續寫，
      //     繞過 no-planId 規則——Momus finding）。缺省一律拒絕，要求顯式 source:"file"。
      //   - linked task：缺省沿用 task.taskContentMode（file / hybrid → file，其餘 → section）。
      let effectiveSource: "section" | "file";
      if (source !== undefined) {
        effectiveSource = source;
      } else if (!effectivePlanId) {
        return jsonResult({
          ok: false,
          code: "STANDALONE_REQUIRES_FILE",
          error: `任務 ${taskId} 沒有 planId，呼叫時也沒帶——獨立任務一定要指定 source（用 source: "file"）`,
        });
      } else {
        effectiveSource = task.taskContentMode === "file" || task.taskContentMode === "hybrid" ? "file" : "section";
      }

      if (!effectivePlanId && effectiveSource === "section") {
        return jsonResult({
          ok: false,
          code: "STANDALONE_REQUIRES_FILE",
          error: `任務 ${taskId} 沒有 planId，呼叫時也沒帶——section 來源需要有計畫`,
        });
      }

      if (readInconsistentMarker(root, PLANS_DIR)) {
        return jsonResult({ ok: false, code: "CONTENT_STORE_INCONSISTENT", error: `content store 待修復（${markerPath(PLANS_DIR)}）。修好後用 plan-content-read({clearInconsistent:true}) 清 marker。` });
      }

      // ── 解析寫入目標 ──
      // section：寫 plan content 檔的 task section（reuse buildUpdatedContent）。
      // file：寫 .ultrawork/plans/tasks/{id}.md（whole-body，可能需先 render 新檔）。
      const planRegistry = effectivePlanId ? runtime.readPlansRegistry(context, false) : null;
      const plan = effectivePlanId ? planRegistry!.plans[effectivePlanId] : null;
      if (effectivePlanId && !plan) return jsonResult({ ok: false, code: "PLAN_NOT_FOUND", error: `找不到計畫 ${effectivePlanId}` });

      let contentPath: string;
      let fileExists: boolean;
      let renderFresh: ((body: string, version: number) => string) | null = null;

      if (effectiveSource === "section") {
        if (plan && !plan.contentRef) plan.contentRef = planContentRef(effectivePlanId!);
        contentPath = plan?.contentRef
          ? resolvePlansContentRef(plan.contentRef, root, PLANS_DIR)
          : planContentPath(effectivePlanId!, PLANS_DIR);
        fileExists = !!readPlanContent(root, PLANS_DIR, contentPath);
        if (!fileExists) return jsonResult({ ok: false, code: "PLAN_CONTENT_MISSING", error: `plan ${effectivePlanId} 還沒有 content 檔，先 plan-content-create。` });
      } else {
        const rel = taskContentFilePath(taskId);
        contentPath = join(root, rel);
        assertSafePlansPath(contentPath, PLANS_DIR);
        fileExists = !!readPlanContent(root, PLANS_DIR, contentPath);
        renderFresh = effectivePlanId
          ? (body, version) => renderTaskContentMarkdown(task, effectivePlanId!, body, version)
          : (body, version) => renderStandaloneTaskContentMarkdown(task, body, version);
      }

      const target: UpdateTarget = effectiveSource === "section" ? { kind: "task", taskId } : { kind: "full" };
      const taskMarkers = effectiveSource === "section"
        ? { heading: `### task: ${taskId}`, anchor: `<!-- task-anchor: ${taskId} -->` }
        : undefined;

      const versionBase = () => {
        if (effectiveSource === "section") return (plan?.contentVersion ?? 0);
        return effectivePlanId ? (plan?.contentVersion ?? 0) : (task.contentVersion ?? 0);
      };

      // 組出 proposed 檔內容。
      const buildProposed = (raw: string, nextVersion: number): { proposed: string } | { code: string; error: string } => {
        if (effectiveSource === "file" && !raw) {
          // 新 task 檔：直接 render（op 只有 replace 有意義）。
          return { proposed: normalize(renderFresh!(content, nextVersion)) };
        }
        const built = buildUpdatedContent({
          rawFile: raw,
          nextContentVersion: nextVersion,
          updatedAt: nowIso(),
          target,
          op,
          newBody: content,
          taskMarkers,
        });
        if ("code" in built) return built;
        return { proposed: built.proposed };
      };

      // 定址時比對 section sha；section 尚未建立時退回比對整個 plan 檔的 sha，
      // 讓「新建 section」的 preview→apply 之間仍有競態保護（別人動了 plan 檔
      // 或搶先建了同名 section → sha 變 → CONTENT_SHA_CONFLICT）。
      const expectedShaFor = (raw: string): string | null => {
        if (!raw) return null;
        if (effectiveSource !== "section") return fileSha256(raw);
        return sectionMeta(raw, { kind: "task", taskId })?.sha256 ?? fileSha256(raw);
      };

      // ── preview ──
      if (mode === "preview") {
        const raw = readPlanContent(root, PLANS_DIR, contentPath) || "";
        const nextVersion = versionBase() + 1;
        const bp = buildProposed(raw, nextVersion);
        if ("code" in bp) return jsonResult({ ok: false, ...bp });
        if (raw) {
          const v = validateProposedBody(normalize(raw), bp.proposed, { requireH1: effectiveSource === "section" });
          if (v) return jsonResult({ ok: false, ...v });
        }
        return jsonResult({
          ok: true,
          mode: "preview",
          taskId,
          planId: effectivePlanId ?? null,
          source: effectiveSource,
          op,
          changed: normalize(raw) !== bp.proposed,
          diff: taskUnifiedDiff(normalize(raw), bp.proposed),
          currentSha256: expectedShaFor(raw),
          proposedFileSha256: fileSha256(bp.proposed),
          currentContentVersion: raw ? frontmatterContentVersion(raw) : null,
          nextContentVersion: nextVersion,
          exists: effectiveSource === "section" && raw ? sectionMeta(raw, { kind: "task", taskId }) !== null : !!raw,
          hint: !raw
            ? `新檔：mode:"apply" + expectedSha256 傳 null。`
            : `mode:"apply" + expectedSha256:"${expectedShaFor(raw)}"（${effectiveSource === "section" && sectionMeta(raw, { kind: "task", taskId }) === null ? "新 section，比對整個 plan 檔 sha" : "定址比對 section sha"}）。`,
        }, null, 2);
      }

      // ── apply ──
      // expectedSha256 的要求規則：
      //   - 整個內容檔不存在（task source:file 全新檔、且 standalone task）→
      //     targetShaNow 為 null，可省略 expectedSha256
      //   - 整個內容檔存在（task source:file 既有、task source:section 不管 section 是否已建）→
      //     一律必填 expectedSha256，比對的是 preview 或 read 回的 currentSha256：
      //       · source:file → 整檔 sha
      //       · source:section 且 section 已存在 → section sha
      //       · source:section 且 section 不存在 → plan 檔整檔 sha（不是免 sha，是用整檔 sha 比對）
      const rawNow = readPlanContent(root, PLANS_DIR, contentPath) || "";
      const targetShaNow = expectedShaFor(rawNow);
      if (targetShaNow && !expectedSha256) {
        return jsonResult({ ok: false, code: "EXPECTED_SHA256_REQUIRED", error: "mode:apply 需要 expectedSha256（新目標可省略）。", currentSha256: targetShaNow });
      }

      runtime.ensureDir(PLANS_DIR, context); // lock 檔的父目錄（standalone task 可能還沒有 plans/）

      try {
        assertSafeContentPath(root, PLANS_DIR, join(PLANS_DIR, CONTENT_WRITE_LOCK));
        return await withContentWriteLock<string>(lockPath, async (): Promise<string> => {
          // lock 內重讀 registry
          const taskReg = runtime.readRegistry(context, false);
          const t = taskReg.tasks[taskId];
          if (!t) return jsonResult({ ok: false, code: "TASK_NOT_FOUND", error: `找不到任務 ${taskId}` });
          const planReg = effectivePlanId ? runtime.readPlansRegistry(context, false) : null;
          const p = effectivePlanId ? planReg!.plans[effectivePlanId] : null;
          if (effectivePlanId && !p) return jsonResult({ ok: false, code: "PLAN_NOT_FOUND", error: `找不到計畫 ${effectivePlanId}` });
          if (p && effectiveSource === "section" && !p.contentRef) p.contentRef = planContentRef(effectivePlanId!);

          if (readInconsistentMarker(root, PLANS_DIR)) {
            return jsonResult({ ok: false, code: "CONTENT_STORE_INCONSISTENT", error: `content store 待修復（${markerPath(PLANS_DIR)}）。` });
          }

          const raw = readPlanContent(root, PLANS_DIR, contentPath) || "";
          if (!raw && effectiveSource === "section") {
            return jsonResult({ ok: false, code: "PLAN_CONTENT_MISSING", error: `plan content 檔在寫入前消失了。` });
          }
          // 鎖內重讀：用 sectionSha256（section 已存在）或 整檔 sha 比對。
          // 額外允許「給整檔 sha 且鎖內整檔 sha 相符」——整檔逐字相同比 section
          // 匹配的保證更強，足以涵蓋 section 比對（強保證蘊含弱保證）。
          // 必須用鎖內這次 readPlanContent 算的 fileSha256 比對，
          // 不可用鎖外先算的值。
          const currentSha = expectedShaFor(raw);
          const lockFileSha = fileSha256(raw);
          const acceptedAsFileSha =
            currentSha !== lockFileSha &&
            expectedSha256 != null &&
            expectedSha256 === lockFileSha;
          // null == 目標不存在（新建）。expectedSha256 省略時視為 null。
          if ((expectedSha256 ?? null) !== currentSha && !acceptedAsFileSha) {
            return jsonResult({ ok: false, code: "CONTENT_SHA_CONFLICT", error: "content 自讀取以來已變更，重讀後再試。", expectedSha256: expectedSha256 ?? null, currentSha256: currentSha });
          }
          // shaAccepted 必須反映實際比對層級：
          //   - file target（source:file）一律是 file
          //   - section 不存在 → fallback 整檔 sha → file
          //   - section 存在 + 用 section sha 通過 → section
          //   - section 存在 + 用整檔 sha 相容接受 → file
          const sectionExists = effectiveSource === "section"
            && sectionMeta(raw, { kind: "task", taskId }) !== null;
          let shaAccepted: "file" | "section";
          if (effectiveSource === "file") {
            shaAccepted = "file";
          } else if (!sectionExists) {
            shaAccepted = "file";
          } else if (acceptedAsFileSha) {
            shaAccepted = "file";
          } else {
            shaAccepted = "section";
          }

          const nextVersion = (effectiveSource === "section"
            ? (p?.contentVersion ?? 0)
            : effectivePlanId ? (p?.contentVersion ?? 0) : (t.contentVersion ?? 0)) + 1;
          const bp = buildProposed(raw, nextVersion);
          if ("code" in bp) return jsonResult({ ok: false, ...bp });
          if (raw) {
            const v = validateProposedBody(normalize(raw), bp.proposed, { requireH1: effectiveSource === "section" });
            if (v) return jsonResult({ ok: false, ...v });
          }

          const raw2 = readPlanContent(root, PLANS_DIR, contentPath) || "";
          if (fileSha256(raw2) !== fileSha256(raw)) {
            return jsonResult({ ok: false, code: "CONTENT_SHA_CONFLICT", error: "content 在寫入前一刻變了，什麼都沒寫。" });
          }

          assertSafeContentRoot(root, PLANS_DIR);
          assertSafeContentPath(root, PLANS_DIR, contentPath);
          runtime.ensureDir(dirname(contentPath), context);
          const writeResult = await guardedContentWrite({
            projectRoot: root,
            plansDir: PLANS_DIR,
            contentPath,
            proposedFile: bp.proposed,
            extraSnapshotPaths: [TASKS_JSON, PLANS_JSON],
            op: `task-content-update ${effectiveSource} ${op}`,
            shaBefore: { file: raw ? fileSha256(raw) : "", contentVersion: raw ? frontmatterContentVersion(raw) : null },
            shaAfter: { file: fileSha256(bp.proposed), contentVersion: nextVersion },
            writeRegistry: async () => {
              if (effectiveSource === "file") {
                t.taskContentPath = taskContentFilePath(taskId);
                t.taskContentMode = p?.contentRef ? "hybrid" : "file";
                t.contentRef = taskFileContentRef(taskId);
                if (!effectivePlanId) t.contentVersion = nextVersion;
              } else {
                t.contentRef = taskSectionContentRef(effectivePlanId!, taskId);
                t.taskContentMode = "section";
                t.taskContentPath = undefined;
              }
              await runtime.transactRegistries(context, (draft, control) => {
                const target = draft.tasks.tasks[taskId];
                if (target) {
                  target.taskContentPath = t.taskContentPath;
                  target.taskContentMode = t.taskContentMode;
                  target.contentRef = t.contentRef;
                  if (!effectivePlanId) target.contentVersion = nextVersion;
                }
                if (p) {
                  const plan = draft.plans.plans[p.planId];
                  if (plan) {
                    plan.contentVersion = nextVersion;
                    plan.updatedAt = nowIso();
                    plan.history = Array.isArray(plan.history) ? plan.history : [];
                    plan.history.push(`| ${nowIso()} | TASK_CONTENT_UPDATE | system | taskId=${taskId} source=${effectiveSource} op=${op} |`);
                  }
                }
                control.commit();
              });
            },
          });

          if (writeResult.kind === "rolled_back") {
            return jsonResult({ ok: false, code: "REGISTRY_WRITE_FAILED_ROLLED_BACK", error: `registry 寫入失敗，已全還原成原始位元組，可安全重試。（${writeResult.error}）` });
          }
          if (writeResult.kind === "partial") {
            return jsonResult({ ok: false, code: "PARTIAL_WRITE", error: "content 已寫入但 registry 未同步且還原失敗。不可直接重試。", marker: writeResult.marker });
          }

          const written = readPlanContent(root, PLANS_DIR, contentPath) || "";
          return jsonResult({
            ok: true,
            mode: "apply",
            applied: true,
            taskId,
            planId: effectivePlanId ?? null,
            source: effectiveSource,
            contentRef: t.contentRef,
            contentVersion: nextVersion,
            fileSha256: fileSha256(written),
            shaAccepted,
            ...(effectiveSource === "file"
              ? { taskContentPath: t.taskContentPath }
              : { sectionSha256: sectionMeta(written, { kind: "task", taskId })?.sha256 }),
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

/** preview 用的行級 diff：LCS + 共同前後綴。 */
function taskUnifiedDiff(before: string, after: string): string {
  return unifiedLineDiff(before, after);
}
