/**
 * peek_file：安全地回傳檔案輪廓或有界行區間。
 *
 * 行為、錯誤碼、訊息與舊外掛 peek-file 逐字一致；
 * 根目錄改由呼叫端解析好的字串傳入，不再讀執行期 context。
 */

import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import { defineTool, type DefinedTool, type ToolExecutionContext } from "../../kit/define-tool.ts";
import { jsonError, jsonResult } from "../../kit/json.ts";
import { formatNumberedLines, truncateLine } from "../../kit/lines.ts";
import {
  isBinaryFile,
  resolveReadableTarget,
  validateBoundedInteger,
  type RootResolver,
} from "./search-utils.ts";

type PeekMode = "outline" | "range" | "around" | "head" | "tail";
interface NumberedLine { line: number; text: string }
interface PeekResult {
  ok: true;
  file: string;
  profile: { sizeBytes: number; lineCount: number; mode: PeekMode };
  outline?: NumberedLine[];
  excerpt: { startLine: number; endLine: number; lines: NumberedLine[] };
  truncated: boolean;
  nextStartLine: number | null;
}

const PeekFileInput = z.object({
  file: z.string(),
  mode: z.enum(["outline", "range", "around", "head", "tail"]).optional(),
  startLine: z.number().optional(),
  line: z.number().optional(),
  lineCount: z.number().optional(),
  context: z.number().optional(),
  maxChars: z.number().optional(),
  head: z.number().optional(),
});

export function createPeekFileTool(resolveRoot: RootResolver): DefinedTool {
  return defineTool({
    name: "peek_file",
    description: "安全地回傳檔案輪廓或有界行區間；預設不輸出全文",
    inputSchema: PeekFileInput,
    execute: async (args, toolCtx: ToolExecutionContext) => {
      const resolution = resolveReadableTarget(args.file, await resolveRoot(toolCtx));
      if (!resolution.ok) return resolution.result;
      const target = resolution.target;
      if (target.isDirectory) return jsonError("NOT_A_FILE", `Expected a file: ${target.relativePath}`);
      let binary: boolean;
      try {
        binary = isBinaryFile(target.absolutePath);
      } catch {
        return jsonError("FILE_READ_ERROR", `Cannot read file: ${target.relativePath}`);
      }
      if (binary) return jsonError("BINARY_FILE", `Refusing to read binary file: ${target.relativePath}`);

      const mode: PeekMode = args.mode ?? (args.head === undefined ? "outline" : "head");
      const requestedLineCount = args.lineCount ?? args.head ?? 20;
      const aroundContext = args.context ?? 5;
      const maxChars = args.maxChars ?? 12_000;
      const countError = validateBoundedInteger(requestedLineCount, 1, 200, "lineCount");
      if (countError) return jsonError("INVALID_LINE_COUNT", countError);
      const budgetError = validateBoundedInteger(maxChars, 1000, 30_000, "maxChars");
      if (budgetError) return jsonError("INVALID_MAX_CHARS", budgetError);
      const contextError = validateBoundedInteger(aroundContext, 0, 50, "context");
      if (contextError) return jsonError("INVALID_CONTEXT", contextError);

      let requestedStart = 1;
      let requestedEnd = requestedLineCount;
      if (mode === "range") {
        requestedStart = args.startLine ?? 1;
        const startError = validateBoundedInteger(requestedStart, 1, Number.MAX_SAFE_INTEGER, "startLine");
        if (startError) return jsonError("INVALID_START_LINE", startError);
        requestedEnd = requestedStart + requestedLineCount - 1;
      } else if (mode === "around") {
        const center = args.line ?? 0;
        const lineError = validateBoundedInteger(center, 1, Number.MAX_SAFE_INTEGER, "line");
        if (lineError) return jsonError("INVALID_LINE", lineError);
        requestedStart = Math.max(1, center - aroundContext);
        requestedEnd = center + aroundContext;
      }

      const excerpt: NumberedLine[] = [];
      const outline: NumberedLine[] = [];
      const tail: NumberedLine[] = [];
      let totalLines = 0;
      try {
        const reader = createInterface({ input: createReadStream(target.absolutePath, { encoding: "utf-8" }), crlfDelay: Infinity });
        for await (const rawLine of reader) {
          totalLines += 1;
          const numbered = { line: totalLines, text: truncateLine(rawLine) };
          if (mode === "tail") {
            tail.push(numbered);
            if (tail.length > requestedLineCount) tail.shift();
          } else if (totalLines >= requestedStart && totalLines <= requestedEnd) {
            excerpt.push(numbered);
          }
          if (mode === "outline" && outline.length < 40 && isOutlineLine(rawLine)) {
            outline.push(numbered);
          }
        }
      } catch {
        return jsonError("FILE_READ_ERROR", `Cannot read file: ${target.relativePath}`);
      }
      if (mode === "tail") excerpt.push(...tail);

      const startLine = excerpt[0]?.line ?? Math.min(requestedStart, Math.max(totalLines, 1));
      let sizeBytes: number;
      try {
        sizeBytes = statSync(target.absolutePath).size;
      } catch {
        return jsonError("FILE_READ_ERROR", `Cannot stat file: ${target.relativePath}`);
      }
      const result: PeekResult = {
        ok: true,
        file: target.relativePath,
        profile: { sizeBytes, lineCount: totalLines, mode },
        ...(mode === "outline" ? { outline } : {}),
        excerpt: { startLine, endLine: excerpt.at(-1)?.line ?? startLine, lines: excerpt },
        truncated: (excerpt.at(-1)?.line ?? 0) < totalLines,
        nextStartLine: (excerpt.at(-1)?.line ?? 0) < totalLines ? (excerpt.at(-1)?.line ?? 0) + 1 : null,
      };

      fitPeekResult(result, maxChars);
      return renderPeekResult(result);
    },
  });
}

function isOutlineLine(line: string): boolean {
  return /^\s{0,3}#{1,6}\s+\S/.test(line)
    || /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+[A-Za-z_$]/.test(line);
}

/** 輸出時才把逐行資料排成帶行號的文字；截斷仍以實際輸出的長度為準。 */
function renderPeekResult(result: PeekResult): string {
  const { outline, excerpt, ...rest } = result;
  return jsonResult({
    ...rest,
    ...(outline ? { outline: formatNumberedLines(outline) } : {}),
    excerpt: { ...excerpt, lines: formatNumberedLines(excerpt.lines) },
  });
}

function fitPeekResult(result: PeekResult, maxChars: number): void {
  while (renderPeekResult(result).length > maxChars && (result.outline?.length ?? 0) > 0) result.outline!.pop();
  while (renderPeekResult(result).length > maxChars && result.excerpt.lines.length > 0) {
    result.excerpt.lines.pop();
    result.truncated = true;
  }
  const lastLine = result.excerpt.lines.at(-1)?.line;
  result.excerpt.endLine = lastLine ?? result.excerpt.startLine;
  if (result.truncated) result.nextStartLine = lastLine === undefined ? result.excerpt.startLine : lastLine + 1;
}
