/**
 * opencode-ultrawork — Comment Signal Module：source comment lexer
 *
 * 角色：
 *   - 提供語言感知的 lexical comment 抽取，避免 regex 把字串、
 *     template literal raw、regex 字面值內的 slash-shapes 誤判為 comment。
 *   - 與 parser.parseCommentSignals 與 validator.validateSource* 共用，
 *     保證兩條路徑（signal-level 與 source-level）在同一檔案看到的是
 *     同一份 comment 清單；這也是把字串 / template / JSDoc 內容
 *     排除後才能讓 TAG 範例不被誤判為 functional tag 的根因。
 *
 * 設計重點：
 *   - 純函式；無 closure、無 IO。
 *   - JS-family（含 JVM .java/.kt/.kts/.groovy）採 slash-slash line 與
 *     slash-star block；CSS 用同樣 token 但關掉 slash-slash；YAML/Shell
 *     用 #；HTML-family 用 HTML comment markers 並對 script 內容再做
 *     JS 二次處理。
 *   - template literal 內 ${...} interpolation 視為可執行 code：其中
 *     的 comment markers 仍會被視為 comment；純 template raw text（一對
 *     反引號之間、無 interpolation 的部分）視為字串 literal，跳過。
 *     Groovy triple-double GString 也以同樣規則掃描 `${...}` interpolation；
 *     triple-single raw string 則不插值。
 *   - JVM triple-quoted 文字（Java text block / Kotlin raw string /
 *     Groovy triple-quoted）以三個雙引號或三個單引號包裹，跨越多行且
 *     內容任意；對 .java/.kt/.kts/.groovy 啟用 triple 模式掃到收尾對應
 *     delimiter 才退出，避免字串內容裡的 line comment、block comment、
 *     fake tag header、workflow-ID-like 文字被誤判為 comment。
 *     每種語言有專屬 config：
 *       · Java text block：`"""` 開啟、反斜線 honor escape（`\"` 不會誤關）。
 *       · Kotlin raw string：`"""` 開啟、反斜線為 literal（`\"""` 表示
 *         literal `\` + closing `"""`），保留 raw string 語意。
 *       · Groovy triple-quoted：`"""` 與 `'''` 皆為 triple delimiter
 *         （`'''` 為純 raw string，無 interpolation、無 escape），
 *         反斜線為 literal。
 *     JS / TS 不啟用 triple 模式（語言無原生三引號字串；三引號字面仍
 *     視為相鄰雙引號字串串接，與既有規則一致）。
  *   - JSON / TXT 完全沒有原生 comment，回傳空清單（與既有規則一致）。
  *   - Swift（`.swift`）走專用 `extractSwiftCommentLines`：slash-slash line
  *    （含三斜線 doc）與可巢狀 slash-star block；單引號與反引號不是字串
  *     邊界；普通雙引號、三引號多行、raw（含多 hash 與多行）字串內容跳過，
  *     插值內回到 code mode 讓註解照常抽取。
 *
 * 對外規則（不可破壞）：
 *   - 每個回傳 entry 至少含 line（comment 起點 1-based 行號）與
 *     text（去掉 markers 後的內文）。
 *   - block comment 跨多行時，每行分別回傳獨立 entry；上層 parser 用
 *     行號連續性 coalesce。
 *   - 行號超過 source 範圍或來源為空時，回傳空清單。
 *
 * 限制：
 *   - 不得 import runtime helper。
 *   - 不得改變既有 CommentSignal / Violation 形狀。
 *
 * @see ./types.ts — SourceCommentLine 形狀
 * @see ./parser.ts — coalesce + parse
 * @see ./validator.ts — use for unformatted / workflow id scan
 */

import type { SourceCommentLine } from "./types.ts";

// ─── Public Dispatcher ─────────────────────────────────────────

/** Comment Signal 認可的 JVM 副檔名集合（共用 `.java/.kt/.kts/.groovy`）。 */
const JVM_TRIPLE_QUOTE_EXTENSIONS = new Set([".java", ".kt", ".kts", ".groovy"]);

