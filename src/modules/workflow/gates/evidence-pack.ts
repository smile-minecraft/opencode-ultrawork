/**
 * opencode-ultrawork — 實作說明 純函式 validator
 *
 * 角色：
 *   - 提供 `validateEvidencePack(prompt, opts)` 純函式，給
 *     `src/tools/registry-hooks.ts` 之 實作準備階段 實作說明 gate 消費；
 *     取代舊版只看 prompt 內容的鬆散判斷。
 *   - 將 實作說明 規格（AGENTS.md「固定格式 Artifact Templates」之
 *     實作說明 七節固定格式）內化為單一 唯一正式資料。
 *   - 對 implementer / debugger 任務 prompt 強制驗證：七節標題、順序、
 *     唯一性、必要內容、Acceptance Criteria 至少一個 checkbox。
 *
 * 設計重點：
 *   - **純函式**：接收 `prompt: unknown`（防禦 non-string）→ 回傳
 *     `EvidencePackValidationResult`；無 IO / 無 closure / 無 side effect。
 *   - **結構化錯誤**：每個 violation 一個 `EvidencePackValidationError`，
 *     含 code / section / message，便於 caller 聚合 + 友善診斷。
 *   - **不洩漏 prompt body**：呼叫端決定如何組裝錯誤訊息；本檔僅回傳
 *     code + section 名稱 + 簡述，避免將整段 prompt 反射到 stderr / log。
 *   - **CRLF-tolerant**：解析前先將 `\r\n` / `\r` 統一為 `\n`，避免
 *     Windows-style line ending 造成誤判。
 *   - **標題格式嚴格**：section heading 必須為 `### N. <Section Name>`
 *     （N 為 1..7 序號），避免章節被誤吃 / 順序滑動。
 *
 * 對外規則（不可破壞）：
 *   - `validateEvidencePack` 必須回傳 `valid: boolean` + `errors` 陣列 +
 *     `sections` 物件（key 為 固定格式 section name，value 為 trimmed body）。
 *   - 對 `null` / `undefined` / 非 string prompt → `valid: false`、
 *     `BAD_PROMPT_TYPE` 錯誤。
 *   - 七節缺失 / 空 / 順序錯 / 重複 / 缺 checkbox 都會反映在 errors。
 *
 * 限制：
 *   - 不引入 IO / 副作用。
 *   - 不依賴 runtime helper（registry / context-builder / plugin closure）。
 *   - 不修改任何既有 hook signature。
 *
 * @see ../../../../README.md                                   — 模組一覽
 * @see ../tools/work-order-build.ts                            — 唯一 runtime consumer
 */

import { normalizeNewline } from "../core/helpers.ts";
import { lineFenceState } from "../core/markdown-fence.ts";
import type { UltraworkSettings } from "../../../settings/defaults.ts";
import { asStringList } from "../../../settings/validate.ts";

// ─── Constants ───────────────────────────────────────────────

/**
 * 七節 固定格式 section names（順序敏感）。
 * 變更此陣列必須同步更新 AGENTS.md 之 固定格式 實作說明 規格、
 * `agents/build.md` / `agents/ultra.md` 之 實作說明 描述、
 * 以及對應 unit test 的 section 名稱清單。
 */
export const EVIDENCE_PACK_SECTIONS = [
  "Task Identity",
  "Objective",
  "Known Evidence",
  "Constraints",
  "TDD Requirements",
  "Acceptance Criteria",
  "Required Return",
] as const;

/** 對應七節的序號前綴字串（用於 `### N. <Name>` 解析）。 */
export const EVIDENCE_PACK_SECTION_NUMBERS = ["1", "2", "3", "4", "5", "6", "7"] as const;

export type EvidencePackSectionName = (typeof EVIDENCE_PACK_SECTIONS)[number];

/** 受 實作準備階段 強制驗證的 subagent_type（plugin 內 allowlist 子集）。
 *
 * 清單可用設定覆寫（workflow.evidencePack.gatedSubagents），預設等於下方常數；
 * 設定給了非預期的值一律退回預設（由設定驗證層保證，這裡再擋一次是縱深）。
 */
