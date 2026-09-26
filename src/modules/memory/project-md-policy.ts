/**
 * project.md 容量政策（單一真相來源）：自舊外掛 core/project-md-policy 逐字搬入。
 *
 * 規則：
 * - hard limit 7000。
 * - frontmatter `limit:` 只能收緊（<= hard）且須為正整數；缺省 = hard。
 * - 非正整數／NaN／陣列／空字串／超過 hard → invalid → fail closed，
 *   effectiveLimit 仍為 hard 但 isValid=false 並帶 configurationError。
 * - near-limit threshold = Math.floor(effectiveLimit * 0.8)；7000 → 5600。
 * - BOOTSTRAP_FULL_SOFT_BUDGET 維持 10000；STATE_MD_LIMIT 為 3000。
 *
 * 本檔為 pure policy，不做 IO；不自動瘦身，只報告段落排序與 over_by。
 */

import { splitFrontmatter } from "./helpers.ts";
import { parseFrontmatterBlock } from "./frontmatter.ts";
import { lineFenceState } from "./markdown-fence.ts";
import {
  PROJECT_MD_HARD_LIMIT as CONST_HARD_LIMIT,
  STATE_MD_LIMIT as CONST_STATE_LIMIT,
  BOOTSTRAP_FULL_SOFT_BUDGET as CONST_BOOTSTRAP,
  PROJECT_MD_NEAR_LIMIT_RATIO as CONST_RATIO,
} from "./constants.ts";

// ─── Hard limits (single source) ──────────────────────────
// 7000/3000/10000 的數值來源唯一在 constants.ts；此處 re-export 避免漂移。
export const PROJECT_MD_HARD_LIMIT = CONST_HARD_LIMIT;
export const STATE_MD_LIMIT = CONST_STATE_LIMIT;
export const BOOTSTRAP_FULL_SOFT_BUDGET = CONST_BOOTSTRAP;
export const PROJECT_MD_NEAR_LIMIT_RATIO = CONST_RATIO;

// 向後相容：舊常數名仍可用，但以 hard limit 為準
export const PROJECT_MD_LIMIT = PROJECT_MD_HARD_LIMIT;

export interface ProjectMdPolicyResult {
  hardLimit: number;
  effectiveLimit: number;
  frontmatterLimit?: number;
  rawLimit?: string;
  isValid: boolean;
  configurationError?: string;
  isTightened: boolean;
}

export interface CurrentSectionInfo {
  name: string;
  size: number;
}

function parseLimitFromFrontmatter(frontmatter: string | null): ProjectMdPolicyResult {
  const hardLimit = PROJECT_MD_HARD_LIMIT;
  if (frontmatter === null) {
    return {
      hardLimit,
      effectiveLimit: hardLimit,
      isValid: false,
      configurationError: `project.md 沒有有效的 frontmatter 區塊（缺少以 --- 開頭的 frontmatter，無法判定有效上限）`,
      isTightened: false,
    };
  }
  const fm = parseFrontmatterBlock(frontmatter);
  if (fm.limit === undefined) {
    return {
      hardLimit,
      effectiveLimit: hardLimit,
      isValid: true,
      isTightened: false,
    };
  }
  // 陣列 → invalid
  if (Array.isArray(fm.limit)) {
    const display = `[${fm.limit.join(", ")}]`;
    return {
      hardLimit,
      effectiveLimit: hardLimit,
      rawLimit: display,
      isValid: false,
      configurationError: `project.md 的 frontmatter limit 無效：${display}（必須是 1..${hardLimit} 的正整數，且不能超過 hard limit ${hardLimit}）`,
      isTightened: false,
    };
  }
  const raw = String(fm.limit).trim();
  if (raw === "") {
    return {
      hardLimit,
      effectiveLimit: hardLimit,
      rawLimit: raw,
      isValid: false,
      configurationError: `project.md 的 frontmatter limit 無效：空值（必須是 1..${hardLimit} 的正整數）`,
      isTightened: false,
    };
  }
  const parsed = Number(raw);
  // 非有限數或非整數
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return {
      hardLimit,
      effectiveLimit: hardLimit,
      rawLimit: raw,
      isValid: false,
      configurationError: `project.md 的 frontmatter limit 不是有效正整數：\"${raw}\"（必須是 1..${hardLimit} 的正整數）`,
      isTightened: false,
    };
  }
  if (parsed <= 0) {
    return {
      hardLimit,
      effectiveLimit: hardLimit,
      rawLimit: raw,
      isValid: false,
      configurationError: `project.md 的 frontmatter limit 必須是正整數：\"${raw}\"（必須 >0 且 <= ${hardLimit}）`,
      isTightened: false,
    };
  }
  if (parsed > hardLimit) {
    return {
      hardLimit,
      effectiveLimit: hardLimit,
      rawLimit: raw,
      isValid: false,
      frontmatterLimit: parsed,
      configurationError: `project.md 的 frontmatter limit ${parsed} 超過 hard limit ${hardLimit}，不能放寬上限（只能收緊）`,
      isTightened: false,
    };
  }
  // valid and <= hard
  const effectiveLimit = parsed;
  return {
    hardLimit,
    effectiveLimit,
    frontmatterLimit: parsed,
    rawLimit: raw,
    isValid: true,
    isTightened: parsed < hardLimit,
  };
}

