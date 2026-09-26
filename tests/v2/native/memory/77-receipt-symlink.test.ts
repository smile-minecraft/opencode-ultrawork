import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReceiptForCompletion } from "../../../../src/modules/memory/receipt-validator.ts";
import { createExternalSymlinkFixture } from "../symlink-containment-fixture.ts";

describe("memory receipt path containment", () => {
  test(".ultrawork symlink 指向外部時，不讀取外部 receipt", () => {
    const project = mkdtempSync(join(tmpdir(), "uw-memory-receipt-guard-"));
    const receipt = JSON.stringify({
      taskId: "t-leak",
      projectId: "project",
      projectPath: project,
      status: "ok",
      createdAt: new Date().toISOString(),
      zeroExtractionReason: "外部檔案不應被讀取",
    });
    const fixture = createExternalSymlinkFixture({
      anchorRoot: project,
      linkPath: join(project, ".ultrawork"),
      outsidePrefix: "uw-memory-receipt-outside-",
      victim: { relativePath: "receipts/receipt-leak.json", content: receipt },
    });
    try {
      const result = validateReceiptForCompletion(
        project,
        "receipt-leak",
        { taskId: "t-leak" },
        { projectId: "project", projectPath: project },
      );
      expect(result.ok).toBe(false);
      fixture.expectVictimUnchanged();
    } finally {
      rmSync(project, { recursive: true, force: true });
      fixture.cleanup();
    }
  });
});
