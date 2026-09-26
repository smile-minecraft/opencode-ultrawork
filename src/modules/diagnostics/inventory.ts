/**
 * 凍結介面的單一正式資料：49 個工具、6 個 hook、11 個分類、41 個來源。
 *
 * 這份表是**對外介面的唯一正式資料**，也是它的比對基準：工具名稱、參數與
 * 回傳格式是這個外掛對呼叫端承諾的介面，改動前要先取得使用者同意。
 * `tests/v2/native/diagnostics/tool-parity.test.ts` 內嵌一份同樣的凍結清單
 * 逐項比對這裡的常數；兩邊不一致就是介面漂移，該測試會失敗。
 *
 * `source` 一律填 V2 的實際檔案位置（`src/modules/**`），不是模組的邏輯分組。
 * 因為它宣稱的是「這個工具的程式碼在哪裡」，填一個不存在的路徑等於給出
 * 死路資訊，`tool-parity.test.ts` 會直接檢查每個來源檔真的存在。
 *
 * 診斷工具自己知道實際註冊了哪些工具名（`defineTool` 回傳的 `name`），
 * 但跨模組的完整登錄清單由 `ctx.tool.list()` 提供；取不到時
 * `workflow_health_check` 會把該項比對標成 skipped 並寫明原因。
 */

/** 工具分類（語意分類，與舊版 `ToolCategory` union 相同）。 */
export type ToolCategory =
  | "grep_peek"
  | "task_state"
  | "plan_state"
  | "plan_content"
  | "task_content"
  | "workflow"
  | "memory_curation"
  | "memory_query"
  | "comment_signal"
  | "verification"
  | "skill"
  | "self_diagnostic";

/** 承載工具的 V2 模組 key（對應 `settings.modules`）。 */
export type InventoryModuleKey =
  | "search"
  | "verification"
  | "commentSignal"
  | "skills"
  | "skiller"
  | "workflow"
  | "diagnostics"
  | "memory";

/**
 * Event hooks（沿用舊版 `HOOK_NAMES` 的 6 個名稱）。
 *
 * 舊版名稱是 OpenCode 公開事件名；V2 的註冊點是 `ctx.event`／`ctx.tool.hook`／
 * `ctx.session.hook`／`ctx.tool.transform`，對應關係寫在 `HOOK_WIRING_SOURCE`。
 * 名字本身是凍結介面，不改名。
 */
