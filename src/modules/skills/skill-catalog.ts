/**
 * 技能清單按需查詢：把 system prompt 的完整清單換成名稱索引，
 * 完整描述改由 `skill_search` 依關鍵字查詢。
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineTool, type DefinedTool, type ToolExecutionContext } from "../../kit/define-tool.ts";
import { queryTerms, containsTerm } from "../../kit/text-search.ts";
import { jsonResult } from "../../kit/json.ts";
import { resolveGlobalConfigDir, resolveGlobalUltraworkDir } from "../../settings/paths.ts";
import { SessionStateStore, type KeyValueStorage, type SessionStateStoreOptions } from "../../state/store.ts";
import { assertSafeGlobalUltraworkPath } from "./containment.ts";

export { queryTerms } from "../../kit/text-search.ts";

const BLOCK_PATTERN = /<available_skills>\n([\s\S]*?)\n<\/available_skills>/;
// V1 的每個技能是 name／description／location；V2 在 name 前面多一個 id、沒有 location。
const ENTRY_PATTERN = /<skill>\s*(?:<id>[\s\S]*?<\/id>\s*)?<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>(?:\s*<location>[\s\S]*?<\/location>)?\s*<\/skill>/g;
/** 原始清單小於這個字元數就不改寫。 */
export const COMPACT_THRESHOLD_CHARS = 6000;
export const MAX_SESSIONS = 500;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const SKILL_CATALOG_KIND = "skill-catalog";

export interface SkillEntry {
  name: string;
  description: string;
}

/** skills-policy.json `searchKeywords` 的一筆：中文和英文各一組。 */
export interface SkillKeywords {
  zh?: string[];
  en?: string[];
}

export type SkillKeywordIndex = Record<string, SkillKeywords>;

export function parseSkillCatalog(text: string): { block: string; skills: SkillEntry[] } | null {
  const match = BLOCK_PATTERN.exec(text);
  if (!match) return null;
  const skills: SkillEntry[] = [];
  for (const entry of match[1]!.matchAll(ENTRY_PATTERN)) {
    const name = entry[1]!.trim();
    if (name) skills.push({ name, description: entry[2]!.trim() });
  }
  return { block: match[0], skills };
}

