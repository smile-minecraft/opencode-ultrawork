/**
 * opencode-ultrawork — content 檔 + registry 寫入的快照 / 全還原 / inconsistent marker
 *
 * 內容工具設計 決策 10：
 *   - lock 內、寫任何東西之前，快照這次可能碰到的全部檔案（`.ultrawork/plans/`
 *     整棵樹 + `tasks.json` + `plans.json`）。
 *   - 寫入順序 content 先、registry 後。任一步 throw → 從快照全還原 → 逐檔
 *     re-hash 對照：
 *       全相符 → `REGISTRY_WRITE_FAILED_ROLLED_BACK`（可安全重試）
 *       任一不符 / 還原 throw → 寫 `.content-store-inconsistent` marker →
 *         `PARTIAL_WRITE`（不可直接重試）
 *   - marker 存在時所有 content **寫入**工具 fail-closed；read / grep 仍可用；
 *     只由顯式 recover 操作清除。doctor 只讀 marker 診斷。
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { atomicWriteFile } from "../../../kit/atomic-write.ts";
import { assertContainedPath } from "../../../kit/path-guard.ts";
import { restoreBytesAtomic } from "./byte-restore.ts";

export const INCONSISTENT_MARKER = ".content-store-inconsistent";
export const CONTENT_WRITE_LOCK = ".content-write.lock";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 所有 workflow content path 的共同 containment guard。 */
export function assertSafeContentRoot(projectRoot: string, plansDir: string): void {
  assertContainedPath(projectRoot, plansDir, {
    directoryPath: plansDir,
    label: "Workflow plans path guard",
  });
}

export function assertSafeContentPath(projectRoot: string, plansDir: string, path: string): void {
  assertContainedPath(projectRoot, path, {
    lexicalRoot: plansDir,
    directoryPath: plansDir,
    label: "Workflow content path guard",
  });
}

export function assertSafeProjectFile(projectRoot: string, plansDir: string, path: string): void {
  assertContainedPath(projectRoot, path, {
    directoryPath: plansDir,
    label: "Workflow project file path guard",
  });
}


/** 遞迴列出目錄下所有一般檔的相對路徑（跳過 lock / marker / dot-file）。 */
function listFiles(dir: string, base: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === CONTENT_WRITE_LOCK || name === INCONSISTENT_MARKER) continue;
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) throw new Error(`symlink path is not allowed: ${full}`);
    if (st.isDirectory()) listFiles(full, base, out);
    else if (st.isFile()) out.push(relative(base, full));
  }
}

export interface StoreSnapshot {
  /** 可信專案根目錄。 */
  projectRoot: string;
  /** 快照涵蓋的絕對目錄（plansDir）。 */
  root: string;
  /** relpath → 檔案內容（Buffer）。快照當下不存在的檔不列入。 */
  files: Map<string, Buffer>;
  /** 額外快照的絕對路徑（tasks.json / plans.json）→ Buffer 或 null（不存在）。 */
  extra: Map<string, Buffer | null>;
}

/**
 * 快照 plansDir 整棵樹 + 指定的額外檔（tasks.json / plans.json）。
 */
export function snapshotStore(projectRoot: string, plansDir: string, extraPaths: string[]): StoreSnapshot {
  assertSafeContentRoot(projectRoot, plansDir);
  const rels: string[] = [];
  listFiles(plansDir, plansDir, rels);
  const files = new Map<string, Buffer>();
  for (const rel of rels) {
    const full = join(plansDir, rel);
    assertSafeContentPath(projectRoot, plansDir, full);
    files.set(rel, readFileSync(full));
  }
  const extra = new Map<string, Buffer | null>();
  for (const p of extraPaths) {
    assertSafeProjectFile(projectRoot, plansDir, p);
    extra.set(p, existsSync(p) ? readFileSync(p) : null);
  }
  return { projectRoot, root: plansDir, files, extra };
}

/**
 * 從快照全還原，再逐檔 re-read + re-hash 對照。
 * @returns `{ ok: true }` 全相符；`{ ok: false, mismatches }` 任一不符 / 還原 throw。
 */
