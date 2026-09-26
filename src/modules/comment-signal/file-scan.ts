/**
 * opencode-ultrawork — Comment Signal Module：file scan helper
 *
 * 角色：
 *   - 提供 `listDirectoryFiles(worktree, dirPath)`：遞迴列舉資料夾內符合
 *     SCAN_EXTENSIONS 的檔案，回傳相對於 worktree 的 POSIX 路徑清單。
 *   - 提供 `isDirectoryTargetPath(worktree, path)`：explicit path 該走資料夾
 *     列舉或單檔讀取的單一判斷點（check／baseline／only_new 共用）。
 *   - 從原本 `src/tools/registry.ts` inline 抽出的純函式（無 closure 依賴）。
 *   - 同時提供 `SCAN_EXTENSIONS` / `SCAN_EXCLUDED_DIRS` 兩個常數供測試與
 *     registry 共享單一事實來源。
 *
 * 設計重點：
 *   - 純函式：不讀 registry、不引入 plugin 依賴；任何測試可獨立呼叫。
 *   - 排除 `node_modules` / `dist` / `.git` / `coverage` / `.next` / `build` /
 *     `.turbo` / `.cache` / `.opencode` / `.obsidian` 等雜訊目錄，另排除
 *     Swift / Xcode 產物（`.build` / `DerivedData` / `.swiftpm`）。
 *   - dot 目錄與 dot 檔分開處理：一般的 dot 目錄（如 `.github`）放行，
 *     其下的可掃描檔照常列舉；dot 檔（basename 以 `.` 開頭的隱藏檔）排除，
 *     `.env.example` 除外。
 *   - Markdown（`.md` / `.markdown`）刻意排除：Comment Signal 系統完全不掃
 *     MD 檔案。
 *   - 結果排序便於測試斷言穩定。
 *
 * 對外規則（不可破壞）：
 *   - `listDirectoryFiles` 在目錄不存在 / 不是資料夾時回 `null`（與原實作一致）。
 *   - 回傳值為相對路徑 POSIX 字串，POSIX 分隔符統一。
 *   - 不引入 IO 副作用以外的拋錯；permission / symlink loop 等一律 try-catch 跳過。
 *
 * 限制：
 *   - 不得 import `src/tools/registry.ts`（避免循環依賴）。
 *   - 不修改 caller 的 read / write 行為；本模組僅負責列舉。
 *
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isSensitivePath } from "../../kit/path-guard.ts";
import { isCanonicalInsideWorktree, resolveCanonicalRoot, resolveCanonicalTarget } from "./containment.ts";

/** 敏感檔名判定只有 kit 一份；這裡轉匯出，保持既有 import 路徑可用。 */
export { isSensitivePath } from "../../kit/path-guard.ts";

// ─── Constants ───────────────────────────────────────────────

/** Comment Signal 系統認可的文字副檔名集合（不含 .md / .markdown）。
 *
 * 納入標準：該語言的註解語法有對應的 lexer 分支，能正確抽出註解——
 *   - 雙斜線行註解＋斜線星號區塊註解：C-family（.go／.rs／.c／.h 及其
 *     sibling）與 JS 變體（.mjs／.cjs）沿用既有 js-style lexer；
 *   - `#`：.py／.toml 走 hash lexer（三引號多行字串除外，見 lexer）。
 * 無對應分支的語言（.rb／.php／.lua／.sql 等）不納入，避免誤判。
 */
export const SCAN_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
  ".json", ".css", ".html", ".vue", ".svelte",
  ".yaml", ".yml", ".txt", ".sh",
  // JVM source：與 TS/JS 共用 `//` 與 `/* */` 註解語法，parser 可直接沿用
  // 既有 tag header 規則產生 violations。
  ".java", ".kt", ".kts", ".groovy",
  // Swift source：`//`（含 `///` doc）與可巢狀 `/* */`，由 Swift lexer
  // 處理字串 / raw string / 插值邊界後沿用既有 tag header 規則。
  ".swift",
  // `#` 註解語言：hash lexer＋parser `#` tag header。
  ".py", ".toml",
  // C-family：`//` 與 `/* */`，既有 js-style lexer 直接沿用。
  ".go", ".rs", ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp",
]);

