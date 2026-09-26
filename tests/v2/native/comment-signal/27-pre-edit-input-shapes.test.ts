/**
 * 27 — pre-edit hook 的 input 形狀容忍與可診斷性（Red first）。
 *
 * 問題：`execute.before` 在抽不到路徑時會 fail closed 阻斷整個工具呼叫，
 * 這是必要的（抽不到就等於跳過修改前檢查）。但抽取只認少數欄位名與
 * 純物件形狀，一旦 OpenCode／外掛／harness 送來另一種形狀（序列化字串、
 * 包一層的 args、snake_case 欄位、陣列值），**每一次**編輯都會被擋下，
 * 而且訊息只說「缺少 path／patchText」，完全看不出實際收到什麼。
 *
 * 實測（見回報）：標準形狀 `{ path }` 與 `{ filePath }` 在真實工作階段是
 * 正常放行的，所以要修的不是「放寬阻斷」，而是：
 *   1. 抽取涵蓋真實世界會出現的其他形狀；
 *   2. 真的抽不到時，訊息要指出「哪個工具、收到哪些欄位、型態是什麼」。
 *
 * 安全邊界（不得放寬）：
 *   - 抽不到路徑仍然阻斷。
 *   - 診斷訊息只輸出欄位名與型態，**不得**輸出欄位值（oldString／newString
 *     可能是整份檔案內容）。
 *   - 抽到的每一條路徑都還是要過 P0 檢查（下面每個案例都用 P0 檔證明
 *     「確實有去檢查」，不是默默跳過）。
 *
 * P0 阻斷/G3 傳統：functional tag literal 以 TAG_OPEN 拼接。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractFilePathsFromArgs, describeToolInputFields } from "../../../../src/modules/comment-signal/hook-adapter.ts";
import {
  createWorkspace,
  setupCommentSignal,
  type CommentSignalFixture,
} from "./_helpers.ts";

const TAG_OPEN = "[";

/** 帶 P0 的檔案：一旦路徑真的被抽到並檢查，就會被擋。 */
const P0_SOURCE = `// ${TAG_OPEN}AI_DO_NOT_EDIT:P0] 此檔由 codegen 自動產生，禁止人工修改。\n`;
/** 乾淨檔案：抽到路徑就應放行。 */
const CLEAN_SOURCE = `// ${TAG_OPEN}目的] 乾淨檔案。\n`;