export function restoreStore(snap: StoreSnapshot): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  try {
    // 1) plansDir 內：現有檔若不在快照 → 刪；快照中的檔 → 覆寫。
    assertSafeContentRoot(snap.projectRoot, snap.root);
    const currentRels: string[] = [];
    listFiles(snap.root, snap.root, currentRels);
    for (const rel of currentRels) {
      if (!snap.files.has(rel)) {
        const full = join(snap.root, rel);
        assertSafeContentPath(snap.projectRoot, snap.root, full);
        rmSync(full, { force: true });
      }
    }
    for (const [rel, buf] of snap.files) {
      const full = join(snap.root, rel);
      assertSafeContentPath(snap.projectRoot, snap.root, full);
      if (existsSync(full) && sha256(readFileSync(full)) === sha256(buf)) continue; // 已相符，跳過
      if (!existsSync(dirname(full))) mkdirSync(dirname(full), { recursive: true });
      restoreBytesAtomic(full, buf, () => assertSafeContentPath(snap.projectRoot, snap.root, full));
    }
    // 2) 額外檔
    for (const [p, buf] of snap.extra) {
      assertSafeProjectFile(snap.projectRoot, snap.root, p);
      if (buf === null) {
        rmSync(p, { force: true });
      } else if (!(existsSync(p) && sha256(readFileSync(p)) === sha256(buf))) {
        restoreBytesAtomic(p, buf, () => assertSafeProjectFile(snap.projectRoot, snap.root, p));
      }
    }
    // 3) 驗證
    for (const [rel, buf] of snap.files) {
      const full = join(snap.root, rel);
      if (!existsSync(full) || sha256(readFileSync(full)) !== sha256(buf)) {
        mismatches.push(rel);
      }
    }
    for (const [p, buf] of snap.extra) {
      if (buf === null) {
        if (existsSync(p)) mismatches.push(p);
      } else if (!existsSync(p) || sha256(readFileSync(p)) !== sha256(buf)) {
        mismatches.push(p);
      }
    }
  } catch (err) {
    mismatches.push(`restore threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: mismatches.length === 0, mismatches };
}

export interface InconsistentMarker {
  at: string;
  op: string;
  filesWritten: string[];
  filesPending: string[];
  detail: Record<string, unknown>;
}

export function markerPath(plansDir: string): string {
  return join(plansDir, INCONSISTENT_MARKER);
}

export function readInconsistentMarker(projectRoot: string, plansDir: string): InconsistentMarker | null {
  assertSafeContentPath(projectRoot, plansDir, markerPath(plansDir));
  const p = markerPath(plansDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as InconsistentMarker;
  } catch {
    return { at: "?", op: "?", filesWritten: [], filesPending: [], detail: { unreadable: true } };
  }
}

export function writeInconsistentMarker(projectRoot: string, plansDir: string, marker: InconsistentMarker): void {
  const p = markerPath(plansDir);
  assertSafeContentPath(projectRoot, plansDir, p);
  writeFileSync(p, JSON.stringify(marker, null, 2));
}

/**
 * 清除 inconsistent marker。
 *
 * `expectedAt` 給定時，只有當磁碟上的 marker `at` 仍等於它才刪——避免在
 * 「讀 marker → 使用者判斷已修好 → 清」之間，另一個 writer 剛好產生了**新的**
 * marker 而被誤刪。呼叫端應在 content write lock 內呼叫（marker 只由持鎖的
 * writer 產生），`expectedAt` 是額外的雙保險。
 */
export function clearInconsistentMarker(projectRoot: string, plansDir: string, expectedAt?: string): boolean {
  const p = markerPath(plansDir);
  assertSafeContentPath(projectRoot, plansDir, p);
  if (!existsSync(p)) return false;
  if (expectedAt !== undefined) {
    const current = readInconsistentMarker(projectRoot, plansDir);
    if (!current || current.at !== expectedAt) return false;
  }
  rmSync(p, { force: true });
  return true;
}

export type GuardedWriteResult =
  | { kind: "ok" }
  | { kind: "rolled_back"; error: string }
  | { kind: "partial"; marker: InconsistentMarker };

/**
 * 把「快照當下」與「現在」比對，回報這期間實際被 mutate 動過的檔案。
 * 供 `PARTIAL_WRITE` marker 記錄真正 touched 的 content / task 檔（不只 registry）。
 */
export function diffStoreAgainstSnapshot(snap: StoreSnapshot): {
  added: string[];
  removed: string[];
  modified: string[];
} {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  const currentRels: string[] = [];
  assertSafeContentRoot(snap.projectRoot, snap.root);
  listFiles(snap.root, snap.root, currentRels);
  const currentSet = new Set(currentRels);
  for (const rel of currentRels) {
    const before = snap.files.get(rel);
    if (before === undefined) { added.push(rel); continue; }
    try {
      if (sha256(readFileSync(join(snap.root, rel))) !== sha256(before)) modified.push(rel);
    } catch { modified.push(rel); }
  }
  for (const rel of snap.files.keys()) {
    if (!currentSet.has(rel)) removed.push(rel);
  }
  for (const [p, before] of snap.extra) {
    const nowExists = existsSync(p);
    if (before === null && nowExists) added.push(p);
    else if (before !== null && !nowExists) removed.push(p);
    else if (before !== null && nowExists) {
      try {
        if (sha256(readFileSync(p)) !== sha256(before)) modified.push(p);
      } catch { modified.push(p); }
    }
  }
  return { added, removed, modified };
}

/**
 * 通用版：快照 `plansDir` 整棵樹 + 額外檔 → 執行 `mutate()`（可含多檔刪除 /
 * 建立 / registry 寫入，順序自訂）→ 任一步 throw 就從快照全還原 + re-hash 對照。
 *   全相符 → `rolled_back`（可安全重試）
 *   不符 / 還原 throw → 寫 marker → `partial`（不可直接重試）
 *
 * `guardedContentWrite` 是本函式「單一 content 檔 + 一次 registry 寫入」的特例；
 * `plan_content_create`（全新檔）與 `plan_content_delete` 用這個通用版。
 *
 * **必須在 content-write lock 臨界區內呼叫。**
 */
export async function guardedStoreMutation(params: {
  projectRoot: string;
  plansDir: string;
  extraSnapshotPaths: string[];
  op: string;
  detail?: Record<string, unknown>;
  mutate: () => void | Promise<void>;
}): Promise<GuardedWriteResult> {
  const snap = snapshotStore(params.projectRoot, params.plansDir, params.extraSnapshotPaths);
  try {
    await params.mutate();
    return { kind: "ok" };
  } catch (err) {
    // 還原前先記錄這次 mutate 實際動過哪些檔（content / task / registry 都算）
    const touched = diffStoreAgainstSnapshot(snap);
    const restore = restoreStore(snap);
    if (restore.ok) {
      return { kind: "rolled_back", error: err instanceof Error ? err.message : String(err) };
    }
    const marker: InconsistentMarker = {
      at: new Date().toISOString(),
      op: params.op,
      filesWritten: [...touched.added, ...touched.modified],
      filesPending: [...touched.removed, ...params.extraSnapshotPaths],
      detail: {
        error: err instanceof Error ? err.message : String(err),
        restoreMismatches: restore.mismatches,
        touched,
        ...(params.detail ?? {}),
      },
    };
    try {
      writeInconsistentMarker(params.projectRoot, params.plansDir, marker);
    } catch {
      // plansDir 唯讀——仍回 partial，caller 訊息會提醒人工檢查
    }
    return { kind: "partial", marker };
  }
}

/**
 * 快照 → 寫 content → 寫 registry（固定順序）。registry throw → 全還原：
 *   還原成功 → `rolled_back`（可安全重試）
 *   還原失敗 → 寫 inconsistent marker → `partial`（不可直接重試）
 *
 * **必須在 content-write lock 臨界區內呼叫。**
 */
export async function guardedContentWrite(params: {
  projectRoot: string;
  plansDir: string;
  contentPath: string;
  proposedFile: string;
  extraSnapshotPaths: string[];
  op: string;
  /** 診斷用：寫入前後的 sha / contentVersion，寫進 marker。 */
  shaBefore: { file: string; contentVersion: number | null };
  shaAfter: { file: string; contentVersion: number };
  writeRegistry: () => void | Promise<void>;
}): Promise<GuardedWriteResult> {
  const snap = snapshotStore(params.projectRoot, params.plansDir, params.extraSnapshotPaths);
  assertSafeContentPath(params.projectRoot, params.plansDir, params.contentPath);
  atomicWriteFile(params.contentPath, params.proposedFile);
  try {
    await params.writeRegistry();
    return { kind: "ok" };
  } catch (err) {
    const restore = restoreStore(snap);
    if (restore.ok) {
      return { kind: "rolled_back", error: err instanceof Error ? err.message : String(err) };
    }
    const marker: InconsistentMarker = {
      at: new Date().toISOString(),
      op: params.op,
      filesWritten: [params.contentPath],
      filesPending: params.extraSnapshotPaths,
      detail: {
        registryError: err instanceof Error ? err.message : String(err),
        restoreMismatches: restore.mismatches,
        shaBefore: params.shaBefore,
        shaAfter: params.shaAfter,
      },
    };
    try {
      writeInconsistentMarker(params.projectRoot, params.plansDir, marker);
    } catch {
      // 連 marker 都寫不進去（例如 plansDir 唯讀）——仍回 partial，caller 的
      // 錯誤訊息會提醒人工檢查；下次 apply 因為讀不到 marker 不會 fail-closed，
      // 但 sha lock 仍會擋住基於舊內容的寫入。
    }
    return { kind: "partial", marker };
  }
}