/**
 * JVM triple-quote 模式設定。
 *
 * 依 JVM 語言副檔名 dispatch 不同行為：
 *   - Java text block：`"""` 開啟、honor 反斜線 escape（避免 `\"\"\"`
 *     形式的 escape sequence 誤關閉 triple）。
 *   - Kotlin raw string：`"""` 開啟、反斜線為 literal；關閉只看 delimiter
 *     是否連續出現，不論前面是否有 `\`（這是 raw string 的語意）。
 *   - Groovy triple-quoted：`"""` 與 `'''` 皆為 triple delimiter，
 *     反斜線為 literal（與 Kotlin 相同）。
 *
 * 由 `extractSourceCommentLines` 依副檔名選擇對應 config；
 * 測試也可直接呼叫 `extractJsStyleCommentLines` 並傳入 config 驗證
 * 個別語言語意。
 */
export interface JvmTripleConfig {
  /** triple delimiter 種類：'"' 僅 `"""`；'both' 額外支援 `'''`（Groovy）。 */
  delimiter: '"' | "both";
  /** 是否 honor 反斜線 escape：Java text block 為 true；Kotlin/Groovy raw 為 false。 */
  escape: boolean;
}

/**
 * 依副檔名抽取出真實的 comment 行。JS-family lexer 會略過字串與
 * template raw text（但仍進入 ${...} interpolation），HTML-family、
 * YAML/Shell 與 CSS 使用各自的 comment 邊界，避免把 raw text / URL
 * 等誤判為註解。
 *
 * JVM 副檔名（.java/.kt/.kts/.groovy）依語言啟用對應的 triple-quote
 * config：Java text block 保留反斜線 escape；Kotlin raw string 與
 * Groovy triple-quoted 視反斜線為 literal；Groovy 額外支援 `'''` delimiter。
 * JS / TS / 其它副檔名不啟用 triple-quote 模式，行為與既有規則一致。
 * Swift（.swift）走專用 Swift lexer（見 `extractSwiftCommentLines`）。
 */
export function extractSourceCommentLines(
  source: string,
  filePath: string,
): SourceCommentLine[] {
  const extension = filePath.toLowerCase().match(/\.[^.\/]+$/)?.[0] ?? "";
  if (extension === ".yaml" || extension === ".yml" || extension === ".sh") {
    return extractHashCommentLines(source);
  }
  if (extension === ".html" || extension === ".vue" || extension === ".svelte") {
    return extractHtmlFamilyCommentLines(source);
  }
  if (extension === ".css") {
    return extractJsStyleCommentLines(source, false, false);
  }
  if (extension === ".json" || extension === ".txt") return [];
  if (extension === ".swift") {
    return extractSwiftCommentLines(source);
  }
  // JVM triple-quote 模式依語言 dispatch：
  //   - Java：""" triple + honor escape（與既有規則一致）
  //   - Kotlin / .kts：""" triple + literal `\`（raw string 語意）
  //   - Groovy：""" 與 ''' triple + literal `\`（含三單引號 raw string）
  if (extension === ".java") {
    return extractJsStyleCommentLines(source, true, { delimiter: '"', escape: true });
  }
  if (extension === ".kt" || extension === ".kts") {
    return extractJsStyleCommentLines(source, true, { delimiter: '"', escape: false });
  }
  if (extension === ".groovy") {
    return extractJsStyleCommentLines(source, true, { delimiter: "both", escape: false });
  }
  // 未知 JVM 副檔名（含 SCAN_EXTENSIONS 變動等）：保留舊式行為以維持向後相容。
  if (JVM_TRIPLE_QUOTE_EXTENSIONS.has(extension)) {
    return extractJsStyleCommentLines(source, true, { delimiter: '"', escape: true });
  }
  return extractJsStyleCommentLines(source, true, false);
}

// ─── Hash Comment Lexer（YAML / Shell） ────────────────────────

/**
 * 逐字元掃描，命中行首（quote 之外）的 # 起為 comment。
 * Shell 變數展開（${...}）仍維持在同一 quote 模式內處理，跳過。
 */
