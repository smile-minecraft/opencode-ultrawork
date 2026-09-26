/**
 * `.opencode/` → `.ultrawork/` 的自動搬遷。
 *
 * 這不是可開關模組，由外掛入口 `setupUltrawork` 直接呼叫一次。規則（企劃書 4.4 節）：
 *
 * 1. 某一層只做一次：`<層>/.ultrawork/.migrated-from-opencode.json` 存在就整層跳過。
 * 2. 逐項處理：目標已存在 → 記警告並跳過（舊檔留在原地、不改名）；
 *    目標不存在 → 複製到新位置，再把舊檔改名成 `<原檔名>.migrated-<時間戳>`。
 *    **永遠不刪除使用者資料。**
 * 3. 標記檔只在該層整趟沒有失敗時才寫；全部跳過也算成功。
 * 4. 任一項失敗 → 該層停止、不寫標記、不影響外掛載入。下次啟動重跑時，
 *    已搬的項目因為目標已存在而自然被跳過（冪等收斂）。
 * 5. 凡搬遷會觸及的路徑（每個 `from` 的父層、每個 `to` 的父層，以及標記檔自身
 *    的父層）都必須通過 canonical containment；任何一段是 symlink 就記
 *    `unsafe-path`、該層不寫標記。「標記已經在了」也是一條搬遷路徑，同樣要過。
 *
 * 搬遷本身是唯讀來源 + 寫新位置：唯一的刪除對象是自己建立的搬遷暫存路徑。
 */

import { basename, dirname, join, relative, resolve } from "node:path";
import { atomicWriteFileWithOps } from "../kit/atomic-write.ts";
import { assertContainedPath, isInsideWorktree } from "../kit/path-guard.ts";
import { resolveGlobalUltraworkDir, resolveProjectUltraworkDir } from "../settings/paths.ts";
import { nodeMigrateFsOps } from "./fs-ops.ts";
import { GLOBAL_MIGRATION_ITEMS, LEGACY_PROJECT_SOURCES, PROJECT_MIGRATION_ITEMS, type MigrationItem } from "./items.ts";
import type {
  MigrateFsOps,
  MigrateLayerOptions,
  MigrationGitignoreOutcome,
  MigrationItemOutcome,
  MigrationResult,
  MigrationStateReport,
  ProjectMigrationResult,
  RunMigrationsOptions,
  RunMigrationsResult,
} from "./types.ts";

/** 標記檔名；放進該層的 `.ultrawork/`。 */
export const MIGRATION_MARKER_FILE = ".migrated-from-opencode.json";

/**
 * `.ultrawork/.gitignore` 的內容。
 *
 * `*` 忽略全部（含 cache/ 與資料檔），只留設定檔與檔案自己。
 * 唯讀外掛不該把使用者的資料檔送進版控。
 */
export const ULTRAWORK_GITIGNORE_CONTENT = "*\n!.gitignore\n!ultrawork.jsonc\n";

/** 逐項搬遷一整層（專案層或全域層）。 */
export function migrateProjectData(options: MigrateLayerOptions): ProjectMigrationResult {
  const fs = resolveOps(options);
  const result = migrateLayer("project", options, PROJECT_MIGRATION_ITEMS, resolveProjectUltraworkDir, fs);
  return { ...result, gitignore: ensureUltraworkGitignore(options.root, fs) };
}

/** 逐項搬遷全域層的 skiller 資料。全域層不建 `.gitignore`（企劃書 4.3 節的清單沒有它）。 */
export function migrateGlobalData(options: MigrateLayerOptions): MigrationResult {
  return migrateLayer("global", options, GLOBAL_MIGRATION_ITEMS, resolveGlobalUltraworkDir, resolveOps(options));
}

/**
 * 兩層一起跑，回傳結果與值得記錄的警告。
 *
 * 呼叫端（外掛入口）負責把警告打到 console，並用 try/catch 包住整個呼叫；
 * 要不要跑由呼叫端決定（入口只在專案根目錄存在時呼叫，見 `src/index.ts`）。
 */