export const EVIDENCE_PACK_GATED_SUBAGENTS = ["implementer", "debugger", "ultra-coder"] as const;
export type EvidencePackGatedSubagent = (typeof EVIDENCE_PACK_GATED_SUBAGENTS)[number];

/** 從設定解出實際受驗證的 subagent 清單；沒寫或寫壞都退回內建預設。 */
export function resolveEvidencePackGatedSubagents(
  settings: UltraworkSettings | undefined,
): readonly string[] {
  return asStringList(settings?.workflow?.evidencePack?.gatedSubagents)
    ?? [...EVIDENCE_PACK_GATED_SUBAGENTS];
}

// ─── Error Types ─────────────────────────────────────────────

/** 實作說明 驗證錯誤代碼。 */
export type EvidencePackErrorCode =
  | "BAD_PROMPT_TYPE"
  | "MISSING_HEADER"
  | "MISSING_SECTION"
  | "DUPLICATE_SECTION"
  | "OUT_OF_ORDER"
  | "EMPTY_SECTION"
  | "NUMBER_MISMATCH"
  | "NO_ACCEPTANCE_CHECKBOX";

/** 單筆驗證錯誤。 */
export interface EvidencePackValidationError {
  code: EvidencePackErrorCode;
  section?: EvidencePackSectionName;
  message: string;
}

/** `validateEvidencePack` 回傳結果。 */
export interface EvidencePackValidationResult {
  valid: boolean;
  errors: EvidencePackValidationError[];
  /** 解析到的 section body map（key 為 固定格式 section name；缺漏則缺漏）。 */
  sections: Partial<Record<EvidencePackSectionName, string>>;
  /** 解析到的 section header 序號（由 1 起；缺漏為 null）。用於診斷 out-of-order。 */
  sectionOrder: Array<EvidencePackSectionName | null>;
}

// ─── Section Heading Regex ───────────────────────────────────

/**
 * 嚴格 section heading matcher：`### N. <Name>`（N 為 1..7）。
 *
 * - 不允許縮排（前綴須為行首）。
 * - N 後接 `.` + 至少一個空白。
 * - `<Name>` 必須等於七節 固定格式 name 之一（case-sensitive，
 *   容忍 leading/trailing 空白）。
 *
 * 採 named capture 方便 debugger 直接讀 `match.groups.section`。
 */
const SECTION_HEADING_RE = /^###\s+([1-7])\.\s+(.+?)\s*$/;

/**
 * 寬鬆 ATX heading matcher（用於 normalize）：任何層級 `#{1,6} N. <Name>`。
 *
 * 與 SECTION_HEADING_RE 不同：此 regex 不限定 `###`，涵蓋 H1/H2/H4/H5/H6。
 * 仍要求：
 *   - 前綴須為行首（不允許縮排）
 *   - `N` 為 1..7
 *   - `<Name>` 等於七節 固定格式 name 之一（trim 後）
 *
 * normalizeHeadingLevels 採此 regex 判定「哪幾行可以安全改為 H3」，
 * 並且額外要求 `N` 等於 `<Name>` 在 `EVIDENCE_PACK_SECTIONS` 內的索引（1-based）；
 * 若 number ≠ canonical index，視為「序號錯」而非「層級錯」，不自動修正。
 * validateEvidencePack 仍走 SECTION_HEADING_RE，以維持既有語意。
 */
const ANY_LEVEL_SECTION_HEADING_RE = /^#{1,6}\s+([1-7])\.\s+(.+?)\s*$/;

/**
 * Acceptance Criteria 內的 checkbox 偵測：
 *   - `- [ ] foo`
 *   - `- [x] foo`
 *   - `* [X] foo`
 *   - 允許行首縮排（≤ 8 spaces）。
 *
 * 注意：採 multiline flag 後 `^` 匹配行首（搭配 normalizeNewline 後）。
 */
