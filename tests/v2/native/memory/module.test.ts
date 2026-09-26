/**
 * memory 模組開關：關閉時 6 個工具都不註冊，開啟時全部註冊。
 *
 * 對應 search.test.ts 底部的開關測試，形狀相同。
 */

import { describe, expect, test } from "bun:test";
import { setupUltrawork } from "../../../../src/index.ts";
import { memoryModule } from "../../../../src/modules/memory/index.ts";
import { createFakeV2Context } from "../../_fake-v2-context.ts";

const EXPECTED_TOOLS = [
  "project-memory-read",
  "project-memory-update",
  "project-memory-rewrite",
  "memory-receipt-create",
  "memory-receipt-read",
  "memory-receipt-list",
];

describe("memory 模組開關", () => {
  test("模組關閉時 6 個工具都不註冊", async () => {
    const fake = createFakeV2Context();
    const cleanup = await setupUltrawork(fake.ctx, {
      modules: [memoryModule],
      settings: { modules: { memory: false } },
    });
    try {
      expect(fake.added.size).toBe(0);
      for (const name of EXPECTED_TOOLS) {
        expect(fake.added.get(name)).toBeUndefined();
      }
    } finally {
      await cleanup();
    }
  });

  test("模組開啟時 6 個工具都註冊（連字號名稱）", async () => {
    const fake = createFakeV2Context();
    const cleanup = await setupUltrawork(fake.ctx, { modules: [memoryModule] });
    try {
      for (const name of EXPECTED_TOOLS) {
        const tool = fake.added.get(name);
        expect(tool, name).toBeDefined();
        expect(typeof tool?.description).toBe("string");
      }
    } finally {
      await cleanup();
    }
  });
});