/** 預設排除的雜訊目錄（避免掃描 build artifacts / VCS / opencode 自身）。 */
export const SCAN_EXCLUDED_DIRS = new Set([
  "node_modules", "dist", ".git", "coverage",
  ".next", "build", ".turbo", ".cache",
  ".opencode", ".obsidian",
  // Swift / Xcode 建置產物：SwiftPM `.build`、Xcode `DerivedData`、
  // SwiftPM 快取 `.swiftpm`（皆為機器產生目錄，不含手寫註解）。
  ".build", "DerivedData", ".swiftpm",
  // Python 生態的機器產生目錄：`.py` 納入掃描後，虛擬環境與 bytecode 快取
  // 會帶進大量第三方原始碼（純誤報來源，且拖慢掃描）。
  "__pycache__", ".venv",
]);

/**
 * 判斷 `path` 是否指向 worktree 根目錄本身。
 *
 * 用於「整專案重掃」這種完整範圍的判定：只有涵蓋整個 worktree 的掃描才能
 * 替一個不知道範圍的舊阻斷（升級前遺留下來、歸不出檔案的那筆）重新確立
 * 真相。局部路徑（`src`、`.github`）不行——那連範圍都沒涵蓋完整。
 *
 * 以「解析後的絕對路徑是否等於 worktree 根」判定，而不是比對字面形狀：
 * 單看形狀會把 `/`（主機根目錄）當成根，那是錯的。比較時走 canonical
 * 解析，讓 symlinked worktree 與其真身視為同一個根。
 */
export function isWorktreeRootPath(worktree: string, path: string): boolean {
  if (!worktree) return false;
  const canonicalRoot = resolveCanonicalRoot(worktree);
  const root = canonicalRoot ?? resolve(worktree);
  // 直接把原始 path 交給 resolve，不先去掉尾斜線：先去尾斜線會把 "/"
  // 變成 ""，主機根目錄就被誤判成 worktree 根了。resolve 本身已經把
  // "."／""／"./"／"a//" 這些寫法正規化好。
  return resolve(root, path) === root;
}

/**
 * 判斷 explicit `path` 該走「資料夾列舉」還是「單檔讀取」。
 *
 * 這是三個工具（check／baseline／only_new）共用的單一判斷點。過去各呼叫端
 * 各自用同一段副檔名啟發式判斷，導致兩類問題：
 *   - `.github`／`.hidden` 這類名稱本身帶點號，會被誤判成「副檔名齊全的
 *     檔案」而整棵目錄不掃描（dot 目錄放行的規則形同虛設）。
 *   - 規則一旦修正就要改三處，容易漏。
 *
 * 判斷順序：先看檔案系統（存在且是目錄 → 資料夾；存在且是檔案 → 單檔），
 * 不存在時才退回字面啟發式（尾斜線，或 basename 沒有副檔名 → 資料夾）。
 * 以檔案系統為準才能正確處理 dot 目錄：`.github` 這種名稱本身帶點號，只看
 * 副檔名會被當成檔案，整棵目錄就永遠不會被掃到。
 *
 * 退回路徑（目標不存在）刻意往「視為資料夾」傾斜：路徑不存在時，caller 會
 * 拿到 `directory_unreadable` 而 fail closed，而不是回空報告假裝通過。寧可
 * 叫使用者把路徑修好，也不要讓沒被掃描過的路徑靜靜地通過。
 *
 * 純讀取判定，不做任何掃描；stat 失敗（權限／斷掉的 symlink）一律走啟發式。
 */
export function isDirectoryTargetPath(worktree: string, path: string): boolean {
  const cleaned = path.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (cleaned === "") return true;
  const absolute = resolve(worktree, cleaned);
  try {
    return statSync(absolute).isDirectory();
  } catch {
    // 檔案系統答不了（不存在／不可讀／斷鏈）→ 用字面形狀判斷。
    if (path.endsWith("/")) return true;
    const basename = cleaned.split("/").pop() ?? "";
    const dotIdx = basename.lastIndexOf(".");
    // 只有「開頭的點」不算副檔名：`.github` 沒有副檔名，`.env.local` 有。
    return dotIdx <= 0;
  }
}

