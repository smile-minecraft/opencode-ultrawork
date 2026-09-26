/**
 * project-memory 工具：讀取、分段更新、整份重寫 project.md。
 *
 * 自舊外掛 tools/project-memory 移植，行為逐字一致：
 * - `project-memory-read`：digest（預設）／full／section；section 在
 *   mode=section 時必填且只能是單行值；三種模式都回 fileSha256。
 * - `project-memory-update`：replace／append／delete × preview（預設）／apply；
 *   保留 frontmatter 與其他段落，不寫歷史；apply 需 fresh expectedSha256，
 *   在與 rewrite 共用的寫入鎖內核對後才原子寫入；超限拒絕不截斷。
 * - `project-memory-rewrite`：整份 body 替換、frontmatter 保留原樣；
 *   body 須含非空 H1 且不含 frontmatter；H2 不可重複；上限與鎖同 update。
 *
 * V2 差異（僅接線層）：工具經 defineTool＋zod 定義、於 register 以
 * ctx.tool.transform 註冊；路徑改用 `<工作階段位置>/.ultrawork/project.md`，
 * 工作階段位置由呼叫端解析傳入；原子寫入與寫入鎖用 kit 共用件。
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineTool, type DefinedTool } from "../../kit/define-tool.ts";
import { jsonResult } from "../../kit/json.ts";
import { atomicWriteFile } from "../../kit/atomic-write.ts";
import { ContentLockBusyError, withContentWriteLock } from "../../kit/write-lock.ts";
import { normalizeNewline, splitFrontmatter } from "./helpers.ts";
import { lineFenceState } from "./markdown-fence.ts";
import { PROJECT_MD_HARD_LIMIT, PROJECT_MEMORY_LOCK } from "./constants.ts";
import { getMemoryPaths, assertSafeMemoryPath } from "./paths.ts";
import {
  resolveProjectMdPolicyFromContent,
  getProjectMdCurrentSections,
  getProjectMdOverLimitHint,
} from "./project-md-policy.ts";
import type { MemoryRootResolver } from "./session-root.ts";

/** project-memory IO 的最小替身介面，供交易邊界做 deterministic 驗證。 */
export interface ProjectMemoryFileOps {
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, content: string): void;
}

const defaultProjectMemoryFileOps: ProjectMemoryFileOps = {
  exists: (path) => {
    try {
      statSync(path);
      return true;
    } catch (err) {
      if (isEnoent(err)) return false;
      throw err;
    }
  },
  read: (path) => readFileSync(path, "utf8"),
  write: (path, content) => atomicWriteFile(path, content),
};

let projectMemoryFileOps: ProjectMemoryFileOps = defaultProjectMemoryFileOps;

/**
 * 暫時替換 project-memory 的檔案操作；回傳復原函式，僅供 deterministic tests 使用。
 */
export function setProjectMemoryFileOpsForTesting(overrides: Partial<ProjectMemoryFileOps>): () => void {
  const previous = projectMemoryFileOps;
  projectMemoryFileOps = { ...previous, ...overrides };
  return () => {
    projectMemoryFileOps = previous;
  };
}

/**
 * 讀取 project.md 的存在性視窗；只把 ENOENT 視為檔案不存在，其他 IO 錯誤照原樣拋出。
 */