export function runMigrations(options: RunMigrationsOptions): RunMigrationsResult {
  const warnings: string[] = [];
  let project: ProjectMigrationResult;
  let global: MigrationResult;
  if (options.projectDir) {
    project = migrateProjectData({ root: options.projectDir, fs: options.fs, now: options.now });
  } else {
    project = { ...emptyResult("project"), gitignore: { path: "", created: false } };
  }
  if (options.globalDir) {
    global = migrateGlobalData({ root: options.globalDir, fs: options.fs, now: options.now });
  } else {
    global = emptyResult("global");
  }
  for (const outcome of [...project.items, ...global.items]) {
    if (outcome.status === "skipped" && outcome.reason === "target-exists") {
      warnings.push(`搬遷略過 ${outcome.from}：${outcome.detail ?? "新位置已有資料"}`);
    }
    if (outcome.status === "failed") {
      warnings.push(`搬遷 ${outcome.from} 失敗：${outcome.detail ?? "未知錯誤"}`);
    }
  }
  return { project, global, warnings };
}

/**
 * 建立 `<專案>/.ultrawork/.gitignore`；已存在就不覆寫。
 *
 * 內容與預設相同時不算警告（正常狀態）；內容不同才提示，因為那通常代表使用者
 * 自己改過或上一版外掛寫了別的內容。
 */
export function ensureUltraworkGitignore(root: string, fs: MigrateFsOps = nodeMigrateFsOps()): MigrationGitignoreOutcome {
  // 根目錄不合法時直接什麼都不做：`resolve()` 會把它解到 cwd，
  // 那就等於在專案外寫檔。
  if (!isUsableRoot(root)) return { path: "", created: false };
  const path = join(resolveProjectUltraworkDir(root), ".gitignore");
  // 與搬遷同一套封頂判準：`.ultrawork` 是 symlink 時不在外部建立任何檔案。
  const unsafe = unsafeParentDetail(root, path, "搬遷路徑（.gitignore）");
  if (unsafe !== undefined) {
    return { path, created: false, warning: `${path} 的上層路徑未通過安全檢查，未建立：${unsafe}` };
  }
  if (fs.existsSync(path)) {
    let existing: string | undefined;
    try {
      existing = fs.readFileSync(path, "utf-8");
    } catch {
      existing = undefined;
    }
    return {
      path,
      created: false,
      ...(existing === ULTRAWORK_GITIGNORE_CONTENT
        ? {}
        : { warning: `${path} 已存在且內容與預設不同，未覆寫` }),
    };
  }
  fs.mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileWithOps(path, ULTRAWORK_GITIGNORE_CONTENT, fs);
  return { path, created: true };
}

/**
 * 診斷用：這個專案的搬遷做完沒有。
 *
 * 舊資料位置仍在、但標記檔不存在 → `pending`，`workflow_doctor` 依此回報。
 * 另一種 `pending` 是「標記存在但 `.ultrawork/` 的父層沒通過封頂」：搬移端在那個
 * 情況回 `unsafe-path` 而不是 `alreadyMigrated`，診斷端必須跟著回 `pending`，
 * 否則 doctor 會對「本專案的舊資料還沒搬」這件事回 `passed`。
 *
 * 「舊資料位置是否仍在」刻意與搬移端共用 `legacyEntryExists()`：兩端對同一個
 * 磁碟現況必須給同一個答案。用會跟隨 symlink 的 `existsSync()` 會讓斷鏈
 * symlink 被回成「不存在」而報成「沒有待搬遷」——但搬移端對同一個磁碟現況是
 * 記 `copy-failed`、不寫標記、每次啟動重試，使用者就拿不到任何訊號。
 *
 * `pending` 為真時另外附上「為什麼還沒搬完」的原因碼與說明（見
 * `markerParentUnsafeDetail()` 與 `firstUnsafeItemDetail()`），讓 `workflow_doctor`
 * 能講出使用者該排除什麼。
 */
