import { jsonResult } from "../../../kit/json.ts";
/**
 * opencode-ultrawork — plan-next tool factory
 *
 * 角色：
 *     公開工具定義。回傳可開始的任務與被擋住的任務、每個任務做完會解開
 *     哪幾件事（`unblocks`），並依 `parallelGroup` 將可開始的任務分組。
 *
 * 對外規則（不可破壞）：
 *   - tool name / args schema / execute 固定外層 JSON 格式必須維持一致
 *     （含 ready/blocked 列表、parallelGroups 結構）。
 *   - 可開始的判定**必須**走 `registry/plan-completion.ts` 的
 *     `isTaskStartable`，不得在本檔自己實作一份。`state.md` 的投影走的是
 *     同一個函式；兩邊各寫一份就會對同一份資料給出不同的答案。
 *   - `readyTasks` 是**排序過**的，依據記在 `orderedBy` 欄位。排序必須是
 *     完全確定的（同分時以 taskId 收尾），否則同一份資料會回不同排列。
 *   - `unblocks` 是即時由 `dependsOn` 反轉算出來的衍生資料，放在任務物件
 *     **外面**（與 `blockedReasons` 同層）：不寫進 registry，避免第二份索引；
 *     也不塞進 Task，避免撐大預設投影的體積。
 *   - `readyTasks` / `blockedTasks` / `parallelGroups` 內的 Task 預設為投影
 *     （`projection: "summary"`，少 history 與重複的專案身分），`verbose: true`
 *     回完整 Task（`projection: "full"`）。ready / blocked 的判定本身不受投影
 *     影響，`blockedReasons` 與 `completionStats` 一律完整。見 ./context-projection.ts。
 *   - 透過 `UltraworkRuntimeContext` 取得 registry IO，行為與 closure
 *     原版本完全一致。
 *     僅由 index.ts 反向引用；引入反向 import 會形成循環依賴。
 *
 * 設計重點：
 *   - 採 factory 形式（`createPlanNextTool(runtime)`），接受 runtime
 *     context 注入；tool 內所有 IO 與 path 推導皆透過 `runtime.*`，
 *     不持有 closure-scoped 狀態。
 *   - `isFinishedTaskState` 自 `../core/helpers.ts` 引入；Task 型別自
 *     `../core/types.ts` 引入。
 *
 * @see ../../../../README.md                              — 模組一覽
 * @see ../registry/plan-completion.ts                     — 可開始判定的唯一入口
 */

import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../../kit/define-tool.ts";
type ToolContext = ToolExecutionContext;
import type { UltraworkRuntimeContext } from "../runtime/context-builder.ts";
import { isFinishedTaskState } from "../core/helpers.ts";
import { isTaskStartable, resolveCompletion } from "../registry/plan-completion.ts";
import type { Task } from "../core/types.ts";
import { projectTasks, type ProjectionMode } from "./context-projection.ts";


/** `orderedBy` 的固定說明字串：讓呼叫端知道這個順序是有意義的，不是註冊順序。 */
const READY_ORDER_DESCRIPTION = "unblocks desc, planStep asc, priority, taskId";

/**
 * priority 排序權重。這個系統對 priority 沒有強制字彙（`P0` / `high` 都有人用），
 * 所以認得的值給權重，認不得的一律排在已知值之後——不猜、也不擋。
 */
const PRIORITY_RANK: Record<string, number> = {
  P0: 0, p0: 0, high: 0, critical: 0,
  P1: 1, p1: 1, medium: 1, normal: 1,
  P2: 2, p2: 2, low: 2,
  P3: 3, p3: 3,
};

function priorityRank(priority: string | undefined): number {
  if (!priority) return 90;
  const rank = PRIORITY_RANK[priority];
  return rank === undefined ? 90 : rank;
}

/**
 * 把 `dependsOn` 反轉成「做完這個會解開哪幾件事」。
 *
 * 為什麼要回這個：`plan_next` 原本只回「哪些能開始」，模型看不出哪一個是
 * 關鍵路徑的起點。解開三件事的任務，和什麼都沒解開的葉子任務，在原本的
 * 輸出裡長得一模一樣，於是每一輪都要自己重新推一次先做哪個。
 *
 * 只統計同一個計畫內、而且還沒進終態的下游：已經結束的任務不會因為上游
 * 完成而被解開，算進去只會虛報關鍵路徑的寬度。反向邊每次即時算出來，
 * 不另外儲存——依賴的唯一來源仍然是 `task.dependsOn`，不引入第二份索引。
 */
function collectUnblocks(tasks: readonly Task[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const task of tasks) out[task.taskId] = [];
  for (const task of tasks) {
    if (isFinishedTaskState(task.state)) continue;
    for (const depId of task.dependsOn || []) {
      const downstream = out[depId];
      if (downstream) downstream.push(task.taskId);
    }
  }
  return out;
}

/**
 * 建立 readyTasks 的排序器。
 *
 * 依序比：解開的任務數（多的先）→ `planStep`（小的先）→ priority → taskId。
 * 最後拿 taskId 收尾是為了讓輸出完全確定：同分的任務每次都排同一個順序，
 * 否則同一份資料在不同輪會回不同的排列，既難除錯也會破壞快取。
 * `planStep` 到這裡才第一次真正有消費端——它原本寫得進去但沒有人讀。
 */
