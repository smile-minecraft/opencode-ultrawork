/**
 * 路徑守衛收斂的行為缺口（Red）：修正前失敗、修正後通過。
 *
 * 全部只用暫存目錄與唯讀操作，不寫入家目錄或系統目錄：
 * - migrate 用注入的 stub fs（只記錄、不落檔）；
 * - memory 用 read／list（唯讀）；
 * - comment-signal 用預設 changedOnly（工作階段 modifiedFiles 為空，不走訪家目錄）。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setupUltrawork } from "../../../src/index.ts";
import type { MigrateFsOps } from "../../../src/migrate/types.ts";
import { migrateProjectData } from "../../../src/migrate/index.ts";
import { commentSignalModule } from "../../../src/modules/comment-signal/index.ts";
import { createReceiptTools } from "../../../src/modules/memory/receipts.ts";
import { createProjectMemoryTools } from "../../../src/modules/memory/project-memory.ts";
import { resolveReadableTarget } from "../../../src/modules/search/search-utils.ts";
import {
  captureTrackedFileSnapshots,
  changeScopeStoreDirForRoot,
} from "../../../src/modules/verification/change-scope-check.ts";
import { verificationModule } from "../../../src/modules/verification/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/settings/defaults.ts";
import { createFakeV2Context, fakeGlobalDir, fakeV2ToolContext } from "../_fake-v2-context.ts";

const HOME = homedir();

function makeStubFs(): { ops: MigrateFsOps; writes: string[] } {
  const writes: string[] = [];
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const ops = {
    existsSync: (_path: string) => false,
    statSync: (_path: string): { isDirectory(): boolean; isFile(): boolean } => {
      throw enoent();
    },
    lstatSync: (_path: string) => {
      throw enoent();
    },
    mkdirSync: (path: string, _options: { recursive: true }) => {
      writes.push(`mkdir:${path}`);
    },
    readdirSync: (_path: string): string[] => [],
    copyFileSync: (source: string, destination: string) => {
      writes.push(`copy:${source}->${destination}`);
    },
    readFileSync: (_path: string, _encoding: "utf-8"): string => {
      throw enoent();
    },
    rmSync: (_path: string, _options: { recursive: true; force: boolean }) => {},
    renameSync: (a: string, b: string) => {
      writes.push(`rename:${a}->${b}`);
    },
    unlinkSync: (_path: string) => {},
    writeFileSync: (...args: unknown[]) => {
      writes.push(`write:${String(args[0])}`);
    },
  } as unknown as MigrateFsOps;
  return { ops, writes };
}

function makeTempRoot(prefix: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("家目錄當根：各模組一致拒絕", () => {
  test("migrate：家目錄拒絕搬遷、不寫標記、不留檔", () => {
    const { ops, writes } = makeStubFs();
    const result = migrateProjectData({ root: HOME, fs: ops, now: () => new Date("2026-01-01T00:00:00Z") });
    expect(result.ok).toBe(false);
    expect(result.errors.map((item) => item.reason)).toEqual(["unsafe-path"]);
    expect(writes).toEqual([]);
  });

  test("memory read：家目錄回 UNSAFE_ROOT", async () => {
    const tools = createProjectMemoryTools(async () => HOME);
    const raw = await tools["project-memory-read"].execute({ mode: "digest" }, fakeV2ToolContext());
    const parsed = JSON.parse(raw.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("UNSAFE_ROOT");
  });

  test("memory receipt-list：家目錄回 UNSAFE_ROOT", async () => {
    const tools = createReceiptTools(async () => HOME);
    const raw = await tools["memory-receipt-list"].execute({}, fakeV2ToolContext());
    const parsed = JSON.parse(raw.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("UNSAFE_ROOT");
  });

  test("comment-signal check：家目錄直接拒絕", async () => {
    const { ops } = makeStubFs();
    const fake = createFakeV2Context({ directory: HOME, sessionDirectory: HOME });
    const cleanup = await setupUltrawork(fake.ctx, {
      modules: [commentSignalModule],
      migrateFs: ops,
      settings: DEFAULT_SETTINGS,
    });
    try {
      const check = fake.added.get("comment_signal_check");
      expect(check).toBeDefined();
      await expect(check.execute({}, fakeV2ToolContext())).rejects.toThrow(/unsafe root/i);
    } finally {
      await cleanup();
    }
  });

  test("search resolveReadableTarget：家目錄回 UNSAFE_ROOT", () => {
    const result = resolveReadableTarget("project.md", HOME);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const parsed = JSON.parse(result.result);
      expect(parsed.code).toBe("UNSAFE_ROOT");
    }
  });

  test("verification recheck：家目錄回 INVALID_CWD", async () => {
    const fake = createFakeV2Context({ directory: HOME, sessionDirectory: HOME });
    await verificationModule.register({ ctx: fake.ctx, settings: DEFAULT_SETTINGS });
    const definition = fake.added.get("verification_run");
    const missing = { path: "definitely-missing.txt", state: "missing", comparable: false, reason: "FILE_NOT_FOUND" };
    const raw = await definition.execute(
      {
        action: "recheck",
        evidence: {
          schema: "verification-evidence-v1",
          requestedFiles: ["definitely-missing.txt"],
          before: [missing],
          after: [missing],
          stable: false,
          reusable: false,
          status: "insufficient_evidence",
        },
      },
      { ...fakeV2ToolContext(), agent: "momus" },
    );
    const parsed = JSON.parse(raw.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_CWD");
  });
});

describe("symlink 目錄：專案外檔案不被讀、不被算 sha256", () => {
  test("captureTrackedFileSnapshots 不對 symlink 目錄下的專案外檔案算 sha256", () => {
    const ws = makeTempRoot("uw-pathguard-link-");
    const outside = makeTempRoot("uw-pathguard-outside-");
    try {
      writeFileSync(join(outside.root, "secret.txt"), "outside-content", "utf8");
      symlinkSync(outside.root, join(ws.root, "link"), "dir");
      const snapshots = captureTrackedFileSnapshots(ws.root, ["link/secret.txt"]);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].comparable).toBe(false);
      expect(snapshots[0].sha256).toBeUndefined();
    } finally {
      ws.cleanup();
      outside.cleanup();
    }
  });

  test("change-scope create 不對 symlink 目錄下的專案外檔案算 sha256", async () => {
    const ws = makeTempRoot("uw-scope-link-");
    const outside = makeTempRoot("uw-scope-outside-");
    try {
      writeFileSync(join(outside.root, "secret.txt"), "outside-content", "utf8");
      symlinkSync(outside.root, join(ws.root, "link"), "dir");
      const fake = createFakeV2Context({ directory: ws.root });
      await verificationModule.register({ ctx: fake.ctx, settings: DEFAULT_SETTINGS });
      const definition = fake.added.get("change-scope-check");
      const raw = await definition.execute(
        { action: "create", paths: [{ path: "link/secret.txt", kind: "file" }] },
        { ...fakeV2ToolContext(), agent: "build" },
      );
      const parsed = JSON.parse(raw.content);
      expect(parsed.ok).toBe(true);
      const stored = JSON.parse(
        readFileSync(join(changeScopeStoreDirForRoot(ws.root), `${parsed.data.baselineId}.json`), "utf8"),
      );
      const entry = stored.files.find((file: { path: string }) => file.path === "link/secret.txt");
      expect(entry).toBeDefined();
      expect(entry.sha256).toBeUndefined();
      expect(
        stored.coverage.issues.some((issue: { code: string }) => issue.code === "SYMLINK_NOT_FOLLOWED"),
      ).toBe(true);
    } finally {
      ws.cleanup();
      outside.cleanup();
    }
  });
});

describe("migrate copyTree：不跟隨來源樹 symlink", () => {
  test("來源樹內的 symlink 不被跟隨複製，該層失敗且不寫標記", () => {
    const ws = makeTempRoot("uw-migrate-link-");
    const outside = makeTempRoot("uw-migrate-outside-");
    try {
      const receipts = join(ws.root, ".opencode", "memory", "receipts");
      mkdirSync(receipts, { recursive: true });
      writeFileSync(join(receipts, "r.json"), '{"ok":true}', "utf8");
      writeFileSync(join(outside.root, "evil.txt"), "evil-outside", "utf8");
      symlinkSync(join(outside.root, "evil.txt"), join(receipts, "evil-link.json"));
      const result = migrateProjectData({ root: ws.root, now: () => new Date("2026-01-01T00:00:00Z") });
      expect(result.ok).toBe(false);
      expect(result.errors.map((item) => item.reason)).toContain("copy-failed");
      expect(result.errors.some((item) => /symlink/i.test(item.detail ?? ""))).toBe(true);
      // 標記沒寫：下次啟動會重試。
      expect(result.alreadyMigrated).toBe(false);
      // 外部內容沒有被搬進 .ultrawork。
      const copied = join(ws.root, ".ultrawork", "receipts", "evil-link.json");
      expect(() => readFileSync(copied, "utf8")).toThrow();
    } finally {
      ws.cleanup();
      outside.cleanup();
    }
  });
});

describe("敏感檔名：新補的四個被拒", () => {
  test("peek_file 拒絕 .npmrc／.netrc／.git-credentials／id_ecdsa", async () => {
    const ws = makeTempRoot("uw-sensitive-");
    try {
      const { searchModule } = await import("../../../src/modules/search/index.ts");
      const { setupUltrawork: setup } = await import("../../../src/index.ts");
      const fake = createFakeV2Context({ directory: ws.root, sessionDirectory: ws.root });
      const cleanup = await setup(fake.ctx, {
        modules: [searchModule],
        globalDir: fakeGlobalDir(),
      });
      try {
        const peek = fake.added.get("peek_file");
        for (const name of [".npmrc", ".netrc", ".git-credentials", "id_ecdsa"]) {
          writeFileSync(join(ws.root, name), "secret-content", "utf8");
          const raw = await peek.execute({ file: name }, fakeV2ToolContext());
          const parsed = JSON.parse(raw.content);
          expect(parsed.code).toBe("SENSITIVE_PATH");
        }
      } finally {
        await cleanup();
      }
    } finally {
      ws.cleanup();
    }
  });
});