export function extractHashCommentLines(source: string): SourceCommentLine[] {
  const out: SourceCommentLine[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const current = lines[index];
    let quote: "single" | "double" | null = null;
    let escaped = false;
    for (let column = 0; column < current.length; column++) {
      const char = current[column];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote === "double" && char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "'" && quote !== "double") {
        quote = quote === "single" ? null : "single";
        continue;
      }
      if (char === '"' && quote !== "single") {
        quote = quote === "double" ? null : "double";
        continue;
      }
      if (char === "#" && quote === null) {
        out.push({ line: index + 1, text: current.slice(column + 1) });
        break;
      }
    }
  }
  return out;
}

// ─── HTML Family Lexer ────────────────────────────────────────

/**
 * HTML/Vue/Svelte：先抓 HTML comment markers 註解，再對 script 標籤
 * 內的字串以 JS 規則二次抽取。混合語言檔案（如 Vue SFC）也能正確分層。
 */
export function extractHtmlFamilyCommentLines(source: string): SourceCommentLine[] {
  const normalized = source.replace(/\r\n/g, "\n");
  const comments: SourceCommentLine[] = [];
  const htmlCommentRe = /<!--[\s\S]*?-->/g;
  for (const match of normalized.matchAll(htmlCommentRe)) {
    const start = match.index ?? 0;
    const startLine = normalized.slice(0, start).split("\n").length;
    const body = match[0].slice(4, -3).split("\n");
    body.forEach((text, offset) => comments.push({ line: startLine + offset, text }));
  }

  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of normalized.matchAll(scriptRe)) {
    const fullStart = match.index ?? 0;
    const bodyOffset = match[0].indexOf(match[1]);
    const bodyStart = fullStart + bodyOffset;
    const prefixLines = normalized.slice(0, bodyStart).split("\n").length - 1;
    const prefixed = `${"\n".repeat(prefixLines)}${match[1]}`;
    comments.push(...extractJsStyleCommentLines(prefixed, true, false));
  }
  return comments.sort((a, b) => a.line - b.line);
}

// ─── JS-family Lexer（含 JVM） ─────────────────────────────────

/**
 * 對 JS-family（也涵蓋 JVM .java / .kt / .kts / .groovy）逐字元
 * state-machine 走訪，跳過 single/double/template literal 字串內容；
 * 進入 template 的 ${...} interpolation 又視為一般 code（含 comment）
 * —— 這與 TypeScript runtime 一致；Groovy triple-double GString 的
 * interpolation 也採相同的 bounded brace tracking。
 *
 * allowLineComments=false 可用於 CSS 類語言（無 line comment，僅 block）。
 *
 * jvmTriple 為 JvmTripleConfig 時啟用 JVM triple-quoted 字串識別：
 *   - delimiter='"' 時只接受 `"""` 開頭 / 收尾（Java / Kotlin）。
 *   - delimiter='both' 時額外接受 `'''` 開頭 / 收尾（Groovy）；Groovy
 *     的單引號三元字串為純 raw，無 interpolation。
 *   - escape=true（Java text block）時 honor 反斜線 escape（`\` 會消耗
 *     下一字元），避免 `\"\"\"` 形式的 escape 誤關閉 triple。
 *   - escape=false（Kotlin / Groovy raw）時 `\` 為 literal；遇到連續
 *     delimiter 三個即關閉 triple，不論前面是否為 `\`。這是 raw string
 *     的標準語意。
 *   - Groovy triple-double GString 在 `${...}` 內暫時回到 code mode，並以
 *     brace depth 回到原 triple mode；Groovy `'''` 維持純 raw string。
 *
 * jvmTriple=false（預設；含 JS / TS / CSS / HTML-script）時不啟用 triple
 * 模式，`"""..."""` 仍被視為相鄰雙引號字串串接，行為與既有規則一致。
 */
