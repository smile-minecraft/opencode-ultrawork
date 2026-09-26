/**
 * 雙行程鎖測試 worker（非測試檔，由父測試 spawn 執行）。
 *
 * 用法：bun _lock-worker.ts <storageDir> <lockDir> <sessionID> <file...>
 * 以檔案後端 storage＋共用 lock 目錄建 CommentSignalStore，逐筆記錄後退出。
 */

import { CommentSignalStore } from "../../../../src/modules/comment-signal/state.ts";
import { createFileKvStorage } from "./_file-kv.ts";

const [storageDir, lockDir, sessionID, ...files] = process.argv.slice(2);
if (!storageDir || !lockDir || !sessionID || files.length === 0) {
  console.error("用法：bun _lock-worker.ts <storageDir> <lockDir> <sessionID> <file...>");
  process.exit(2);
}

const store = new CommentSignalStore(createFileKvStorage(storageDir), { lockDir });
for (const file of files) {
  await store.recordModifiedFile(sessionID, file);
}
console.log(`worker done: session=${sessionID} files=${files.length}`);
