import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommentSignalStore } from "../../../../src/modules/comment-signal/state.ts";
import { createExternalSymlinkFixture } from "../symlink-containment-fixture.ts";
import type { KeyValueStorage } from "../../../../src/state/store.ts";

function memoryStorage(): KeyValueStorage {
  const values = new Map<string, unknown>();
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    remove: async (key) => { values.delete(key); },
    scan: async ({ prefix, after }) => {
      const entries = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => ({ key, value }));
      return entries.length > 0 ? { entries, next: entries.at(-1)!.key } : { entries };
    },
  };
}

describe("22 - commentSignal lock path containment", () => {
  test("cache symlink 指向外部時，不建立外部 lock 目錄或寫入 storage", async () => {
    const project = mkdtempSync(join(tmpdir(), "uw-cs-lock-guard-"));
    const fixture = createExternalSymlinkFixture({
      anchorRoot: project,
      linkPath: join(project, ".ultrawork", "cache"),
      outsidePrefix: "uw-cs-lock-outside-",
      expectedOutsideEntries: [],
    });
    const storage = memoryStorage();
    try {
      const store = new CommentSignalStore(storage, {
        resolveLockDir: async () => join(project, ".ultrawork", "cache", "locks"),
      });

      await store.recordModifiedFile("session-guard", "src/file.ts");

      fixture.expectOutsideUnchanged();
      expect(await store.getModifiedFiles("session-guard")).toEqual([]);
    } finally {
      rmSync(project, { recursive: true, force: true });
      fixture.cleanup();
    }
  });
});
