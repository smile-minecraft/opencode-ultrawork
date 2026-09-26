/** `.opencode/` → `.ultrawork/` 自動搬遷的公開介面。 */

export {
  ensureUltraworkGitignore,
  inspectProjectMigration,
  legacyEntryExists,
  migrateGlobalData,
  migrateProjectData,
  runMigrations,
  MIGRATION_MARKER_FILE,
  ULTRAWORK_GITIGNORE_CONTENT,
} from "./migrate.ts";
export { nodeMigrateFsOps } from "./fs-ops.ts";
export {
  GLOBAL_MIGRATION_ITEMS,
  LEGACY_PROJECT_SOURCES,
  PROJECT_MIGRATION_ITEMS,
  type MigrationItem,
} from "./items.ts";
export type {
  MigrateFsOps,
  MigrateLayerOptions,
  MigrationGitignoreOutcome,
  MigrationItemOutcome,
  MigrationItemStatus,
  MigrationResult,
  MigrationStateReport,
  ProjectMigrationResult,
  RunMigrationsOptions,
  RunMigrationsResult,
} from "./types.ts";