/** 依名稱第一段分組；只有一個成員的組併進「其他」。 */
export function renderSkillIndex(skills: SkillEntry[]): string {
  const groups = new Map<string, string[]>();
  for (const name of skills.map((skill) => skill.name).sort((a, b) => a.localeCompare(b))) {
    const key = name.split(/[-_:]/)[0] || name;
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  const lines: string[] = [];
  const singles: string[] = [];
  for (const [key, names] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (names.length === 1) singles.push(names[0]!);
    else lines.push(`- ${key}：${names.join(", ")}`);
  }
  if (singles.length) lines.push(`- 其他：${singles.join(", ")}`);
  return [
    "<available_skills_index>",
    `這裡只列技能名稱（共 ${skills.length} 個）。要知道某個技能做什麼、適不適合目前的任務，先用 \`skill_search\` 查，中文或英文關鍵字都可以，它會回傳完整描述；確定需要再用 \`skill\` 工具依名稱載入。角色說明裡直接點名的技能可以不查，直接載入。`,
    ...lines,
    "</available_skills_index>",
  ].join("\n");
}

/** 只要求 text part；其他 part 原樣保留。 */
export interface SkillSystemPart {
  type?: unknown;
  text?: unknown;
  [key: string]: unknown;
}

export interface SkillCatalogStore {
  /** 改寫 system prompt，並記下這個工作階段的完整清單。回傳是否有改寫。 */
  compact(system: SkillSystemPart[], sessionID: string | undefined): Promise<boolean>;
  get(sessionID: string): Promise<SkillEntry[] | undefined>;
}

export function createSkillCatalogStore(
  storage: KeyValueStorage,
  options: SessionStateStoreOptions = {},
): SkillCatalogStore {
  const sessions = new SessionStateStore(storage, {
    maxSessions: options.maxSessions ?? MAX_SESSIONS,
  });

  async function remember(sessionID: string, skills: SkillEntry[]): Promise<void> {
    await sessions.setSession(sessionID, SKILL_CATALOG_KIND, skills);
  }

  return {
    async compact(system, sessionID) {
      for (let index = 0; index < system.length; index += 1) {
        const part = system[index]!;
        if (part.type !== "text" || typeof part.text !== "string") continue;
        const parsed = parseSkillCatalog(part.text);
        if (!parsed || parsed.skills.length === 0) continue;
        if (sessionID) await remember(sessionID, parsed.skills);
        if (parsed.block.length < COMPACT_THRESHOLD_CHARS) return false;
        system[index] = {
          ...part,
          text: part.text.replace(parsed.block, () => renderSkillIndex(parsed.skills)),
        };
        return true;
      }
      return false;
    },
    async get(sessionID) {
      const stored = await sessions.getSession(sessionID, SKILL_CATALOG_KIND);
      if (!Array.isArray(stored)) return undefined;
      const skills = stored.filter(
        (item): item is SkillEntry =>
          !!item &&
          typeof item === "object" &&
          typeof (item as SkillEntry).name === "string" &&
          typeof (item as SkillEntry).description === "string",
      );
      return skills.length === stored.length ? skills : undefined;
    },
  };
}

const HAN = /\p{Script=Han}/u;

/** 去掉空白並轉小寫；中文關鍵字常被寫成「去 AI 味」，查詢卻打成「去AI味」。 */
function compact(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

/** 整個關鍵字出現在查詢裡：含中文的忽略空白比對，英文要是完整的詞組。 */
function queryContainsKeyword(query: string, keyword: string): boolean {
  if (HAN.test(keyword)) return compact(query).includes(compact(keyword));
  const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  return containsTerm(normalize(query), normalize(keyword));
}

export function searchSkills(
  skills: SkillEntry[],
  query: string,
  keywords: SkillKeywordIndex = {},
): Array<SkillEntry & { score: number }> {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const scored = skills.map((skill) => {
    const name = skill.name.toLowerCase();
    const segments = name.split(/[-_:]/);
    const description = skill.description.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name === term) score += 20;
      else if (segments.includes(term)) score += 8;
      else if (term.length >= 4 && name.includes(term)) score += 4;
      if (containsTerm(description, term)) score += 3;
    }
    const entry = keywords[skill.name];
    for (const keyword of [...(entry?.zh ?? []), ...(entry?.en ?? [])]) {
      const key = keyword.toLowerCase();
      if (!key.trim()) continue;
      // 整個關鍵字出現在查詢裡，代表意圖最明確，份量和名稱完全相同一樣。
      if (queryContainsKeyword(query, key)) score += 20;
      else if (terms.some((term) => term.length >= 2 && containsTerm(key, term))) score += 4;
    }
    return { ...skill, score };
  });
  return scored
    .filter((skill) => skill.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** 讀 skills-policy.json 的 searchKeywords；檔案沒變就用上次讀的，讀不到就當作沒有關鍵字。 */
export function createKeywordLoader(policyPath: string): () => SkillKeywordIndex {
  let cached: { mtimeMs: number; index: SkillKeywordIndex } | null = null;
  return () => {
    try {
      assertSafeGlobalUltraworkPath(policyPath);
      const mtimeMs = statSync(policyPath).mtimeMs;
      if (cached && cached.mtimeMs === mtimeMs) return cached.index;
      const policy = JSON.parse(readFileSync(policyPath, "utf8")) as { searchKeywords?: unknown };
      const raw = policy.searchKeywords;
      const index: SkillKeywordIndex = {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
          if (!value || typeof value !== "object") continue;
          const { zh, en } = value as { zh?: unknown; en?: unknown };
          const strings = (list: unknown) =>
            Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
          index[name] = { zh: strings(zh), en: strings(en) };
        }
      }
      cached = { mtimeMs, index };
      return index;
    } catch {
      return {};
    }
  };
}

export interface SkillSearchOptions {
  /** 讀取 searchKeywords 的 skills-policy.json；預設是全域 `.ultrawork`。 */
  policyPath?: string;
}

/** skills-policy.json 的預設全域路徑；測試與 plugin options 可指定 globalDir。 */
export function resolveSkillsPolicyPath(globalConfigDir?: string): string {
  const globalDir = globalConfigDir ?? resolveGlobalConfigDir(process.env as Record<string, string | undefined>, homedir());
  return join(resolveGlobalUltraworkDir(globalDir), "skills-policy.json");
}

interface SkillSearchInput {
  query: string;
  limit?: number;
}

function createSkillSearchInputSchema(): z.ZodType<SkillSearchInput> {
  // zod 的型別在此模組集中宣告，避免公開工具定義依賴內部 schema 形狀。
  return z.object({
    query: z.string().min(1).describe("任務要做的事、框架名稱或技能名稱，中英文都可以，例如「推播通知」「去 AI 味」「swiftui navigation」"),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`最多回傳幾筆，預設 ${DEFAULT_LIMIT}`),
  }) as z.ZodType<SkillSearchInput>;
}

