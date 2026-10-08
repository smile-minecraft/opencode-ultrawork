# v2-data fixture：2.x 形狀的回讀測試資料

`v2-data-readback.test.ts` 的來源資料。已進版控、去識別化，乾淨 checkout
也能完整跑過該測試（不依賴本機 gitignored 的 `.ultrawork/`）。

## 內容

- `tasks.json`（registry，version 4.0）：1 個進行中任務（`t-fixture-active`，
  IN_PROGRESS）＋ 1 個已終態任務（`t-fixture-done`，CANCELLED）。
- `plans.json`（registry，version 1.0）：1 個進行中計畫
  （`p-fixture-20261007`，IN_PROGRESS），`contentRef` 指向 `plans/` 下的內容檔。
- `plans/p-fixture-20261007.md`：計畫內容檔，可被 plan-content-read 解析。
- `memory/topics/fixture-topic.md`＋`memory/log.jsonl`＋`memory/MEMORY.md`＋
  `memory/usage.json`：中性記憶主題 `fixture-topic`（搜尋標記 `fixturemarker`）；
  log 只有一筆 create，hash 鏈以 `verifyLog` 驗過有效。
- `cache/change-scope/csb_fixture01_abcdef12.json`：外專案身分的比較起點，
  `projectPath` 指向不存在的 `/fixture-origin/fixture-project`，compare 必為
  `CROSS_PROJECT` 明確拒絕（或同屬優雅拒絕的 `BASELINE_NOT_FOUND`／
  `INVALID_BASELINE`）。

## 產生方式（來源可追溯）

以本 repo v3 真實模組在暫存專案產生（2.x 與 v3 共用同一套檔案格式，故等同
2.x 形狀資料），步驟是用合成宿主依序呼叫工具：task-state-sync（建兩個任務，
一個收到 IN_PROGRESS、一個取消）、plan-state-sync（建計畫並收到 IN_PROGRESS）、
plan-task-link、plan-content-create、memory-write（`fixture-topic`，apply）、
memory-read、change-scope-check create；再拷出 `.ultrawork/` 的子集。

## 去識別化

產生後只改了身分欄位，格式與 hash 不受影響：registry 與計畫內容檔的
`projectId`／`projectPath` 換成 `/fixture-placeholder/project`（測試執行時會再
機械重指到暫存根）；比較起點的 `projectPath` 換成固定不存在的
`/fixture-origin/fixture-project`。全目錄無個人姓名、家目錄路徑與真實工作資料。
