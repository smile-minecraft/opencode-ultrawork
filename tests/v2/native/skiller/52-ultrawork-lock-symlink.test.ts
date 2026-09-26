import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSkillerWriteLock } from "../../../../src/modules/skiller/skiller-common.ts";
import { createExternalSymlinkFixture } from "../symlink-containment-fixture.ts";

describe("skiller .ultrawork lock containment", () => {
  test("cache symlink 指向外部時，不在外部建立或使用 lock", async () => {
    const project = mkdtempSync(join(tmpdir(), "uw-skiller-lock-guard-"));
    const fixture = createExternalSymlinkFixture({
      anchorRoot: project,
      linkPath: join(project, ".ultrawork", "cache"),
      outsidePrefix: "uw-skiller-lock-outside-",
      expectedOutsideEntries: [],
    });
    let called = false;
    try {
      const lockPath = join(project, ".ultrawork", "cache", "locks", "skiller.lock");

      await expect(withSkillerWriteLock(lockPath, async () => { called = true; })).rejects.toThrow();
      expect(called).toBe(false);
      fixture.expectOutsideUnchanged();
    } finally {
      rmSync(project, { recursive: true, force: true });
      fixture.cleanup();
    }
  });
});