// ─── Explicit path 過濾（與目錄掃描一致）──────────────────────

/**
 * explicit 單檔路徑是否可掃描：跟目錄掃描套用相同三層過濾
 *（dot 檔／支援副檔名／敏感路徑；`.env.example` 豁免）。
 * Markdown 不在此判斷（check 另有 MD 分支先行；explain 沿用既有 MD 行為）。
 *
 * dot 目錄與 dot 檔分開處理：中間路徑段只擋 `SCAN_EXCLUDED_DIRS`
 *（`.git`／`.opencode` 等）與敏感路徑（`.env` 目錄等），一般的 dot 目錄
 *（如 `.github`）放行；只有最後一段（basename）以 `.` 開頭才視為隱藏檔
 * 跳過（`.env.example` 豁免跟以前一致）。
 */
export function isScannableExplicitPath(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") return false;
  const segments = filePath.split("\\").join("/").split("/").filter(Boolean);
  if (segments.length === 0) return false;
  for (const seg of segments.slice(0, -1)) {
    if (SCAN_EXCLUDED_DIRS.has(seg)) return false;
  }
  const basename = segments[segments.length - 1];
  if (basename.startsWith(".") && basename !== ".env.example") return false;
  if (isSensitivePath(filePath)) return false;
  const dotIdx = basename.lastIndexOf(".");
  if (dotIdx < 0) return false;
  return SCAN_EXTENSIONS.has(basename.slice(dotIdx).toLowerCase());
}

// ─── Dir root 政策（與 entry 相同）────────────────────────────

/**
 * 路徑段政策：任一段命中 SCAN_EXCLUDED_DIRS 即排除（`.git`／`.opencode`
 * 等保留）。一般的 dot 目錄（如 `.github`）**不**排除，由種類分支再決定：
 * 目錄往下走，dot  basename 的檔案才跳過（見 `isExcludedWalkFile`）。
 * 敏感判定不含在內，由各呼叫點按需疊加（`isScannableDirRoot` 含之，
 * 走訪 entry 不含——跟既有規則一致，只換判定對象）。
 */
function hasExcludedSegment(relPath: string): boolean {
  const segments = relPath.split("/").filter((s) => s !== "" && s !== ".");
  return segments.some((seg) => SCAN_EXCLUDED_DIRS.has(seg));
}

/**
 * 走訪到的檔案 entry 是否排除：basename 以 `.` 開頭即為隱藏檔，跳過
 *（`.env.example` 豁免，跟顯式單檔一致）。dot 目錄下的檔案不受影響。
 */
function isExcludedWalkFile(basename: string): boolean {
  return basename.startsWith(".") && basename !== ".env.example";
}

/**
 * 顯式資料夾根是否可列舉：對根路徑的每一段套用跟走訪 entry 相同的政策
 *（SCAN_EXCLUDED_DIRS／敏感路徑；一般的 dot 目錄如 `.github` 放行，
 * `.env.example` 豁免跟 entry 一致）。
 * 根本身不受檢 = 敏感／排除目錄的內容會被整批列出，故根必須先擋。
 * 輸入應為政策相對路徑（見 `toPolicyRelativePath`）；純字串判定，不碰 FS。
 */
export function isScannableDirRoot(dirPath: string): boolean {
  // "." 與空字串都指 worktree 本身，不當 segment 檢查。
  if (hasExcludedSegment(dirPath.split("\\").join("/"))) return false;
  if (isSensitivePath(dirPath)) return false;
  return true;
}

// ─── 政策判定的單一入口（canonical 化）──────────────────────

/**
 * 政策判定的單一入口：把字面路徑換算成「相對於 canonical worktree root
 * 的 POSIX 路徑」。canonical 解析成功就用 canonical 結果（symlink 別名
 * 現形，如 `alias/child.ts` → `.hidden/child.ts`）；解析失敗、或 canonical
 * 目標已在 root 外，就回退字面路徑原樣（前者等同既有行為，後者交給
 * containment 判定擋下，不在此改變越界語意）。
 * 呼叫端一律以回傳值做政策判定，不再直接拿字面路徑判定。
 */
