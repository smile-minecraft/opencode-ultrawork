/**
 * 搬遷標記檔的分層記錄。
 *
 * 背景：專案層與全域層共用同一個標記檔名（`<層>/.ultrawork/.migrated-from-opencode.json`）。
 * 當 `projectDir == globalDir`（例如在全域設定資料夾本身開工作階段），兩層其實是同一個
 * 檔案：舊格式只認「檔案存在」，專案層先跑、寫下標記，全域層就靜默早退，四個全域項目
 * 永遠不搬 —— 而且因為標記已經在了，下次啟動也不會重試。
 *
 * 新格式（`version: 2`）：同一份檔案用 `layers.project`／`layers.global` 分層記錄，
 * `alreadyMigrated` 只在「這一層有記錄」時成立。舊格式（`version: 1`、沒有 `layers`）
 * 沒有分層資訊，用內容推斷是哪一層寫的：兩層的 `to` 集合不相交（專案層是 tasks.json／
 * plans.json／…，全域層是 skills-policy.json／skill-drafts／…），看條目落在哪一邊。
 *
 * 空的舊標記（沒有條目）不算涵蓋任何一層：舊版在該層沒有舊資料時也會寫下空標記，
 * 所以「空」證明不了哪一層做過了，只能證明「某一層跑過」。重跑是安全的 —— 搬遷
 * 永遠不覆寫新位置的既有檔案（目標已存在就跳過），空跑一輪只會把標記升級成分層
 * 格式。反而是把它當成已完成，才會讓共用目錄的另一層永遠沒機會搬。
 *
 * 同理，檔案存在但讀不到、不是合法 JSON、JSON 根不是物件時也不算涵蓋：
 * 「讀不懂」視為沒做過，兩端（`migrateLayer` 與 `inspectProjectMigration`）都調
 * 同一個 `markerCoversLayer`，所以診斷端回報待搬、搬移端照常嘗試，成功後標記被
 * 重寫成可解析的分層格式自我修復 —— 不會卡在「doctor 說沒事、資料卻沒搬」。
 *
 * 寫入一律合併：新格式保留另一層的記錄；舊格式若能推斷出是另一層寫的，原樣轉成
 * 那一層的記錄一起帶著（已受影響的實例因此能在下次啟動續搬，不需手動刪標記）。
 */

import { GLOBAL_MIGRATION_ITEMS, PROJECT_MIGRATION_ITEMS } from "./items.ts";
import type { MigrateFsOps } from "./types.ts";

/** 搬遷的層。標記檔名兩層相同，分層靠這裡的 key。 */
export type MigrationLayer = "project" | "global";

/** 某一層的完成記錄（`from`／`to` 都是相對於該層根目錄，和舊格式同一形狀）。 */
export interface MarkerLayerRecord {
  migratedAt: string;
  items: Array<{ from: string; to: string; archivedTo: string }>;
  skipped: Array<{ from: string; to: string; reason?: string }>;
}

/** 標記檔全文：頂層的 `items`／`skipped` 是最後寫入那一層的（與舊格式相容），分層以 `layers` 為準。 */
export interface MarkerDocument {
  version: number;
  migratedAt: string;
  items: MarkerLayerRecord["items"];
  skipped: MarkerLayerRecord["skipped"];
  layers?: Partial<Record<MigrationLayer, MarkerLayerRecord>>;
}

const LAYER_TO_SETS: Record<MigrationLayer, ReadonlySet<string>> = {
  project: new Set(PROJECT_MIGRATION_ITEMS.map((item) => item.to)),
  global: new Set(GLOBAL_MIGRATION_ITEMS.map((item) => item.to)),
};

