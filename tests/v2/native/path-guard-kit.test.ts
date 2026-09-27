/**
 * kit 路徑守衛的單一實作：isUnsafeRoot／isSensitivePath 的唯一判定。
 *
 * 各模組（workflow／search／verification／migrate／memory／comment-signal／
 * skiller）一律從 `src/kit/path-guard.ts` 取用，不再各寫一份黑名單。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isSensitivePath, isUnsafeRoot } from "../../../src/kit/path-guard.ts";

describe("kit isUnsafeRoot：唯一的黑名單判定", () => {
  test("系統根與關鍵目錄是 unsafe", () => {
    expect(isUnsafeRoot("/")).toBe(true);
    expect(isUnsafeRoot("")).toBe(true);
    expect(isUnsafeRoot("/Users")).toBe(true);
    expect(isUnsafeRoot("/Volumes")).toBe(true);
  });

  test("家目錄本身是 unsafe，存在祖先下的一般子目錄不是", () => {
    expect(isUnsafeRoot(homedir())).toBe(true);
    // 家目錄下的子路徑若不存在（例如 CI 乾淨家目錄的 ~/.config/opencode），
    // 最近的存在祖先就是家目錄本身，會走 fail closed；所以「一般子目錄不是
    // unsafe」改用暫存目錄下實際存在的路徑驗，不依賴執行環境的家目錄內容。
    const dir = mkdtempSync(join(tmpdir(), "kit-unsafe-"));
    try {
      mkdirSync(join(dir, "sub"));
      expect(isUnsafeRoot(join(dir, "sub"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("不存在、只能解析到家目錄的路徑判 unsafe（fail closed）", () => {
    // 不存在的子路徑最近的存在祖先就是家目錄本身，無法確認它是獨立存在的
    // 子目錄 → 無法確認 containment，一律判 unsafe。這個語意是刻意的，
    // 不能拿真實家目錄下存在的路徑來反證它。
    expect(isUnsafeRoot(join(homedir(), ".ultrawork-test-nonexistent-8f3c2a"))).toBe(true);
  });

  test("暫存測試目錄不是 unsafe", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-unsafe-"));
    try {
      expect(isUnsafeRoot(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("指到 unsafe 目標的 symlink alias 也是 unsafe", () => {
    const parent = mkdtempSync(join(tmpdir(), "kit-unsafe-alias-"));
    try {
      for (const target of ["/", "/Users", "/Volumes", homedir()]) {
        const alias = join(parent, `alias-${target.replace(/[^A-Za-z0-9]+/g, "-")}`);
        symlinkSync(target, alias, "dir");
        expect(isUnsafeRoot(alias)).toBe(true);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("kit isSensitivePath：唯一的敏感檔名判定", () => {
  test("原有清單維持", () => {
    for (const name of [".env", ".env.local", "id_rsa", "id_ed25519", "credentials.json", "service-account.json", "secret.pem", "key.p12"]) {
      expect(isSensitivePath(name)).toBe(true);
    }
    expect(isSensitivePath(".env.example")).toBe(false);
  });

  test("新補的檔名被拒", () => {
    for (const name of ["id_ecdsa", "id_dsa", ".npmrc", ".netrc", ".git-credentials"]) {
      expect(isSensitivePath(name)).toBe(true);
      expect(isSensitivePath(`nested/dir/${name}`)).toBe(true);
    }
  });

  test("一般檔名放行", () => {
    for (const name of ["app.ts", "README.md", "notes.txt", "config.json"]) {
      expect(isSensitivePath(name)).toBe(false);
    }
  });

  test("sensitive 判定不依賴檔案系統（純字串）", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-sensitive-"));
    try {
      const name = "id_ecdsa";
      writeFileSync(join(dir, "other.txt"), "x", "utf8");
      expect(isSensitivePath(name)).toBe(true);
      expect(isSensitivePath("other.txt")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