describe("27 - pre-edit input 形狀：抽取涵蓋真實形狀", () => {
  let ws: ReturnType<typeof createWorkspace>;
  let fx: CommentSignalFixture;
  beforeEach(async () => {
    ws = createWorkspace();
    fx = await setupCommentSignal(ws.root);
    mkdirSync(join(ws.root, "src"), { recursive: true });
  });
  afterEach(async () => {
    await fx.cleanup();
    ws.cleanup();
  });

  function before() {
    const hook = fx.fake.toolHooks.get("execute.before");
    expect(hook, "execute.before 已註冊").toBeDefined();
    return hook!;
  }

  /** 真實世界會出現、但修正前抽不到路徑的 input 形狀。 */
  const TOLERATED_SHAPES: Array<{ label: string; build: (p: string) => unknown }> = [
    { label: "JSON 序列化字串", build: (p) => JSON.stringify({ path: p }) },
    { label: "包一層 args", build: (p) => ({ args: { path: p } }) },
    { label: "包一層 arguments", build: (p) => ({ arguments: { path: p } }) },
    { label: "包一層 input", build: (p) => ({ input: { path: p } }) },
    { label: "包一層 state.input", build: (p) => ({ state: { input: { path: p } } }) },
    { label: "snake_case file_path", build: (p) => ({ file_path: p }) },
    { label: "snake_case filepath", build: (p) => ({ filepath: p }) },
    { label: "camelCase fileName", build: (p) => ({ fileName: p }) },
    { label: "陣列值 files", build: (p) => ({ files: [p] }) },
    { label: "巢狀 args + snake_case", build: (p) => ({ args: { file_path: p } }) },
  ];

  for (const shape of TOLERATED_SHAPES) {
    test(`edit 收到「${shape.label}」：乾淨檔放行`, async () => {
      writeFileSync(join(ws.root, "src", "ok.ts"), CLEAN_SOURCE, "utf-8");
      await before()({
        tool: "edit",
        sessionID: "shape-ok",
        input: shape.build("src/ok.ts"),
      });
    });

    test(`edit 收到「${shape.label}」：P0 檔仍被擋（證明確實有檢查）`, async () => {
      writeFileSync(join(ws.root, "src", "gen.ts"), P0_SOURCE, "utf-8");
      await expect(
        before()({ tool: "edit", sessionID: "shape-p0", input: shape.build("src/gen.ts") }),
      ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);
    });
  }

  test("混合包裝：外層 Markdown、內層 P0 → 必須阻斷（不能只檢查到外層）", async () => {
    // 審查指出的漏檢：input 同時有兩個路徑來源時，舊邏輯碰到第一個含已知
    // 欄位的物件就停，只抽到外層的 Markdown；hook 略過 Markdown，內層真正
    // 被編輯的 P0 檔就完全沒被檢查——等於繞過 P0 保護。
    writeFileSync(join(ws.root, "notes.md"), "# 文件不掃\n", "utf-8");
    writeFileSync(join(ws.root, "src", "gen.ts"), P0_SOURCE, "utf-8");
    await expect(
      before()({
        tool: "edit",
        sessionID: "mix-outer-md",
        input: { path: "notes.md", args: { path: "src/gen.ts" } },
      }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);
  });

  test("混合包裝：外層 P0、內層 Markdown → 一樣必須阻斷（方向不因順序改變）", async () => {
    writeFileSync(join(ws.root, "notes.md"), "# 文件不掃\n", "utf-8");
    writeFileSync(join(ws.root, "src", "gen.ts"), P0_SOURCE, "utf-8");
    await expect(
      before()({
        tool: "edit",
        sessionID: "mix-outer-p0",
        input: { path: "src/gen.ts", args: { path: "notes.md" } },
      }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);
  });

  test("混合包裝：陣列值 + 多層包裝，全部候選都要檢查", async () => {
    writeFileSync(join(ws.root, "notes.md"), "# 文件不掃\n", "utf-8");
    writeFileSync(join(ws.root, "src", "gen.ts"), P0_SOURCE, "utf-8");
    await expect(
      before()({
        tool: "edit",
        sessionID: "mix-array",
        input: { files: ["notes.md"], state: { input: { args: { path: "src/gen.ts" } } } },
      }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);
  });

  test("混合包裝：所有候選都乾淨時仍要放行（不能變成看到多來源就擋）", async () => {
    writeFileSync(join(ws.root, "notes.md"), "# 文件不掃\n", "utf-8");
    writeFileSync(join(ws.root, "src", "ok.ts"), CLEAN_SOURCE, "utf-8");
    await before()({
      tool: "edit",
      sessionID: "mix-clean",
      input: { path: "notes.md", args: { path: "src/ok.ts" } },
    });
  });

  test("抽取函式：多個來源的路徑全部合併（外層在前、去重）", () => {
    expect(
      extractFilePathsFromArgs({ path: "notes.md", args: { path: "src/gen.ts" } }),
    ).toEqual(["notes.md", "src/gen.ts"]);
    // 同一條路徑出現在兩層時只留一份
    expect(
      extractFilePathsFromArgs({ path: "src/a.ts", args: { path: "src/a.ts" } }),
    ).toEqual(["src/a.ts"]);
    // 陣列與多層同時存在
    expect(
      extractFilePathsFromArgs({
        files: ["a.ts", "b.ts"],
        state: { input: { path: "c.ts" } },
      }),
    ).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("只沿著包裝鍵往下走，不會鑽進任意巢狀欄位（避免誤判）", () => {
    // 合併全部候選不代表要掃遍整個物件：只有包裝鍵（args／state／input…）
    // 會被展開，其他鍵底下的物件不動，否則工具 metadata 裡任何叫 path 的
    // 欄位都會被當成檔案路徑。
    expect(
      extractFilePathsFromArgs({ path: "src/ok.ts", metadata: { nested: { path: "not/a/real/path" } } }),
    ).toEqual(["src/ok.ts"]);
    // 包裝鍵底下的路徑仍然要取到
    expect(
      extractFilePathsFromArgs({ path: "src/ok.ts", state: { input: { path: "src/b.ts" } } }),
    ).toEqual(["src/ok.ts", "src/b.ts"]);
  });

  test("抽取函式：多層包裝仍抽得到，且保持順序去重", () => {
    expect(extractFilePathsFromArgs(JSON.stringify({ path: "src/a.ts" }))).toEqual(["src/a.ts"]);
    expect(extractFilePathsFromArgs({ args: { path: "src/a.ts" } })).toEqual(["src/a.ts"]);
    expect(extractFilePathsFromArgs({ state: { input: { file_path: "src/b.ts" } } })).toEqual(["src/b.ts"]);
    // 多檔 patch 仍照舊
    expect(
      extractFilePathsFromArgs({ patchText: "*** Update File: src/a.ts\n*** Add File: src/b.ts\n" }),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("write 與 patch 的真實形狀不受影響", async () => {
    writeFileSync(join(ws.root, "src", "gen.ts"), P0_SOURCE, "utf-8");
    await expect(
      before()({ tool: "write", sessionID: "s-write", input: { path: "src/gen.ts", content: "x" } }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);
    await expect(
      before()({
        tool: "patch",
        sessionID: "s-patch",
        input: { patchText: "*** Update File: src/gen.ts\n" },
      }),
    ).rejects.toThrow(/AI_DO_NOT_EDIT:P0/);
  });
});

describe("27 - pre-edit input 形狀：抽不到時仍然阻斷，但可診斷", () => {
  let ws: ReturnType<typeof createWorkspace>;
  let fx: CommentSignalFixture;
  beforeEach(async () => {
    ws = createWorkspace();
    fx = await setupCommentSignal(ws.root);
    mkdirSync(join(ws.root, "src"), { recursive: true });
  });
  afterEach(async () => {
    await fx.cleanup();
    ws.cleanup();
  });

  function before() {
    const hook = fx.fake.toolHooks.get("execute.before");
    expect(hook, "execute.before 已註冊").toBeDefined();
    return hook!;
  }

  test("完全沒有路徑：仍然阻斷，訊息指出工具名與收到的欄位", async () => {
    await expect(
      before()({
        tool: "edit",
        sessionID: "diag-1",
        input: { filePattern: "src/*.ts", replaceAll: true },
      }),
    ).rejects.toThrow(/edit/);
    // 訊息要點名實際收到的欄位，而不是只說「缺少 path」
    await expect(
      before()({
        tool: "edit",
        sessionID: "diag-1",
        input: { filePattern: "src/*.ts", replaceAll: true },
      }),
    ).rejects.toThrow(/filePattern/);
  });

  test("input 為空物件：仍然阻斷且訊息可讀", async () => {
    await expect(
      before()({ tool: "edit", sessionID: "diag-2", input: {} }),
    ).rejects.toThrow(/edit/);
  });

  test("input 為 null／字串／數字：仍然阻斷", async () => {
    for (const input of [null, "src/a.ts", 42]) {
      await expect(
        before()({ tool: "edit", sessionID: "diag-3", input }),
      ).rejects.toThrow(/edit/);
    }
  });

  test("診斷只輸出欄位名與型態，不洩漏欄位值", async () => {
    const secret = "SUPER_SECRET_CONTENT_VALUE";
    let message = "";
    try {
      await before()({
        tool: "edit",
        sessionID: "diag-4",
        input: { body: secret, hint: { nested: secret } },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/edit/);
    expect(message).toContain("body");
    // 值絕對不能出現在訊息裡
    expect(message).not.toContain(secret);
  });

  test("describeToolInputFields：欄位名、型態、截斷", () => {
    expect(describeToolInputFields({ path: "a.ts", n: 1 })).toContain("path");
    expect(describeToolInputFields({ path: "a.ts", n: 1 })).toContain("n");
    expect(describeToolInputFields({ path: "a.ts", n: 1 })).not.toContain("a.ts");
    expect(describeToolInputFields({})).toBe("（無欄位）");
    expect(describeToolInputFields(null)).toBe("（無 input）");
    expect(describeToolInputFields(undefined)).toBe("（無 input）");
    // 字串輸入要說得出長度與是否像 JSON，但不得回顯內容
    expect(describeToolInputFields("src/a.ts")).toContain("string");
    expect(describeToolInputFields("src/a.ts")).not.toContain("a.ts");
    expect(describeToolInputFields('{"path":"src/a.ts"}')).toContain("JSON");
    expect(describeToolInputFields('{"path":"src/a.ts"}')).not.toContain("a.ts");
    expect(describeToolInputFields(42)).toBe("（number）");
    // 欄位很多時要截斷，避免訊息爆長
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) many[`f${i}`] = i;
    const described = describeToolInputFields(many);
    expect(described.length).toBeLessThan(200);
    expect(described).toContain("另有 88 個欄位");
  });

  test("describeToolInputFields：物件值會展開鍵名（看得到路徑藏在哪一層）", () => {
    const nested = describeToolInputFields({ state: { input: { filePath: "src/a.ts" } } });
    expect(nested).toContain("state(");
    expect(nested).toContain("input(");
    expect(nested).toContain("filePath(");
    // 展開的過程仍然不得帶出值
    expect(nested).not.toContain("a.ts");
    // 陣列只報長度，不展開內容
    const withArray = describeToolInputFields({ items: [{ secret: "V" }] });
    expect(withArray).toContain("items(array(1))");
    expect(withArray).not.toContain("secret");
  });
});
