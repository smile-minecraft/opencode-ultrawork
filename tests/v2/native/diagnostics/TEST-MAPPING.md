# 舊測試歸屬對照表（diagnostics）——歷史對照

> **歷史文件**：V1→V2 測試遷移已完成，這份表是當時的決策紀錄（哪些舊測試被移植、
> 哪些被刻意淘汰、原因是什麼），不是待辦清單。**表中的舊測試名是歷史鍵**：
> 對應的 V1 測試檔在 V2 repo 已不存在，無法、也不需要再逐項驗證；新增測試
> 請直接寫 V2 案例，不要回來擴充這份表。

> 這一版以 V2 原生模組測試為準。標示「群組覆蓋」表示該舊測試的主題已由本目錄的整合案例覆蓋，但沒有逐條複製所有 fixture。
>
> 這份表只列歸屬到 diagnostics 模組的舊測試。其他模組的歸屬見各模組自己的 `TEST-MAPPING.md`；全repo的完整對照見 `tests/v2/native/workflow/TEST-MAPPING.md`。

## 逐檔對照

| 舊測試 | 案例數 | 歸屬 | V2 位置／處理 |
|---|---|---|---|
| 10-bootstrap-modes | 6 | 本模組 | `workflow-bootstrap.test.ts`（8 案）——五種 mode 全覆蓋，另加 refs 指向新資料層、游標回退 |
| 14-doctor-memory-budget | 10 | 本模組 | `workflow-l1-check.test.ts`（11 案）＋ `workflow-doctor.test.ts`（24 案）——記憶體預算、contentRef 缺漏、投影對不上全部覆蓋 |
| 17-phase5-tools（診斷部分） | 27 | 本模組 | `tool-hook-manifest.test.ts`、`workflow-health-check.test.ts`、`ultrawork-selftest.test.ts`、`tool-parity.test.ts` |
| 17-phase5-tools（comment_signal_* 部分） | 11 | comment-signal | 已移植到 comment-signal 模組自己的測試；不在本目錄 |
| 32-registry-fail-closed | 11 | 本模組（本目錄只接診斷側） | `workflow-l1-check.test.ts` 的 frontmatter limit CONFIGURATION_ERROR 三案＋ `workflow-doctor.test.ts` 的 tasks.json／plans.json 損壞標 skipped 兩案；寫入端的 fail-closed 與 lazyEnsure 歸 workflow 模組 |
| 42-project-md-policy | 12 | memory ＋ 本模組 | 政策常數與 fail-closed 解析在 memory 模組；診斷側的反應在 `workflow-l1-check.test.ts`、`workflow-doctor.test.ts` |
| 23-plan-completion-tombstones | 22 | 本模組（本目錄只接診斷側） | `workflow-doctor.test.ts`／`workflow-health-check.test.ts` 的 Plan Registry Health（warn→degraded、error→failed）；`inspectPlanRegistry` 純函式的八類 check 由 workflow 模組自己測 |
| 15-registry-auto-trim | 12 | 本模組（本目錄只接診斷側） | 修剪行為在 workflow 模組；診斷端只讀修剪後的結果，見 `workflow-doctor.test.ts` 的 registry 讀取案例 |
| 38-content-grep-and-recovery | 13 | 本模組（本目錄只接診斷側） | grep／write API 在 workflow 模組；`.content-store-inconsistent` 的診斷在 `workflow-doctor.test.ts` |
| 00-smoke | 3 | 本模組（本目錄只接診斷側） | `module.test.ts`（3 案）——註冊 6 個工具、關閉時不註冊、dispose 不殘留 |
| 19-loader-runtime-integration | 13 | 淘汰 | 測的是 V1 入口與 `__OPENCODE_ULTRAWORK_PROMISE__` 觀察側路，V2 原生外掛沒有這層 |

## 未移植的案例與理由

| 舊測試 | 案例 | 未移植理由 |
|---|---|---|
| 10-bootstrap-modes | 0 | 全部移植 |
| 14-doctor-memory-budget | 0 | 全部移植（少數案例與其他舊檔重疊，合併到同一個新案例） |
| 17-phase5-tools（診斷部分） | 2 | `match：同一陣列參考也 match=true（自我比較）` 與 `match：完整 tool 整合對齊 RUNTIME_EXPECTED_TOOL_NAMES` 屬於「比對函式在完整外掛下」的整合確認；V2 用 `tests/v2/native/diagnostics/tool-parity.test.ts` 的 baseline 快照對應鎖住同一件事（名稱、分類、hook 名稱、四個數量逐項對應） |
| 17-phase5-tools | 11 | comment_signal_* 工具（baseline／suppress／only_new）屬 comment-signal 模組，已在其目錄移植 |
| 32-registry-fail-closed | 6 | 寫入端 fail-closed、lazyEnsure IO 失敗、symlink escape、first-run skeleton：都是 workflow／memory 模組的寫入行為，不是診斷工具的職責 |
| 42-project-md-policy | 8 | `isTightened`、near-limit 門檻、CRLF 計數、section 排序、fenced headings 排除、`maxChars` 邊界：project.md 政策本身在 memory 模組；診斷端只觀察最終的 limit 與 warn |
| 23-plan-completion-tombstones | 20 | `isDependencySatisfied` 語意、`computePlanCompletionStats` 分母、純函式八類 check、Check 6 narrowing、link tombstone 不落placeholder：都是 workflow 模組的 registry 邏輯；診斷端只把它們的輸出彙整成 `plan_registry_health` |
| 15-registry-auto-trim | 12 | 全部是修剪、保護 dangling 清理、plan-next 依賴判斷等寫入端行為，歸 workflow 模組 |
| 38-content-grep-and-recovery | 12 | grep／regex 錯誤／section selector／roundtrip 還原：都是 content 工具行為，歸 workflow 模組 |
| 00-smoke | 2 | `task-state-sync status` 與 `plan-state-sync status` 屬 workflow 模組工具 |
| 19-loader-runtime-integration | 13 | 全部淘汰：V1 loader／bridge／觀察側路在 V2 已不存在 |

## 刻意落差（診斷端主動改寫的行為）

| 項目 | 舊版 | V2 | 理由 |
|---|---|---|---|
| `workflow_bootstrap` 的 `registry_summary.refs` | 硬編 `.opencode/memory/*` | `.ultrawork/*` | V1 資料層位置在 V2 不存在，照抄會指向不存在的檔案 |
| 「實際工具集合」的來源 | 無法列舉，靠假 context 假設 | `ctx.tool.list()`，收斂到本外掛工具名 | V2 可以逐一關閉模組，硬編 48 個會長期誤報不一致 |
| 平台不提供 `ctx.tool.list` | 舊版無此路徑 | 該項標 `skipped` 並在 details 寫明原因 | 不得把「沒比」寫成「比過但有瑕疵」 |
| 記憶體預算的 limit 來源 | `PROJECT_MD_LIMIT` 常數 | project.md frontmatter 的 `limit`，缺漏時用政策預設 | 政策在 memory 模組，診斷端只讀不判 |
| `tool_hook_manifest` 的 `hooks[].wired` 與 `workflow_health_check` 的 hook wiring 檢查 | 舊版讀模組開關推導 | 同樣依 `settings.modules` 推導，**是預估值不是實際註冊的觀測值** | 平台沒有「查詢某個 hook 有沒有真的被註冊」的 API；只註冊 diagnostics、卻把 commentSignal 開著的組合會推導出 `wired: true` 但實際上沒有該 hook。回傳欄位與輸出文字維持凍結介面不變，語意落差只以程式註解揭露 |