export const HOOK_NAMES = [
  "event",
  "tool.execute.before",
  "tool.execute.after",
  "experimental.chat.system.transform",
  "experimental.session.compacting",
  "tool.definition",
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

/** 每個 hook 在 V2 的註冊點；用來判斷 wiring 狀態。 */
export const HOOK_WIRING_SOURCE: Record<HookName, string> = {
  event: "ctx.event.subscribe",
  "tool.execute.before": "ctx.tool.hook('execute.before')",
  "tool.execute.after": "ctx.tool.hook('execute.after')",
  "experimental.chat.system.transform": "ctx.session.hook('context')",
  "experimental.session.compacting": "ctx.session.hook('compaction')",
  "tool.definition": "ctx.tool.transform",
};

/**
 * 工具名 → 來源檔（V2 實際位置）。41 個來源涵蓋 49 個工具。
 * 單一唯一正式資料：其他位置不得另外維護 tool↔source 對應。
 */
export const TOOL_SOURCES: Record<string, string> = {
  "memory-search": "src/modules/memory/tools/memory-search.ts",
  "memory-read": "src/modules/memory/tools/memory-read.ts",
  "memory-note": "src/modules/memory/tools/memory-note.ts",
  "memory-extract": "src/modules/memory/tools/memory-extract.ts",
  "memory-write": "src/modules/memory/tools/memory-write.ts",
  "memory-maintain": "src/modules/memory/tools/memory-maintain.ts",
  "memory-task-close": "src/modules/memory/tools/memory-task-close.ts",

  // search
  grep_context: "src/modules/search/grep-context.ts",
  peek_file: "src/modules/search/peek-file.ts",
  // verification
  verification_run: "src/modules/verification/verification-run.ts",
  "change-scope-check": "src/modules/verification/change-scope-check.ts",
  // comment signal
  comment_signal_check: "src/modules/comment-signal/tool-check.ts",
  comment_signal_policy: "src/modules/comment-signal/tool-policy.ts",
  comment_signal_touched_report: "src/modules/comment-signal/tool-touched-report.ts",
  comment_signal_explain: "src/modules/comment-signal/tool-explain.ts",
  comment_signal_baseline: "src/modules/comment-signal/baseline-tools.ts",
  comment_signal_suppress: "src/modules/comment-signal/baseline-tools.ts",
  comment_signal_only_new: "src/modules/comment-signal/baseline-tools.ts",
  // skills
  skill_search: "src/modules/skills/skill-catalog.ts",
  // skiller
  "skiller-scan": "src/modules/skiller/skiller-scan.ts",
  "skiller-validate": "src/modules/skiller/skiller-validate.ts",
  "skiller-draft": "src/modules/skiller/skiller-draft.ts",
  "skiller-draft-read": "src/modules/skiller/skiller-draft-ops.ts",
  "skiller-draft-update": "src/modules/skiller/skiller-draft-ops.ts",
  "skiller-draft-delete": "src/modules/skiller/skiller-draft-ops.ts",
  "skiller-promote": "src/modules/skiller/skiller-promote.ts",
  "skiller-retire": "src/modules/skiller/skiller-retire.ts",
  "skiller-restore": "src/modules/skiller/skiller-restore.ts",
  "skiller-import": "src/modules/skiller/skiller-import.ts",
  "skiller-policy-update": "src/modules/skiller/skiller-policy-update.ts",
  // workflow：任務與計畫狀態
  "task-state-sync": "src/modules/workflow/tools/task-state-sync.ts",
  "plan-state-sync": "src/modules/workflow/tools/plan-state-sync.ts",
  "plan-task-link": "src/modules/workflow/tools/plan-task-link.ts",
  "plan-status": "src/modules/workflow/tools/plan-status.ts",
  "plan-next": "src/modules/workflow/tools/plan-next.ts",
  "plan-progress-reconcile": "src/modules/workflow/tools/plan-progress-reconcile.ts",
  // workflow：內容檔
  "plan-content-create": "src/modules/workflow/tools/plan-content.ts",
  "plan-content-read": "src/modules/workflow/tools/plan-content.ts",
  "plan-content-update": "src/modules/workflow/tools/plan-content.ts",
  "plan-content-delete": "src/modules/workflow/tools/plan-content.ts",
  "task-content-read": "src/modules/workflow/tools/task-content.ts",
  "task-content-update": "src/modules/workflow/tools/task-content.ts",
  "work-order-build": "src/modules/workflow/tools/work-order-build.ts",
  // memory
  // diagnostics（自我診斷）
  workflow_bootstrap: "src/modules/diagnostics/workflow-bootstrap.ts",
  workflow_l1_check: "src/modules/diagnostics/workflow-l1-check.ts",
  workflow_doctor: "src/modules/diagnostics/workflow-doctor.ts",
  workflow_health_check: "src/modules/diagnostics/workflow-health-check.ts",
  ultrawork_selftest: "src/modules/diagnostics/ultrawork-selftest.ts",
  tool_hook_manifest: "src/modules/diagnostics/tool-hook-manifest.ts",
};

/**
 * 工具名 → 分類。
 *
 * 與舊版 `DEFAULT_TOOL_CATEGORY` 相同：診斷三工具的**語意**分類是
 * `self_diagnostic`，但 runtime 表徵歸在 `workflow`，這樣 manifest 的
 * `categories` 維持 11 個。整張表在 `tool-parity.test.ts` 對著內嵌的凍結
 * 清單鎖住。
 */
export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  "memory-search": "memory_query",
  "memory-read": "memory_query",
  "memory-note": "memory_curation",
  "memory-extract": "memory_curation",
  "memory-write": "memory_curation",
  "memory-maintain": "memory_curation",
  "memory-task-close": "memory_curation",

  grep_context: "grep_peek",
  peek_file: "grep_peek",
  "task-state-sync": "task_state",
  "plan-state-sync": "plan_state",
  "plan-task-link": "plan_state",
  "plan-status": "plan_state",
  "plan-next": "plan_state",
  "plan-progress-reconcile": "plan_state",
  "plan-content-create": "plan_content",
  "plan-content-read": "plan_content",
  "plan-content-update": "plan_content",
  "plan-content-delete": "plan_content",
  "task-content-read": "task_content",
  "task-content-update": "task_content",
  workflow_bootstrap: "workflow",
  workflow_l1_check: "workflow",
  workflow_doctor: "workflow",
  workflow_health_check: "workflow",
  comment_signal_check: "comment_signal",
  comment_signal_policy: "comment_signal",
  comment_signal_touched_report: "comment_signal",
  comment_signal_explain: "comment_signal",
  comment_signal_baseline: "comment_signal",
  comment_signal_suppress: "comment_signal",
  comment_signal_only_new: "comment_signal",
  verification_run: "verification",
  "work-order-build": "workflow",
  "change-scope-check": "verification",
  "skiller-scan": "skill",
  skill_search: "skill",
  "skiller-validate": "skill",
  "skiller-draft": "skill",
  "skiller-draft-read": "skill",
  "skiller-draft-update": "skill",
  "skiller-draft-delete": "skill",
  "skiller-promote": "skill",
  "skiller-retire": "skill",
  "skiller-restore": "skill",
  "skiller-import": "skill",
  "skiller-policy-update": "skill",
  ultrawork_selftest: "workflow",
  tool_hook_manifest: "workflow",
};