export function toPolicyRelativePath(worktree: string, filePath: string): string {
  const lexicalAbs = resolve(worktree, filePath);
  const canonicalRoot = resolveCanonicalRoot(worktree);
  const canonicalTarget = resolveCanonicalTarget(lexicalAbs);
  if (canonicalRoot !== undefined && canonicalTarget !== undefined) {
    const target = canonicalTarget.split("\\").join("/");
    const root = canonicalRoot.split("\\").join("/");
    if (target === root || target.startsWith(`${root}/`)) {
      return relative(canonicalRoot, canonicalTarget).split("\\").join("/");
    }
    // canonical 已在 root 外：回退字面原樣，交給 containment（既有行為）。
    return filePath;
  }
  return filePath;
}

// ─── Public API ──────────────────────────────────────────────

/**
 * 遞迴列舉 `dirPath`（相對於 worktree）內符合 SCAN_EXTENSIONS 的檔案。
 *
 * 行為：
 *   - 根目錄本身先套用跟 entry 相同的政策（dotfile／SCAN_EXCLUDED_DIRS／
 *     敏感路徑）：不合一律回 `null`，不列舉（caller 走 fail-closed 空語意）。
 *   - 目錄不存在 / 不是資料夾時回 `null`。
 *   - 起點或任一 entry canonical 化後超出 worktree（symlink 逃逸）→
 *     起點超出回 `null`，entry 超出则跳過該 entry／子樹。
 *   - permission / symlink loop / read 失敗 → 跳過該子樹。
 *   - 回傳相對於 worktree 的 POSIX 路徑清單（已 sort）。
 *   - 不會跨出 worktree（lexical＋canonical 雙層檢查）。
 */
