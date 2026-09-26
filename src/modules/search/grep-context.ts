/**
 * grep_context：在 worktree 內搜尋文字，回傳有界、可分頁的結構化結果。
 *
 * 搜尋執行檔、參數、TOCTOU 防護、錯誤碼、訊息與舊外掛 grep-context 逐字一致；
 * 根目錄改由呼叫端解析好的字串傳入，不再讀執行期 context。
 */

import { spawn } from "node:child_process";
import { createReadStream, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { defineTool, type DefinedTool, type ToolExecutionContext } from "../../kit/define-tool.ts";
import { jsonError, jsonResult } from "../../kit/json.ts";
import { formatNumberedLines, truncateLine } from "../../kit/lines.ts";
import { assertSafeWorktreePath } from "../../kit/path-guard.ts";
import {
  isBinaryFile,
  isSensitivePath,
  normalizeRelativePath,
  resolveReadableTarget,
  validateBoundedInteger,
  type RootResolver,
} from "./search-utils.ts";

type SearchMode = "regex" | "literal";
interface ContextLine { line: number; text: string }
interface SearchMatch {
  file: string;
  line: number;
  column: number;
  text: string;
  before: ContextLine[];
  after: ContextLine[];
}

const DEFAULT_EXCLUDES = [
  "!node_modules/**", "!dist/**", "!build/**", "!.git/**", "!.next/**",
  "!.env", "!*.pem", "!*.key", "!*.p12", "!*.pfx",
  "!id_rsa", "!id_ed25519", "!credentials.json", "!service-account.json",
];

const GrepContextInput = z.object({
  pattern: z.string(),
  target: z.string().optional(),
  mode: z.enum(["regex", "literal"]).optional(),
  context: z.number().optional(),
  maxMatches: z.number().optional(),
  maxChars: z.number().optional(),
  offset: z.number().optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  caseSensitive: z.boolean().optional(),
});

export function createGrepContextTool(resolveRoot: RootResolver): DefinedTool {
  return defineTool({
    name: "grep_context",
    description: "在 worktree 內搜尋文字，回傳有界、可分頁且帶行號的結構化結果",
    inputSchema: GrepContextInput,
    execute: async (args, toolCtx: ToolExecutionContext) => {
      const searchContext = args.context ?? 3;
      const maxMatches = args.maxMatches ?? 20;
      const maxChars = args.maxChars ?? 12_000;
      const offset = args.offset ?? 0;
      const contextError = validateBoundedInteger(searchContext, 0, 10, "context");
      if (contextError) return jsonError("INVALID_CONTEXT", contextError);
      const matchError = validateBoundedInteger(maxMatches, 1, 100, "maxMatches");
      if (matchError) return jsonError("INVALID_MAX_MATCHES", matchError);
      const budgetError = validateBoundedInteger(maxChars, 1000, 30_000, "maxChars");
      if (budgetError) return jsonError("INVALID_MAX_CHARS", budgetError);
      const offsetError = validateBoundedInteger(offset, 0, Number.MAX_SAFE_INTEGER, "offset");
      if (offsetError) return jsonError("INVALID_OFFSET", offsetError);
      if (!args.pattern) return jsonError("EMPTY_PATTERN", "pattern must not be empty");
      if ((args.include?.length ?? 0) > 20 || (args.exclude?.length ?? 0) > 20) {
        return jsonError("TOO_MANY_GLOBS", "include and exclude accept at most 20 entries each");
      }

      const resolution = resolveReadableTarget(args.target ?? ".", await resolveRoot(toolCtx));
      if (!resolution.ok) return resolution.result;
      const target = resolution.target;
      if (!target.isDirectory) {
        let binary: boolean;
        try {
          binary = isBinaryFile(target.absolutePath);
        } catch {
          return jsonError("FILE_READ_ERROR", `Cannot read file: ${target.relativePath}`);
        }
        if (binary) {
          return jsonError("BINARY_FILE", `Refusing to search binary file: ${target.relativePath}`);
        }
      }

      const mode: SearchMode = args.mode ?? "regex";
      const rgArgs = [
        "--json", "--sort", "path", "--color", "never", "--line-number", "--column",
        "--max-columns", "2000", "--max-columns-preview",
      ];
      if (mode === "literal") rgArgs.push("--fixed-strings");
      if (args.caseSensitive === false) rgArgs.push("--ignore-case");
      for (const glob of DEFAULT_EXCLUDES) rgArgs.push("--glob", glob);
      for (const glob of args.include ?? []) rgArgs.push("--glob", glob);
      for (const glob of args.exclude ?? []) rgArgs.push("--glob", glob.startsWith("!") ? glob : `!${glob}`);
      rgArgs.push("--", args.pattern, target.absolutePath);

      const searched = await collectMatches(rgArgs, target.worktreeRoot, offset, maxMatches, toolCtx.signal);
      if (!searched.ok) return jsonError(searched.code, searched.error);
      const attached = await attachContext(searched.matches, target.worktreeRoot, searchContext);
      if (!attached.ok) return jsonError(attached.code, attached.error);

      const result = {
        ok: true,
        pattern: args.pattern,
        mode,
        target: target.relativePath,
        matches: searched.matches,
        returnedMatches: searched.matches.length,
        truncated: searched.hasMore,
        nextOffset: searched.hasMore ? offset + searched.matches.length : null as number | null,
      };
      fitSearchResult(result, maxChars, offset);
      return renderSearchResult(result);
    },
  });
}

async function collectMatches(
  rgArgs: string[],
  worktreeRoot: string,
  offset: number,
  maxMatches: number,
  abort?: AbortSignal,
): Promise<{ ok: true; matches: SearchMatch[]; hasMore: boolean } | { ok: false; code: string; error: string }> {
  if (abort?.aborted) return { ok: false, code: "ABORTED", error: "Search was aborted" };
  return await new Promise((resolve) => {
    const child = spawn("rg", rgArgs, { cwd: worktreeRoot, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const matches: SearchMatch[] = [];
    let seen = 0;
    let hasMore = false;
    let stdoutBuffer = "";
    let timedOut = false;
    let aborted = false;

    const stop = () => child.kill("SIGTERM");
    const timer = setTimeout(() => { timedOut = true; stop(); }, 10_000);
    const onAbort = () => { aborted = true; stop(); };
    abort?.addEventListener("abort", onAbort, { once: true });

    const consume = (line: string) => {
      if (!line) return;
      try {
        const event = JSON.parse(line);
        if (event.type !== "match") return;
        const data = event.data;
        const rawPath = data.path?.text ?? "";
        // 敏感／外部 match 先過濾：不進結果、不消耗 offset 槽位，分頁才不會
        // 因被過濾的 match 而重複或跳過。
        const resolved = resolveMatchPath(rawPath, worktreeRoot);
        if (!resolved.ok) return;
        if (seen < offset) { seen += 1; return; }
        if (matches.length >= maxMatches) { hasMore = true; stop(); return; }
        seen += 1;
        const rawText = String(data.lines?.text ?? "").replace(/\r?\n$/, "");
        matches.push({
          file: resolved.relativePath,
          line: Number(data.line_number ?? 0),
          column: Number(data.submatches?.[0]?.start ?? 0) + 1,
          text: truncateLine(rawText),
          before: [],
          after: [],
        });
      } catch {
        return;
      }
    };

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    });
    child.stderr.resume();
    child.on("error", (error) => {
      clearTimeout(timer);
      abort?.removeEventListener("abort", onAbort);
      resolve({ ok: false, code: "RG_UNAVAILABLE", error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      abort?.removeEventListener("abort", onAbort);
      consume(stdoutBuffer);
      if (aborted) return resolve({ ok: false, code: "ABORTED", error: "Search was aborted" });
      if (timedOut) return resolve({ ok: false, code: "SEARCH_TIMEOUT", error: "Search exceeded 10 seconds" });
      if (code !== 0 && code !== 1 && !hasMore) {
        // 不回傳 stderr：ripgrep 錯誤訊息可能含絕對路徑，只保留 numeric exit code。
        return resolve({ ok: false, code: "RG_ERROR", error: `ripgrep failed with exit code ${code}` });
      }
      resolve({ ok: true, matches, hasMore });
    });
  });
}

/**
 * 將 ripgrep 回報的 match path 轉成 project-relative 路徑。
 * - 先 canonical realpath（absolute 或相對於 cwd 的 path 都處理）。
 * - 以 canonical containment 確認 match 真的在 root 內，不能用字串 prefix
 *   判斷（root 名稱共同前綴如 `/tmp/project` 與 `/tmp/project-old` 會誤判）。
 * - 敏感路徑的 match 一律丟棄，不進結果或 context attachment。
 * 任一步失敗（檔案被刪除、symlink escape、sensitive）都回傳 `{ ok: false }`，
 * 由 caller 跳過該 match；此處不 reject，避免 tool Promise 未處理。
 */
function resolveMatchPath(rawPath: string, worktreeRoot: string): { ok: true; relativePath: string } | { ok: false } {
  if (!rawPath) return { ok: false };
  const absolute = isAbsolute(rawPath) ? rawPath : join(worktreeRoot, rawPath);
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    return { ok: false };
  }
  try {
    assertSafeWorktreePath(canonical, worktreeRoot);
  } catch {
    return { ok: false };
  }
  const relativePath = normalizeRelativePath(relative(worktreeRoot, canonical));
  if (isSensitivePath(relativePath)) return { ok: false };
  return { ok: true, relativePath };
}

/**
 * attachContext 讀取前重新 canonical 化並確認 containment 與敏感路徑。
 * rg 回報 match 後到讀取 context 之間，檔案可能被刪除、換成指向外部
 * 的 symlink，或換成 root 內的 sensitive 檔案（TOCTOU）；realpath 失敗、
 * 超出 root 或 canonical target 為 sensitive 都回傳 `{ ok: false }`，
 * 由 caller 回傳結構化 read error，不讀取外部或敏感內容。
 */
export function resolveAttachFile(file: string, worktreeRoot: string): { ok: true; absolutePath: string } | { ok: false } {
  let canonical: string;
  try {
    canonical = realpathSync(join(worktreeRoot, file));
    assertSafeWorktreePath(canonical, worktreeRoot);
  } catch {
    return { ok: false };
  }
  const relativePath = normalizeRelativePath(relative(worktreeRoot, canonical));
  if (isSensitivePath(relativePath)) return { ok: false };
  return { ok: true, absolutePath: canonical };
}

async function attachContext(
  matches: SearchMatch[],
  worktreeRoot: string,
  context: number,
): Promise<{ ok: true } | { ok: false; code: string; error: string }> {
  if (context === 0 || matches.length === 0) return { ok: true };
  const byFile = new Map<string, SearchMatch[]>();
  for (const match of matches) byFile.set(match.file, [...(byFile.get(match.file) ?? []), match]);

  for (const [file, fileMatches] of byFile) {
    const wanted = new Set<number>();
    for (const match of fileMatches) {
      for (let line = Math.max(1, match.line - context); line <= match.line + context; line += 1) wanted.add(line);
    }
    const resolved = resolveAttachFile(file, worktreeRoot);
    if (!resolved.ok) {
      return { ok: false, code: "FILE_READ_ERROR", error: `Cannot read file: ${file}` };
    }
    const lines = new Map<number, string>();
    let number = 0;
    try {
      const reader = createInterface({ input: createReadStream(resolved.absolutePath, { encoding: "utf-8" }), crlfDelay: Infinity });
      for await (const rawLine of reader) {
        number += 1;
        if (wanted.has(number)) lines.set(number, truncateLine(rawLine));
      }
    } catch {
      return { ok: false, code: "FILE_READ_ERROR", error: `Cannot read file: ${file}` };
    }
    for (const match of fileMatches) {
      for (let line = Math.max(1, match.line - context); line < match.line; line += 1) {
        if (lines.has(line)) match.before.push({ line, text: lines.get(line)! });
      }
      for (let line = match.line + 1; line <= match.line + context; line += 1) {
        if (lines.has(line)) match.after.push({ line, text: lines.get(line)! });
      }
    }
  }
  return { ok: true };
}

type SearchResult = { matches: SearchMatch[]; returnedMatches: number; truncated: boolean; nextOffset: number | null };

/**
 * 輸出時才把每個命中的前後文和命中行合成一段帶行號的文字；截斷仍以實際輸出的長度為準。
 * 命中行標 `:`、前後文標 `-`，所以不必再分成 text／before／after 三個欄位。
 */
function renderSearchResult(result: SearchResult): string {
  return jsonResult({
    ...result,
    matches: result.matches.map(({ file, line, column, text, before, after }) => ({
      file,
      line,
      column,
      lines: [
        formatNumberedLines(before, "-"),
        formatNumberedLines([{ line, text }]),
        formatNumberedLines(after, "-"),
      ].filter(Boolean).join("\n"),
    })),
  });
}

function fitSearchResult(result: SearchResult, maxChars: number, offset: number): void {
  while (renderSearchResult(result).length > maxChars) {
    let reducedContext = false;
    for (let index = result.matches.length - 1; index >= 0; index -= 1) {
      const match = result.matches[index];
      if (match.after.length > 0) {
        match.after.pop();
        reducedContext = true;
        break;
      }
      if (match.before.length > 0) {
        match.before.shift();
        reducedContext = true;
        break;
      }
    }
    if (reducedContext) continue;
    const longText = result.matches.findLast((match) => match.text.length > 160);
    if (longText) {
      longText.text = truncateLine(longText.text, 160);
      continue;
    }
    if (result.matches.length <= 1) break;
    result.matches.pop();
    result.truncated = true;
  }
  result.returnedMatches = result.matches.length;
  result.nextOffset = result.truncated ? offset + result.returnedMatches : null;
}
