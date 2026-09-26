import { describe, expect, test } from "bun:test";
import { createWorkOrderStore } from "../../../../src/modules/workflow/tools/work-order-store.ts";
import { createFakeV2Context } from "../../_fake-v2-context.ts";

describe("workflow work-order storage", () => {
  test("重新建立 store 後仍可解析，其他工作階段仍被擋下", async () => {
    const fake = createFakeV2Context();
    const first = createWorkOrderStore(fake.ctx.storage);
    const id = await first.save("完整工作說明", "s1");
    const reloaded = createWorkOrderStore(fake.ctx.storage);
    expect(await reloaded.resolve(`work-order:${id}`, "s1")).toEqual({
      kind: "resolved",
      id,
      prompt: "完整工作說明",
    });
    expect(await reloaded.resolve(`work-order:${id}`, "s2")).toEqual({ kind: "wrong-session", id });
  });

  test("維持 200 筆上限並淘汰最舊資料", async () => {
    const fake = createFakeV2Context();
    let clock = 1_000;
    const store = createWorkOrderStore(fake.ctx.storage, () => ++clock);
    const ids: string[] = [];
    for (let index = 0; index < 205; index++) ids.push(await store.save(`prompt-${index}`, "s1"));
    expect((await store.resolve(`work-order:${ids[0]}`, "s1")).kind).toBe("not-found");
    expect((await store.resolve(`work-order:${ids[204]}`, "s1")).kind).toBe("resolved");
    expect([...fake.store.keys()].filter((key) => key.includes("/work-order/"))).toHaveLength(200);
  });

  test("工作階段刪除時清理代號", async () => {
    const fake = createFakeV2Context();
    const store = createWorkOrderStore(fake.ctx.storage);
    const id = await store.save("prompt", "s1");
    await store.clearSession("s1");
    expect(await store.resolve(`work-order:${id}`, "s1")).toEqual({ kind: "not-found", id });
  });
});
