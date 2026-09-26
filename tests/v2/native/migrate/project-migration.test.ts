/**
 * 專案層搬遷的三種情境：全新專案、只有舊資料、新舊都有。
 *
 * 全部用真實暫存目錄，只斷言磁碟上實際發生了什麼。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MIGRATION_MARKER_FILE, ULTRAWORK_GITIGNORE_CONTENT, migrateProjectData } from "../../../../src/migrate/index.ts";
import { FIXED_NOW, archivedName, cleanupTempRoots, readJson, tempRoot, writeFile, writeJson } from "./_helpers.ts";

afterEach(cleanupTempRoots);

const now = () => FIXED_NOW;
const marker = (root: string) => join(root, ".ultrawork", MIGRATION_MARKER_FILE);

function run(root: string) {
  return migrateProjectData({ root, now });
}

/** 鋪一份完整的舊記憶資料（記憶區 + plans 內容庫）。 */
function seedLegacy(root: string): void {
  writeJson(root, ".opencode/memory/tasks.json", { version: "1", tasks: { "t-1": {} } });
  writeJson(root, ".opencode/memory/plans.json", { version: "1", plans: { "p-1": {} } });
  writeFile(root, ".opencode/memory/state.md", "state: IN_PROGRESS\n");
  writeFile(root, ".opencode/memory/audit.jsonl", '{"at":"2026-01-01"}\n');
  writeFile(root, ".opencode/memory/project.md", "# 專案記憶\n");
  writeJson(root, ".opencode/memory/comment-signal-baseline.json", { "src/index.ts": 3 });
  writeFile(root, ".opencode/memory/receipts/r-1.json", '{"receiptId":"r-1"}\n');
  writeFile(root, ".opencode/plans/plan-1.md", "# 計畫長文\n");
}

describe("專案層搬移：全新專案（沒有舊資料）", () => {
  test("建立 .ultrawork/.gitignore，內容是忽略全部只留設定檔", () => {
    const root = tempRoot();
    const result = run(root);
    expect(result.ok).toBe(true);
    const gitignore = join(root, ".ultrawork", ".gitignore");
    expect(existsSync(gitignore)).toBe(true);
    expect(readFileSync(gitignore, "utf-8")).toBe(ULTRAWORK_GITIGNORE_CONTENT);
    expect(readFileSync(gitignore, "utf-8").split("\n").filter(Boolean)).toEqual([
      "*",
      "!.gitignore",
      "!ultrawork.jsonc",
    ]);
    expect(result.gitignore).toEqual({ path: gitignore, created: true });
  });

  test("沒有舊資料也寫標記檔，items 與 skipped 都是空陣列", () => {
    const root = tempRoot();
    run(root);
    expect(existsSync(marker(root))).toBe(true);
    const payload = readJson(marker(root));
    expect(payload.items).toEqual([]);
    expect(payload.skipped).toEqual([]);
    expect(payload.migratedAt).toBe(FIXED_NOW.toISOString());
    // 舊位置本來就沒有，屬於靜默跳過，不算警告。
    expect(payload.version).toBe(1);
  });
});

describe("專案層搬移：只有舊資料", () => {
  test("全部搬進 .ultrawork/，舊檔改名保留，沒有任何刪除", () => {
    const root = tempRoot();
    seedLegacy(root);
    const result = run(root);

    expect(result.migrated.map((item) => item.to)).toEqual([
      join(root, ".ultrawork/tasks.json"),
      join(root, ".ultrawork/plans.json"),
      join(root, ".ultrawork/state.md"),
      join(root, ".ultrawork/audit.jsonl"),
      join(root, ".ultrawork/project.md"),
      join(root, ".ultrawork/comment-signal-baseline.json"),
      join(root, ".ultrawork/receipts"),
      join(root, ".ultrawork/plans"),
    ]);

    // 新位置內容與舊位置逐字相同（含目錄內檔案）。
    expect(readFileSync(join(root, ".ultrawork/tasks.json"), "utf-8")).toBe(
      readFileSync(join(root, `.opencode/memory/${archivedName("tasks.json")}`), "utf-8"),
    );
    expect(readFileSync(join(root, ".ultrawork/receipts/r-1.json"), "utf-8")).toBe('{"receiptId":"r-1"}\n');
    expect(readFileSync(join(root, ".ultrawork/plans/plan-1.md"), "utf-8")).toBe("# 計畫長文\n");

    // 舊路徑本身不再存在，但改名保留的檔案都在。
    expect(existsSync(join(root, ".opencode/memory/tasks.json"))).toBe(false);
    for (const name of ["tasks.json", "state.md", "project.md"]) {
      expect(existsSync(join(root, ".opencode/memory", archivedName(name)))).toBe(true);
    }
    expect(existsSync(join(root, ".opencode/memory", archivedName("receipts")))).toBe(true);
    expect(existsSync(join(root, ".opencode", archivedName("plans")))).toBe(true);
  });

  test("標記檔記錄每個項目的新位置與改名後的檔名", () => {
    const root = tempRoot();
    seedLegacy(root);
    run(root);
    const payload = readJson(marker(root));
    expect(payload.items).toHaveLength(8);
    expect(payload.items[0]).toEqual({
      from: `.opencode/memory/tasks.json`,
      to: ".ultrawork/tasks.json",
      archivedTo: archivedName("tasks.json"),
    });
    expect(payload.items.find((i: any) => i.from === ".opencode/plans")).toEqual({
      from: ".opencode/plans",
      to: ".ultrawork/plans",
      archivedTo: archivedName("plans"),
    });
  });
});

