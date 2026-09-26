import { expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface ExternalSymlinkFixtureOptions {
  anchorRoot: string;
  linkPath: string;
  outsidePrefix: string;
  victim?: {
    relativePath: string;
    content: string | Buffer;
  };
  expectedOutsideEntries?: string[];
}

export interface ExternalSymlinkFixture {
  outsideRoot: string;
  victimPath?: string;
  expectVictimUnchanged(): void;
  expectOutsideUnchanged(): void;
  cleanup(): void;
}

/** 建立模組 symlink 越界測試共用的外部目錄、victim 與清理流程。 */
export function createExternalSymlinkFixture(options: ExternalSymlinkFixtureOptions): ExternalSymlinkFixture {
  const outsideRoot = mkdtempSync(join(tmpdir(), options.outsidePrefix));
  mkdirSync(dirname(options.linkPath), { recursive: true });
  symlinkSync(outsideRoot, options.linkPath, "dir");

  const victimPath = options.victim ? join(outsideRoot, options.victim.relativePath) : undefined;
  if (victimPath && options.victim) {
    mkdirSync(dirname(victimPath), { recursive: true });
    writeFileSync(victimPath, options.victim.content);
  }

  return {
    outsideRoot,
    victimPath,
    expectVictimUnchanged() {
      if (!victimPath || !options.victim) return;
      expect(existsSync(victimPath)).toBe(true);
      if (typeof options.victim.content === "string") {
        expect(readFileSync(victimPath, "utf8")).toBe(options.victim.content);
      } else {
        expect(Buffer.compare(readFileSync(victimPath), options.victim.content)).toBe(0);
      }
    },
    expectOutsideUnchanged() {
      const expected = options.expectedOutsideEntries;
      if (expected) expect(readdirSync(outsideRoot)).toEqual(expected);
    },
    cleanup() {
      rmSync(outsideRoot, { recursive: true, force: true });
    },
  };
}