function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function readProjectMemoryFile(path: string): string | null {
  try {
    if (!projectMemoryFileOps.exists(path)) return null;
    return projectMemoryFileOps.read(path);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** 讀取模式合法值。 */
export type ProjectMemoryReadMode = "digest" | "full" | "section";

/** 寫入操作合法值。 */
export type ProjectMemoryUpdateOp = "replace" | "append" | "delete";

/** 寫入交易模式；預設 preview，只有 apply 會寫入。 */
export type ProjectMemoryUpdateMode = "preview" | "apply";

/** 完整重寫模式；預設 preview，只有 apply 會寫入。 */
export type ProjectMemoryRewriteMode = "preview" | "apply";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function duplicateH2Headings(body: string): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const lines = normalizeNewline(body).split("\n");
  const fenceMask = lineFenceState(lines);
  for (let i = 0; i < lines.length; i++) {
    if (fenceMask[i]) continue;
    const match = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (!match) continue;
    const heading = match[1].trim();
    if (seen.has(heading)) duplicates.add(heading);
    seen.add(heading);
  }
  return [...duplicates];
}

/**
 * Returns true when at least one line outside a fenced code block matches an
 * H1 heading. Used by `project-memory-rewrite` to require a structural H1
 * without being fooled by `# heading` lines embedded in fenced code samples.
 */
function hasNonFenceH1(body: string): boolean {
  const lines = normalizeNewline(body).split("\n");
  const fenceMask = lineFenceState(lines);
  const h1Pattern = /^#\s+\S.*$/;
  for (let i = 0; i < lines.length; i++) {
    if (fenceMask[i]) continue;
    if (h1Pattern.test(lines[i])) return true;
  }
  return false;
}

function renderProjectRewrite(raw: string, body: string): string {
  const normalizedRaw = normalizeNewline(raw);
  const { frontmatter } = splitFrontmatter(normalizedRaw);
  const normalizedBody = normalizeNewline(body).replace(/^\n+/, "").replace(/\n*$/, "\n");
  return frontmatter === null
    ? normalizedBody
    : `---\n${frontmatter}\n---\n${normalizedBody}`;
}

/**
 * 解析後的 section 結構。
 *   - `name`: H2 標題文字（不含 `## ` 前綴）
 *   - `level`: heading level（固定 2，目前僅支援 H2 section）
 *   - `content`: section body（不含 heading 行本身）
 *   - `lineStart`: section 在原始文件中的起始行（1-indexed）
 */
interface ParsedSection {
  name: string;
  level: number;
  content: string;
  lineStart: number;
}

/**
 * 將 project.md 全文解析為 sections。
 *
 * 啟發式：
 *   - 使用 `splitFrontmatter` 抽出 frontmatter 與 body
 *   - 以 H2 (`## `) 為 section 邊界
 *   - H1 (`# `) 為頂層標題（不視為 section）
 *   - 其他內容（frontmatter、頂層 H1、section 之間的散落文字）歸入 `_preamble`
 */
function parseProjectSections(raw: string): {
  frontmatter: string | null;
  preamble: string;
  sections: ParsedSection[];
} {
  const normalized = normalizeNewline(raw);
  const { frontmatter, body } = splitFrontmatter(normalized);
  const lines = body.split("\n");

  const sections: ParsedSection[] = [];
  const preambleLines: string[] = [];

  let current: ParsedSection | null = null;
  let preambleEnded = false;
  const fenceMask = lineFenceState(lines);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const inFence = fenceMask[i]!;
    const h2Match = !inFence ? /^##\s+(.+?)\s*$/.exec(line) : null;
    const h1Match = !inFence ? /^#\s+(.+?)\s*$/.exec(line) : null;

    if (h2Match) {
      // 開新 section（僅在 fence 外）
      current = { name: h2Match[1].trim(), level: 2, content: "", lineStart: i + 1 };
      sections.push(current);
      preambleEnded = true;
      continue;
    }

    if (current) {
      current.content += (current.content ? "\n" : "") + line;
    } else {
      // 尚未進入第一個 H2 之前的內容（含 H1 標題）
      if (!preambleEnded && h1Match) {
        preambleLines.push(line);
      } else if (!preambleEnded) {
        preambleLines.push(line);
      } else {
        // safety net: 理論上不會到這（preambleEnded 設為 true 之後必在 section 內）
        preambleLines.push(line);
      }
    }
  }

  // 去除每個 section content 的尾端多餘空行
  for (const s of sections) {
    s.content = s.content.replace(/\n+$/, "");
  }

  return {
    frontmatter,
    preamble: preambleLines.join("\n").replace(/\n+$/, ""),
    sections,
  };
}

interface SourceLine {
  text: string;
  start: number;
  end: number;
}

/**
 * 取得保留原始 line ending 的行 span；`end` 包含該行的換行字元。
 */
function sourceLines(raw: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < raw.length) {
    const lf = raw.indexOf("\n", start);
    const cr = raw.indexOf("\r", start);
    let newlineStart = lf;
    let newlineLength = 1;
    if (cr !== -1 && (lf === -1 || cr < lf)) {
      newlineStart = cr;
      newlineLength = raw[cr + 1] === "\n" ? 2 : 1;
    }

    if (newlineStart === -1) {
      lines.push({ text: raw.slice(start), start, end: raw.length });
      break;
    }
    lines.push({ text: raw.slice(start, newlineStart), start, end: newlineStart + newlineLength });
    start = newlineStart + newlineLength;
  }
  return lines;
}

/**
 * 找出非 fenced H2 的原始字元範圍；只用於 delete，避免重建未刪除的內容。
 */
function findProjectSectionSpans(raw: string): Array<{ name: string; start: number; end: number }> {
  const lines = sourceLines(raw);
  const first = lines[0];
  if (!first || first.text !== "---" || first.end === first.start + first.text.length) return [];

  let bodyLineIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.text === "---" && line.end > line.start + line.text.length) {
      bodyLineIndex = i + 1;
      break;
    }
  }
  if (bodyLineIndex === -1) return [];

  const bodyLines = lines.slice(bodyLineIndex);
  const fenceMask = lineFenceState(bodyLines.map((line) => line.text));
  const sections: Array<{ name: string; start: number; end: number }> = [];
  for (let i = 0; i < bodyLines.length; i++) {
    if (fenceMask[i]) continue;
    const match = /^##\s+(.+?)\s*$/.exec(bodyLines[i]!.text);
    if (!match) continue;
    sections.push({ name: match[1]!.trim(), start: bodyLines[i]!.start, end: raw.length });
  }
  for (let i = 0; i + 1 < sections.length; i++) {
    sections[i]!.end = sections[i + 1]!.start;
  }
  return sections;
}

interface ProjectMemoryPreview {
  proposedContent?: string;
  diff?: {
    operation: "delete";
    section: string;
    removedContent: string;
    replacement: "";
  };
}

