/**
 * 25 — 結案 gate 改為每檔最新報告聚合（Red first）。
 *
 * 背景：gate（`validateCommentSignalForCompletion`）只讀單一 `lastReport`，
 * 後一次編輯的報告會覆蓋前一次，導致兩種失效：
 *   ① 先紅檔（阻斷）後黃檔（警告）：gate 翻回 false（漏放）。
 *   ② 紅檔修好後：乾淨編輯不寫報告，舊阻斷一直誤擋。
 * 加上子工作階段的編輯只聚合 modifiedFiles／warnings，per-file 報告到不了
 * 父工作階段，父工作階段結案前看不見子工作階段的阻斷。
 *
 * 要求（gate 語意）：所有已修改檔案的最新報告中，任一件
 * `shouldBlockCompletion` 為真即阻斷；問題修好後該檔舊阻斷清除；
 * 子工作階段的編輯往上聚合到父工作階段。
 *
 * P0 阻斷/G3 傳統：fixture 內的 functional tag literal 以 TAG_OPEN 拼接，
 * 避免測試檔自身被掃描器命中。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkflowRuntime } from "../../../../src/modules/workflow/runtime/v2-runtime.ts";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";
import { checkFileDetailed } from "../../../../src/modules/comment-signal/guard.ts";
import { UNATTRIBUTED_LEGACY_BLOCK_KEY as LEGACY_SENTINEL } from "../../../../src/modules/comment-signal/completion-gate.ts";
import {
  createWorkspace,
  setupCommentSignal,
  run,
  type CommentSignalFixture,
} from "./_helpers.ts";

const TAG_OPEN = "[";

async function gate(fx: CommentSignalFixture, sessionID: string) {
  const runtime = createWorkflowRuntime(fx.fake.ctx, DEFAULT_SETTINGS);
  return runtime.validateCommentSignalForCompletion(sessionID);
}

describe("25 - 結案 gate：每檔最新報告聚合", () => {
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

  test("先紅檔後黃檔：gate 必須仍然阻斷（不得翻回 false）", async () => {
    writeFileSync(
      join(ws.root, "src", "a.ts"),
      `// ${TAG_OPEN}WARN:P1] 未知 tag，之後處理\n`,
      "utf-8",
    );
    writeFileSync(join(ws.root, "src", "b.ts"), "// [TODO:P2] 之後處理\n", "utf-8");
    const after = fx.fake.toolHooks.get("execute.after");
    expect(after, "execute.after 已註冊").toBeDefined();

    await after!({ tool: "edit", sessionID: "gate-mask", status: "completed", input: { path: "src/a.ts" } });
    await after!({ tool: "edit", sessionID: "gate-mask", status: "completed", input: { path: "src/b.ts" } });

    const result = await gate(fx, "gate-mask");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("COMMENT_SIGNAL_BLOCKED");
  });

  test("問題修好後：gate 必須變成可以結案（不得繼續誤擋）", async () => {
    writeFileSync(
      join(ws.root, "src", "a.ts"),
      `// ${TAG_OPEN}WARN:P1] 未知 tag，之後處理\n`,
      "utf-8",
    );
    const after = fx.fake.toolHooks.get("execute.after");
    expect(after, "execute.after 已註冊").toBeDefined();

    await after!({ tool: "edit", sessionID: "gate-clear", status: "completed", input: { path: "src/a.ts" } });
    const blocked = await gate(fx, "gate-clear");
    expect(blocked.ok).toBe(false);

    // 修好：改成乾淨的說明型註解後再編輯一次
    writeFileSync(join(ws.root, "src", "a.ts"), "// [目的] 乾淨檔案。\n", "utf-8");
    await after!({ tool: "edit", sessionID: "gate-clear", status: "completed", input: { path: "src/a.ts" } });

    const result = await gate(fx, "gate-clear");
    expect(result.ok).toBe(true);
  });

  test("子工作階段編輯（後建立父子對應）：父工作階段結案前看得到阻斷", async () => {
    writeFileSync(
      join(ws.root, "src", "child.ts"),
      `// ${TAG_OPEN}WARN:P1] 未知 tag，之後處理\n`,
      "utf-8",
    );
    const after = fx.fake.toolHooks.get("execute.after");
    expect(after, "execute.after 已註冊").toBeDefined();

    // 先編輯、後建立父子對應（late-parent 回填路徑）
    await after!({ tool: "edit", sessionID: "gate-child", status: "completed", input: { path: "src/child.ts" } });
    await fx.store.registerSessionParent("gate-child", "gate-parent");

    const result = await gate(fx, "gate-parent");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("COMMENT_SIGNAL_BLOCKED");
  });

  test("只有 check 過、沒被 modified 記錄的檔案有阻斷報告：gate 仍要阻斷", async () => {
    // `comment_signal_check`（指定 path、changedOnly=false）會寫 per-file 報告但
    // 不會把檔案記進 modifiedFiles。若 gate 只看 modifiedFiles 的交集，這種
    // 「已檢出問題但沒編輯過」的情形會直接漏放。
    writeFileSync(
      join(ws.root, "src", "a.ts"),
      `// ${TAG_OPEN}WARN:P1] 未知 tag，之後處理\n`,
      "utf-8",
    );
    const out = await run(
      fx.tools["comment_signal_check"],
      { path: "src/a.ts", changedOnly: false },
      "gate-check-only",
    );
    expect(out.shouldBlockCompletion).toBe(true);
    expect(await fx.store.getModifiedFiles("gate-check-only")).toEqual([]);

    const result = await gate(fx, "gate-check-only");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("COMMENT_SIGNAL_BLOCKED");
  });

  test("舊版狀態（只有 lastReport、沒有 fileReports）：仍要阻斷（升級 fail-closed）", async () => {
    // 舊版外掛寫入的狀態沒有 fileReports 欄位。升級後不能因為讀不到 per-file
    // 報告就把既有阻斷靜默放掉；一旦有檔案被重新檢查並寫入 fileReports，
    // 就改由 per-file 報告接管（該檔修好即清除，不會永久誤擋）。
    await fx.fake.ctx.storage.set("session/gate-legacy/comment-signal", {
      modifiedFiles: ["src/a.ts"],
      lastReport: { shouldBlockCompletion: true },
      warnings: [],
    });
    const result = await gate(fx, "gate-legacy");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("COMMENT_SIGNAL_BLOCKED");

    // 舊版狀態的 lastReport 為 false 時不阻斷。
    await fx.fake.ctx.storage.set("session/gate-legacy-ok/comment-signal", {
      modifiedFiles: ["src/a.ts"],
      lastReport: { shouldBlockCompletion: false },
      warnings: [],
    });
    expect((await gate(fx, "gate-legacy-ok")).ok).toBe(true);
  });

  test("完全沒有任何報告時回 not-reported（不阻斷也不假裝通過）", async () => {
    const result = await gate(fx, "gate-never-reported");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("not-reported");
  });

  // ─── 升級相容：舊版阻斷不得因任何寫入而消失 ──────────────────

  /** 舊版（無 fileReports 欄位）寫下的阻斷 lastReport；violations 可辨識檔案。 */
  function legacyBlockingState(blockedPath: string) {
    return {
      modifiedFiles: [blockedPath],
      lastReport: {
        scannedFileCount: 1,
        checkedCommentCount: 1,
        violationCount: 1,
        errorCount: 1,
        warningCount: 0,
        highRiskCount: 0,
        shouldBlockCompletion: true,
        agentFeedback: "舊版報告。",
        violations: [
          {
            code: "UNKNOWN_TAG",
            severity: "blocking",
            filePath: blockedPath,
            line: 1,
            message: "未知 tag",
          },
        ],
        highRisk: [],
        humanSummary: "舊版報告。",
      },
      warnings: [],
    };
  }

  /** 舊版（無 fileReports 欄位）寫下的、歸不出檔案的阻斷狀態。 */
  async function seedUnattributedLegacyBlock(sessionID: string, modifiedFiles: string[]) {
    await fx.fake.ctx.storage.set(`session/${sessionID}/comment-signal`, {
      modifiedFiles,
      lastReport: { shouldBlockCompletion: true },
      warnings: [],
    });
  }

  test("子工作階段的乾淨重掃不得解除父工作階段的無歸檔舊阻斷", async () => {
    // 審查抓到：解除動作連帶清掉 ancestor 的標記。子工作階段的掃描範圍是
    // 「子工作階段修改過的檔案」，根本不涵蓋父工作階段的檔案，卻把父層阻斷
    // 一起清掉就是漏放。解除權限必須收斂到產生標記的工作階段自己。
    //
    // 父子「都」帶著自己的舊阻斷才會走到 ancestor 清除：只有子工作階段自己
    // 沒有標記時，解除動作會在清除前就結束，父層不受影響。
    await seedUnattributedLegacyBlock("anc-parent", ["src/p.ts"]);
    await seedUnattributedLegacyBlock("anc-child", ["src/c.ts"]);
    writeFileSync(join(ws.root, "src", "p.ts"), "// [目的] 乾淨檔案。\n", "utf-8");
    writeFileSync(join(ws.root, "src", "c.ts"), "// [目的] 乾淨檔案。\n", "utf-8");
    await fx.store.registerSessionParent("anc-child", "anc-parent");
    // 父子兩邊的標記都必須在動手前就存在
    expect((await gate(fx, "anc-parent")).ok).toBe(false);
    expect((await gate(fx, "anc-child")).ok).toBe(false);

    const swept = await run(fx.tools["comment_signal_check"], {}, "anc-child");
    expect(swept.shouldBlockCompletion).toBe(false);
    expect(swept.scannedFileCount).toBeGreaterThan(0);

    // 子工作階段自己的標記解除（它有權解除自己的）
    expect(await fx.store.getFileReports("anc-child")).not.toHaveProperty(LEGACY_SENTINEL);
    // 父層標記必須還在，父層 gate 仍然阻斷
    expect(await fx.store.getFileReports("anc-parent")).toHaveProperty(LEGACY_SENTINEL);
    const result = await gate(fx, "anc-parent");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("COMMENT_SIGNAL_BLOCKED");
  });

  test("子工作階段自己的無歸檔舊阻斷，由自己的乾淨重掃解除", async () => {
    await seedUnattributedLegacyBlock("own-child", ["src/c.ts"]);
    writeFileSync(join(ws.root, "src", "c.ts"), "// [目的] 乾淨檔案。\n", "utf-8");
    await fx.store.registerSessionParent("own-child", "own-parent");
    expect((await gate(fx, "own-child")).ok).toBe(false);

    const swept = await run(fx.tools["comment_signal_check"], {}, "own-child");
    expect(swept.shouldBlockCompletion).toBe(false);

    const result = await gate(fx, "own-child");
    expect(result.ok).toBe(true);
  });

  test("父工作階段自己的乾淨重掃解除父層自己的標記（不會變成永遠無法解除）", async () => {
    await seedUnattributedLegacyBlock("self-parent", ["src/p.ts"]);
    writeFileSync(join(ws.root, "src", "p.ts"), "// [目的] 乾淨檔案。\n", "utf-8");
    expect((await gate(fx, "self-parent")).ok).toBe(false);

    const swept = await run(fx.tools["comment_signal_check"], {}, "self-parent");
    expect(swept.shouldBlockCompletion).toBe(false);
    expect(swept.scannedFileCount).toBeGreaterThan(0);

    const result = await gate(fx, "self-parent");
    expect(result.ok).toBe(true);
  });

  test("沒有可掃描的已修改檔時：訊息要指出可行的下一步，且整專案重掃可解除", async () => {
    // 沒有已修改檔 → 工作階段重掃永遠 scannedFileCount=0，標記會一直擋著。
    // 這時訊息必須指向真的做得到的動作（重掃整個專案），否則就是死路。
    await seedUnattributedLegacyBlock("empty-scope", []);
    writeFileSync(join(ws.root, "src", "ok.ts"), "// [目的] 乾淨檔案。\n", "utf-8");

    const blocked = await gate(fx, "empty-scope");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error).toContain(LEGACY_SENTINEL);
      expect(blocked.error).toContain("comment_signal_check");
      // 還沒重掃過，所以不知道工作階段重掃會不會掃到東西：訊息要同時給出
      // 「便宜的第一步」和「確定做得到的整專案重掃」，不能只給其中一個。
      expect(blocked.error).toContain("重掃本工作階段");
      expect(blocked.error).toContain('path: "."');
      expect(blocked.error).toContain("changedOnly: false");
    }

    // 明確重掃整個專案且乾淨 → 解除
    const swept = await run(
      fx.tools["comment_signal_check"],
      { path: ".", changedOnly: false },
      "empty-scope",
    );
    expect(swept.scannedFileCount).toBeGreaterThan(0);
    expect(swept.shouldBlockCompletion).toBe(false);
    expect((await gate(fx, "empty-scope")).ok).toBe(true);
  });

  test("modifiedFiles 非空但全部不可掃描：訊息指向整專案重掃，照著做真的能解除", async () => {
    // 審查抓到：分流只看 modifiedFiles 數量就建議「重掃工作階段」。但清單裡
    // 全是 Markdown／隱藏檔／已刪除檔時，那次重掃實際掃到 0 個檔，照指示做
    // 仍然被擋。分流必須依**實際掃描結果**，而且指示出去就要做得到。
    writeFileSync(join(ws.root, "notes.md"), "# 文件不掃\n", "utf-8");
    writeFileSync(join(ws.root, "src", ".hidden.ts"), "// [目的] 隱藏檔不掃。\n", "utf-8");
    await fx.fake.ctx.storage.set("session/gate-unscannable/comment-signal", {
      modifiedFiles: ["notes.md", "src/.hidden.ts", "src/deleted.ts"],
      lastReport: { shouldBlockCompletion: true },
      warnings: [],
    });

    // 先照舊指示做一次工作階段重掃：掃不到東西，標記不解除
    const swept = await run(fx.tools["comment_signal_check"], {}, "gate-unscannable");
    expect(swept.scannedFileCount).toBe(0);
    expect((await gate(fx, "gate-unscannable")).ok).toBe(false);

    // 訊息必須指出「重掃掃到 0 個檔」並指向整專案重掃
    const blocked = await gate(fx, "gate-unscannable");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error).toContain("0 個檔案");
      expect(blocked.error).toContain('path: "."');
      expect(blocked.error).toContain("changedOnly: false");
    }

    // 照訊息做：整專案重掃且乾淨 → 真的解除
    writeFileSync(join(ws.root, "src", "ok.ts"), "// [目的] 乾淨檔案。\n", "utf-8");
    const whole = await run(
      fx.tools["comment_signal_check"],
      { path: ".", changedOnly: false },
      "gate-unscannable",
    );
    expect(whole.scannedFileCount).toBeGreaterThan(0);
    expect(whole.shouldBlockCompletion).toBe(false);
    expect((await gate(fx, "gate-unscannable")).ok).toBe(true);
  });

  test("還沒重掃過：訊息先給工作階段重掃，並附整專案重掃的後路", async () => {
    await seedUnattributedLegacyBlock("gate-never-swept", ["src/a.ts"]);
    const blocked = await gate(fx, "gate-never-swept");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error).toContain("comment_signal_check");
      expect(blocked.error).toContain('path: "."');
    }
  });

  test("舊版阻斷不會被 recordModifiedFile 或寫入別檔的乾淨報告沖掉", async () => {
    // 這是審查抓到的漏放：舊版狀態沒有 fileReports 欄位，任何一次狀態寫入都會
    // 先經 normalizeState 補出空的 fileReports，之後 gate 以為已經有 per-file
    // 資料就不再回頭看 lastReport，於是舊阻斷被靜默放行。
    await fx.fake.ctx.storage.set("session/gate-legacy-writes/comment-signal", legacyBlockingState("src/a.ts"));

    // 寫入另一個檔案的修改記錄
    await fx.store.recordModifiedFile("gate-legacy-writes", "src/other.ts");
    // 再寫入「另一個檔案」的乾淨報告
    await fx.store.recordFileReport(
      "gate-legacy-writes",
      "src/other.ts",
      checkFileDetailed("src/other.ts", "// 乾淨檔案。\n")!,
    );

    const result = await gate(fx, "gate-legacy-writes");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("COMMENT_SIGNAL_BLOCKED");
  });

  test("舊版阻斷在重新檢查造成阻斷的檔案且乾淨後解除（不是永久誤擋）", async () => {
    await fx.fake.ctx.storage.set("session/gate-legacy-clear/comment-signal", legacyBlockingState("src/a.ts"));
    await fx.store.recordModifiedFile("gate-legacy-clear", "src/other.ts");
    expect((await gate(fx, "gate-legacy-clear")).ok).toBe(false);

    // 把 a.ts 修乾淨後重新檢查 → 該檔的舊阻斷跟著解除
    writeFileSync(join(ws.root, "src", "a.ts"), "// [目的] 乾淨檔案。\n", "utf-8");
    await run(
      fx.tools["comment_signal_check"],
      { path: "src/a.ts", changedOnly: false },
      "gate-legacy-clear",
    );

    const result = await gate(fx, "gate-legacy-clear");
    expect(result.ok).toBe(true);
  });

  test("舊版阻斷無法歸檔時仍阻斷，且可由整工作階段的乾淨重掃解除", async () => {
    // 舊版 lastReport 只說「有阻斷」卻說不出是哪個檔案（真實舊版報告帶著
    // violations，所以這是防禦性分支）。不得因為後續寫入而消失，也不得變成
    // 永久誤擋：一次涵蓋整個工作階段修改檔的乾淨重掃就是明確的解除動作。
    await fx.fake.ctx.storage.set("session/gate-legacy-unattributed/comment-signal", {
      modifiedFiles: ["src/a.ts"],
      lastReport: { shouldBlockCompletion: true },
      warnings: [],
    });

    await fx.store.recordModifiedFile("gate-legacy-unattributed", "src/other.ts");
    expect((await gate(fx, "gate-legacy-unattributed")).ok).toBe(false);

    // 整工作階段重掃（changedOnly，掃所有已修改檔）且乾淨 → 解除
    writeFileSync(join(ws.root, "src", "a.ts"), "// [目的] 乾淨檔案。\n", "utf-8");
    writeFileSync(join(ws.root, "src", "other.ts"), "// [目的] 乾淨檔案。\n", "utf-8");
    const swept = await run(fx.tools["comment_signal_check"], {}, "gate-legacy-unattributed");
    expect(swept.shouldBlockCompletion).toBe(false);

    const result = await gate(fx, "gate-legacy-unattributed");
    expect(result.ok).toBe(true);
  });

  test("無法歸檔的舊版阻斷：只掃部分檔案不足以解除", async () => {
    // 解除條件必須真的代表「真相已重新確立」：只掃一個檔案不能代表整個
    // 工作階段乾淨，否則會變成另一種漏放。
    await fx.fake.ctx.storage.set("session/gate-legacy-partial/comment-signal", {
      modifiedFiles: ["src/a.ts", "src/b.ts"],
      lastReport: { shouldBlockCompletion: true },
      warnings: [],
    });
    writeFileSync(join(ws.root, "src", "b.ts"), "// [目的] 乾淨檔案。\n", "utf-8");

    await run(
      fx.tools["comment_signal_check"],
      { path: "src/b.ts", changedOnly: false },
      "gate-legacy-partial",
    );
    expect((await gate(fx, "gate-legacy-partial")).ok).toBe(false);
  });

  test("子工作階段編輯（先建立父子對應）：父工作階段結案前看得到阻斷", async () => {
    writeFileSync(
      join(ws.root, "src", "child.ts"),
      `// ${TAG_OPEN}WARN:P1] 未知 tag，之後處理\n`,
      "utf-8",
    );
    const after = fx.fake.toolHooks.get("execute.after");
    expect(after, "execute.after 已註冊").toBeDefined();

    // 先建立父子對應、後編輯（即時聚合路徑）
    await fx.store.registerSessionParent("gate-child-early", "gate-parent-early");
    await after!({ tool: "edit", sessionID: "gate-child-early", status: "completed", input: { path: "src/child.ts" } });

    const result = await gate(fx, "gate-parent-early");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("COMMENT_SIGNAL_BLOCKED");
  });
});