export function inspectProjectMigration(
  projectRoot: string,
  fs: Pick<MigrateFsOps, "existsSync" | "lstatSync"> = nodeMigrateFsOps(),
): MigrationStateReport {
  const markerPath = join(resolveProjectUltraworkDir(projectRoot), MIGRATION_MARKER_FILE);
  const markerExists = fs.existsSync(markerPath);
  const legacySources = LEGACY_PROJECT_SOURCES.filter((source) =>
    legacyEntryExists(fs, resolve(projectRoot, source)),
  );
  const base = { markerPath, markerExists, legacySources };
  if (markerExists) {
    // 標記檔的父層就是 `.ultrawork/`。搬移端在「標記已存在」時也會對這個父層做
    // 同一個封頂判準，所以診斷端不能只看標記存在就說「已完成」。
    const unsafe = markerParentUnsafeDetail(projectRoot, markerPath);
    if (unsafe !== undefined) return { ...base, pending: true, reason: "unsafe-path", detail: unsafe };
    return { ...base, pending: false };
  }
  const pending = legacySources.length > 0;
  if (!pending) return { ...base, pending };
  const unsafe = firstUnsafeItemDetail(projectRoot);
  return {
    ...base,
    pending,
    ...(unsafe === undefined ? {} : { reason: "unsafe-path", detail: unsafe }),
  };
}

/**
 * 標記檔的父層（`<專案>/.ultrawork/`）是否沒通過封頂；不通過就回說明文字。
 *
 * 與搬移端讀到既存標記時用的是同一個 `unsafeParentDetail()`，所以兩端對同一個
 * 磁碟現況一定給同一個答案：搬移端回 `unsafe-path`，診斷端就是 `pending`。
 */
function markerParentUnsafeDetail(root: string, markerPath: string): string | undefined {
  if (!isUsableRoot(root)) return undefined;
  return unsafeParentDetail(root, markerPath);
}

/**
 * 重演搬移端的第一個封頂失敗，回說明文字。
 *
 * 用同一個 `unsafeParentDetail()`、同一份項目清單與同一個順序：搬移端在第一個
 * 不通過的項目就整層停止，所以診斷端看到的也是同一個原因。
 *
 * 只重演「不動手就判斷得出來」的封頂失敗。`copy-failed` 這類要真的複製才會發生的
 * 失敗不在這裡重演 —— 診斷工具不該為了講原因而開始搬使用者資料；判斷不出來就
 * 回 `undefined`，由呼叫端沿用原本的「未完成」語意。
 */
function firstUnsafeItemDetail(root: string): string | undefined {
  if (!isUsableRoot(root)) return undefined;
  for (const item of PROJECT_MIGRATION_ITEMS) {
    let from: string;
    let to: string;
    try {
      from = joinLayerPath(root, item.from);
      to = joinLayerPath(root, item.to);
    } catch {
      // 項目清單被改壞到逃出根目錄時，診斷端不猜原因。
      return undefined;
    }
    // 掃到**第一個**不通過的項目就停：這正是搬移端整層停止的位置，兩端因此對同一個
    // 磁碟現況講同一個原因。不在第一項就 return 的話，答案會變成「清單第一項恰好
    // 覆蓋到所有關鍵父層」這個隱性前提 —— 清單一改，doctor 的 reason 就會靜默退回
    // 泛用提示，而搬移端仍在失敗。
    const unsafe = unsafeParentDetail(root, from) ?? unsafeParentDetail(root, to);
    if (unsafe !== undefined) return unsafe;
  }
  return undefined;
}

function resolveOps(options: { fs?: MigrateFsOps }): MigrateFsOps {
  return options.fs ?? nodeMigrateFsOps();
}

/** 根目錄必須是非空字串；空白字串經 `resolve()` 會落到 cwd，不能拿來寫檔。 */
function isUsableRoot(root: unknown): root is string {
  return typeof root === "string" && root.trim() !== "";
}

/**
 * 頂層舊項目「本身」是否存在：不跟隨 symlink 判斷。
 *
 * `existsSync()` 會跟著 symlink 走，所以斷鏈 symlink 會被回成「不存在」而記成
 * `source-missing`，該層卻照樣寫下搬遷標記 —— 資料沒搬走、之後也不會再重試
 * （例如 `skills-policy.json` 指向暫時沒掛載的磁碟）。
 *
 * 改用 `lstatSync()`：只有真的沒有這個項目（`ENOENT`）或路徑中段不是目錄
 * （`ENOTDIR`）才算不存在；斷鏈 symlink 與其他讀不到的情況都當成存在，
 * 交給後續複製去失敗並記 `copy-failed`，該層就不寫標記、下次啟動重試。
 *
 * 這是搬移端與診斷端（`workflow_doctor`）唯一的「舊資料是否存在」判斷；
 * 新增判斷舊資料是否還在的地方一律呼叫這個函式，不要另外再寫一套。
 */