const CHECKBOX_RE = /^[ \t]{0,8}[-*][ \t]+\[[ xX]\]/m;

// ─── Pure helpers ────────────────────────────────────────────

/**
 * 從 prompt 文字抽出 section heading 行（每一行符合 SECTION_HEADING_RE 的視為一個）。
 * 回傳順序保留原始出現順序，供後後續 OUT_OF_ORDER / DUPLICATE_SECTION 判定。
 *
 * **Fence-aware**：跳過 fenced code block（``` / ~~~）內的 heading 行，
 * 避免誤把 fence 內的範例標題當成實際 section heading；同時與
 * `normalizeHeadingLevels` 共用同一份 fence 偵測（透過 `lineFenceState`），
 * 保證 normalize 與 validator 對「哪些 heading 算數」的判定完全一致。
 */
function extractSectionHeadings(normalizedPrompt: string): Array<{
  index: number;
  number: string;
  name: string;
  nameTrimmed: string;
  matchedCanonical: EvidencePackSectionName | null;
}> {
  const lines = normalizedPrompt.split("\n");
  const fenceMask = lineFenceState(lines);
  const out: Array<{
    index: number;
    number: string;
    name: string;
    nameTrimmed: string;
    matchedCanonical: EvidencePackSectionName | null;
  }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenceMask[i]) continue;
    const line = lines[i];
    const match = SECTION_HEADING_RE.exec(line);
    if (!match) continue;
    const number = match[1];
    const nameRaw = match[2] ?? "";
    const nameTrimmed = nameRaw.trim();
    const matched = (EVIDENCE_PACK_SECTIONS as readonly string[]).includes(nameTrimmed)
      ? (nameTrimmed as EvidencePackSectionName)
      : null;
    out.push({ index: i, number, name: nameRaw, nameTrimmed, matchedCanonical: matched });
  }
  return out;
}

// ─── Heading-level normalizer ─────────────────────────────────

/**
 * 把 prompt 中的合法七節 heading 從 H1/H2/H4-H6 統一改成 H3。
 *
 * 規則（保守、不可補資料、不可重排）：
 *   - 只處理 Markdown ATX heading 行：行首 `<n>#` + ` N. <Name>`，其中
 *     `<n>` 為 1..6，`N` 為 1..7，`<Name>`（trim 後）等於七節 canonical name 之一。
 *   - 已正確 H3 的 heading 不變。
 *   - 其它（不同序號、不同名稱、非 heading 行）一律不動。
 *   - fenced code block（``` 或 ~~~）內的行完全不動（連「看似標題」也不改）；
 *     共用 `lineFenceState` 與 validator 一致的 fence 偵測，避免兩邊判斷分歧。
 *   - 非 string 輸入（null / undefined / 非 string）原樣回傳，不 throw。
 *   - 純函式：相同輸入 → 相同輸出；連續呼叫兩次結果相同（idempotent）。
 *   - 換行保留：逐一保留輸入中的 `"\r\n"` 與 `"\n"` 分隔符；同一份 prompt
 *     若同時混用 CRLF 與 LF，每個分隔符依原樣保留，不整份強制統一。
 *     （`normalizeNewline` 會把所有 CRLF 換成 LF，因此本函式不使用它；改用
 *     `split(/(\r?\n)/)` 的 capturing-group 形式保留分隔符。）
 *
 * 注意：本函式只負責 heading 層級修正；其他語意錯誤（缺節、順序、空節、
 * 缺 checkbox）仍由 `validateEvidencePack` 把關。
 */