export function extractJsStyleCommentLines(
  source: string,
  allowLineComments: boolean,
  jvmTriple: JvmTripleConfig | false = false,
): SourceCommentLine[] {
  type Mode = "code" | "single" | "double" | "template" | "triple" | "block";

  const normalized = source.replace(/\r\n/g, "\n");
  const comments: SourceCommentLine[] = [];
  let mode: Mode = "code";
  let escaped = false;
  let line = 1;
  let blockLine = 1;
  let blockText = "";
  let templateExpressionDepth = 0;
  let tripleExpressionDepth = 0;
  /** 進入 triple 模式時鎖定的 delimiter（`"` 或 `'`）；null 表示不在 triple。 */
  let tripleDelimiter: '"' | "'" | null = null;

  const pushBlockLine = (): void => {
    comments.push({ line: blockLine, text: blockText });
    blockText = "";
  };

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    const next = normalized[i + 1];

    if (mode === "triple") {
      const delim = tripleDelimiter ?? '"';
      // Java text block（escape=true）：`\` 消耗下一字元，避免 `\"\"\"`
      // 形式的 escape 誤關閉 triple。
      // Kotlin / Groovy raw（escape=false）：`\` 為 literal，直接 continue，
      // 由後續 delimiter 偵測負責關閉 triple。
      if (jvmTriple !== false && jvmTriple.escape && escaped) {
        escaped = false;
        if (char === "\n") line++;
        continue;
      }
      if (jvmTriple !== false && jvmTriple.escape && char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\n") {
        line++;
        continue;
      }
      // Groovy `"""` 是 GString：raw text 跳過，但 `${...}` 內回到
      // code mode，讓 interpolation 中的註解照常抽取。`'''` 沒有插值。
      if (
        jvmTriple !== false
        && jvmTriple.delimiter === "both"
        && delim === '"'
        && char === "$"
        && next === "{"
      ) {
        mode = "code";
        tripleExpressionDepth = 1;
        i++;
        continue;
      }
      if (char === delim && next === delim && normalized[i + 2] === delim) {
        mode = "code";
        tripleDelimiter = null;
        i += 2;
        continue;
      }
      continue;
    }

    if (mode === "block") {
      if (char === "*" && next === "/") {
        pushBlockLine();
        mode = "code";
        i++;
        continue;
      }
      if (char === "\n") {
        pushBlockLine();
        line++;
        blockLine = line;
        continue;
      }
      blockText += char;
      continue;
    }

    if (mode !== "code") {
      if (char === "\n") {
        line++;
        if (mode !== "template") mode = "code";
        escaped = false;
        continue;
      }
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (
        (mode === "single" && char === "'")
        || (mode === "double" && char === '"')
        || (mode === "template" && char === "`")
      ) {
        mode = "code";
        continue;
      }
      if (mode === "template" && char === "$" && next === "{") {
        mode = "code";
        templateExpressionDepth = 1;
        i++;
      }
      continue;
    }

    if (char === "\n") {
      line++;
      continue;
    }
    // JVM triple-quoted 字串開頭：依 config 支援 `"""` 與 / 或 `'''`。
    // tripleDelimiter 必須在 i += 2 之前設定，以利 triple 模式內引用。
    if (jvmTriple !== false && templateExpressionDepth === 0 && tripleExpressionDepth === 0) {
      if (
        (jvmTriple.delimiter === '"' || jvmTriple.delimiter === "both")
        && char === '"'
        && next === '"'
        && normalized[i + 2] === '"'
      ) {
        mode = "triple";
        tripleDelimiter = '"';
        i += 2;
        continue;
      }
      if (
        jvmTriple.delimiter === "both"
        && char === "'"
        && next === "'"
        && normalized[i + 2] === "'"
      ) {
        mode = "triple";
        tripleDelimiter = "'";
        i += 2;
        continue;
      }
    }
    if (char === "'") {
      mode = "single";
      continue;
    }
    if (char === '"') {
      mode = "double";
      continue;
    }
    if (char === "`") {
      mode = "template";
      continue;
    }
    if (templateExpressionDepth > 0 && char === "{") {
      templateExpressionDepth++;
      continue;
    }
    if (templateExpressionDepth > 0 && char === "}") {
      templateExpressionDepth--;
      if (templateExpressionDepth === 0) mode = "template";
      continue;
    }
    if (tripleExpressionDepth > 0 && char === "{") {
      tripleExpressionDepth++;
      continue;
    }
    if (tripleExpressionDepth > 0 && char === "}") {
      tripleExpressionDepth--;
      if (tripleExpressionDepth === 0) mode = "triple";
      continue;
    }
    if (allowLineComments && char === "/" && next === "/" && normalized[i - 1] !== ":") {
      const end = normalized.indexOf("\n", i + 2);
      const lineEnd = end === -1 ? normalized.length : end;
      comments.push({ line, text: normalized.slice(i + 2, lineEnd) });
      i = lineEnd - 1;
      continue;
    }
    if (char === "/" && next === "*") {
      mode = "block";
      blockLine = line;
      blockText = "";
      i++;
    }
  }

  if (mode === "block") pushBlockLine();
  return comments;
}

