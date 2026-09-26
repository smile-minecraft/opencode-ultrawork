import { existsSync, writeFileSync } from "node:fs";
import { resolveSkillerLockPath, withSkillerWriteLock, type SkillerDeps } from "../../../../src/modules/skiller/skiller-common.ts";
import { createSkillerDraftUpdateTool } from "../../../../src/modules/skiller/skiller-draft-ops.ts";

const [projectRoot, name, expectedSha256, content, holdMsText, readyPath] = process.argv.slice(2);
if (!projectRoot || !name || !expectedSha256 || !content || !holdMsText || !readyPath) process.exit(2);

const deps: SkillerDeps = { resolveProjectRoot: () => projectRoot };
const holdMs = Number(holdMsText);
if (holdMs > 0) {
  await withSkillerWriteLock(resolveSkillerLockPath("project", deps), async () => {
    writeFileSync(readyPath, "held", "utf-8");
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  });
}

const tool = createSkillerDraftUpdateTool(deps);
const result = await tool.execute(
  { scope: "project", name, mode: "apply", expectedSha256, op: "append", content: `\n${content}\n` },
  { sessionID: "worker", agent: "build", messageID: "worker", id: "worker" },
);
if (!existsSync(readyPath) && holdMs === 0) writeFileSync(readyPath, "done", "utf-8");
process.stdout.write(result.content);
