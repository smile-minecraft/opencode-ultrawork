/**
 * 外掛入口（shim）。
 *
 * OpenCode 的 V2 外掛有兩種安裝形式，各自認的入口位置不同：
 *   - npm／git 形式：走 `package.json` 的 `exports`（見該欄位），指到
 *     `./src/index.ts`，不需要這個檔案。
 *   - 本機目錄形式（把這個 repo 的路徑直接指給 OpenCode）：只認目錄根層有
 *     `index` 或 `server` 入口，**不看 `exports`**。少了這行，設定會指向一個
 *     沒有入口的目錄，然後安靜地什麼都不載入——沒有錯誤訊息，只是工具整個
 *     沒出現。
 *
 * 所以實作本體放在 `src/index.ts`（可測試、可型別檢查），這裡只做轉出，
 * 讓兩種形式指到同一份程式碼。
 */
export { default } from "./src/index.ts";