describe("專案層搬移：新舊都有", () => {
  test("新位置已有資料 → 不覆寫、記警告跳過、舊檔留在原地，標記仍寫入", () => {
    const root = tempRoot();
    seedLegacy(root);
    writeFile(root, ".ultrawork/tasks.json", '{"version":"1","tasks":{}}\n');

    const result = run(root);

    // 新位置內容沒被動過。
    expect(readFileSync(join(root, ".ultrawork/tasks.json"), "utf-8")).toBe('{"version":"1","tasks":{}}\n');
    // 舊檔留在原地，沒有改名也沒有刪除。
    expect(existsSync(join(root, ".opencode/memory/tasks.json"))).toBe(true);
    expect(existsSync(join(root, ".opencode/memory", archivedName("tasks.json")))).toBe(false);
    // 其餘項目照搬。
    expect(result.migrated).toHaveLength(7);
    expect(result.skipped.map((item) => item.reason)).toEqual(["target-exists"]);
    expect(result.ok).toBe(true);
    // 全部跳過也算成功，標記要寫。
    const payload = readJson(marker(root));
    expect(payload.items).toHaveLength(7);
    expect(payload.skipped).toEqual([
      { from: ".opencode/memory/tasks.json", to: ".ultrawork/tasks.json", reason: "target-exists" },
    ]);
  });

  test("全新專案加上新舊並存（只有部分檔案有舊資料）也收斂", () => {
    const root = tempRoot();
    writeFile(root, ".opencode/memory/state.md", "state: IDLE\n");
    writeFile(root, ".ultrawork/state.md", "state: IDLE\n");
    const result = run(root);
    expect(result.migrated).toEqual([]);
    expect(result.skipped.filter((item) => item.reason === "source-missing")).toHaveLength(7);
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, ".opencode/memory/state.md"))).toBe(true);
  });
});

describe("專案層搬移：邊際情況", () => {
  test("目標已存在但型別不同（來源是檔案、目標是目錄）→ 跳過不覆寫", () => {
    const root = tempRoot();
    writeFile(root, ".opencode/memory/project.md", "# 舊\n");
    writeFile(root, ".ultrawork/project.md/keep.txt", "使用者自己建的目錄\n");

    const result = run(root);
    expect(result.migrated).toEqual([]);
    const projectMd = result.skipped.find((item) => item.from.endsWith("memory/project.md"));
    expect(projectMd?.reason).toBe("target-exists");
    expect(readFileSync(join(root, ".ultrawork/project.md/keep.txt"), "utf-8")).toBe("使用者自己建的目錄\n");
    expect(readFileSync(join(root, ".opencode/memory/project.md"), "utf-8")).toBe("# 舊\n");
  });

  test("改名保留撞名時加序號", () => {
    const root = tempRoot();
    writeFile(root, ".opencode/memory/tasks.json", '{"version":"1"}\n');
    writeFile(root, `.opencode/memory/${archivedName("tasks.json")}`, "上一輪搬移留下的\n");

    const result = run(root);
    expect(result.migrated[0].archivedTo).toBe(join(root, ".opencode/memory", archivedName("tasks.json", 1)));
    expect(existsSync(join(root, ".opencode/memory", archivedName("tasks.json", 1)))).toBe(true);
    // 舊的那份沒有被蓋掉。
    expect(readFileSync(join(root, ".opencode/memory", archivedName("tasks.json")), "utf-8")).toBe("上一輪搬移留下的\n");
  });

  test(".gitignore 已存在 → 不覆寫；內容相同時不警告", () => {
    const root = tempRoot();
    const gitignore = join(root, ".ultrawork", ".gitignore");
    run(root);
    const second = run(root);
    expect(second.gitignore.created).toBe(false);
    expect(second.gitignore.warning).toBeUndefined();
    expect(readFileSync(gitignore, "utf-8")).toBe(ULTRAWORK_GITIGNORE_CONTENT);
  });

  test(".gitignore 已存在且內容被改過 → 不覆寫並記警告", () => {
    const root = tempRoot();
    writeFile(root, ".ultrawork/.gitignore", "cache/\n");
    const result = run(root);
    expect(result.gitignore.created).toBe(false);
    expect(result.gitignore.warning).toContain("未覆寫");
    expect(readFileSync(join(root, ".ultrawork/.gitignore"), "utf-8")).toBe("cache/\n");
  });

  test("根目錄不合法（空白字串）→ 不搬、不建 .gitignore、不丟錯", () => {
    const result = migrateProjectData({ root: "  ", now });
    expect(result.ok).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.gitignore).toEqual({ path: "", created: false });
  });

  test("搬完不會留下 .partial- 暫存檔", () => {
    const root = tempRoot();
    seedLegacy(root);
    run(root);
    expect(snapshot(root).filter((entry) => entry.includes(".partial-"))).toEqual([]);
  });
});

/** 標記檔已存在 → 該層不再動任何資料。 */
describe("專案層搬移：標記檔已存在", () => {
  test("第二次呼叫不做任何事，磁碟完全沒變", () => {
    const root = tempRoot();
    seedLegacy(root);
    run(root);
    const before = snapshot(root);

    const second = run(root);
    expect(second.alreadyMigrated).toBe(true);
    expect(second.items).toEqual([]);
    expect(snapshot(root)).toEqual(before);
  });

  test("標記檔存在時新出現的舊資料也不會被搬（只做一次的約定）", () => {
    const root = tempRoot();
    run(root);
    writeFile(root, ".opencode/memory/state.md", "state: IDLE\n");
    const second = run(root);
    expect(second.alreadyMigrated).toBe(true);
    expect(existsSync(join(root, ".ultrawork/state.md"))).toBe(false);
  });
});

/** 遞迴列出所有檔案的相對路徑與大小；用來證明搬遷是「改名保留」而不是搬完就沒了。 */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else out.push(`${rel}:${statSync(join(dir, entry.name)).size}`);
    }
  };
  walk(root, "");
  return out.sort();
}