export function resolveProjectMdPolicy(frontmatter: string | null): ProjectMdPolicyResult {
  return parseLimitFromFrontmatter(frontmatter);
}

export function resolveProjectMdPolicyFromContent(content: string): ProjectMdPolicyResult {
  const { frontmatter } = splitFrontmatter(content);
  return parseLimitFromFrontmatter(frontmatter);
}

export function getProjectMdNearLimitThreshold(effectiveLimit: number): number {
  return Math.floor(effectiveLimit * PROJECT_MD_NEAR_LIMIT_RATIO);
}

export function getProjectMdCurrentSections(content: string): CurrentSectionInfo[] {
  // CRLF 一致：以 raw 的 \r?\n 作為字元計數單位，避免 normalize 少算 \r。
  const rawDelims = content.match(/\r?\n/g) ?? [];
  const logicalLines = content.split(/\r?\n/);
  // 依 logicalLines 偵測 frontmatter 範圍，與 splitFrontmatter 語意對齊
  let bodyStart = 0;
  if (logicalLines.length > 0 && logicalLines[0] === "---") {
    let endIdx = -1;
    for (let i = 1; i < logicalLines.length; i++) {
      if (logicalLines[i] === "---") { endIdx = i; break; }
    }
    if (endIdx !== -1) bodyStart = endIdx + 1;
    else bodyStart = 0;
  }
  // 與 splitFrontmatter 的 null 判定對齊：無有效 frontmatter 時 whole 視為 body
  const { frontmatter } = splitFrontmatter(content);
  if (frontmatter === null) bodyStart = 0;

  const bodyLines = logicalLines.slice(bodyStart);
  const bodyDelims = rawDelims.slice(bodyStart);
  const fenceMask = lineFenceState(bodyLines);
  type Tmp = { name: string; lines: string[]; startIdx: number };
  const sections: Tmp[] = [];
  let current: Tmp | null = null;
  for (let i = 0; i < bodyLines.length; i++) {
    if (fenceMask[i]) {
      if (current) current.lines.push(bodyLines[i]!);
      continue;
    }
    const m = /^##\s+(.+?)\s*$/.exec(bodyLines[i]!);
    if (m) {
      current = { name: m[1].trim(), lines: [], startIdx: i + 1 };
      sections.push(current);
      continue;
    }
    if (current) {
      current.lines.push(bodyLines[i]!);
    }
  }
  const infos: CurrentSectionInfo[] = sections.map((sec) => {
    let rawContent = "";
    for (let k = 0; k < sec.lines.length; k++) {
      rawContent += sec.lines[k]!;
      if (k < sec.lines.length - 1) {
        const d = bodyDelims[sec.startIdx + k] ?? "\n";
        rawContent += d;
      }
    }
    rawContent = rawContent.replace(/(\r?\n)+$/, "");
    return { name: sec.name, size: rawContent.length };
  });
  infos.sort((a, b) => b.size - a.size);
  return infos;
}

export function getProjectMdOverLimitHint(effectiveLimit: number, overBy: number, currentSections: CurrentSectionInfo[]): string {
  const largest = currentSections[0]?.name ? `最大段落「${currentSections[0].name}」(${currentSections[0].size} 字)` : "無段落";
  return `project.md 超過上限 ${overBy} 字（上限 ${effectiveLimit}）；${largest}。請將 project.md 精簡到 ${effectiveLimit} 字以內，或用 project-memory-update 分段精煉 H2 段落（避免整檔重寫）。`;
}
