/**
 * 搬遷用的真實檔案操作。
 *
 * 與 `MigrateFsOps` 的形狀一致；測試要模擬失敗時覆寫其中一兩個方法即可。
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { MigrateFsOps } from "./types.ts";

/** 真實執行時的檔案操作（node:fs）。 */
export function nodeMigrateFsOps(): MigrateFsOps {
  return {
    existsSync,
    statSync: (path: string) => statSync(path),
    lstatSync: (path: string) => lstatSync(path),
    mkdirSync: (path: string, options: { recursive: true }) => mkdirSync(path, options),
    readdirSync: (path: string) => readdirSync(path),
    copyFileSync,
    readFileSync: (path: string) => readFileSync(path, "utf-8"),
    rmSync: (path: string, options: { recursive: true; force: boolean }) => rmSync(path, options),
    renameSync,
    unlinkSync,
    writeFileSync,
  };
}