export function normalizeHeadingLevels(prompt: string): string;
export function normalizeHeadingLevels(prompt: unknown): unknown;
export function normalizeHeadingLevels(prompt: unknown): unknown {
  if (typeof prompt !== "string" || prompt.length === 0) {
    return prompt;
  }

  // 用 capturing-group split：tokens 交錯為 [content, sep, content, sep, ...]，
  // 這樣後續 rejoin 時可以保留每個原始分隔符。trailing newline 會產生尾端空
  // content，需另外處理（見下方）。
  const tokens = prompt.split(/(\r?\n)/);
  // tokens 結構：
  //   奇數索引 = 分隔符（"\r\n" 或 "\n"，最後一個可能是 undefined）
  //   偶數索引 = content（含可能的尾部空字串）
  // 把 content 行抽出供 fence-aware 分析（不包含分隔符）。
  const lines: string[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    lines.push(tokens[i] ?? "");
  }
  const fenceMask = lineFenceState(lines);

  // 先檢查是否需要任何修改；都不需要就直接回傳原字串（保留完全相同 identity）
  let needsRewrite = false;
  for (let i = 0; i < lines.length; i++) {
    if (fenceMask[i]) continue;
    const line = lines[i]!;
    if (line.startsWith("### ")) continue; // 已是 H3
    const match = ANY_LEVEL_SECTION_HEADING_RE.exec(line);
    if (!match) continue;
    const number = match[1]!;
    const nameTrimmed = (match[2] ?? "").trim();
    if (!(EVIDENCE_PACK_SECTIONS as readonly string[]).includes(nameTrimmed)) continue;
    // 額外要求：序號 N 必須等於 name 在 canonical 列表內的 1-based 索引
    const canonicalIndex = (EVIDENCE_PACK_SECTIONS as readonly string[]).indexOf(nameTrimmed);
    if (canonicalIndex < 0) continue;
    const canonicalNumber = String(canonicalIndex + 1);
    if (number !== canonicalNumber) continue;
    needsRewrite = true;
    break;
  }
  if (!needsRewrite) {
    return prompt;
  }

  // 重建：content[i] 與 sep[i] 配對，最後一個 content 是 trailing newline 後的內容。
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (!fenceMask[i] && !line.startsWith("### ")) {
      const match = ANY_LEVEL_SECTION_HEADING_RE.exec(line);
      if (match) {
        const number = match[1]!;
        const name = (match[2] ?? "").trim();
        const canonicalIndex = (EVIDENCE_PACK_SECTIONS as readonly string[]).indexOf(name);
        if (canonicalIndex >= 0) {
          const canonicalNumber = String(canonicalIndex + 1);
          if (number === canonicalNumber) {
            line = `### ${number}. ${name}`;
          }
          // 序號錯 / 名稱錯：保守維持原行
        }
      }
    }
    out.push(line);
    // 在最後一行後面不再 append separator；其他行後面接對應 separator。
    const sep = tokens[i * 2 + 1];
    if (sep !== undefined) {
      out.push(sep);
    }
  }
  return out.join("");
}

// ─── Main validator ──────────────────────────────────────────

/**
 * 驗證 `prompt` 是否符合 固定格式 實作說明 七節格式。
 *
 * 規則：
 *   1. prompt 必須為 non-empty string；否則 `BAD_PROMPT_TYPE`。
 *   2. prompt 必須包含至少 7 個 `### N. <Name>` heading；缺漏 → `MISSING_SECTION`。
 *   3. heading 序號必須等於七節 固定格式 順序（1 → 7 嚴格遞增）；違反 → `OUT_OF_ORDER`。
 *   4. heading 不可重複；違反 → `DUPLICATE_SECTION`。
 *   5. 每節 body（heading 下一行到下一個 `### ` heading 或 EOF 為止）
 *      經 trim 後不可為空；違反 → `EMPTY_SECTION`。
 *   6. Acceptance Criteria 節 body 必須含至少一個 `- [ ]` / `- [x]` checkbox；
 *      違反 → `NO_ACCEPTANCE_CHECKBOX`。
 *
 * @param prompt 來自 `task` tool 之 `args.prompt`（呼叫端負責抽出）。
 * @returns `valid: true` 表示通過；`valid: false` 時 `errors` 列出所有違規。
 */
