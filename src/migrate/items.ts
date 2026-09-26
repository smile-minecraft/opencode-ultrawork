/**
 * 舊→新搬遷對照表。
 *
 * 對應企劃書 4.4 節的對照表。`from`／`to` 都是相對於該層根目錄的路徑；
 * 兩層共用同一套逐項演算法（見 `migrate.ts`），差別只有項目清單。
 */

/** 單一搬遷項目。 */
export interface MigrationItem {
  /** 舊位置（相對於該層根目錄）。 */
  from: string;
  /** 新位置（相對於該層根目錄）。 */
  to: string;
}

/**
 * 專案層：`<專案>/.opencode/` 的記憶與計畫資料 → `<專案>/.ultrawork/`。
 *
 * 刻意不搬 `<專案>/.opencode/skills`、`skill-drafts`、`skill-quarantine`：
 * project scope 的技能探索位置沿用 OpenCode 的 `.opencode/skills`
 * （見 `src/modules/skiller/skiller-common.ts` 的說明），而草稿區與隔離區
 * 是全域 skiller 的資料（見下方的全域清單）。搬走會動到已結案的 skiller 行為，
 * 而且企劃書 4.4 節的對照表只列了上面的記憶與計畫資料。
 */
export const PROJECT_MIGRATION_ITEMS: readonly MigrationItem[] = [
  { from: ".opencode/memory/tasks.json", to: ".ultrawork/tasks.json" },
  { from: ".opencode/memory/plans.json", to: ".ultrawork/plans.json" },
  { from: ".opencode/memory/state.md", to: ".ultrawork/state.md" },
  { from: ".opencode/memory/audit.jsonl", to: ".ultrawork/audit.jsonl" },
  { from: ".opencode/memory/project.md", to: ".ultrawork/project.md" },
  { from: ".opencode/memory/comment-signal-baseline.json", to: ".ultrawork/comment-signal-baseline.json" },
  { from: ".opencode/memory/receipts", to: ".ultrawork/receipts" },
  { from: ".opencode/plans", to: ".ultrawork/plans" },
];

/**
 * 全域層：全域設定資料夾根目錄的 skiller 資料 → `<全域>/.ultrawork/`。
 *
 * 刻意不搬 `$XDG_DATA_HOME` 底下 change-scope 的快取快照：企劃書 4.4 節的對照表
 * 有列它，但同一節把 `cache/` 定義成「可以重建的東西」，change-scope 快照就是
 * 這種重建成本低、卻會隨專案路徑漂移的資料；不快照不會損失任何使用者資料。
 */
export const GLOBAL_MIGRATION_ITEMS: readonly MigrationItem[] = [
  { from: "skills-policy.json", to: ".ultrawork/skills-policy.json" },
  { from: "skills-personal.json", to: ".ultrawork/skills-personal.json" },
  { from: "skill-drafts", to: ".ultrawork/skill-drafts" },
  { from: "skill-quarantine", to: ".ultrawork/skill-quarantine" },
];

/**
 * 診斷用的舊資料位置：`<專案>/.opencode/` 下只要這兩個之一還在，
 * 就是還沒搬完（或搬失敗）。
 */
export const LEGACY_PROJECT_SOURCES: readonly string[] = [".opencode/memory", ".opencode/plans"];
