/**
 * 主題檔：解析、驗證與渲染（企劃書第 4.3 節）。
 *
 * frontmatter 只允許固定的 8 個 key，每個都是單行純量；缺 key、多 key、重複 key、
 * 多行值一律視為格式錯誤（fail closed）。理由是索引與搜尋完全依賴這些欄位，
 * 寬鬆解析會讓壞掉的主題悄悄從索引裡消失或排錯位置。
 *
 * 渲染一律用 JSON 字串形式寫值（`title: "..."`），解析同時接受雙引號、單引號與
 * 不帶引號的純量，讓人手寫的主題也讀得進來。
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { MemoryError, memoryPath, type MemoryLayer } from "./layers.ts";

export const TOPIC_TYPES = ["decision", "reference", "lesson", "pitfall", "preference"] as const;
export type TopicType = (typeof TOPIC_TYPES)[number];

export interface TopicFrontmatter {
  title: string;
  description: string;
  type: TopicType;
  pinned: boolean;
  /** `task:<taskId>`、`note:<seq>`、`migration` 或 `manual`。 */
  source: string;
  created: string;
  updated: string;
  /** 空字串代表從未核對過。 */
  verified_at: string;
}

export interface Topic {
  topic: string;
  frontmatter: TopicFrontmatter;
  body: string;
  raw: string;
  /** 檔案原始位元組的 sha256；`memory-write` 的 `expectedSha256` 與結案檢查都用它。 */
  sha256: string;
  size: number;
}

const KEYS = ["title", "description", "type", "pinned", "source", "created", "updated", "verified_at"] as const;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SOURCE_PATTERN = /^(task:.+|note:[1-9]\d*|migration|manual)$/;
const ISO_UTC_PATTERN = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
/** 不帶引號時，YAML 會讀成別的東西（區塊、流式集合、錨點、註解、巢狀映射）的開頭或片段。 */
const UNSAFE_PLAIN_SCALAR = /^[>|[\]{}&*!]|\s#|:\s/;

export function sha256(raw: string | Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** slug 白名單：工具參數只收 slug、不收路徑，檔名永遠落在 `topics/` 內。 */
export function validateSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new MemoryError("INVALID_TOPIC_SLUG", "主題名稱只接受小寫英數字與連字號，開頭必須是英數字，長度 1 到 64 字元。");
  }
}

function invalid(raw: string): never {
  // 原文一併回傳，讓 memorizer 能直接修，不必另外讀檔。
  throw new MemoryError("INVALID_TOPIC_FORMAT", "主題格式錯誤，請派 memorizer 檢查 frontmatter。", { raw });
}

/** 解析單一 frontmatter 值；不合法時回 undefined。 */
function parseScalar(value: string): string | undefined {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) return undefined;
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return UNSAFE_PLAIN_SCALAR.test(value) ? undefined : value;
}

export function parseTopic(topic: string, raw: string, hash = sha256(raw)): Topic {
  validateSlug(topic);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!match) return invalid(raw);

  const values: Record<string, string | boolean> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([a-z_]+):[ \t]*(.*)$/.exec(line);
    const key = field?.[1];
    if (!field || !key || !(KEYS as readonly string[]).includes(key) || Object.hasOwn(values, key)) return invalid(raw);
    const value = parseScalar(field[2]!.trim());
    if (value === undefined || /[\r\n]/.test(value)) return invalid(raw);
    if (key === "pinned") {
      if (value !== "true" && value !== "false") return invalid(raw);
      values[key] = value === "true";
    } else {
      values[key] = value;
    }
  }
  if (Object.keys(values).length !== KEYS.length) return invalid(raw);

  for (const key of ["title", "description", "source"] as const) {
    if (!(values[key] as string).trim()) return invalid(raw);
  }
  if (!TOPIC_TYPES.includes(values.type as TopicType)) return invalid(raw);
  if (!SOURCE_PATTERN.test(values.source as string)) return invalid(raw);
  for (const key of ["created", "updated", "verified_at"] as const) {
    const date = values[key] as string;
    if (key === "verified_at" && date === "") continue;
    if (!ISO_UTC_PATTERN.test(date) || !Number.isFinite(Date.parse(date))) return invalid(raw);
  }

  return {
    topic,
    frontmatter: values as unknown as TopicFrontmatter,
    body: match[2]!.replace(/^\r?\n/, ""),
    raw,
    sha256: hash,
    size: raw.length,
  };
}

export function renderTopic(frontmatter: TopicFrontmatter, body: string): string {
  const lines = KEYS.map((key) => `${key}: ${JSON.stringify(frontmatter[key])}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

export function readTopic(layer: MemoryLayer, topic: string): Topic {
  validateSlug(topic);
  let bytes: Buffer;
  try {
    bytes = readFileSync(memoryPath(layer, "topics", `${topic}.md`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MemoryError("TOPIC_NOT_FOUND", "找不到這個主題，請先用 memory-search 查詢正確的名稱與層。");
    }
    throw error;
  }
  // sha 取原始位元組，與結案檢查比對檔案時用同一個基準。
  return parseTopic(topic, bytes.toString("utf8"), sha256(bytes));
}

/** 列出一層的所有主題（依檔名排序）；目錄不存在代表還沒有記憶。 */
export function listTopics(layer: MemoryLayer): Topic[] {
  let names: string[];
  try {
    names = readdirSync(memoryPath(layer, "topics"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => readTopic(layer, name.slice(0, -3)));
}
