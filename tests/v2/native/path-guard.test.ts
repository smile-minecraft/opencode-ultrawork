import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { assertContainedPath } from "../../../src/kit/path-guard.ts";
import { resolveCanonicalRoot, resolveCanonicalTarget } from "../../../src/modules/comment-signal/containment.ts";
import { assertSafeMemoryPath } from "../../../src/modules/memory/paths.ts";
import { assertSafeProjectFile } from "../../../src/modules/workflow/content/content-store.ts";

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** 建立一個「真實目錄 + 指向它的 symlink」錨點，回傳兩種路徑寫法。 */
function symlinkedAnchor(prefix: string): { realRoot: string; linkRoot: string } {
  const sandbox = tempRoot(prefix);
  const realRoot = join(sandbox, "real");
  mkdirSync(realRoot);
  const linkRoot = join(sandbox, "proj-link");
  symlinkSync(realRoot, linkRoot, "dir");
  return { realRoot, linkRoot };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("kit symlink-aware containment guard", () => {
  test("拒絕錨與目標之間的中間 symlink", () => {
    const root = tempRoot("uw-path-guard-root-");
    const outside = tempRoot("uw-path-guard-outside-");
    symlinkSync(outside, join(root, "linked-dir"), "dir");

    expect(() => assertContainedPath(root, join(root, "linked-dir", "new.txt"))).toThrow(/symlink/i);
  });

  test("拒絕目標本身是 symlink", () => {
    const root = tempRoot("uw-path-guard-root-");
    const outside = tempRoot("uw-path-guard-outside-");
    const victim = join(outside, "victim.txt");
    const original = Buffer.from([0xff, 0x00, 0x41]);
    writeFileSync(victim, original);
    symlinkSync(victim, join(root, "linked.txt"), "file");

    expect(() => assertContainedPath(root, join(root, "linked.txt"))).toThrow(/symlink/i);
    expect(readFileSync(victim)).toEqual(original);
  });

  test("允許尾端尚未存在，但會檢查既有父段", () => {
    const root = tempRoot("uw-path-guard-root-");
    const parent = join(root, "existing");
    mkdirSync(parent);
    const target = join(parent, "nested", "new.txt");

    expect(assertContainedPath(root, target)).toBe(resolve(target));
    expect(existsSync(target)).toBe(false);
  });

  test("拒絕 canonical 目標逃出錨", () => {
    const root = tempRoot("uw-path-guard-root-");
    const outside = tempRoot("uw-path-guard-outside-");

    expect(() => assertContainedPath(root, join(root, "..", "escaped.txt"))).toThrow();
    expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
  });

  test("正常路徑放行並回傳解析路徑", () => {
    const root = tempRoot("uw-path-guard-root-");
    const target = join(root, "safe", "file.txt");
    mkdirSync(join(root, "safe"));
    writeFileSync(target, "safe");

    expect(assertContainedPath(root, target)).toBe(resolve(target));
  });
});

describe("錨點本身是 symlink 的邊界", () => {
  test("錨點是 symlink＋目標尾端整段不存在 → 放行，canonical 落錨內", () => {
    const { realRoot, linkRoot } = symlinkedAnchor("uw-path-guard-anchor-");
    const target = join(linkRoot, ".ultrawork", "plans", "tasks", "t-1.md");

    expect(assertContainedPath(linkRoot, target)).toBe(resolve(target));
    expect(existsSync(target)).toBe(false);

    // 對照舊的模組版 resolver：canonical 目標必須與它一致，且落在錨點 realpath 子樹內。
    const canonicalRoot = resolveCanonicalRoot(linkRoot);
    const canonicalTarget = resolveCanonicalTarget(resolve(target));
    expect(canonicalRoot).toBe(realpathSync(realRoot));
    expect(canonicalTarget).not.toBeUndefined();
    const rel = relative(canonicalRoot as string, canonicalTarget as string);
    expect(rel === ".." || rel.startsWith(`..${sep}`)).toBe(false);
  });

  test("錨點是 symlink＋目標已存在於錨下 → 放行（維持現況）", () => {
    const { realRoot, linkRoot } = symlinkedAnchor("uw-path-guard-anchor-");
    const target = join(linkRoot, ".ultrawork", "project.md");
    mkdirSync(join(realRoot, ".ultrawork"), { recursive: true });
    writeFileSync(join(realRoot, ".ultrawork", "project.md"), "ok");

    expect(assertContainedPath(linkRoot, target)).toBe(resolve(target));
  });

  test("錨點是 symlink＋中間段是 symlink → 拒絕", () => {
    const { realRoot, linkRoot } = symlinkedAnchor("uw-path-guard-anchor-");
    const outside = tempRoot("uw-path-guard-outside-");
    mkdirSync(join(realRoot, "sub"));
    symlinkSync(outside, join(realRoot, "sub", "linked-dir"), "dir");

    expect(() => assertContainedPath(linkRoot, join(linkRoot, "sub", "linked-dir", "new.txt"))).toThrow(/symlink/i);
  });

  test("錨點是 symlink＋canonical 逃出錨 → 拒絕且外部未被建立", () => {
    const { realRoot, linkRoot } = symlinkedAnchor("uw-path-guard-anchor-");
    const outside = tempRoot("uw-path-guard-outside-");
    writeFileSync(join(outside, "secret.txt"), "SECRET");
    mkdirSync(join(realRoot, "sub"));
    // 錨下既有段是 symlink，canonical 會落到錨外：必須 fail closed。
    symlinkSync(outside, join(realRoot, "sub", "esc"), "dir");

    expect(() => assertContainedPath(linkRoot, join(linkRoot, "sub", "esc", "secret.txt"))).toThrow();
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("SECRET");
  });

  test("錨點是 dangling symlink → 拒絕（fail closed 不放寬）", () => {
    const sandbox = tempRoot("uw-path-guard-anchor-");
    const linkRoot = join(sandbox, "dangling");
    symlinkSync(join(sandbox, "missing-target"), linkRoot, "dir");

    expect(() => assertContainedPath(linkRoot, join(linkRoot, ".ultrawork", "project.md"))).toThrow(
      /cannot resolve guarded root/,
    );
  });

  test("錨點不存在（allowMissingAnchor）＋其父是 symlink → 拒絕", () => {
    const sandbox = tempRoot("uw-path-guard-anchor-");
    const realRoot = join(sandbox, "real");
    mkdirSync(realRoot);
    const linkRoot = join(sandbox, "proj-link");
    symlinkSync(realRoot, linkRoot, "dir");
    const missingAnchor = join(linkRoot, "not-created-yet");

    expect(() =>
      assertContainedPath(missingAnchor, join(missingAnchor, "x.txt"), { allowMissingAnchor: true }),
    ).toThrow(/cannot resolve guarded root/);
  });

  test("錨點是 symlink＋allowMissingAnchor＋尾端不存在 → 放行", () => {
    const { linkRoot } = symlinkedAnchor("uw-path-guard-anchor-");
    const target = join(linkRoot, "nope", "deep", "x.txt");

    expect(assertContainedPath(linkRoot, target, { allowMissingAnchor: true })).toBe(resolve(target));
  });
});

describe("呼叫端回歸：symlink 專案根不再誤拒", () => {
  test("assertSafeMemoryPath 在 symlink 專案根＋全新專案放行 receipts 路徑", () => {
    const { linkRoot } = symlinkedAnchor("uw-anchor-caller-");
    const target = join(linkRoot, ".ultrawork", "receipts");

    expect(assertSafeMemoryPath(linkRoot, target)).toBe(resolve(target));
  });

  test("assertSafeProjectFile 在 symlink 專案根＋全新專案放行 lazyEnsure 的 tasks.json", () => {
    const { linkRoot } = symlinkedAnchor("uw-anchor-caller-");
    const plansDir = join(linkRoot, ".ultrawork", "plans");

    expect(() => assertSafeProjectFile(linkRoot, plansDir, join(linkRoot, ".ultrawork", "memory", "tasks.json"))).not.toThrow();
  });

  test("呼叫端仍拒絕 symlink 專案根下經 symlink 的越界路徑", () => {
    const { realRoot, linkRoot } = symlinkedAnchor("uw-anchor-caller-");
    const outside = tempRoot("uw-path-guard-outside-");
    mkdirSync(join(realRoot, ".ultrawork"), { recursive: true });
    symlinkSync(outside, join(realRoot, ".ultrawork", "receipts"), "dir");

    expect(() => assertSafeMemoryPath(linkRoot, join(linkRoot, ".ultrawork", "receipts", "r.json"))).toThrow(/symlink/i);
  });
});