export function listDirectoryFiles(worktree: string, dirPath: string): string[] | null {
  const cleaned = dirPath.replace(/\/+$/g, "");
  // 根政策（canonical 相對路徑判定；跟 entry 相同）：隱藏／排除／敏感目錄
  // 一律回 null，不列舉。
  if (!isScannableDirRoot(toPolicyRelativePath(worktree, cleaned || "."))) return null;
  const absDir = resolve(worktree, cleaned || ".");
  if (!existsSync(absDir)) return null;
  let stat;
  try {
    stat = statSync(absDir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;
  // canonical containment：起點本身是 symlink→外部時回 null（caller 走 fail-closed）。
  const canonicalRoot = resolveCanonicalRoot(worktree);
  if (canonicalRoot === undefined) return null;
  if (!isCanonicalInsideWorktree(absDir, canonicalRoot)) return null;
  const out: string[] = [];
  const stack: string[] = [absDir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(cur, name);
      // 政策判定一律看 canonical 相對路徑（symlink 別名現形，如 alias 下的
      // 真身 .hidden 段）；輸出仍用 lexical 相對路徑（顯示不變）。
      // 段排除之外再套敏感檔名過濾（跟顯式單檔同一政策；`.env.example` 豁免不變）。
      const policyRel = toPolicyRelativePath(worktree, relative(worktree, full));
      if (hasExcludedSegment(policyRel) || isSensitivePath(policyRel)) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      // canonical containment：symlink 指到 worktree 外的一律跳過。
      if (!isCanonicalInsideWorktree(full, canonicalRoot)) continue;
      if (st.isDirectory()) {
        // dot 目錄本身不是排除對象（上已過濾 EXCLUDED／敏感）：往下走，
        // 其下的檔案由下方的檔案分支再判定。
        stack.push(full);
        continue;
      }
      if (!st.isFile()) continue;
      // dot 檔（隱藏檔）跳過，`.env.example` 豁免跟顯式單檔一致。
      if (isExcludedWalkFile(name)) continue;
      const dotIdx = name.lastIndexOf(".");
      if (dotIdx < 0) continue;
      const ext = name.slice(dotIdx).toLowerCase();
      if (!SCAN_EXTENSIONS.has(ext)) continue;
      const rel = relative(worktree, full).split("\\").join("/");
      out.push(rel);
    }
  }
  out.sort();
  return out;
}

/**
 * Directory listing 語意類別，供 `tool-check.ts` 在 `directoryResolver` 回空陣列
 * 時決定 fail-closed 策略。
 *   - `missing`：目錄不存在或無法 stat（caller 端已另外處理）。
 *   - `empty`：目錄存在但完全沒有 entry（沿用既有 `no_supported_files`
 *     fail-closed 規則）。被政策排除（含敏感檔名）的 entry 不計入，
 *     故只有敏感檔的目錄同樣視為空。
 *   - `markdownOnly`：所有 entry 都是 Markdown（`.md` / `.markdown`）。
 *     依實作說明，Markdown-only 維持零掃描、不形成障礙。
 *   - `hasNonMarkdown`：存在至少一個非 Markdown 的 entry（含 `.csv` / `.png`
 *     等 unsupported 但仍需 fail-closed 的副檔名）。
 *
 * 此列舉只描述 listing 語意，不讀 entry 內容，符合 Markdown exclusion 約束。
 */
export type DirectoryListingKind =
  | "empty"
  | "markdownOnly"
  | "hasNonMarkdown";

/**
 * 遞迴 inspect directory，判定其屬於哪一類 listing。
 *
 * 與 `listDirectoryFiles` 採相同遞迴 / 排除規則（含根政策），確保兩者
 * 對同一目錄的語意一致。回傳 `null` 表示目錄不存在 / 不是資料夾／
 * 根不合政策（caller 應走 `directory_unreadable` fail-closed 分支）。
 *
 * 注意：
 *   - 不讀 entry 內容，只看 basename 與副檔名。
 *   - 與 `listDirectoryFiles` 不同：本函式**不**過濾 SCAN_EXTENSIONS，
 *     因此能區分 `.csv` / `.png` 等 unsupported 副檔名與 Markdown。
 *   - 排除規則（SCAN_EXCLUDED_DIRS / dotfile）與 listing 保持一致，
 *     避免目錄內含 `node_modules` 等雜訊被誤判為 `hasNonMarkdown`。
 */
export function inspectDirectoryListing(
  worktree: string,
  dirPath: string,
): DirectoryListingKind | null {
  const cleaned = dirPath.replace(/\/+$/g, "");
  // 根政策跟 listDirectoryFiles 一致（canonical 相對路徑判定，見 isScannableDirRoot）。
  if (!isScannableDirRoot(toPolicyRelativePath(worktree, cleaned || "."))) return null;
  const absDir = resolve(worktree, cleaned || ".");
  if (!existsSync(absDir)) return null;
  let stat;
  try {
    stat = statSync(absDir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;
  // canonical containment：起點本身是 symlink→外部時回 null（caller 走 fail-closed）。
  const canonicalRoot = resolveCanonicalRoot(worktree);
  if (canonicalRoot === undefined) return null;
  if (!isCanonicalInsideWorktree(absDir, canonicalRoot)) return null;
  let totalEntries = 0;
  let hasNonMarkdown = false;
  const stack: string[] = [absDir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(cur, name);
      // 跟列舉一致：政策判定看 canonical 相對路徑（別名現形才不計入），
      // 再加敏感檔名過濾（只有敏感檔的目錄視為空，見下方）。
      const policyRel = toPolicyRelativePath(worktree, relative(worktree, full));
      if (hasExcludedSegment(policyRel) || isSensitivePath(policyRel)) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      // canonical containment：symlink 指到 worktree 外的一律跳過（與列舉一致）。
      if (!isCanonicalInsideWorktree(full, canonicalRoot)) continue;
      if (st.isDirectory()) {
        // dot 目錄本身不是排除對象：往下走（與列舉一致）。
        stack.push(full);
        continue;
      }
      if (!st.isFile()) continue;
      // dot 檔（隱藏檔）不計入（與列舉一致；`.env.example` 豁免）。
      if (isExcludedWalkFile(name)) continue;
      totalEntries++;
      const dotIdx = name.lastIndexOf(".");
      const ext = dotIdx >= 0 ? name.slice(dotIdx).toLowerCase() : "";
      if (ext !== ".md" && ext !== ".markdown") {
        hasNonMarkdown = true;
      }
    }
  }
  if (totalEntries === 0) return "empty";
  if (hasNonMarkdown) return "hasNonMarkdown";
  return "markdownOnly";
}
