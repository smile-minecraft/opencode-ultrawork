# opencode-ultrawork

OpenCode V2 原生外掛，提供 48 個工具與 6 個 hook，負責工作區搜尋、驗證、工作說明檢查、Comment Signal、技能管理、任務與計畫狀態、診斷和專案記憶。工具的名稱、參數與回傳格式是對外凍結的介面，改動前要先取得使用者同意。

來源：介面凍結清單見 `src/modules/diagnostics/inventory.ts`（48 工具、6 hook、11 分類），並由 `tests/v2/native/diagnostics/tool-parity.test.ts` 逐項把關。

> 本文提到的 `src/…`、`tests/…`、`AGENTS.md` 都是 repo 裡的路徑。npm 套件只內含 `src/`、`schema/`、`index.ts`、`README.md`、`LICENSE`，其餘檔案請到 [GitHub repo](https://github.com/smile-minecraft/opencode-ultrawork) 對應的 branch 查看。

## 模組一覽

8 個模組各自的職責（工具對應哪個模組見 `src/modules/diagnostics/inventory.ts` 的 `TOOL_MODULES`，hook 註冊點見同檔的 `HOOK_WIRING_SOURCE`；開關 key 見 `src/settings/defaults.ts` 的 `MODULE_KEYS`）：

| 模組（設定 key） | 職責 |
|---|---|
| `search` | 在工作區內讀檔與搜尋（唯讀工具） |
| `verification` | 執行驗證、檢查變更範圍 |
| `commentSignal` | 註解必要檢查，含 `AI_DO_NOT_EDIT:P0` 阻斷 |
| `skills` | 把 system prompt 的技能清單換成名稱索引，並提供查詢 |
| `skiller` | 技能的掃描、驗證、草稿、晉升／退役／還原、匯入與政策更新 |
| `workflow` | 任務與計畫的狀態、內容、工作說明檢查與派遣流程 |
| `diagnostics` | 啟動導引、健康檢查、工具／hook 清單與自我測試 |
| `memory` | 專案記憶與同步紀錄 |

各模組提供的工具（名稱以 `src/modules/**` 的實作為準）：

- `search`：`peek_file`、`grep_context`
- `verification`：`verification_run`、`change-scope-check`
- `commentSignal`：`comment_signal_check`、`comment_signal_touched_report`、`comment_signal_explain`、`comment_signal_policy`、`comment_signal_only_new`、`comment_signal_baseline`、`comment_signal_suppress`
- `skills`：`skill_search`
- `skiller`：`skiller-scan`、`skiller-validate`、`skiller-draft`、`skiller-draft-read`、`skiller-draft-update`、`skiller-draft-delete`、`skiller-promote`、`skiller-retire`、`skiller-restore`、`skiller-import`、`skiller-policy-update`
- `workflow`：`task-state-sync`、`task-content-read`、`task-content-update`、`plan-state-sync`、`plan-task-link`、`plan-status`、`plan-next`、`plan-progress-reconcile`、`plan-content-create`、`plan-content-read`、`plan-content-update`、`plan-content-delete`、`work-order-build`
- `diagnostics`：`workflow_bootstrap`、`workflow_doctor`、`workflow_health_check`、`workflow_l1_check`、`tool_hook_manifest`、`ultrawork_selftest`
- `memory`：`project-memory-read`、`project-memory-update`、`project-memory-rewrite`、`memory-receipt-create`、`memory-receipt-read`、`memory-receipt-list`

hook 共 6 個（名稱凍結，註冊點對照見 `src/modules/diagnostics/inventory.ts` 的 `HOOK_WIRING_SOURCE`）：`event`、`tool.execute.before`、`tool.execute.after`、`experimental.chat.system.transform`、`experimental.session.compacting`、`tool.definition`。

## 安裝

在 `opencode.jsonc` 引用這個外掛。以下兩點是實測確認的坑，請照著做：

1. key 必須是 **`plugins`（複數）**。寫成單數 `plugin` 只接受字串，物件陣列會被靜默忽略。
2. **本機目錄形式要指向目錄，不要指向檔案**。V2 對本機目錄只認根層的 `index` 或 `server` 入口：指向檔案（例如 `src/index.ts`）會被拒（`configured plugin path must be a directory`）；目錄根層沒有入口時不載入也不報錯，工具只是靜默地沒出現。

有三種形式可選，差別在「版本怎麼定」和「要不要自己裝」：

| 形式 | 寫法 | 版本 | 適用情境 |
|---|---|---|---|
| npm | `"opencode-ultrawork"` | 自動抓 `latest`，會跟著更新 | 一般使用者，想直接用最新版本 |
| npm（釘住 major） | `"opencode-ultrawork@^2.0.0"` | 只收 `2.x` 的更新 | 想自動吃小改動，但不跨大版本 |
| npm（完全釘住） | `"opencode-ultrawork@2.0.0"` | 固定不動 | 需要可重現的環境 |
| git | `"github:smile-minecraft/opencode-ultrawork#<完整 commit hash>"` | 固定在那個 commit | 要用還沒發布的 commit，或追 V2 開發進度 |
| 本機目錄 | `"/path/to/opencode-ultrawork"` | 跟你 working tree 走 | 開發這個外掛本身 |

npm 形式（一般使用者）：

```jsonc
{
  "plugins": ["opencode-ultrawork"]
}
```

要控制版本就在套件名稱後面加 `@` 加版本範圍，寫法跟 npm 一樣——`^2.0.0`、`~2.0.1`、`2.0.0` 都可以。**沒寫版本時 OpenCode 會裝 `latest`**，所以要可重現就一定要寫。名單只有 `@` 加範圍（或純數字）的時候，套件名稱要寫完整：

```jsonc
{
  // 收 2.x 的更新，不跨到 3.0
  "plugins": ["opencode-ultrawork@^2.0.0"]
}
```

git 形式（固定版本、不自動更新）：

```jsonc
{
  "plugins": ["github:smile-minecraft/opencode-ultrawork#<完整 commit hash>"]
}
```

`<完整 commit hash>` 換成實際要用的 commit。npm 與 git 形式都走 `package.json` 的 `exports` 找入口，不需要根層的 `index.ts`。開發時用本機目錄指向這個 repo 的根目錄即可——根層的 `index.ts` 就是為此存在的轉出層（說明見該檔註解）：

```jsonc
{
  "plugins": ["/path/to/opencode-ultrawork"]
}
```

## 設定

設定檔是 `ultrawork.jsonc`，有兩層：全域 `<OpenCode 全域設定資料夾>/.ultrawork/ultrawork.jsonc`，專案 `<專案根目錄>/.ultrawork/ultrawork.jsonc`（全域設定資料夾的解析規則見 `src/settings/paths.ts`：`OPENCODE_CONFIG_DIR` → `$XDG_CONFIG_HOME/opencode` → `~/.config/opencode`）。

載入順序是內建預設 → 全域 → 專案；物件深層合併，純量與陣列整個覆寫（`src/settings/merge.ts`）。讀不到檔案視為沒有設定；某一層格式錯誤只記一則警告並忽略該層，外掛照常載入（`src/settings/load.ts`）。

範例（全域與專案同一種格式，專案層只寫要覆寫的部分；欄位定義以 `schema/ultrawork.schema.json` 為準，預設值見 `src/settings/defaults.ts`）：

```jsonc
{
  // 讓編輯器自動完成、欄位檢查；所有欄位都選填
  "$schema": "https://raw.githubusercontent.com/smile-minecraft/opencode-ultrawork/main/schema/ultrawork.schema.json",
  "modules": {
    "search": true,
    "verification": true,
    "commentSignal": true,
    "skills": true,
    "skiller": true,
    "workflow": true,
    "diagnostics": true,
    "memory": true
  },
  "skiller": {
    // 個人技能目錄，預設 ~/.agents/skills
    "personalSkillRoot": "~/.agents/skills",
    // 晉升／退役時改寫的角色檔目錄，auto = <OpenCode 全域設定資料夾>/agents
    "agentsDir": "auto"
  },
  "skills": {
    // 技能清單在 system prompt 的呈現：index 只列名稱，full 走原本完整清單
    "catalog": "index"
  },
  "workflow": {
    "completion": {
      // memory 模組開啟時預設要求同步紀錄；關閉時由完成前檢查自行放行
      "requireMemoryReceipt": true
    }
  }
}
```

模組開關在 `modules` 底下，預設全部開啟；關掉的模組不註冊工具、不掛 hook（`src/settings/defaults.ts`）。`memory` 關閉時，任務結案不再要求同步紀錄；`commentSignal` 關閉時，結案流程的相關檢查回報「未啟用」而不是失敗。

**改完設定要重新載入或重啟 OpenCode 才生效。**實測 OpenCode 2.0.16 只監看外掛原始檔（約 1 秒內重新載入），改 `opencode.jsonc` 或 `ultrawork.jsonc` 不會自動生效。

## 資料位置與搬遷

外掛的資料放在 `<專案>/.ultrawork/`（專案根目錄以該次呼叫所在工作階段的位置為準）：`ultrawork.jsonc`、`tasks.json`、`plans.json`、`state.md`、`plans/`、`project.md`、`receipts/`、`comment-signal-baseline.json`、`audit.jsonl`、`cache/`（可重建的快照），以及外掛建立的 `.gitignore`（預設忽略資料檔與 `cache/`，只留 `ultrawork.jsonc`）。

第一次在某個專案啟動時，外掛會把舊位置的資料自動搬到 `.ultrawork/`（實作見 `src/migrate/migrate.ts`、`src/migrate/items.ts`）：

- 專案層：`.opencode/memory/` 下的 `tasks.json`、`plans.json`、`state.md`、`audit.jsonl`、`project.md`、`comment-signal-baseline.json`、`receipts/`，以及 `.opencode/plans/`。
- 全域層：設定資料夾根目錄的 `skills-policy.json`、`skills-personal.json`、`skill-drafts/`、`skill-quarantine/`。
- 只做一次（以 `.ultrawork/.migrated-from-opencode.json` 標記判斷）；**複製到新位置後把舊檔改名成 `<原檔名>.migrated-<時間戳>` 保留，永不刪除**。
- 新位置已有資料時不覆寫，記警告並跳過那個檔案。
- 任一步失敗就停下該層、不寫標記，外掛照常用新位置運作；下次啟動重跑，已搬的項目因目標已存在而自然跳過。搬遷狀態可由 `workflow_doctor` 回報。

刻意不搬的：專案的 `.opencode/skills`（沿用 OpenCode 的 project scope 技能位置），以及 `$XDG_DATA_HOME` 底下的 change-scope 快取快照（`cache/` 本來就是可重建的資料）。

寫入一律採原子寫入加寫入鎖，因為兩個 V2 伺服器可能共用同一個 `.ultrawork/`（實作見 `src/kit/atomic-write.ts`、`src/kit/write-lock.ts`）。

## 從設定 repo 版本遷移

以下是在設定 repo（`~/.config/opencode` 那一側）要做的事：

1. `opencode.jsonc` 加上 `"plugins": [..., "opencode-ultrawork@^2.0.0"]`（或用 `github:` 形式釘住某個 commit，見「安裝」）；刪掉 `plugins/opencode-ultrawork.ts`、`plugins/opencode-ultrawork/`、`tests/ultrawork/`、`scripts/generate-ultrawork-baseline.ts`。
2. `skills-policy.json`、`skills-personal.json`、`skill-drafts/`、`skill-quarantine/` 搬到 `<全域設定資料夾>/.ultrawork/`（外掛第一次啟動會自動搬；但設定 repo 裡讀它們的 `scripts/skill-approval.ts`、`scripts/skill-profile.ts`、`lib/skill-capability.ts` 和 `tests/config/` 的契約測試要改路徑）。
3. `AGENTS.md`、`agents/*.md`、`commands/*.md` 裡的 `.opencode/memory/…`、`.opencode/plans/…` 字串改成 `.ultrawork/…`。
4. `lib/dcp-evidence-policy.ts` 列的是 ultrawork 工具名稱，名稱沒變就不用改。
5. 把那條讀設定 repo 技能政策的使用者專屬測試移回設定 repo 的 `tests/config/`。

## 開發

```bash
bun install
bun test
bun run typecheck
```

`src/**` 零 V1 import 的 gate：`tests/v2/native/v1-free-surface.test.ts`。三者都要通過才算完成一個階段（`AGENTS.md`）。

提醒：48 個工具的名稱、參數與回傳格式是對外介面，凍結清單由 `tests/v2/native/diagnostics/tool-parity.test.ts` 把關；任何改變都要先問使用者（`AGENTS.md`）。

## 授權

MIT，見 `LICENSE`。