export function legacyEntryExists(fs: Pick<MigrateFsOps, "lstatSync">, path: string): boolean {
  try {
    fs.lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

function emptyResult(layer: "project" | "global"): MigrationResult {
  return {
    layer,
    root: "",
    markerPath: "",
    alreadyMigrated: false,
    ok: true,
    migrated: [],
    skipped: [],
    errors: [],
    items: [],
  };
}

function migrateLayer(
  layer: "project" | "global",
  options: MigrateLayerOptions,
  items: readonly MigrationItem[],
  ultraworkDirOf: (root: string) => string,
  fs: MigrateFsOps,
): MigrationResult {
  const root = options.root;
  const now = options.now ?? ((): Date => new Date());
  const result = emptyResult(layer);
  result.root = root;
  if (!isUsableRoot(root)) {
    // 沒有根目錄就無從搬起；不算失敗，但也不寫標記，下次啟動還會再試。
    return { ...result, ok: true };
  }
  result.markerPath = join(ultraworkDirOf(root), MIGRATION_MARKER_FILE);
  if (fs.existsSync(result.markerPath)) {
    // 「標記已經在了」也是一條搬遷路徑：這一行等於宣告「`<root>/.ultrawork/` 就是本專案
    // 的資料位置」。`.ultrawork/` 是 symlink 時那個宣告指向的是外部目錄，本專案的舊資料
    // 也就永遠不會被搬 —— 所以這裡一樣要過封頂，不通過就記 `unsafe-path` 失敗
    // （不視為已完成，下次啟動仍會嘗試並持續回報），而不是靜默回 `alreadyMigrated`。
    const unsafe = unsafeParentDetail(root, result.markerPath);
    if (unsafe !== undefined) {
      return failLayer(result, {
        from: result.markerPath,
        to: result.markerPath,
        status: "failed",
        reason: "unsafe-path",
        detail: unsafe,
      });
    }
    return { ...result, alreadyMigrated: true };
  }

  for (const item of items) {
    const from = joinLayerPath(root, item.from);
    const to = joinLayerPath(root, item.to);
    // 封頂判準：搬遷要動到的每個路徑，其父層都必須通過 canonical containment。
    // 任何一段是 symlink 就停在這裡 —— 寧可失敗，也不跟著 symlink 去搬外部資料。
    const unsafe = unsafeParentDetail(root, from) ?? unsafeParentDetail(root, to);
    if (unsafe !== undefined) {
      return failLayer(result, { from, to, status: "failed", reason: "unsafe-path", detail: unsafe });
    }
    if (!legacyEntryExists(fs, from)) {
      result.items.push({
        from,
        to,
        status: "skipped",
        reason: "source-missing",
        detail: "舊位置不存在，沒有可搬的資料",
      });
      result.skipped.push(result.items[result.items.length - 1]);
      continue;
    }
    if (fs.existsSync(to)) {
      result.items.push({
        from,
        to,
        status: "skipped",
        reason: "target-exists",
        detail: "新位置已有資料，未覆寫；舊檔留在原地",
      });
      result.skipped.push(result.items[result.items.length - 1]);
      continue;
    }
    try {
      const archivedTo = copyThenRename(from, to, fs, archiveOldPath(from, fs, now()));
      const outcome: MigrationItemOutcome = { from, to, status: "migrated", archivedTo };
      result.items.push(outcome);
      result.migrated.push(outcome);
    } catch (error) {
      // 該層整趟停止：不寫標記，下次啟動重跑。
      return failLayer(result, {
        from,
        to,
        status: "failed",
        reason: "copy-failed",
        detail: errorMessage(error),
      });
    }
  }
  return finishLayer(result, root, fs, now, true);
}

/** 記下一個失敗項目並讓該層整趟停止：不寫標記，下次啟動重跑。 */
function failLayer(result: MigrationResult, outcome: MigrationItemOutcome): MigrationResult {
  result.items.push(outcome);
  result.errors.push(outcome);
  return { ...result, ok: false };
}

function finishLayer(
  result: MigrationResult,
  root: string,
  fs: MigrateFsOps,
  now: () => Date,
  writeMarker: boolean,
): MigrationResult {
  if (!writeMarker) return { ...result, ok: false };
  try {
    fs.mkdirSync(dirname(result.markerPath), { recursive: true });
    atomicWriteFileWithOps(result.markerPath, JSON.stringify(markerPayload(result, root, now()), null, 2) + "\n", fs);
  } catch (error) {
    result.items.push({
      from: result.markerPath,
      to: result.markerPath,
      status: "failed",
      reason: "marker-write-failed",
      detail: errorMessage(error),
    });
    result.errors.push(result.items[result.items.length - 1]);
    return { ...result, ok: false };
  }
  return { ...result, ok: true };
}

/** 標記檔內容；相對於該層根目錄，換機器也讀得懂。 */
function markerPayload(result: MigrationResult, root: string, migratedAt: Date): Record<string, unknown> {
  return {
    version: 1,
    migratedAt: migratedAt.toISOString(),
    items: result.migrated.map((outcome) => ({
      from: relative(root, outcome.from),
      to: relative(root, outcome.to),
      archivedTo: basename(outcome.archivedTo ?? ""),
    })),
    // 只記真正需要注意的跳過（舊位置本來就沒有的不算）。
    skipped: result.skipped
      .filter((outcome) => outcome.reason !== "source-missing")
      .map((outcome) => ({
        from: relative(root, outcome.from),
        to: relative(root, outcome.to),
        reason: outcome.reason,
      })),
  };
}

/**
 * 複製到暫存路徑再 rename 到位。
 *
 * 中途失敗時暫存路徑會被清掉，目標位置不會留下半套資料 ——
 * 否則下一次重跑會因為「目標已存在」而把半套當成搬好了。
 */
function copyThenRename(
  from: string,
  to: string,
  fs: MigrateFsOps,
  archivedTo: string,
): string {
  fs.mkdirSync(dirname(to), { recursive: true });
  const staging = `${to}.partial-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  try {
    copyTree(from, staging, fs);
    fs.renameSync(staging, to);
  } catch (error) {
    try {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // 清理失敗不蓋掉主錯誤。
    }
    throw error;
  }
  fs.renameSync(from, archivedTo);
  return archivedTo;
}

function copyTree(from: string, to: string, fs: MigrateFsOps): void {
  if (fs.statSync(from).isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of [...fs.readdirSync(from)].sort()) {
      copyTree(join(from, entry), join(to, entry), fs);
    }
    return;
  }
  fs.copyFileSync(from, to);
}

/** 舊檔改名保留的位置；撞名時加序號。永不刪除。 */
function archiveOldPath(from: string, fs: MigrateFsOps, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  let candidate = `${from}.migrated-${stamp}`;
  for (let index = 1; fs.existsSync(candidate); index += 1) {
    candidate = `${from}.migrated-${stamp}-${index}`;
  }
  return candidate;
}

/** 項目路徑必須留在該層根目錄內；清單是常數，這裡只是不讓它被改壞時寫到別處。 */
function joinLayerPath(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  if (!isInsideWorktree(target, root)) {
    throw new Error(`搬遷項目路徑逃出該層根目錄：${relativePath}`);
  }
  return target;
}

/**
 * 搬遷路徑的**父層**是否通過 canonical containment；不通過就回說明文字。
 *
 * 沿用 `kit/path-guard` 的同一套判斷（以該層根目錄為錨、逐段 lstat、canonical 落錨內），
 * 這是 skiller 對「模組資料夾是外部 symlink」既有 fail-closed 語意的同一個來源。
 *
 * 只看父層、不看項目本身：項目自己是 symlink 時（例如 `skills-policy.json` 指向
 * 檔案）語意不變，照常複製內容、舊 symlink 改名保留。要擋的是「搬遷會穿過
 * symlink 動手」—— `<專案>/.opencode` 或 `<專案>/.ultrawork` 是 symlink 時，
 * 寫進去的其實是別處的目錄。
 *
 * `allowMissingAnchor` 讓根目錄還沒建立的情況維持原行為（照樣建 `.ultrawork/`）：
 * 錨點存在時這個選項不影響任何判斷。
 */
function unsafeParentDetail(root: string, targetPath: string, label = "搬遷路徑"): string | undefined {
  try {
    assertContainedPath(root, dirname(targetPath), { label, allowMissingAnchor: true });
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