export function validateEvidencePack(prompt: unknown): EvidencePackValidationResult {
  const errors: EvidencePackValidationError[] = [];
  const sections: Partial<Record<EvidencePackSectionName, string>> = {};
  const sectionOrder: Array<EvidencePackSectionName | null> = [];

  // Rule 1：型別檢查
  if (typeof prompt !== "string" || prompt.length === 0) {
    return {
      valid: false,
      errors: [
        {
          code: "BAD_PROMPT_TYPE",
          message:
            "實作說明必須是非空文字（subagent 工具的 prompt）。",
        },
      ],
      sections,
      sectionOrder,
    };
  }

  const normalized = normalizeNewline(prompt);
  const headings = extractSectionHeadings(normalized);

  // Rule 2 + 4：缺漏 / 重複節檢查
  const seenNames = new Set<string>();
  let lastSeenIndex = -1; // EVIDENCE_PACK_SECTIONS index of last seen 固定格式 section
  for (const h of headings) {
    if (h.matchedCanonical === null) {
      // 不在七節清單內：忽略（避免誤吃相似標題），由「缺少該節」自然反映於 MISSING_SECTION
      continue;
    }
    if (seenNames.has(h.matchedCanonical)) {
      errors.push({
        code: "DUPLICATE_SECTION",
        section: h.matchedCanonical,
        message: `段落「${h.matchedCanonical}」出現了不只一次。`,
      });
      // 不覆寫既有 body，仍記進 sectionOrder 以維持診斷一致性
      sectionOrder.push(h.matchedCanonical);
      continue;
    }
    seenNames.add(h.matchedCanonical);
    sectionOrder.push(h.matchedCanonical);
    const currentIndex = (EVIDENCE_PACK_SECTIONS as readonly string[]).indexOf(h.matchedCanonical);
    // Rule 3a：序號檢查（heading 上的 `N. ` 必須等於 canonical 1-based 索引）
    const expectedNumber = EVIDENCE_PACK_SECTION_NUMBERS[currentIndex]!;
    if (h.number !== expectedNumber) {
      errors.push({
        code: "NUMBER_MISMATCH",
        section: h.matchedCanonical,
        message: `段落「${h.matchedCanonical}」序號錯（寫 ${h.number}，應為 ${expectedNumber}）。`,
      });
    }
    // Rule 3b：順序檢查（與前一個 固定格式 section 比較）
    if (currentIndex < lastSeenIndex) {
      errors.push({
        code: "OUT_OF_ORDER",
        section: h.matchedCanonical,
        message: `段落「${h.matchedCanonical}」（第 ${h.number} 節）順序不對，應該排在「${EVIDENCE_PACK_SECTIONS[lastSeenIndex] ?? "(開頭)"}」後面。`,
      });
    }
    lastSeenIndex = currentIndex;
  }

  // Rule 2（補）：缺漏節檢查 — 七節必須全部出現（依 EVIDENCE_PACK_SECTIONS 順序）
  for (let i = 0; i < EVIDENCE_PACK_SECTIONS.length; i++) {
    const canonical = EVIDENCE_PACK_SECTIONS[i];
    if (!seenNames.has(canonical)) {
      errors.push({
        code: "MISSING_SECTION",
        section: canonical,
        message: `缺少段落「${canonical}」（應該是「### ${EVIDENCE_PACK_SECTION_NUMBERS[i]}. ${canonical}」）。`,
      });
    }
  }

  // Rule 5 + 6：每節 body 解析與驗證
  // 對 headings（不限是否在七節內）依 line index 排序，作為 section boundary
  const allHeadingLines = normalized.split("\n");
  // 只把「matchedCanonical 非 null」的 headings 視為 boundary；其餘忽略
  const boundaryIndices: number[] = [];
  for (const h of headings) {
    if (h.matchedCanonical !== null && seenNames.has(h.matchedCanonical)) {
      boundaryIndices.push(h.index);
    }
  }
  // 為了避免重複節被兩次 boundary 解析，seenNames 已是去重集合，這裡再次
  // 依 headings 順序取出第一個出現位置即可（保留 first-occurrence semantics）
  const canonicalBoundary: Array<{ name: EvidencePackSectionName; line: number }> = [];
  for (const h of headings) {
    if (h.matchedCanonical === null) continue;
    if (canonicalBoundary.some((b) => b.name === h.matchedCanonical)) continue;
    canonicalBoundary.push({ name: h.matchedCanonical, line: h.index });
  }

  for (let i = 0; i < canonicalBoundary.length; i++) {
    const { name, line } = canonicalBoundary[i];
    const nextLine = i + 1 < canonicalBoundary.length ? canonicalBoundary[i + 1]!.line : allHeadingLines.length;
    // body = heading 之後到下一個 boundary 之間（不含 heading 行本身）
    const bodyLines = allHeadingLines.slice(line + 1, nextLine);
    const body = bodyLines.join("\n").trim();
    sections[name] = body;
    if (body.length === 0) {
      errors.push({
        code: "EMPTY_SECTION",
        section: name,
        message: `段落「${name}」有標題但內文是空的。`,
      });
      continue;
    }
    // Rule 6：Acceptance Criteria 必須有 checkbox
    if (name === "Acceptance Criteria" && !CHECKBOX_RE.test(body)) {
      errors.push({
        code: "NO_ACCEPTANCE_CHECKBOX",
        section: "Acceptance Criteria",
        message:
          "Acceptance Criteria section must contain at least one `- [ ]` or `- [x]` checkbox.",
      });
    }
  }

  const valid = errors.length === 0;
  return { valid, errors, sections, sectionOrder };
}