export function createSkillSearchTool(
  store: SkillCatalogStore,
  options: SkillSearchOptions = {},
): DefinedTool {
  const loadKeywords = createKeywordLoader(options.policyPath ?? resolveSkillsPolicyPath());
  const run = async ({ query, limit }: SkillSearchInput, context: ToolExecutionContext): Promise<string> => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return jsonResult({ ok: false, code: "INVALID_INPUT", error: "query 不能是空的。" }, undefined, "改用任務關鍵字或技能名稱查詢。");
    }
    const skills = await store.get(context.sessionID);
    if (!skills) {
      return jsonResult(
        { ok: false, code: "SKILL_CATALOG_UNAVAILABLE", error: "這個工作階段還沒有技能清單可以查。" },
        undefined,
        "直接依 system prompt 裡的技能名稱用 skill 工具載入。",
      );
    }
    const normalizedLimit = typeof limit === "number" && Number.isInteger(limit)
      ? Math.min(Math.max(limit, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;
    const matches = searchSkills(skills, normalizedQuery, loadKeywords());
    return jsonResult({
      ok: true,
      query: normalizedQuery,
      totalMatches: matches.length,
      skills: matches.slice(0, normalizedLimit).map(({ name, description }) => ({ name, description })),
    }, matches.length
      ? `找到 ${matches.length} 個相關技能。`
      : "沒有符合的技能；換個說法，或改用框架、檔案類型等更具體的關鍵字再查。");
  };

  const defined = defineTool({
    name: "skill_search",
    description: "依關鍵字查詢目前可用技能的完整描述，用來判斷要不要載入某個技能。中文或英文關鍵字都可以。只查這個工作階段原本就能用的技能；載入仍用 skill 工具。",
    inputSchema: createSkillSearchInputSchema(),
    execute: run,
  });

  // 空字串仍走舊版固定錯誤訊息；其餘輸入維持 defineTool 的 schema 驗證。
  return {
    ...defined,
    execute: async (raw, context) => {
      if (raw && typeof raw === "object" && typeof (raw as { query?: unknown }).query === "string") {
        const candidate = raw as { query: string; limit?: unknown };
        const validLimit = candidate.limit === undefined ||
          (typeof candidate.limit === "number" && Number.isInteger(candidate.limit) && candidate.limit >= 1 && candidate.limit <= MAX_LIMIT);
        if (validLimit) {
          return {
            content: await run({
              query: candidate.query,
              limit: typeof candidate.limit === "number" ? candidate.limit : undefined,
            }, context),
          };
        }
      }
      return defined.execute(raw, context);
    },
  };
}