/**
 * 預覽保留完整刪除 span；整份 proposal 僅在目前內容上限內回傳，避免無界回顯。
 */
function buildProjectMemoryPreview(
  raw: string,
  rendered: string,
  op: ProjectMemoryUpdateOp,
  sectionName: string,
  effectiveLimit: number,
): ProjectMemoryPreview {
  const preview: ProjectMemoryPreview = {};
  if (rendered.length <= effectiveLimit) preview.proposedContent = rendered;
  if (op === "delete") {
    const target = findProjectSectionSpans(raw).find((s) => s.name === sectionName);
    if (target) {
      preview.diff = {
        operation: "delete",
        section: sectionName,
        removedContent: raw.slice(target.start, target.end),
        replacement: "",
      };
    }
  }
  return preview;
}

function buildCurrentSectionsSorted(raw: string) {
  return getProjectMdCurrentSections(raw);
}

function buildProjectedSectionsSorted(rendered: string) {
  return getProjectMdCurrentSections(rendered);
}

/**
 * 將更新後的 sections 重新組合成完整 project.md 內容。
 *
 * 結構：frontmatter + preamble (含 H1 標題) + 各 section（`## name\n\ncontent`）。
 */
function renderProjectMarkdown(input: {
  frontmatter: string | null;
  preamble: string;
  sections: ParsedSection[];
}): string {
  const lines: string[] = [];
  if (input.frontmatter !== null) {
    lines.push("---");
    lines.push(input.frontmatter);
    lines.push("---");
    lines.push("");
  }
  if (input.preamble) {
    lines.push(input.preamble);
    lines.push("");
  }
  for (const s of input.sections) {
    lines.push(`## ${s.name}`);
    lines.push("");
    if (s.content) {
      lines.push(s.content);
    }
  }
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

const ProjectMemoryReadInput = z.object({
  mode: z.enum(["digest", "full", "section"]).optional(),
  section: z.string().optional(),
});

const ProjectMemoryUpdateInput = z.object({
  section: z.string(),
  content: z.string().optional(),
  op: z.enum(["replace", "append", "delete"]).optional(),
  mode: z.enum(["preview", "apply"]).optional(),
  expectedSha256: z.string().optional(),
  maxChars: z.number().optional(),
});

const ProjectMemoryRewriteInput = z.object({
  body: z.string(),
  mode: z.enum(["preview", "apply"]).optional(),
  expectedSha256: z.string().optional(),
});

export interface ProjectMemoryToolset {
  "project-memory-read": DefinedTool;
  "project-memory-update": DefinedTool;
  "project-memory-rewrite": DefinedTool;
}

/**
 * 建立 project-memory 三工具；根目錄由呼叫端解析傳入。
 *
 * 與舊版 `createProjectMemoryTools({ runtime })` 的差異只有接線層：
 * runtime.getPaths 改為呼叫端解析好的工作階段位置＋本地路徑表，
 * 其餘交易語意、錯誤碼、訊息逐字一致。
 */
export function createProjectMemoryTools(resolveRoot: MemoryRootResolver): ProjectMemoryToolset {
  // ─── project-memory-read ─────────────────────────────────────────
  const project_memory_read = defineTool({
    name: "project-memory-read",
    description:
      "讀取 .ultrawork/project.md。mode：'digest'（frontmatter + 標題清單 + 每個段落開頭 200 字，預設）、'full'（整份內容）、'section'（單一段落的內文，需要一併給 'section' 參數）。",
    inputSchema: ProjectMemoryReadInput,
    execute: async ({ mode, section }, toolCtx) => {
      const effectiveMode: ProjectMemoryReadMode = mode ?? "digest";
      const root = await resolveRoot(toolCtx);
      const { projectMd: PROJECT_MD } = getMemoryPaths(root);
      assertSafeMemoryPath(root, PROJECT_MD);
      const requestedSection = section ?? "";

      if (effectiveMode === "section" && /[\r\n]/.test(requestedSection)) {
        return jsonResult({
          ok: false,
          code: "INVALID_SECTION_NAME",
          error: "section 必須是一行值，不可包含 carriage return 或 newline。",
        }, null, 2);
      }

      const raw = readProjectMemoryFile(PROJECT_MD);
      if (raw === null) {
        return jsonResult({
          ok: false,
          code: "PROJECT_MD_NOT_FOUND",
          error: `找不到 project.md（${PROJECT_MD}）。先用 workflow_bootstrap 的 mode='minimal' 跑一次，觸發 lazyEnsure。`,
        }, null, 2);
      }

      const totalSize = raw.length;
      const fileSha256 = sha256(raw);
      const parsed = parseProjectSections(raw);

      if (effectiveMode === "full") {
        return jsonResult({
          ok: true,
          mode: "full",
          path: PROJECT_MD,
          totalSize,
          content: raw,
          fileSha256,
          currentSha256: fileSha256,
        }, null, 2);
      }

      if (effectiveMode === "section") {
        const target = requestedSection.trim();
        if (!target) {
          return jsonResult({
            ok: false,
            code: "SECTION_REQUIRED",
            error: "mode='section' requires non-empty 'section' arg.",
            availableSections: parsed.sections.map((s) => s.name),
          }, null, 2);
        }
        const match = parsed.sections.find((s) => s.name === target);
        if (!match) {
          return jsonResult({
            ok: false,
            code: "SECTION_NOT_FOUND",
            error: `project.md 裡找不到「${target}」這個段落。`,
            availableSections: parsed.sections.map((s) => s.name),
          }, null, 2);
        }
        return jsonResult({
          ok: true,
          mode: "section",
          path: PROJECT_MD,
          totalSize,
          section: match.name,
          level: match.level,
          content: match.content,
          fileSha256,
          currentSha256: fileSha256,
        }, null, 2);
      }

      // digest mode
      const DIGEST_PREVIEW = 200;
      const sectionDigests = parsed.sections.map((s) => ({
        name: s.name,
        level: s.level,
        size: s.content.length,
        preview: s.content.length > DIGEST_PREVIEW
          ? s.content.slice(0, DIGEST_PREVIEW) + "..."
          : s.content,
      }));
      return jsonResult({
        ok: true,
        mode: "digest",
        path: PROJECT_MD,
        totalSize,
        frontmatter: parsed.frontmatter,
        preamble: parsed.preamble,
        sections: sectionDigests,
        availableSections: parsed.sections.map((s) => s.name),
        fileSha256,
        currentSha256: fileSha256,
        hint: "Use mode='section' with one of availableSections to fetch a specific section body; use mode='full' for entire content.",
      }, null, 2);
    },
  });

  // ─── project-memory-update ─────────────────────────────────────────
  const project_memory_update = defineTool({
    name: "project-memory-update",
    description:
      "更新 .ultrawork/project.md 裡的一個段落（支援 replace/append/delete 與 preview/apply 交易）。frontmatter 和其他段落保留原樣。preview 不寫檔；apply 需要 fresh expectedSha256 並在與 rewrite 共用的寫入鎖內核對後才原子寫入。delete 不需 content，但 replace/append 缺 content 要回 CONTENT_REQUIRED；找不到 section 的 delete 回 SECTION_NOT_FOUND。",
    inputSchema: ProjectMemoryUpdateInput,
    execute: async ({ section, content, op, mode, expectedSha256, maxChars }, toolCtx) => {
      const effectiveOp: ProjectMemoryUpdateOp = op ?? "replace";
      const effectiveMode: ProjectMemoryUpdateMode = mode ?? "preview";
      const requestedSection = section ?? "";
      const sectionName = requestedSection.trim();

      if (/[\r\n]/.test(requestedSection)) {
        return jsonResult({
          ok: false,
          code: "INVALID_SECTION_NAME",
          error: "section 必須是一行值，不可包含 carriage return 或 newline。",
        }, null, 2);
      }
      if (!sectionName) {
        return jsonResult({
          ok: false,
          code: "SECTION_REQUIRED",
          error: "需要 section 參數，而且必須是一個非空的 H2 標題名稱。",
        }, null, 2);
      }
      // 相容 maxChars：必須是正整數且不能超過 hard limit；實際 write limit = min(policy effective, maxChars)
      if (maxChars !== undefined) {
        if (!Number.isInteger(maxChars) || maxChars <= 0) {
          return jsonResult({
            ok: false,
            code: "INVALID_MAX_CHARS",
            error: "maxChars must be a positive integer.",
          }, null, 2);
        }
        if (maxChars > PROJECT_MD_HARD_LIMIT) {
          return jsonResult({
            ok: false,
            code: "INVALID_MAX_CHARS",
            error: `maxChars cannot exceed the project.md hard limit (${PROJECT_MD_HARD_LIMIT}).`,
            maxChars,
            hardLimit: PROJECT_MD_HARD_LIMIT,
          }, null, 2);
        }
      }
      if (effectiveOp !== "delete" && content === undefined) {
        return jsonResult({
          ok: false,
          code: "CONTENT_REQUIRED",
          error: "op 為 replace/append 時需要 content。",
        }, null, 2);
      }

      const root = await resolveRoot(toolCtx);
      const { projectMd: PROJECT_MD, memoryDir: MEMORY_DIR } = getMemoryPaths(root);
      assertSafeMemoryPath(root, PROJECT_MD);
      const lockPath = join(MEMORY_DIR, PROJECT_MEMORY_LOCK);
      assertSafeMemoryPath(root, lockPath);

      const buildRendered = (raw: string): string | { code: string; error: string } => {
        const parsed = parseProjectSections(raw);
        if (effectiveOp === "delete") {
          const target = findProjectSectionSpans(raw).find((s) => s.name === sectionName);
          if (!target) {
            return { code: "SECTION_NOT_FOUND", error: `project.md 裡找不到「${sectionName}」這個段落。` };
          }
          return raw.slice(0, target.start) + raw.slice(target.end);
        }
        // replace / append
        let target = parsed.sections.find((s) => s.name === sectionName);
        const isNew = !target;
        if (!target) {
          target = { name: sectionName, level: 2, content: "", lineStart: -1 };
          parsed.sections.push(target);
        }
        const prevBody = isNew ? "" : target.content;
        const newBody = content ?? "";
        const nextBody = effectiveOp === "replace"
          ? newBody
          : (prevBody ? prevBody + "\n" + newBody : newBody);
        target.content = nextBody;
        return renderProjectMarkdown(parsed);
      };

      // ── preview（不寫、不取 lock、不觸發 lazyEnsure）──
      if (effectiveMode === "preview") {
        const raw = readProjectMemoryFile(PROJECT_MD);
        if (raw === null) {
          return jsonResult({
            ok: false,
            code: "PROJECT_MD_NOT_FOUND",
            error: `project.md not found at ${PROJECT_MD}. Run workflow_bootstrap with mode='minimal' first.`,
          }, null, 2);
        }
        const currentSha256 = sha256(raw);
        if (splitFrontmatter(raw).frontmatter === null) {
          return jsonResult({
            ok: false,
            code: "PROJECT_MD_FRONTMATTER_REQUIRED",
            error: "project.md 沒有有效的 frontmatter 區塊，無法在保留固定格式的前提下更新。",
            currentSha256,
          }, null, 2);
        }
        const policy = resolveProjectMdPolicyFromContent(raw);
        if (!policy.isValid) {
          return jsonResult({
            ok: false,
            code: "CONFIGURATION_ERROR",
            error: policy.configurationError,
            currentSha256,
            hardLimit: policy.hardLimit,
            effectiveLimit: policy.effectiveLimit,
            rawLimit: policy.rawLimit,
          }, null, 2);
        }
        const effectiveLimit = maxChars !== undefined ? Math.min(policy.effectiveLimit, maxChars) : policy.effectiveLimit;
        const renderedOrErr = buildRendered(raw);
        if (typeof renderedOrErr !== "string") {
          return jsonResult({
            ok: false,
            code: renderedOrErr.code,
            error: renderedOrErr.error,
            availableSections: parseProjectSections(raw).sections.map((s) => s.name),
            currentSha256,
          }, null, 2);
        }
        const rendered = renderedOrErr;
        const proposedSha256 = sha256(rendered);
        const changed = rendered !== raw;
        const preview = buildProjectMemoryPreview(raw, rendered, effectiveOp, sectionName, effectiveLimit);
        if (rendered.length > effectiveLimit) {
          const over_by = rendered.length - effectiveLimit;
          const current_sections = buildCurrentSectionsSorted(raw);
          const hint = getProjectMdOverLimitHint(effectiveLimit, over_by, current_sections);
          return jsonResult({
            ok: false,
            code: "PROJECT_MD_OVER_LIMIT",
            error: `project.md would exceed limit after update (${rendered.length} > ${effectiveLimit}). Update rejected without writing.`,
            current_size: raw.length,
            projected_size: rendered.length,
            limit: effectiveLimit,
            effectiveLimit,
            hardLimit: policy.hardLimit,
            over_by,
            current_sections,
            hint,
            section: sectionName,
            op: effectiveOp,
            currentSha256,
            proposedSha256,
            ...preview,
          }, null, 2);
        }
        return jsonResult({
          ok: true,
          mode: "preview",
          op: effectiveOp,
          path: PROJECT_MD,
          section: sectionName,
          changed,
          ...preview,
          currentSha256,
          proposedSha256,
          current_size: raw.length,
          projected_size: rendered.length,
          limit: effectiveLimit,
          effectiveLimit,
          hardLimit: policy.hardLimit,
          hint: `帶 expectedSha256:"${currentSha256}" 與 mode:"apply" 寫入。`,
        }, null, 2);
      }

      // ── apply ──
      if (!expectedSha256) {
        const raw = readProjectMemoryFile(PROJECT_MD);
        if (raw === null) {
          return jsonResult({
            ok: false,
            code: "PROJECT_MD_NOT_FOUND",
            error: `project.md not found at ${PROJECT_MD}. Run workflow_bootstrap with mode='minimal' first.`,
          }, null, 2);
        }
        const currentSha256 = sha256(raw);
        if (splitFrontmatter(raw).frontmatter === null) {
          return jsonResult({
            ok: false,
            code: "PROJECT_MD_FRONTMATTER_REQUIRED",
            error: "project.md 沒有有效的 frontmatter 區塊，無法在保留固定格式的前提下更新。",
            currentSha256,
          }, null, 2);
        }
        return jsonResult({
          ok: false,
          code: "EXPECTED_SHA256_REQUIRED",
          error: "mode='apply' requires expectedSha256 from a fresh preview/read to prevent lost updates.",
          currentSha256,
        }, null, 2);
      }

      try {
        return await withContentWriteLock<string>(lockPath, async (): Promise<string> => {
          assertSafeMemoryPath(root, lockPath);
          const raw = readProjectMemoryFile(PROJECT_MD);
          if (raw === null) {
            return jsonResult({
              ok: false,
              code: "PROJECT_MD_NOT_FOUND",
              error: `project.md not found at ${PROJECT_MD}. Run workflow_bootstrap with mode='minimal' first.`,
            }, null, 2);
          }
          const currentSha256 = sha256(raw);
          if (splitFrontmatter(raw).frontmatter === null) {
            return jsonResult({
              ok: false,
              code: "PROJECT_MD_FRONTMATTER_REQUIRED",
              error: "project.md 沒有有效的 frontmatter 區塊，無法在保留固定格式的前提下更新。",
              currentSha256,
            }, null, 2);
          }
          if (expectedSha256 !== currentSha256) {
            return jsonResult({
              ok: false,
              code: "PROJECT_MD_HASH_CONFLICT",
              error: "project.md changed since preview. Fetch the current hash and review the proposed update again.",
              expectedSha256,
              currentSha256,
            }, null, 2);
          }

          const renderedOrErr = buildRendered(raw);
          if (typeof renderedOrErr !== "string") {
            return jsonResult({
              ok: false,
              code: renderedOrErr.code,
              error: renderedOrErr.error,
              availableSections: parseProjectSections(raw).sections.map((s) => s.name),
              currentSha256,
            }, null, 2);
          }
          const rendered = renderedOrErr;
          const proposedSha256 = sha256(rendered);
          // policy 在鎖內重算，確保 frontmatter 無效或收緊即時生效
          const lockPolicy = resolveProjectMdPolicyFromContent(raw);
          if (!lockPolicy.isValid) {
            return jsonResult({
              ok: false,
              code: "CONFIGURATION_ERROR",
              error: lockPolicy.configurationError,
              currentSha256,
              hardLimit: lockPolicy.hardLimit,
              effectiveLimit: lockPolicy.effectiveLimit,
              rawLimit: lockPolicy.rawLimit,
            }, null, 2);
          }
          const effectiveLimit = maxChars !== undefined ? Math.min(lockPolicy.effectiveLimit, maxChars) : lockPolicy.effectiveLimit;
          if (rendered.length > effectiveLimit) {
            const over_by = rendered.length - effectiveLimit;
            const current_sections = buildCurrentSectionsSorted(raw);
            const hint = getProjectMdOverLimitHint(effectiveLimit, over_by, current_sections);
            return jsonResult({
              ok: false,
              code: "PROJECT_MD_OVER_LIMIT",
              error: `project.md would exceed limit after update (${rendered.length} > ${effectiveLimit}). Update rejected without writing.`,
              current_size: raw.length,
              projected_size: rendered.length,
              limit: effectiveLimit,
              effectiveLimit,
              hardLimit: lockPolicy.hardLimit,
              over_by,
              current_sections,
              hint,
              section: sectionName,
              op: effectiveOp,
              currentSha256,
              proposedSha256,
            }, null, 2);
          }

          const changed = rendered !== raw;
          if (changed) {
            // re-read TOCTOU 檢查（鎖內二次讀）
            const latestRaw = readProjectMemoryFile(PROJECT_MD);
            if (latestRaw === null) {
              return jsonResult({
                ok: false,
                code: "PROJECT_MD_NOT_FOUND",
                error: `project.md not found at ${PROJECT_MD}. Run workflow_bootstrap with mode='minimal' first.`,
              }, null, 2);
            }
            const latestSha = sha256(latestRaw);
            if (latestSha !== currentSha256) {
              return jsonResult({
                ok: false,
                code: "PROJECT_MD_HASH_CONFLICT",
                error: "project.md changed immediately before the atomic write. No write was performed.",
                expectedSha256,
                currentSha256: latestSha,
                proposedSha256,
              }, null, 2);
            }
            projectMemoryFileOps.write(PROJECT_MD, rendered);
          }

          return jsonResult({
            ok: true,
            mode: "apply",
            op: effectiveOp,
            path: PROJECT_MD,
            section: sectionName,
            applied: changed,
            changed,
            previous_size: raw.length,
            new_size: rendered.length,
            limit: effectiveLimit,
            effectiveLimit,
            hardLimit: lockPolicy.hardLimit,
            currentSha256,
            proposedSha256,
            hint: changed
              ? "project-memory-update applied atomically under lock."
              : "No write needed; rendered content is unchanged.",
          }, null, 2);
        });
      } catch (err) {
        if (err instanceof ContentLockBusyError) {
          return jsonResult({ ok: false, code: err.code, error: err.message, heldByPid: err.heldByPid, ageSeconds: err.ageSeconds }, null, 2);
        }
        throw err;
      }
    },
  });

  // ─── project-memory-rewrite ────────────────────────────────────────
  const project_memory_rewrite = defineTool({
    name: "project-memory-rewrite",
    description:
      `預覽或整份替換 .ultrawork/project.md 的內文，frontmatter 保留原樣，寫入是原子操作。預設 preview。apply 需要 expectedSha256，並強制 ${PROJECT_MD_HARD_LIMIT} 字上限和 H2 標題不重複。`,
    inputSchema: ProjectMemoryRewriteInput,
    execute: async ({ body, mode, expectedSha256 }, toolCtx) => {
      const effectiveMode: ProjectMemoryRewriteMode = mode ?? "preview";
      const root = await resolveRoot(toolCtx);
      const { projectMd: PROJECT_MD, memoryDir: MEMORY_DIR } = getMemoryPaths(root);
      assertSafeMemoryPath(root, PROJECT_MD);
      const lockPath = join(MEMORY_DIR, PROJECT_MEMORY_LOCK);
      assertSafeMemoryPath(root, lockPath);
      const raw = readProjectMemoryFile(PROJECT_MD);
      if (raw === null) {
        return jsonResult({
          ok: false,
          code: "PROJECT_MD_NOT_FOUND",
          error: `project.md not found at ${PROJECT_MD}. Run workflow_bootstrap with mode='minimal' first.`,
        }, null, 2);
      }

      const currentDocument = splitFrontmatter(raw);
      if (currentDocument.frontmatter === null) {
        return jsonResult({
          ok: false,
          code: "PROJECT_MD_FRONTMATTER_REQUIRED",
          error: "project.md 沒有有效的 frontmatter 區塊，無法在保留固定格式的前提下重寫。",
        }, null, 2);
      }

      const proposedBody = normalizeNewline(body ?? "").replace(/^\s+/, "");
      if (!proposedBody || proposedBody.startsWith("---\n") || !hasNonFenceH1(proposedBody)) {
        return jsonResult({
          ok: false,
          code: "PROJECT_MD_BODY_INVALID",
          error: "body 必須是純內文的 Markdown，而且要有一個非空的 H1 標題；body 裡不接受 frontmatter。",
        }, null, 2);
      }

      const duplicates = duplicateH2Headings(proposedBody);
      if (duplicates.length > 0) {
        return jsonResult({
          ok: false,
          code: "DUPLICATE_H2_HEADINGS",
          error: "要寫入的 project.md body 裡有重複的 H2 標題。",
          duplicateHeadings: duplicates,
        }, null, 2);
      }

      const currentSha256 = sha256(raw);
      const policy = resolveProjectMdPolicyFromContent(raw);
      if (!policy.isValid) {
        return jsonResult({
          ok: false,
          code: "CONFIGURATION_ERROR",
          error: policy.configurationError,
          currentSha256,
          hardLimit: policy.hardLimit,
          effectiveLimit: policy.effectiveLimit,
          rawLimit: policy.rawLimit,
        }, null, 2);
      }
      const effectiveLimit = policy.effectiveLimit;
      const rendered = renderProjectRewrite(raw, proposedBody);
      const proposedSha256 = sha256(rendered);
      if (rendered.length > effectiveLimit) {
        const over_by = rendered.length - effectiveLimit;
        const current_sections = buildCurrentSectionsSorted(raw);
        const projected_sections = buildProjectedSectionsSorted(rendered);
        const hint = getProjectMdOverLimitHint(effectiveLimit, over_by, current_sections);
        return jsonResult({
          ok: false,
          code: "PROJECT_MD_OVER_LIMIT",
          error: `project.md would exceed the hard limit after rewrite (${rendered.length} > ${effectiveLimit}). Rewrite rejected without writing.`,
          current_size: raw.length,
          projected_size: rendered.length,
          limit: effectiveLimit,
          effectiveLimit,
          hardLimit: policy.hardLimit,
          over_by,
          current_sections,
          projected_sections,
          hint,
          currentSha256,
          proposedSha256,
        }, null, 2);
      }

      const changed = rendered !== raw;
      if (effectiveMode === "preview") {
        const current_sections = buildCurrentSectionsSorted(raw);
        const projected_sections = buildProjectedSectionsSorted(rendered);
        return jsonResult({
          ok: true,
          path: PROJECT_MD,
          mode: "preview",
          applied: false,
          changed,
          current_size: raw.length,
          projected_size: rendered.length,
          limit: effectiveLimit,
          effectiveLimit,
          hardLimit: policy.hardLimit,
          current_sections,
          projected_sections,
          currentSha256,
          proposedSha256,
          proposedContent: changed && rendered.length <= effectiveLimit ? rendered : undefined,
          hint: "Preview only; pass currentSha256 as expectedSha256 with mode='apply' after reviewing the proposed body.",
        }, null, 2);
      }

      // apply path — requires lock & fresh SHA
      if (!expectedSha256) {
        return jsonResult({
          ok: false,
          code: "EXPECTED_SHA256_REQUIRED",
          error: "mode='apply' requires expectedSha256 from a fresh preview/read to prevent lost updates.",
          currentSha256,
          proposedSha256,
        }, null, 2);
      }
      if (expectedSha256 !== currentSha256) {
        return jsonResult({
          ok: false,
          code: "PROJECT_MD_HASH_CONFLICT",
          error: "project.md changed since preview. Fetch the current hash and review the proposed rewrite again.",
          expectedSha256,
          currentSha256,
          proposedSha256,
        }, null, 2);
      }

      try {
        return await withContentWriteLock<string>(lockPath, async (): Promise<string> => {
          assertSafeMemoryPath(root, lockPath);
          const latestRaw = readProjectMemoryFile(PROJECT_MD);
          if (latestRaw === null) {
            return jsonResult({
              ok: false,
              code: "PROJECT_MD_NOT_FOUND",
              error: "project.md disappeared while holding the project-memory write lock. No write was performed.",
              currentSha256,
              proposedSha256,
            }, null, 2);
          }
          const latestSha256 = sha256(latestRaw);
          if (latestSha256 !== currentSha256) {
            return jsonResult({
              ok: false,
              code: "PROJECT_MD_HASH_CONFLICT",
              error: "project.md changed immediately before the atomic write. No write was performed.",
              expectedSha256,
              currentSha256: latestSha256,
              proposedSha256,
            }, null, 2);
          }
          // re-validate frontmatter inside lock (avoid TOCTOU on missing frontmatter)
          const latestDoc = splitFrontmatter(latestRaw);
          if (latestDoc.frontmatter === null) {
            return jsonResult({
              ok: false,
              code: "PROJECT_MD_FRONTMATTER_REQUIRED",
              error: "project.md 沒有有效的 frontmatter 區塊，無法在保留固定格式的前提下重寫。",
            }, null, 2);
          }
          const latestPolicy = resolveProjectMdPolicyFromContent(latestRaw);
          if (!latestPolicy.isValid) {
            return jsonResult({
              ok: false,
              code: "CONFIGURATION_ERROR",
              error: latestPolicy.configurationError,
              currentSha256: latestSha256,
              hardLimit: latestPolicy.hardLimit,
              effectiveLimit: latestPolicy.effectiveLimit,
              rawLimit: latestPolicy.rawLimit,
            }, null, 2);
          }
          const latestEffectiveLimit = latestPolicy.effectiveLimit;
          const latestRendered = renderProjectRewrite(latestRaw, proposedBody);
          const latestProposedSha256 = sha256(latestRendered);
          // re-check duplicate & limit inside lock with latest raw (body same)
          if (latestRendered.length > latestEffectiveLimit) {
            const over_by = latestRendered.length - latestEffectiveLimit;
            const current_sections = buildCurrentSectionsSorted(latestRaw);
            const projected_sections = buildProjectedSectionsSorted(latestRendered);
            const hint = getProjectMdOverLimitHint(latestEffectiveLimit, over_by, current_sections);
            return jsonResult({
              ok: false,
              code: "PROJECT_MD_OVER_LIMIT",
              error: `project.md would exceed the hard limit after rewrite (${latestRendered.length} > ${latestEffectiveLimit}). Rewrite rejected without writing.`,
              current_size: latestRaw.length,
              projected_size: latestRendered.length,
              limit: latestEffectiveLimit,
              effectiveLimit: latestEffectiveLimit,
              hardLimit: latestPolicy.hardLimit,
              over_by,
              current_sections,
              projected_sections,
              hint,
              currentSha256: latestSha256,
              proposedSha256: latestProposedSha256,
            }, null, 2);
          }
          const latestChanged = latestRendered !== latestRaw;
          let applied = false;
          if (latestChanged) {
            const guardedRaw = readProjectMemoryFile(PROJECT_MD);
            if (guardedRaw === null) {
              return jsonResult({
                ok: false,
                code: "PROJECT_MD_NOT_FOUND",
                error: "project.md disappeared immediately before the atomic write. No write was performed.",
                currentSha256: latestSha256,
                proposedSha256: latestProposedSha256,
              }, null, 2);
            }
            const guardedSha256 = sha256(guardedRaw);
            if (guardedSha256 !== latestSha256) {
              return jsonResult({
                ok: false,
                code: "PROJECT_MD_HASH_CONFLICT",
                error: "project.md changed immediately before the atomic write. No write was performed.",
                currentSha256: guardedSha256,
                proposedSha256: latestProposedSha256,
              }, null, 2);
            }
            projectMemoryFileOps.write(PROJECT_MD, latestRendered);
            applied = true;
          }
          return jsonResult({
            ok: true,
            path: PROJECT_MD,
            mode: "apply",
            applied,
            changed: latestChanged,
            current_size: latestRaw.length,
            projected_size: latestRendered.length,
            limit: latestEffectiveLimit,
            effectiveLimit: latestEffectiveLimit,
            hardLimit: latestPolicy.hardLimit,
            currentSha256: latestSha256,
            proposedSha256: latestProposedSha256,
            hint: applied
              ? "The complete body was atomically replaced; existing frontmatter was preserved."
              : "No write was needed because the rendered project.md is unchanged.",
          }, null, 2);
        });
      } catch (err) {
        if (err instanceof ContentLockBusyError) {
          return jsonResult({ ok: false, code: err.code, error: err.message, heldByPid: err.heldByPid, ageSeconds: err.ageSeconds }, null, 2);
        }
        throw err;
      }
    },
  });

  return {
    "project-memory-read": project_memory_read,
    "project-memory-update": project_memory_update,
    "project-memory-rewrite": project_memory_rewrite,
  };
}