/**
 * 把驗證結果聚合成單一字串（給 hook 端 throw 用）。
 *
 * 設計：
 *   - 不回顯完整 prompt（安全設計不變）。
 *   - 每一筆 error 的 section / message 都列在 issues 清單中，方便診斷。
 *   - 至少列出一個精確正確的 `### N. Name` 範例（從七節 canonical 列表取），
 *     附帶 `agents/build.md` 模板位置，讓 caller 立刻知道正確格式在哪。
 *   - 包含每個出現過的 error code、缺漏 section 名稱、計數，便於自動化判讀。
 */
export function formatEvidencePackErrors(
  result: EvidencePackValidationResult,
  subagentType: string,
): string {
  if (result.valid) return "";

  const codes = Array.from(new Set(result.errors.map((e) => e.code)));
  const missing = result.errors
    .filter((e) => e.code === "MISSING_SECTION" || e.code === "EMPTY_SECTION")
    .map((e) => e.section)
    .filter((s): s is EvidencePackSectionName => Boolean(s));
  const missingUnique = Array.from(new Set(missing));

  // 從 missing 裡挑第一個缺漏節作為精確範例；若都沒缺漏則用第一個 canonical 節作示範。
  const exampleSection: EvidencePackSectionName =
    (missingUnique[0] as EvidencePackSectionName | undefined) ?? EVIDENCE_PACK_SECTIONS[0];
  const exampleNumber = EVIDENCE_PACK_SECTION_NUMBERS[
    (EVIDENCE_PACK_SECTIONS as readonly string[]).indexOf(exampleSection)
  ]!;
  const exampleHeading = `### ${exampleNumber}. ${exampleSection}`;

  const issueLines = result.errors.map(
    (e, idx) => `  - [${idx + 1}] ${e.code}${e.section ? ` section=${e.section}` : ""} :: ${e.message}`,
  );

  const parts = [
    `實作準備未通過：agent='${subagentType}' 的實作說明格式不正確`,
    `codes=[${codes.join(",")}]`,
    `missing_or_empty=[${missingUnique.join(",")}]`,
    `total_errors=${result.errors.length}`,
    `other_errors=${result.errors.length - missingUnique.length}`,
    `example_heading=${exampleHeading}`,
    `template=agents/build.md`,
    `issues=[`,
    ...issueLines,
    `]`,
  ];
  return parts.join("; ");
}
