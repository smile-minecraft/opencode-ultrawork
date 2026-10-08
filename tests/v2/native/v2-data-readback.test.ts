/**
 * 2.x 資料副本回讀：版控內的去識別化 fixture 由 v3 工具正確讀取與操作。
 *
 * 作法：把 `tests/v2/fixtures/v2-data/`（已進版控的 2.x 形狀資料，產生方式
 * 見該目錄 README）整份複製到暫存專案（絕不修改來源），只把複本內 registry
 * 的身分欄位（projectId／projectPath）重指到暫存根——這是換專案位置必做的
 * 機械性重指，不是格式變更；狀態、歷史、計畫內容、記憶 markdown、快取一律
 * 保持原樣——再用合成宿主實際執行 v3 工具。
 *
 * 刻意不讀本 repo 的 `.ultrawork/`：那是 gitignored 的本機工作資料，乾淨
 * checkout 沒有它；依賴它會讓本測試在乾淨環境直接失敗。
 *
 * 讀不回（格式或遷移錯誤）時本檔會失敗，呼叫端依工作說明停下交回決策，
 * 不得改格式迎合。
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DEFAULT_SETTINGS } from "../../../src/settings/defaults.ts";
import { deriveProjectId } from "../../../src/modules/workflow/core/helpers.ts";
import {
  createSyntheticHost,
  invokeSynthetic,
  makeSyntheticProcess,
  registerSynthetic,
} from "./_synthetic-host.ts";

/** 版控內 fixture 根（測試檔位置反推，不依賴 cwd，也不碰 gitignored 目錄）。 */
const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "v2-data");
/** fixture 自帶的外專案比較起點檔名（固定基準，改名視為有意識的 fixture 異動）。 */
const FIXTURE_BASELINE_ID = "csb_fixture01_abcdef12";

/**
 * 遞迴列出目錄下所有一般檔案的相對路徑。
 *
 * 範圍說明：只涵蓋一般檔案。symlink（只記連結本身、不跟隨）、空目錄、
 * 檔案 metadata（權限、mtime）都不在比較範圍內；下面的「零變更」斷言指的
 * 就是這個集合的檔名與內容雜湊一致。
 */