function makeReadyComparator(unblocks: Record<string, string[]>) {
  return function compareReady(a: Task, b: Task): number {
    const byUnblocks = (unblocks[b.taskId]?.length ?? 0) - (unblocks[a.taskId]?.length ?? 0);
    if (byUnblocks !== 0) return byUnblocks;
    const stepA = a.planStep ?? Number.MAX_SAFE_INTEGER;
    const stepB = b.planStep ?? Number.MAX_SAFE_INTEGER;
    if (stepA !== stepB) return stepA - stepB;
    const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
    if (byPriority !== 0) return byPriority;
    return a.taskId.localeCompare(b.taskId);
  };
}

/**
 * 建立 `plan_next` tool。
 *
 * behavior-preserving extraction：行為、args schema、固定外層 JSON 回覆
 * 完全等價。
 *
 * 判定與排序：
 *   - 可開始與否一律問 `isTaskStartable`，它涵蓋狀態、`blockedBy` 與
 *     `dependsOn` 三段，且對「還在任務清單裡」與「只剩完成終結標記」的
 *     依賴使用同一套判準（只有 COMPLETED 算滿足）。
 *   - `blockedReasons` 分得出「依賴已失敗或取消」「依賴還沒完成」「找不到
 *     依賴」三種，因為三種的處置完全不同：改依賴、等、或去查資料缺漏。
 *   - 狀態不符（已經在跑、已經結束）的任務不算「被擋住」，不列入
 *     `blockedTasks`——它們不是卡住，只是不在排程範圍內。
 */
export function createPlanNextTool(runtime: UltraworkRuntimeContext) {
  return defineTool({
    name: "plan-next",
    description: "列出計畫中可以開始的任務、尚未完成的任務，以及目前無法開始的原因。",
    inputSchema: z.object({
      planId: z.string(),
      verbose: z.boolean().optional().describe(
        "預設回投影的任務欄位（不含 history 與每筆重複的專案身分）。要完整 Task 物件時才傳 true。",
      ),
    }),
    async execute({ planId, verbose }, context) {
      const planRegistry = runtime.readPlansRegistry(context, false);
      const taskRegistry = runtime.readRegistry(context, false);
      const plan = planRegistry.plans[planId];
      if (!plan) return jsonResult({ ok: false, code: "PLAN_NOT_FOUND", error: `找不到計畫 ${planId}` });

      const tasks = plan.taskIds.map(id => taskRegistry.tasks[id]).filter(Boolean);
      const readyTasks: Task[] = [];
      const blockedTasks: Task[] = [];
      const blockedReasons: Record<string, string> = {};

      for (const task of tasks) {
        // 唯一的可開始判定入口；state.md 的投影走的是同一個函式。
        const verdict = isTaskStartable(task, taskRegistry, plan);
        if (verdict.startable) {
          readyTasks.push(task);
          continue;
        }
        // 狀態不對的任務（已經在跑、已經結束）不是「被擋住」，不列入。
        if (verdict.code === "STATE") continue;
        blockedTasks.push(task);
        blockedReasons[task.taskId] = verdict.reason;
      }

      // 反向邊：做完某個任務會解開哪幾件事。由 dependsOn 反轉算出來，
      // 不另外儲存——依賴的唯一來源仍然是 task.dependsOn。
      const unblocks = collectUnblocks(tasks);
      // 排序：解開比較多事情的排前面，讓模型不必自己重推關鍵路徑。
      readyTasks.sort(makeReadyComparator(unblocks));

      // Group by parallelGroup
      const parallelGroups = new Map<string | null, Task[]>();
      for (const t of readyTasks) {
        const pg = t.parallelGroup ?? null;
        if (!parallelGroups.has(pg)) parallelGroups.set(pg, []);
        parallelGroups.get(pg)!.push(t);
      }

      // 預設回投影的 Task（拿掉 history 與每筆重複的專案身分）；ready / blocked
      // 的判定本身在上面就算完了，模型不需要原始欄位也能決定下一步。
      const projection: ProjectionMode = verbose === true ? "full" : "summary";
      const view = (list: Task[]) => (projection === "full" ? list : projectTasks(list));
      return jsonResult({
        ok: true,
        planId,
        readyTasks: view(readyTasks),
        blockedTasks: view(blockedTasks),
        blockedReasons,
        unblocks,
        orderedBy: READY_ORDER_DESCRIPTION,
        parallelGroups: Object.fromEntries(
          [...parallelGroups].map(([group, list]) => [group, view(list)]),
        ),
        completionStats: collectCompletionStats(plan, taskRegistry),
        projection,
      });

      function collectCompletionStats(p: typeof plan, tr: typeof taskRegistry) {
        // 用 resolver 計算 tombstoned / live / missing，供 caller debug。
        const liveIds: string[] = [];
        const tombstonedIds: string[] = [];
        const missingIds: string[] = [];
        for (const tid of p.taskIds || []) {
          const res = resolveCompletion(tid, tr, p);
          if (res.kind === "live") liveIds.push(tid);
          else if (res.kind === "tombstone") tombstonedIds.push(tid);
          else missingIds.push(tid);
        }
        return { liveIds, tombstonedIds, missingIds };
      }
    }
  });
}