/**
 * 診斷三工具的**語意**分類（`self_diagnostic`）。
 *
 * 與 `TOOL_CATEGORIES` 分開維護：manifest 對外要維持 11 個分類（runtime 表徵），
 * 這裡保留語意分類給文件與 code review 對照用。與舊版 `TOOL_CATEGORY_MAP` 一致。
 */
export const SELF_DIAGNOSTIC_TOOL_NAMES: readonly string[] = [
  "workflow_health_check",
  "ultrawork_selftest",
  "tool_hook_manifest",
];

/** 診斷三工具在 `TOOL_CATEGORIES` 的 runtime 分類（沿用舊版歸類為 workflow）。 */
export const TOOL_SEMANTIC_CATEGORIES: Record<string, ToolCategory> = {
  workflow_health_check: "self_diagnostic",
  ultrawork_selftest: "self_diagnostic",
  tool_hook_manifest: "self_diagnostic",
};

/**
 * 工具名 → 承載它的 V2 模組 key。
 *
 * 只給 `workflow_health_check` 用：`settings.modules` 可以逐一關閉模組，
 * 關閉的模組不會註冊工具，所以「預期集合」要跟著收斂，否則每次關掉一個模組
 * 就會長期回報 tool-set 不一致。
 */
export const TOOL_MODULES: Record<string, InventoryModuleKey> = {
  "memory-search": "memory",
  "memory-read": "memory",
  "memory-note": "memory",
  "memory-extract": "memory",
  "memory-write": "memory",
  "memory-maintain": "memory",
  "memory-task-close": "memory",

  grep_context: "search",
  peek_file: "search",
  verification_run: "verification",
  "change-scope-check": "verification",
  comment_signal_check: "commentSignal",
  comment_signal_policy: "commentSignal",
  comment_signal_touched_report: "commentSignal",
  comment_signal_explain: "commentSignal",
  comment_signal_baseline: "commentSignal",
  comment_signal_suppress: "commentSignal",
  comment_signal_only_new: "commentSignal",
  skill_search: "skills",
  "skiller-scan": "skiller",
  "skiller-validate": "skiller",
  "skiller-draft": "skiller",
  "skiller-draft-read": "skiller",
  "skiller-draft-update": "skiller",
  "skiller-draft-delete": "skiller",
  "skiller-promote": "skiller",
  "skiller-retire": "skiller",
  "skiller-restore": "skiller",
  "skiller-import": "skiller",
  "skiller-policy-update": "skiller",
  "task-state-sync": "workflow",
  "plan-state-sync": "workflow",
  "plan-task-link": "workflow",
  "plan-status": "workflow",
  "plan-next": "workflow",
  "plan-progress-reconcile": "workflow",
  "plan-content-create": "workflow",
  "plan-content-read": "workflow",
  "plan-content-update": "workflow",
  "plan-content-delete": "workflow",
  "task-content-read": "workflow",
  "task-content-update": "workflow",
  "work-order-build": "workflow",
  workflow_bootstrap: "diagnostics",
  workflow_l1_check: "diagnostics",
  workflow_doctor: "diagnostics",
  workflow_health_check: "diagnostics",
  ultrawork_selftest: "diagnostics",
  tool_hook_manifest: "diagnostics",
};

/** 全部工具名稱（排序後）。這是 `tool_hook_manifest` 與 health_check 的預期集合。 */
export const EXPECTED_TOOL_NAMES: readonly string[] = Object.keys(TOOL_SOURCES).sort();

/** 全部來源路徑（排序後）；數量與凍結清單的來源數相同。 */
export const EXPECTED_SOURCE_PATHS: readonly string[] = Array.from(
  new Set(Object.values(TOOL_SOURCES)),
).sort();

/** 全部 runtime 分類（排序後）；數量與凍結清單的分類數相同。 */
export const EXPECTED_CATEGORIES: readonly string[] = Array.from(
  new Set(Object.values(TOOL_CATEGORIES)),
).sort();

/** 診斷模組自己擁有的 6 個工具（`selftest` 唯一能實際呼叫的對象）。 */
export const DIAGNOSTICS_TOOL_NAMES: readonly string[] = [
  "workflow_bootstrap",
  "workflow_doctor",
  "workflow_health_check",
  "workflow_l1_check",
  "tool_hook_manifest",
  "ultrawork_selftest",
];
