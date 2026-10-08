/**
 * 模組槽位介面：後續任務只在各自資料夾內實作 register。
 *
 * 約定：
 * - 每個模組一個資料夾，預設 export 一個 ModuleDefinition。
 * - register 在模組開關開啟時才被呼叫；關閉時完全不碰宿主。
 * - register 回傳的宿主註冊把手會在卸載時 dispose；
 *   回傳 void 表示沒有需要清理的註冊。
 * - 模組之間只透過 ModuleRuntime 拿共用資源，不直接 import 彼此。
 */

import type { Host, HostRegistration } from "../host.ts";
import type { UltraworkSettings } from "../settings/defaults.ts";

/** 模組拿到的執行環境：宿主能力與合併好的設定。 */
export interface ModuleRuntime {
  readonly host: Host;
  readonly settings: UltraworkSettings;
}

export interface ModuleDefinition {
  /** 對應設定檔 modules 底下的 key；未知 key 預設開啟。 */
  readonly key: string;
  readonly register: (runtime: ModuleRuntime) => Promise<HostRegistration | void> | HostRegistration | void;
}
