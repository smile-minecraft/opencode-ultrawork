import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeywordLoader } from "../../../../src/modules/skills/skill-catalog.ts";
import { createExternalSymlinkFixture } from "../symlink-containment-fixture.ts";

describe("skills policy path containment", () => {
  test(".ultrawork symlink 指向外部時，不讀取外部 policy", () => {
    const globalRoot = mkdtempSync(join(tmpdir(), "uw-skills-policy-"));
    const fixture = createExternalSymlinkFixture({
      anchorRoot: globalRoot,
      linkPath: join(globalRoot, ".ultrawork"),
      outsidePrefix: "uw-skills-policy-outside-",
      victim: {
        relativePath: "skills-policy.json",
        content: JSON.stringify({ searchKeywords: { leaked: { zh: ["外部關鍵字"] } } }),
      },
    });
    try {

      const load = createKeywordLoader(join(globalRoot, ".ultrawork", "skills-policy.json"));
      expect(load()).toEqual({});
      fixture.expectVictimUnchanged();
    } finally {
      rmSync(globalRoot, { recursive: true, force: true });
      fixture.cleanup();
    }
  });
});
