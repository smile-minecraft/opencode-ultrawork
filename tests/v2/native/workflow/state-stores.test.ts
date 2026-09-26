import { describe, expect, test } from "bun:test";
import { createEscalationTracker } from "../../../../src/modules/workflow/gates/escalation.ts";
import {
  clearSessionBinding,
  configureSessionBindingStore,
  getBoundTaskId,
  markSessionTaskBound,
} from "../../../../src/modules/workflow/runtime/session-binding.ts";
import { createFakeV2Context } from "../../_fake-v2-context.ts";

describe("workflow session storage 競爭", () => {
  test("markSessionTaskBound 可等待，完成後立即讀得到", async () => {
    const fake = createFakeV2Context();
    configureSessionBindingStore(fake.ctx.storage);
    await markSessionTaskBound("session-binding-immediate", "task-1");
    expect(await getBoundTaskId("session-binding-immediate")).toBe("task-1");
  });

  test("session deleted 後的晚到 mark 不會復活綁定", async () => {
    const fake = createFakeV2Context();
    configureSessionBindingStore(fake.ctx.storage);
    await markSessionTaskBound("session-binding-deleted", "task-1");
    await clearSessionBinding("session-binding-deleted");
    await markSessionTaskBound("session-binding-deleted", "task-late");
    expect(await getBoundTaskId("session-binding-deleted")).toBeNull();
  });

  test("升級紀錄超過 2000 筆時依建立時間淘汰最舊資料", async () => {
    const fake = createFakeV2Context();
    for (let index = 0; index < 2000; index++) {
      const keyNumber = 1999 - index;
      await fake.ctx.storage.set(`session/s${String(keyNumber).padStart(4, "0")}/escalation`, {
        parentID: "parent",
        agent: "implementer",
        createdAt: index + 1,
      });
    }
    const tracker = createEscalationTracker(fake.ctx.storage, undefined, () => 2001);
    await tracker.record("newest", "parent", "debugger");

    expect(await fake.ctx.storage.get("session/s1999/escalation")).toBeUndefined();
    expect(await fake.ctx.storage.get("session/s0000/escalation")).not.toBeUndefined();
    expect(await fake.ctx.storage.get("session/newest/escalation")).not.toBeUndefined();
  });
});