function listFiles(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out.sort();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 來源目錄的內容快照：相對路徑 → sha256。 */
function snapshot(root: string): Map<string, string> {
  const snap = new Map<string, string>();
  for (const rel of listFiles(root)) snap.set(rel, sha256(join(root, rel)));
  return snap;
}

/**
 * 把複本內 registry 的身分欄位重指到暫存根。
 * 只碰 projectId／projectPath（頂層與每筆），其餘位元組保持原樣。
 */
function repointCopy(copyUltrawork: string, projectId: string, projectPath: string): void {
  for (const [file, entryKey] of [["tasks.json", "tasks"], ["plans.json", "plans"]] as const) {
    const path = join(copyUltrawork, file);
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
    raw.projectId = projectId;
    raw.projectPath = projectPath;
    for (const entry of Object.values<any>(raw[entryKey] ?? {})) {
      if (entry && typeof entry === "object") {
        entry.projectId = projectId;
        entry.projectPath = projectPath;
      }
    }
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  }
}

describe("2.x 資料副本回讀", () => {
  test("複本可被 v3 工具讀取操作，來源 fixture 零變更", async () => {
    const before = snapshot(FIXTURE_DIR);
    expect(before.size).toBeGreaterThan(0);

    const sourceTasks = JSON.parse(readFileSync(join(FIXTURE_DIR, "tasks.json"), "utf-8")) as {
      tasks: Record<string, { title: string; state: string }>;
      activeTaskIds: string[];
    };
    const sourcePlans = JSON.parse(readFileSync(join(FIXTURE_DIR, "plans.json"), "utf-8")) as {
      activePlanIds: string[];
      plans: Record<string, { title: string }>;
    };
    const activePlanId = sourcePlans.activePlanIds[0];
    expect(activePlanId).toBeString();

    const scratch = mkdtempSync(join(tmpdir(), "uw-v2-readback-"));
    const tempProject = join(scratch, "project");
    const tempGlobal = join(scratch, "global");
    mkdirSync(tempProject, { recursive: true });
    mkdirSync(tempGlobal, { recursive: true });
    try {
      cpSync(FIXTURE_DIR, join(tempProject, ".ultrawork"), { recursive: true });
      const projectId = deriveProjectId(tempProject);
      repointCopy(join(tempProject, ".ultrawork"), projectId, tempProject);

      const synth = createSyntheticHost({
        projectDirectory: tempProject,
        globalConfigDirectory: tempGlobal,
        capabilities: { process: makeSyntheticProcess() },
      });
      const registrations = await registerSynthetic(synth, {
        ...DEFAULT_SETTINGS,
        verification: { runAllowedAgents: ["momus"], scopeCheckAllowedAgents: ["build"] },
      });
      try {
        // 任務：status 讀出 active 任務與來源一致（標題、狀態相同）。
        // 工具回傳是 {ok, summary, data} 外框，承載在 data 下；已結束任務
        // 依 FINISHED_TASK_LIMIT 修剪屬正常語意，只比 active。
        const status = await invokeSynthetic(synth, "task-state-sync", { event: "status", verbose: true });
        expect(status.ok).toBe(true);
        const tasks = status.data.registry.tasks as Record<string, { title: string; state: string }>;
        expect([...(status.data.registry.activeTaskIds as string[])].sort()).toEqual(
          [...sourceTasks.activeTaskIds].sort(),
        );
        for (const id of sourceTasks.activeTaskIds) {
          expect(tasks[id]?.title).toBe(sourceTasks.tasks[id]?.title);
          expect(tasks[id]?.state).toBe(sourceTasks.tasks[id]?.state);
        }

        // 計畫：plan-status 與 plan-next 在真實計畫上無格式錯誤。
        const planStatus = await invokeSynthetic(synth, "plan-status", { planId: activePlanId });
        expect(planStatus.ok).toBe(true);
        expect(planStatus.data.plan.title).toBe(sourcePlans.plans[activePlanId]?.title);
        const planNext = await invokeSynthetic(synth, "plan-next", { planId: activePlanId });
        expect(planNext.ok).toBe(true);
        expect(planNext.data.planId).toBe(activePlanId);

        // 記憶：專案層搜尋命中 fixture 主題，全文讀回標題一致。
        const search = await invokeSynthetic(synth, "memory-search", { query: "fixturemarker", layer: "project" });
        expect(search.ok).toBe(true);
        const topics = (search.data.results as Array<{ topic: string }>).map((r) => r.topic);
        expect(topics).toContain("fixture-topic");
        const read = await invokeSynthetic(synth, "memory-read", { layer: "project", topic: "fixture-topic" });
        expect(read.ok).toBe(true);
        expect(read.data.topic).toBe("fixture-topic");
        expect(read.data.frontmatter.title).toBe("Fixture 測試主題");

        // 註解掃描：檢查路徑可用，警告級別不阻擋完成。
        // 方括號拆開寫，避免外層掃描器把此 fixture 誤判為 functional tag。
        mkdirSync(join(tempProject, "src"), { recursive: true });
        writeFileSync(join(tempProject, "src", "probe.ts"), `// ${"["}TODO:P2] 之後處理\n`);
        const check = await invokeSynthetic(synth, "comment_signal_check", {
          path: "src/probe.ts",
          changedOnly: false,
        });
        expect(check.ok).toBe(true);
        expect(check.data.scannedFileCount).toBe(1);
        expect(check.data.shouldBlockCompletion).toBe(false);
        const touched = await invokeSynthetic(synth, "comment_signal_touched_report", {});
        expect(touched.ok).toBe(true);

        // 變更範圍快取：複本自帶外專案身分的比較起點，compare 必須明確拒絕而非崩潰。
        const baselines = readdirSync(join(tempProject, ".ultrawork", "cache", "change-scope")).filter((f) =>
          f.endsWith(".json"),
        );
        expect(baselines).toContain(`${FIXTURE_BASELINE_ID}.json`);
        const compare = await invokeSynthetic(
          synth,
          "change-scope-check",
          { action: "compare", baselineId: FIXTURE_BASELINE_ID, paths: [{ path: "src", kind: "directory" }] },
          "synthetic-session",
          "build",
        );
        // 外專案的比較起點必須是明確拒絕（ok 為 false），且錯誤碼只能是
        // 「找不到」「跨專案」「格式無效」三者之一；成功或崩潰都算失敗。
        expect(compare.ok).toBe(false);
        expect(["BASELINE_NOT_FOUND", "CROSS_PROJECT", "INVALID_BASELINE"]).toContain(
          compare.data?.code ?? compare.code,
        );
      } finally {
        for (const item of registrations.reverse()) await item.dispose();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    // 來源零變更：一般檔案的檔名集合與每個檔案的雜湊都與操作前一致
    //（範圍見 listFiles 上方的說明；symlink／空目錄／metadata 不在內）。
    const after = snapshot(FIXTURE_DIR);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [rel, hash] of before) expect(after.get(rel)).toBe(hash);
  });
});
