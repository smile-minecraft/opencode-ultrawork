# 舊測試歸屬對照表——歷史對照

> **歷史文件**：V1→V2 測試遷移已完成，這份表是當時的決策紀錄（哪些舊測試被移植、
> 哪些被刻意淘汰、原因是什麼），不是待辦清單。**表中的舊測試名是歷史鍵**：
> 對應的 V1 測試檔在 V2 repo 已不存在，無法、也不需要再逐項驗證；新增測試
> 請直接寫 V2 案例，不要回來擴充這份表。

> 這一版以 V2 原生模組測試為準。標示「群組覆蓋」表示該舊測試的主題已由本目錄的整合案例覆蓋，但沒有逐條複製所有 fixture。

| 舊測試 | 歸屬 | V2 位置／處理 |
|---|---|---|
| 00-smoke | 本任務・群組覆蓋 | `module.test.ts` |
| 01-tool-registry-parity | 本任務 | `tool-parity.test.ts`（四組 schema 抽驗） |
| 02-g5-receipt | memory + 本任務 | validator 在 memory 模組；complete 閘門在 `state-content.test.ts` |
| 03-shell-injection | kit | 已移植別處 |
| 04-plan-link | 本任務・群組覆蓋 | `state-content.test.ts` |
| 05-content-delete | 本任務 | `state-content.test.ts`（preview/apply） |
| 06-atomic-write | kit | 已移植別處 |
| 07-hooks | 本任務 | `hooks.test.ts` |
| 07-presplit-contract | 本任務・群組覆蓋 | `tool-parity.test.ts` |
| 08-path-guard | kit | 已移植別處 |
| 08-content-leaf-sanity | 本任務・群組覆蓋 | `state-content.test.ts` |
| 09-isolated-negative | 本任務 + memory | 核心錯誤路徑在 `state-content.test.ts`；memory 負向在 memory 模組 |
| 10-patch-paths | comment-signal／kit | 已移植別處 |
| 10-bootstrap-modes | diagnostics | 刻意淘汰：診斷工具不在 workflow 任務 |
| 11-state-projection | 本任務・群組覆蓋 | `state-content.test.ts`、`registry-lock.test.ts` |
| 12-project-memory-tools | memory | 已移植別處 |
| 13-registry-history-trim | 本任務・群組覆蓋 | registry helper 隨狀態機保留 |
| 14-doctor-memory-budget | diagnostics | 刻意淘汰：診斷工具不屬 workflow |
| 15-registry-auto-trim | 本任務・群組覆蓋 | registry helper 隨狀態機保留 |
| 16-receipt-auto-trim | memory | 已移植別處 |
| 17-phase5-tools | diagnostics | 刻意淘汰：診斷工具不屬 workflow |
| 18-harness-lifecycle | V1 harness | 淘汰：測的是舊 `server()`／假 V1 harness |
| 19-loader-runtime-integration | V1 loader | 淘汰：測的是舊入口與 bridge |
| 20-legacy-disabled-boundary | 舊後端 | 淘汰：舊後端已移除 |
| 21-baseline-automation | diagnostics／repo gate | 由 `baseline:uw:check` 取代 |
| 22-plan-protection-lifecycle | 本任務・群組覆蓋 | `state-content.test.ts` |
| 23-plan-completion-tombstones | 本任務・群組覆蓋 | task complete 與 plan 狀態機案例 |
| 24-comment-signal-parent-child | comment-signal | 已移植別處 |
| 25-verification-run | verification | 已移植別處 |
| 26-state-machine-hardening | 本任務・群組覆蓋 | `state-content.test.ts` |
| 26-maintenance-tools | 本任務・群組覆蓋 | registry／content 工具案例 |
| 27-plan-lifecycle-recovery | 本任務 | `state-content.test.ts`、`registry-lock.test.ts`；含 plan-progress-reconcile 與其他 registry 寫入並行保留兩邊結果 |
| 27-plan-progress-reconcile | 本任務 | `registry-lock.test.ts`：apply 交易與並行 stale-overwrite 案例 |
| 27-search-tools-v2 | search | 已移植別處 |
| 28-plan-lifecycle-recovery-followup | 本任務・群組覆蓋 | `state-content.test.ts` |
| 28-standalone-task-content | 本任務・群組覆蓋 | content store 隨 task／plan 工具保留 |
| 29-tool-output-contract | 本任務 | `tool-parity.test.ts` |
| 30-skiller-tools | skiller | 已移植別處 |
| 31-prompt-injection-boundaries | 本任務・群組覆蓋 | `hooks.test.ts` |
| 32-registry-fail-closed | 本任務 | `state-content.test.ts`、`registry-lock.test.ts`；包含實際工具並行建立、雙檔交易回滾與 writePlansRegistry 第二檔失敗 |
| 33-tool-catalog-consistency | diagnostics | baseline 與 module 註冊測試分擔 |
| 34-content-read-api | 本任務・群組覆蓋 | `state-content.test.ts` |
| 35-content-store | 本任務・群組覆蓋 | `state-content.test.ts` |
| 36-content-write-api | 本任務 | `state-content.test.ts`、`registry-lock.test.ts`；writePlansRegistry 交易失敗以實際 plan-content-create 呼叫驗證 |
| 37-content-write-api-2 | 本任務・群組覆蓋 | `state-content.test.ts` |
| 38-content-grep-and-recovery | 本任務・群組覆蓋 | content helper 隨 plan／task 工具保留 |
| 39-line-diff | skiller／content | 已移植別處或由共用 helper 覆蓋 |
| 40-content-roundtrip-hygiene | 本任務 | `state-content.test.ts` |
| 41-tool-guidance-error-messages | 本任務 | `hooks.test.ts` |
| 42-project-md-policy | memory | 已移植別處 |
| 43-skiller-draft-ops-and-restore | skiller | 已移植別處 |
| 44-review-gate | 本任務 | `state-content.test.ts` |
| 45-session-task-isolation | 本任務・群組覆蓋 | `hooks.test.ts`、storage 測試 |
| 46-change-scope-check | verification | 已移植別處 |
| 47-skiller-import | skiller | 已移植別處 |
| 48-skiller-policy-update | skiller | 已移植別處 |
| 49-skiller-permission-routing | skiller | 已移植別處 |
| 50-system-prompt-cache-stability | skills + 本任務 | skills 已在別處移植；workflow 穩定段在 `hooks.test.ts` |
| 51-tool-catalog-determinism | diagnostics + 本任務 | 目錄由 baseline 負責；workflow transform 在 `module.test.ts` |
| 52-state-query-projection | 本任務・群組覆蓋 | 狀態機與 content 案例 |
| 53-readiness-consistency | 本任務・群組覆蓋 | `state-content.test.ts` |
| 54-acceptance-gate | 本任務 | `state-content.test.ts` |
| 55-skill-catalog | skills | 已移植別處；唯一 repo 專屬測試保留 skip |
| 56-ultra-coder-escalation | 本任務 | `hooks.test.ts` |
| work-order-build | 本任務 | `work-order-store.test.ts`、`hooks.test.ts` |
| gates/evidence-pack | 本任務・群組覆蓋 | `hooks.test.ts` |
| comment-signal/** | comment-signal | 已移植別處 |