/** 讀標記檔並解析；檔案不存在、讀不到、不是 JSON、根不是物件就回 `undefined`（呼叫端視為未涵蓋）。 */
export function readMarkerDocument(
  fs: Pick<MigrateFsOps, "existsSync" | "readFileSync">,
  markerPath: string,
): Record<string, unknown> | undefined {
  try {
    if (!fs.existsSync(markerPath)) return undefined;
    // 舊呼叫端可能只注入 `existsSync`／`lstatSync`：沒有讀檔能力就當讀不到，
    // 呼叫端維持「有檔案就跳過」的舊行為。
    if (typeof fs.readFileSync !== "function") return undefined;
    const raw = fs.readFileSync(markerPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * 這份標記是否涵蓋該層（該層可以視為已完成）。
 *
 * 搬移端與診斷端共用同一個判斷，對同一個磁碟現況給同一個答案：
 *
 * - 算涵蓋：新格式的 `layers[layer]` 存在（空記錄也算：那是該層自己寫下的完成記錄）；
 *   舊格式有條目且命中該層的 `to` 集合；舊格式條目兩邊都不命中（外來內容，維持舊行為）。
 * - 不算涵蓋：檔案不存在、讀不到、不是合法 JSON、JSON 根不是物件、舊格式空標記。
 *   「讀不懂」一律視為沒做過：重跑是安全的（目標已存在就跳過、不覆寫），成功後標記
 *   會被重寫成可解析的分層格式自我修復；反之若當成已完成，沒搬的資料就永遠沒訊號。
 */
export function markerCoversLayer(payload: unknown, layer: MigrationLayer): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const record = payload as { layers?: unknown; items?: unknown; skipped?: unknown };
  if (typeof record.layers === "object" && record.layers !== null) {
    // 光有 key 不夠：`null`、字串這類無效值不能算完成，否則來源尚在也會早退。
    // 有效記錄（`migratedAt`＋`items`＋`skipped`）才算該層做過；無效就重跑，
    // 成功後合併寫入時會用正確記錄覆掉它。
    return isLayerRecord((record.layers as Partial<Record<MigrationLayer, unknown>>)[layer]);
  }
  const entries = [...asEntryList(record.items), ...asEntryList(record.skipped)];
  if (entries.length === 0) return false;
  const other: MigrationLayer = layer === "project" ? "global" : "project";
  const matchesLayer = entries.some((entry) => LAYER_TO_SETS[layer].has(entry.to));
  if (matchesLayer) return true;
  // 沒有任何條目屬於這一層：只有當另一層確實被指到時才算「沒涵蓋」（續搬）；
  // 條目兩邊都不是（外來內容）就維持舊行為。
  return !entries.some((entry) => LAYER_TO_SETS[other].has(entry.to));
}

/**
 * 寫入某一層的完成記錄，回傳要落檔的全文。
 *
 * - 新格式的另一層記錄原樣保留。
 * - 舊格式若能推斷出是另一層寫的（`markerCoversLayer(existing, other)` 且不是空標記），
 *   把它的條目轉成那一層的記錄一起帶著；推斷不出來就不帶（空標記本來就沒有資訊）。
 * - 頂層 `items`／`skipped` 照舊放「這次寫入那一層」的，舊讀者不受影響。
 */
export function buildMarkerDocument(
  existing: unknown,
  layer: MigrationLayer,
  record: MarkerLayerRecord,
): MarkerDocument {
  const layers: Partial<Record<MigrationLayer, MarkerLayerRecord>> = {};
  const existingRecord = existing as { layers?: unknown; migratedAt?: unknown } | null;
  if (typeof existing === "object" && existing !== null && typeof existingRecord?.layers === "object" && existingRecord.layers !== null) {
    const other: MigrationLayer = layer === "project" ? "global" : "project";
    const otherRecord = (existingRecord.layers as Partial<Record<MigrationLayer, unknown>>)[other];
    if (isLayerRecord(otherRecord)) layers[other] = otherRecord;
  } else {
    const converted = convertLegacyMarker(existing, layer);
    if (converted !== undefined) layers[converted.layer] = converted.record;
  }
  layers[layer] = record;
  return {
    version: 2,
    migratedAt: record.migratedAt,
    items: record.items,
    skipped: record.skipped,
    layers,
  };
}

/**
 * 舊格式轉另一層的記錄：只有「條目非空、且明確指向另一層」才轉；空標記沒有資訊，
 * 不憑空捏造另一層的完成記錄（否則共用目錄的空標記會讓另一層永遠被跳過）。
 */
function convertLegacyMarker(
  existing: unknown,
  current: MigrationLayer,
): { layer: MigrationLayer; record: MarkerLayerRecord } | undefined {
  if (typeof existing !== "object" || existing === null) return undefined;
  const other: MigrationLayer = current === "project" ? "global" : "project";
  const source = existing as {
    migratedAt?: unknown;
    items?: unknown;
    skipped?: unknown;
  };
  const items = asEntryList(source.items, true);
  const skipped = asEntryList(source.skipped, false);
  if (items.length + skipped.length === 0) return undefined;
  if (!markerCoversLayer(existing, other)) return undefined;
  if (markerCoversLayer(existing, current)) return undefined;
  return {
    layer: other,
    record: {
      migratedAt: typeof source.migratedAt === "string" ? source.migratedAt : new Date().toISOString(),
      items: items.map((entry) => ({ from: entry.from, to: entry.to, archivedTo: entry.archivedTo ?? "" })),
      skipped: skipped.map((entry) => ({ from: entry.from, to: entry.to, reason: entry.reason })),
    },
  };
}

function asEntryList(
  value: unknown,
  requireArchivedTo = false,
): Array<{ from: string; to: string; archivedTo?: string; reason?: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ from: string; to: string; archivedTo?: string; reason?: string }> = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { from, to, archivedTo, reason } = entry as Record<string, unknown>;
    if (typeof from !== "string" || typeof to !== "string") continue;
    if (requireArchivedTo && typeof archivedTo !== "string") continue;
    out.push({
      from,
      to,
      ...(typeof archivedTo === "string" ? { archivedTo } : {}),
      ...(typeof reason === "string" ? { reason } : {}),
    });
  }
  return out;
}

function isLayerRecord(value: unknown): value is MarkerLayerRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { migratedAt?: unknown; items?: unknown; skipped?: unknown };
  return (
    typeof record.migratedAt === "string" && Array.isArray(record.items) && Array.isArray(record.skipped)
  );
}
