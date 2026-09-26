/**
 * 模組槽位介面：後續任務只在各自資料夾內實作 register。
 *
 * 約定：
 * - 每個模組一個資料夾，預設 export 一個 ModuleDefinition。
 * - register 在模組開關開啟時才被呼叫；關閉時完全不碰 ctx。
 * - register 回傳的 Registration 會在外掛卸載時 dispose；
 *   回傳 void 表示沒有需要清理的註冊。
 * - 模組之間只透過 ModuleRuntime 拿共用資源，不直接 import 彼此。
 */

import type { Plugin } from "@opencode/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import type { UltraworkSettings } from "../settings/defaults.ts";

export type { Registration };

/** 模組拿到的執行環境：原生 V2 context 加上合併好的設定。 */
export interface ModuleRuntime {
  readonly ctx: Plugin.Context;
  readonly settings: UltraworkSettings;
}

export interface ModuleDefinition {
  /** 對應設定檔 modules 底下的 key；未知 key 預設開啟。 */
  readonly key: string;
  readonly register: (runtime: ModuleRuntime) => Promise<Registration | void> | Registration | void;
}