// ─── Swift Lexer ──────────────────────────────────────────────────

/**
 * Swift 專用 lexer：slash-slash line comment（含三斜線 doc）、可巢狀的
 * slash-star block comment；跳過普通雙引號字串、三引號多行字串、
 * raw string（單行與多行，含多 hash） 的字串內容。
 *
 * 字串插值（普通字串為反斜線加左括號；raw 字串為反斜線加同數量 hash
 * 再加左括號）暫時回到 code mode，其中括號配對內的註解照常抽取；
 * 插值可巢狀（含插值內的字串再插值）。
 * 單引號與反引號在 Swift 不是字串邊界，一律視為 code，避免把泛型、
 * 跳脫識別字內的 slash-shapes 誤判。
 */
export function extractSwiftCommentLines(source: string): SourceCommentLine[] {
  type SwiftMode = "code" | "dstring" | "mstring" | "raw" | "rawmulti" | "block";
  interface InterpFrame {
    returnMode: SwiftMode;
    returnHash: number;
    depth: number;
  }

  const normalized = source.replace(/\r\n/g, "\n");
  const comments: SourceCommentLine[] = [];
  let mode: SwiftMode = "code";
  /** 進入 raw / rawmulti 時鎖定的 `#` 數量；離開時歸零。 */
  let hash = 0;
  let line = 1;
  let blockDepth = 0;
  let blockLine = 1;
  let blockText = "";
  /** block opener（`/*`）在該行的 0-based 欄；首個 block entry 攜帶，續行不帶。 */
  let blockStartColumn: number | undefined = undefined;
  const frames: InterpFrame[] = [];

  const pushBlockLine = (): void => {
    comments.push(blockStartColumn === undefined
      ? { line: blockLine, text: blockText }
      : { line: blockLine, text: blockText, startColumn: blockStartColumn });
    blockText = "";
    blockStartColumn = undefined;
  };

  const countHashes = (from: number): number => {
    let count = 0;
    while (normalized[from + count] === "#") count++;
    return count;
  };

  /** 正規化 source 內 offset 對應的行內 0-based 欄。 */
  const columnOf = (pos: number): number =>
    pos - (normalized.lastIndexOf("\n", pos - 1) + 1);

  let i = 0;
  while (i < normalized.length) {
    const char = normalized[i];
    const next = normalized[i + 1] ?? "";

    if (mode === "block") {
      if (char === "/" && next === "*") {
        blockDepth++;
        blockText += "/*";
        i += 2;
        continue;
      }
      if (char === "*" && next === "/") {
        blockDepth--;
        i += 2;
        if (blockDepth === 0) {
          pushBlockLine();
          mode = "code";
        } else {
          blockText += "*/";
        }
        continue;
      }
      if (char === "\n") {
        pushBlockLine();
        line++;
        blockLine = line;
        i++;
        continue;
      }
      blockText += char;
      i++;
      continue;
    }

    if (mode === "dstring" || mode === "mstring") {
      // 插值 `\(` 回到 code mode；括號配對由 frames 追蹤。
      if (char === "\\" && next === "(") {
        frames.push({ returnMode: mode, returnHash: 0, depth: 1 });
        mode = "code";
        i += 2;
        continue;
      }
      if (char === "\\") {
        if (next === "\n") line++;
        i += 2;
        continue;
      }
      if (
        mode === "mstring"
        && char === '"'
        && next === '"'
        && normalized[i + 2] === '"'
      ) {
        mode = "code";
        i += 3;
        continue;
      }
      if (mode === "dstring" && char === '"') {
        mode = "code";
        i++;
        continue;
      }
      if (char === "\n") {
        line++;
        // 單行字串不可跨行：視為未閉合，做 error recovery 回到 code，
        // 避免吞掉後續真實註解。
        if (mode === "dstring") mode = "code";
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (mode === "raw" || mode === "rawmulti") {
      // raw 內無 escape；插值 opener 為 `\` + 同數量 `#` + `(`。
      if (char === "\\") {
        const hashes = countHashes(i + 1);
        if (hashes === hash && normalized[i + 1 + hashes] === "(") {
          frames.push({ returnMode: mode, returnHash: hash, depth: 1 });
          mode = "code";
          i += 2 + hashes;
          continue;
        }
        i++;
        continue;
      }
      if (char === "\n") {
        line++;
        if (mode === "raw") mode = "code";
        i++;
        continue;
      }
      if (
        mode === "rawmulti"
        && char === '"'
        && next === '"'
        && normalized[i + 2] === '"'
      ) {
        const hashes = countHashes(i + 3);
        if (hashes >= hash) {
          const consumed = hash;
          mode = "code";
          hash = 0;
          i += 3 + consumed;
          continue;
        }
        i++;
        continue;
      }
      if (mode === "raw" && char === '"') {
        const hashes = countHashes(i + 1);
        if (hashes >= hash) {
          mode = "code";
          const consumed = hash;
          hash = 0;
          i += 1 + consumed;
          continue;
        }
        i++;
        continue;
      }
      i++;
      continue;
    }

    // mode === "code"
    if (char === "\n") {
      line++;
      i++;
      continue;
    }
    // 插值內的括號配對：字串 / block 另有 mode 分支，不會誤觸此處。
    if (frames.length > 0 && char === "(") {
      frames[frames.length - 1].depth++;
      i++;
      continue;
    }
    if (frames.length > 0 && char === ")") {
      const frame = frames[frames.length - 1];
      frame.depth--;
      i++;
      if (frame.depth === 0) {
        frames.pop();
        mode = frame.returnMode;
        hash = frame.returnHash;
      }
      continue;
    }
    // raw 開啟：`#*"""`（多行）優先於 `#*"`（單行）；`#if` 等 directive
    // 因後綴非 `"` 而直通為 code。
    if (char === "#") {
      const hashes = countHashes(i);
      if (normalized.slice(i + hashes, i + hashes + 3) === '"""') {
        mode = "rawmulti";
        hash = hashes;
        i += hashes + 3;
        continue;
      }
      if (normalized[i + hashes] === '"') {
        mode = "raw";
        hash = hashes;
        i += hashes + 1;
        continue;
      }
      i++;
      continue;
    }
    if (char === '"' && next === '"' && normalized[i + 2] === '"') {
      mode = "mstring";
      i += 3;
      continue;
    }
    if (char === '"') {
      mode = "dstring";
      i++;
      continue;
    }
    // 單引號與反引號在 Swift 不是字串邊界，保持 code。
    if (char === "/" && next === "/") {
      const end = normalized.indexOf("\n", i + 2);
      const lineEnd = end === -1 ? normalized.length : end;
      comments.push({ line, text: normalized.slice(i + 2, lineEnd), startColumn: columnOf(i) });
      i = lineEnd;
      continue;
    }
    if (char === "/" && next === "*") {
      mode = "block";
      blockDepth = 1;
      blockLine = line;
      blockText = "";
      blockStartColumn = columnOf(i);
      i += 2;
      continue;
    }
    i++;
  }

  if (mode === "block") pushBlockLine();
  return comments;
}
