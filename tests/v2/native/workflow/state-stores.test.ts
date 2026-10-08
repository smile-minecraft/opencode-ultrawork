import { describe, expect, test } from "bun:test";
import {
  createSessionBindingStore,
} from "../../../../src/modules/workflow/runtime/session-binding.ts";
import { createFakeV2Context } from "../../_fake-v2-context.ts";

describe("workflow session storage 競爭", () => {
  test("markSessionTaskBound 可等待，完成後立即讀得到", async () => {
    const fake = createFakeV2Context();
    const bindings = createSessionBindingStore(fake.host.storage);
    await bindings.markSessionTaskBound("session-binding-immediate", "task-1");
    expect(await bindings.getBoundTaskId("session-binding-immediate")).toBe("task-1");
  });

  test("session deleted 後的晚到 mark 不會復活綁定", async () => {
    const fake = createFakeV2Context();
    const bindings = createSessionBindingStore(fake.host.storage);
    await bindings.markSessionTaskBound("session-binding-deleted", "task-1");
    await bindings.clearSessionBinding("session-binding-deleted");
    await bindings.markSessionTaskBound("session-binding-deleted", "task-late");
    expect(await bindings.getBoundTaskId("session-binding-deleted")).toBeNull();
  });

  test("多個宿主各自保留 session binding，不受後註冊的 storage 影響", async () => {
    const first = createFakeV2Context();
    const second = createFakeV2Context();
    const firstBindings = createSessionBindingStore(first.host.storage);
    const secondBindings = createSessionBindingStore(second.host.storage);
    await firstBindings.markSessionTaskBound("host-isolation", "first-task");
    expect(await firstBindings.getBoundTaskId("host-isolation")).toBe("first-task");
    expect(await secondBindings.getBoundTaskId("host-isolation")).toBeNull();
  });
});
