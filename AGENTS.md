# opencode-ultrawork

這個 repo 正在把 ultrawork 外掛改寫成 OpenCode V2 原生外掛。**動手之前先讀本檔與 `README.md`**：`README.md` 有對外介面、模組邊界、安裝與設定方式；下面這份清單是開發規則與每階段必過的檢查。已經確定不再討論的決策，只保留在兩者都寫得出理由的部分；其餘設計問題一律先問使用者。

- 用台灣繁體中文寫文件、註解與回報；程式識別字、工具名稱、設定 key 維持英文。
- 每個階段結束前：`bun test` 全過、`bun run typecheck` 沒有錯誤、repo 層級的 V1 表面 gate（`tests/v2/native/v1-free-surface.test.ts`：`src/**` 零 V1 import，且已移除的 V1 表面沒有被引回來）通過。
- 48 個工具的名稱、參數與回傳格式是對外介面，不能在沒問使用者的情況下改。
- `AI_DO_NOT_EDIT:P0` 阻斷不能移除或降級。
- 程式碼不能出現使用者個人的路徑或名稱，這個 repo 之後會公開。
- push、改 repo 可見性、發布之前，要先得到使用者明確同意。
- 本檔與 `README.md` 都沒寫到、而且會改變設計的問題，先問使用者。
