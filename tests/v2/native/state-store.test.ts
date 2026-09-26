/** state 包裝：ctx.storage 的前綴 key、上限淘汰、session.deleted 清理、重新載入後還在。 */

import { describe, expect, test } from "bun:test";
import { SessionStateStore } from "../../../src/state/store.ts";
import { createFakeV2Context } from "../_fake-v2-context.ts";

describe("工作階段狀態", () => {
  test("set／get／remove 照前綴隔離", async () => {
    const fake = createFakeV2Context();
    const store = new SessionStateStore(fake.ctx.storage);
    await store.setSession("s1", "draft", { text: "a" });
    expect(await store.getSession("s1", "draft")).toEqual({ text: "a" });
    expect(await store.getSession("s2", "draft")).toBeUndefined();
    await store.removeSession("s1", "draft");
    expect(await store.getSession("s1", "draft")).toBeUndefined();
  });

  test("scan 支援 prefix、after、limit、next 分頁", async () => {
    const fake = createFakeV2Context();
    const store = new SessionStateStore(fake.ctx.storage);
    await store.setSession("s1", "a", 1);
    await store.setSession("s1", "b", 2);
    await store.setSession("s1", "c", 3);
    const first = await store.scanSession("s1", { limit: 2 });
    expect(first.entries.map((entry) => entry.key)).toHaveLength(2);
    expect(first.next).toBeDefined();
    const second = await store.scanSession("s1", { after: first.next, limit: 2 });
    expect(second.entries.map((entry) => entry.key)).toHaveLength(1);
    expect(second.next).toBeUndefined();
  });

  test("非 JSON 可序列化的值拒絕寫入", async () => {
    const fake = createFakeV2Context();
    const store = new SessionStateStore(fake.ctx.storage);
    await expect(store.setSession("s1", "bad", { fn: () => {} } as any)).rejects.toThrow();
    await expect(store.setSession("s1", "bad", { big: 10n } as any)).rejects.toThrow();
  });

  test("超過上限時淘汰最舊的工作階段", async () => {
    const fake = createFakeV2Context();
    const store = new SessionStateStore(fake.ctx.storage, { maxSessions: 2 });
    await store.setSession("s1", "a", 1);
    await store.setSession("s2", "a", 2);
    await store.setSession("s3", "a", 3);
    expect(await store.getSession("s1", "a")).toBeUndefined();
    expect(await store.getSession("s3", "a")).toBe(3);
  });

  test("session.deleted 清掉該工作階段的狀態", async () => {
    const fake = createFakeV2Context();
    const store = new SessionStateStore(fake.ctx.storage);
    await store.setSession("s1", "a", 1);
    await store.handleEvent({ type: "session.deleted", data: { sessionID: "s1" } });
    expect(await store.getSession("s1", "a")).toBeUndefined();
  });

  test("同一 storage 重新 setup 後狀態還在", async () => {
    const fake = createFakeV2Context();
    const first = new SessionStateStore(fake.ctx.storage);
    await first.setSession("s1", "draft", { text: "keep" });
    const second = new SessionStateStore(fake.ctx.storage);
    expect(await second.getSession("s1", "draft")).toEqual({ text: "keep" });
  });

  test("專案前綴與工作階段前綴互不影響", async () => {
    const fake = createFakeV2Context();
    const store = new SessionStateStore(fake.ctx.storage);
    await store.setProject("p1", "config", { v: 1 });
    expect(await store.getSession("s1", "config")).toBeUndefined();
    expect(await store.getProject("p1", "config")).toEqual({ v: 1 });
  });
});
