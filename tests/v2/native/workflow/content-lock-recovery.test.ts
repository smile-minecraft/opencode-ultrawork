import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContentLockBusyError,
  diagnoseContentWriteLock,
  diagnoseReclaimTicket,
  releaseStaleContentWriteLock,
  withContentWriteLock,
} from "../../../../src/kit/write-lock.ts";
import { callTool, setupWorkflow } from "./_helpers.ts";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "uw-lock-recovery-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 假鎖：持有者 pid 已死（大到不可能是活 pid），時間戳可指定新舊。 */
async function plantLock(lockPath: string, opts: { pid: number; ageMs: number; token?: string }) {
  await mkdir(join(lockPath, ".."), { recursive: true });
  const payload = {
    pid: opts.pid,
    createdAt: new Date(Date.now() - opts.ageMs).toISOString(),
    token: opts.token ?? `fake-${Date.now()}`,
  };
  await writeFile(lockPath, JSON.stringify(payload));
  return payload;
}

const DEAD_PID = 999999;
const registryLockOf = (root: string) => join(root, ".ultrawork/cache/locks/registry.lock");
const contentLockOf = (root: string) => join(root, ".ultrawork/plans/.content-write.lock");

describe("寫入鎖復原：kill -9 後不需手動 rm 就能繼續工作", () => {
  test("死程序的新鎖：plan-state-sync 回 CONTENT_LOCK_BUSY 外框，不拋例外", async () => {
    const root = await tempRoot();
    const fake = await setupWorkflow(root);
    await plantLock(registryLockOf(root), { pid: DEAD_PID, ageMs: 5_000 });
    // 自我驗證：測試用的 pid 真的已死，否則測試前提不成立。
    expect(diagnoseContentWriteLock(registryLockOf(root)).pidAlive).toBe(false);

    const before = readFileSync(registryLockOf(root), "utf-8");
    const result = await callTool(fake, "plan-state-sync", { event: "create", planId: "p1", title: "P1" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONTENT_LOCK_BUSY");
    expect(JSON.stringify(result)).toContain("unlockStale");
    // 非孤兒（太年輕）：鎖檔原封不動。
    expect(readFileSync(registryLockOf(root), "utf-8")).toBe(before);
    await fake.registration?.dispose();
  });

  test("孤兒鎖自動回收：舊死程序鎖不擋寫入，臨界區真的執行且留紀錄", async () => {
    const root = await tempRoot();
    const fake = await setupWorkflow(root);
    await plantLock(registryLockOf(root), { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan" });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const result = await callTool(fake, "plan-state-sync", { event: "create", planId: "p1", title: "P1" });
      expect(result.ok).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
    // 臨界區真的執行：計畫寫進 plans.json。
    const plans = JSON.parse(await readFile(join(root, ".ultrawork/plans.json"), "utf8"));
    expect(Object.keys(plans.plans)).toEqual(["p1"]);
    // 孤兒鎖被回收：不是原來的假鎖（自己持有的鎖也會在臨界區結束後釋放）。
    const after = existsSync(registryLockOf(root)) ? readFileSync(registryLockOf(root), "utf-8") : null;
    expect(after === null || !after.includes("orphan")).toBe(true);
    // 留紀錄。
    expect(warnings.some((w) => w.includes("孤兒") && w.includes("registry.lock"))).toBe(true);
    await fake.registration?.dispose();
  });

  test("活鎖不受影響：自己持有的鎖不被回收", async () => {
    const root = await tempRoot();
    const fake = await setupWorkflow(root);
    const planted = await plantLock(registryLockOf(root), { pid: process.pid, ageMs: 5_000, token: "live" });

    const result = await callTool(fake, "plan-state-sync", { event: "create", planId: "p1", title: "P1" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONTENT_LOCK_BUSY");
    // 活著的鎖原封不動。
    expect(readFileSync(registryLockOf(root), "utf-8")).toBe(JSON.stringify(planted));
    await fake.registration?.dispose();
  });

  test("顯式復原：unlockStale 釋放孤兒 registry 鎖並留紀錄；活鎖不動", async () => {
    const root = await tempRoot();
    const fake = await setupWorkflow(root);
    await plantLock(registryLockOf(root), { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan-reg" });

    const released = await callTool(fake, "plan-content-read", { unlockStale: true });
    expect(released.ok).toBe(true);
    const releasedNames = JSON.stringify(released.data?.released ?? released);
    expect(releasedNames).toContain("registry");
    expect(existsSync(registryLockOf(root))).toBe(false);

    // 活鎖：不釋放，只診斷。
    const planted = await plantLock(registryLockOf(root), { pid: process.pid, ageMs: 5_000, token: "live-reg" });
    const refused = await callTool(fake, "plan-content-read", { unlockStale: true });
    expect(refused.ok).toBe(true);
    expect(JSON.stringify(refused.data?.released ?? [])).not.toContain("registry");
    expect(readFileSync(registryLockOf(root), "utf-8")).toBe(JSON.stringify(planted));
    await fake.registration?.dispose();
  });

  test("顯式復原：unlockStale 釋放孤兒 content 鎖", async () => {
    const root = await tempRoot();
    const fake = await setupWorkflow(root);
    await plantLock(contentLockOf(root), { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan-content" });

    const result = await callTool(fake, "plan-content-read", { unlockStale: true });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.data?.released ?? result)).toContain("content");
    expect(existsSync(contentLockOf(root))).toBe(false);
    await fake.registration?.dispose();
  });
});

describe("寫入鎖有界重試", () => {
  test("相容性：unlockStale 回傳保留改動前的所有欄位與層級", async () => {
    const root = await tempRoot();
    const fake = await setupWorkflow(root);
    // 舊形狀：content 鎖不存在時，頂層攤平診斷欄位。
    const empty = await callTool(fake, "plan-content-read", { unlockStale: true });
    expect(empty.ok).toBe(true);
    expect(empty.data.action).toBe("diagnoseLock");
    expect(empty.data.present).toBe(false);
    expect(empty.data.heldByPid).toBeNull();
    expect(empty.data.since).toBeNull();
    expect(empty.data.ageSeconds).toBeNull();
    expect(empty.data.pidAlive).toBeNull();
    expect(empty.data.looksStale).toBe(false);
    expect(empty.data.hint).toBe("沒有鎖。");

    // 舊形狀：content 孤兒鎖存在時，頂層攤平診斷欄位照舊。
    await plantLock(contentLockOf(root), { pid: DEAD_PID, ageMs: 10 * 60_000, token: "compat-orphan" });
    const diagnosed = await callTool(fake, "plan-content-read", { unlockStale: true });
    expect(diagnosed.ok).toBe(true);
    expect(diagnosed.data.action).toBe("diagnoseLock");
    expect(diagnosed.data.present).toBe(true);
    expect(diagnosed.data.heldByPid).toBe(DEAD_PID);
    expect(typeof diagnosed.data.since).toBe("string");
    expect(typeof diagnosed.data.ageSeconds).toBe("number");
    expect(diagnosed.data.pidAlive).toBe(false);
    expect(diagnosed.data.looksStale).toBe(true);
    expect(diagnosed.data.hint).toContain("手動執行：rm");
    // 新增資訊只用新欄位附加。
    expect(Array.isArray(diagnosed.data.released)).toBe(true);
    expect(JSON.stringify(diagnosed.data.released)).toContain("content");
    expect(existsSync(contentLockOf(root))).toBe(false);
    await fake.registration?.dispose();
  });

  test("預設重試：持有者釋放後第二個 writer 會成功，且等待有上界", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-default-retry-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withContentWriteLock(lockPath, () => gate);
    // 預設參數（不傳 options）：持有者 100ms 後釋放，第二個 writer 應該等到而不是立刻失敗。
    setTimeout(release, 100);
    const startedAt = Date.now();
    await expect(withContentWriteLock(lockPath, async () => "default-retry-ok")).resolves.toBe("default-retry-ok");
    expect(Date.now() - startedAt).toBeLessThan(1000);
    await first;
  });

  test("兩個 writer（顯式參數）：第二個重試等到鎖釋放後成功", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-retry-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withContentWriteLock(lockPath, () => gate);
    const second = withContentWriteLock(lockPath, async () => "second-ok", { retries: 20, retryDelayMs: 5 });
    setTimeout(release, 30);
    await expect(second).resolves.toBe("second-ok");
    await first;
  });

  test("重試有上限與退避上限：配額用完回 BUSY，間隔被封頂", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-backoff-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withContentWriteLock(lockPath, () => gate);
    try {
      const delays: number[] = [];
      const sleep = async (ms: number) => {
        delays.push(ms);
      };
      let code = "";
      try {
        await withContentWriteLock(lockPath, async () => {}, { retries: 3, retryDelayMs: 5, maxRetryDelayMs: 10, sleep });
      } catch (error) {
        code = (error as ContentLockBusyError).code ?? "";
      }
      expect(code).toBe("CONTENT_LOCK_BUSY");
      // 3 次重試 → 3 次睡眠；指數退避 5、10、20 被封頂在 10。
      expect(delays).toEqual([5, 10, 10]);
    } finally {
      release();
      await first;
    }
  });
});

describe("回收者交錯：後到的刪除步驟不可刪掉別人的新鎖", () => {
  test("A 重讀比對成功後、刪除前冒出新鎖 → 新鎖必須存活，且 B 在 A 持資格期間必須放棄", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-interleave-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    // 孤兒鎖 L：持有者已死＋夠舊。
    await plantLock(lockPath, { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan-L" });

    // 用 holder 物件承載 hook 內的寫入，避免區域變數被收窄成 null。
    const seen: { contentionReleased: boolean | null } = { contentionReleased: null };
    const outcome = releaseStaleContentWriteLock(lockPath, undefined, {
      onReclaimClaimed: () => {
        // A 已拿到回收資格：B 此時也來回收，必須放棄，不可走到刪除。
        seen.contentionReleased = releaseStaleContentWriteLock(lockPath).released;
      },
      beforeReclaimUnlink: () => {
        // 最兇的交錯：A 重讀比對成功後、刪除前，A' 已完成回收且新 writer 建了新鎖。
        writeFileSync(
          lockPath,
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: "new-live-lock" }),
        );
      },
    });

    // B 在 A 持資格期間有來過，且放棄了（沒刪東西）。
    expect(seen.contentionReleased).toBe(false);
    // A 的刪除步驟不可刪掉新鎖：A 應該住手而不是回報成功。
    expect(outcome.released).toBe(false);
    // 新鎖存活，內容就是新 writer 寫的那份。
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).token).toBe("new-live-lock");

    // 後續重試（B 稍後再來）看到活鎖也要住手。
    const retry = releaseStaleContentWriteLock(lockPath);
    expect(retry.released).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).token).toBe("new-live-lock");
  });
});

describe("payload 形狀：缺欄位的一律不回收", () => {
  async function plantRaw(lockPath: string, raw: string, mtimeAgeMs?: number) {
    await mkdir(join(lockPath, ".."), { recursive: true });
    await writeFile(lockPath, raw);
    if (mtimeAgeMs !== undefined) {
      const old = new Date(Date.now() - mtimeAgeMs);
      utimesSync(lockPath, old, old);
    }
  }
  const oldCreatedAt = () => new Date(Date.now() - 10 * 60_000).toISOString();

  test("缺 token（且 mtime 很舊）→ 不回收", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-shape-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    const raw = JSON.stringify({ pid: DEAD_PID, createdAt: oldCreatedAt() });
    await plantRaw(lockPath, raw, 10 * 60_000);
    const outcome = releaseStaleContentWriteLock(lockPath);
    expect(outcome.released).toBe(false);
    expect(readFileSync(lockPath, "utf-8")).toBe(raw);
  });

  test("token 空字串 → 不回收", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-shape-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    const raw = JSON.stringify({ pid: DEAD_PID, createdAt: oldCreatedAt(), token: "" });
    await plantRaw(lockPath, raw, 10 * 60_000);
    const outcome = releaseStaleContentWriteLock(lockPath);
    expect(outcome.released).toBe(false);
    expect(readFileSync(lockPath, "utf-8")).toBe(raw);
  });

  test("缺 createdAt（且 mtime 很舊）→ 不回收", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-shape-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    const raw = JSON.stringify({ pid: DEAD_PID, token: "no-createdAt" });
    await plantRaw(lockPath, raw, 10 * 60_000);
    const outcome = releaseStaleContentWriteLock(lockPath);
    expect(outcome.released).toBe(false);
    expect(readFileSync(lockPath, "utf-8")).toBe(raw);
  });

  test("pid 不是數字 → 不回收", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-shape-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    const raw = JSON.stringify({ pid: String(DEAD_PID), createdAt: oldCreatedAt(), token: "pid-string" });
    await plantRaw(lockPath, raw, 10 * 60_000);
    const outcome = releaseStaleContentWriteLock(lockPath);
    expect(outcome.released).toBe(false);
    expect(readFileSync(lockPath, "utf-8")).toBe(raw);
  });

  test("完全無法解析 → 不回收", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-shape-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    const raw = "not-json{{{";
    await plantRaw(lockPath, raw, 10 * 60_000);
    const outcome = releaseStaleContentWriteLock(lockPath);
    expect(outcome.released).toBe(false);
    expect(readFileSync(lockPath, "utf-8")).toBe(raw);
  });

  test("完整 payload 且 pid 已死＋夠舊 → 才回收", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-shape-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    await plantLock(lockPath, { pid: DEAD_PID, ageMs: 10 * 60_000, token: "full-orphan" });
    const outcome = releaseStaleContentWriteLock(lockPath);
    expect(outcome.released).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("pid 0 → 不回收（不是合法的持有者）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-shape-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    const raw = JSON.stringify({ pid: 0, createdAt: oldCreatedAt(), token: "pid-zero" });
    await plantRaw(lockPath, raw, 10 * 60_000);
    const outcome = releaseStaleContentWriteLock(lockPath);
    expect(outcome.released).toBe(false);
    expect(readFileSync(lockPath, "utf-8")).toBe(raw);
  });

  test("pid 負值 → 不回收", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-shape-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    const raw = JSON.stringify({ pid: -5, createdAt: oldCreatedAt(), token: "pid-negative" });
    await plantRaw(lockPath, raw, 10 * 60_000);
    const outcome = releaseStaleContentWriteLock(lockPath);
    expect(outcome.released).toBe(false);
    expect(readFileSync(lockPath, "utf-8")).toBe(raw);
  });

  test("pid 非整數 → 不回收", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-shape-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    const raw = JSON.stringify({ pid: 1.5, createdAt: oldCreatedAt(), token: "pid-float" });
    await plantRaw(lockPath, raw, 10 * 60_000);
    const outcome = releaseStaleContentWriteLock(lockPath);
    expect(outcome.released).toBe(false);
    expect(readFileSync(lockPath, "utf-8")).toBe(raw);
  });
});

describe("過期資格：兩個回收者同時面對同一份過期資格 → 都不可進入回收區段", () => {
  const ticketOf = (lockPath: string) => `${lockPath}.reclaim`;
  const oldTicket = () =>
    JSON.stringify({ pid: DEAD_PID, createdAt: new Date(Date.now() - 10 * 60_000).toISOString(), token: "stale-ticket" });

  test("fail closed：過期資格存在時自動回收住手，鎖與資格原封不動", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-stale-ticket-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    await plantLock(lockPath, { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan-L" });
    const ticketRaw = oldTicket();
    await writeFile(ticketOf(lockPath), ticketRaw);

    // 用 holder 承載 hook 內的寫入，避免區域變數被收窄。
    const seen: { observed: string[]; results: Array<{ name: string; released: boolean }> } = {
      observed: [],
      results: [],
    };
    const b = releaseStaleContentWriteLock(lockPath, undefined, {
      onTicketObserved: () => {
        // B 已看到這份過期資格；此時 A 也來，看到的是同一份。
        seen.observed.push("B");
        const a = releaseStaleContentWriteLock(lockPath);
        seen.observed.push("A");
        seen.results.push({ name: "A", released: a.released });
      },
    });
    seen.results.push({ name: "B", released: b.released });

    // 兩者確實都面對了同一份過期資格（確定的交錯，不靠 sleep）。
    expect(seen.observed).toEqual(["B", "A"]);
    // 任一方都不可進入回收區段：舊碼會偷取並回報成功，這裡必須失敗。
    for (const r of seen.results) expect(r.released).toBe(false);
    // 鎖與資格原封不動：沒有人刪掉別人的東西。
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).token).toBe("orphan-L");
    expect(readFileSync(ticketOf(lockPath), "utf-8")).toBe(ticketRaw);
  });

  test("顯式復原只診斷不刪除：過期資格逐字保留，鎖也不動", async () => {
    const root = await tempRoot();
    const fake = await setupWorkflow(root);
    await plantLock(registryLockOf(root), { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan-reg" });
    const ticketRaw = oldTicket();
    await writeFile(`${registryLockOf(root)}.reclaim`, ticketRaw);
    const lockRaw = readFileSync(registryLockOf(root), "utf-8");

    // 兩個顯式復原者先後診斷：任一方都不可刪除資格檔或鎖檔。
    for (let round = 0; round < 2; round++) {
      const diag = await callTool(fake, "plan-content-read", { unlockStale: true });
      expect(diag.ok).toBe(true);
      expect(diag.data.registry.reclaimTicket.present).toBe(true);
      expect(diag.data.registry.reclaimTicket.stale).toBe(true);
      expect(JSON.stringify(diag.data.released)).not.toContain("reclaim");
      expect(readFileSync(`${registryLockOf(root)}.reclaim`, "utf-8")).toBe(ticketRaw);
      expect(readFileSync(registryLockOf(root), "utf-8")).toBe(lockRaw);
    }

    // 診斷文字要能讓使用者直接照做：哪個檔案、為什麼、下一步是什麼。
    const diag = await callTool(fake, "plan-content-read", { unlockStale: true });
    const hint = String(diag.data.registry.reclaimTicket.hint);
    expect(hint).toContain(`${registryLockOf(root)}.reclaim`);
    expect(hint).toContain("rm ");
    await fake.registration?.dispose();
  });
});

describe("資格檔診斷：五種情況與讀取失敗", () => {
  const ticketOf = (lockPath: string) => `${lockPath}.reclaim`;
  const oldCreatedAt = () => new Date(Date.now() - 10 * 60_000).toISOString();

  test("沒有檔案 → present:false，hint 說不用處理", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-no-ticket-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    await plantLock(lockPath, { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan-L" });

    const status = diagnoseReclaimTicket(lockPath);
    expect(status.present).toBe(false);
    expect(status.readable).toBe(false);
    expect(status.stale).toBe(false);
    expect(status.heldByPid).toBeNull();
    expect(status.ageSeconds).toBeNull();
    // 沒有票據擋路，孤兒鎖照常回收。
    expect(releaseStaleContentWriteLock(lockPath).released).toBe(true);
  });

  test("讀不到（權限／I-O 失敗）→ readable:false、stale:false，不刪任何檔案", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-unreadable-ticket-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    await plantLock(lockPath, { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan-L" });
    const ticketRaw = JSON.stringify({ pid: DEAD_PID, createdAt: oldCreatedAt(), token: "unreadable" });
    await writeFile(ticketOf(lockPath), ticketRaw);
    const lockRaw = readFileSync(lockPath, "utf-8");

    // 注入讀取失敗（模擬權限／暫時性 I/O）：持有者可能還活著，不可當成可清除的 stale。
    const status = diagnoseReclaimTicket(lockPath, {
      readFile: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });
    expect(status.present).toBe(true);
    expect(status.readable).toBe(false);
    expect(status.stale).toBe(false);
    expect(status.heldByPid).toBeNull();
    // hint 要說清楚：哪個檔案、為什麼不能判斷、要使用者做什麼（且絕不是自動清除）。
    expect(status.hint).toContain(ticketOf(lockPath));
    expect(status.hint).not.toContain("清除後重試");

    // 不刪任何檔案、不動鎖。
    expect(readFileSync(ticketOf(lockPath), "utf-8")).toBe(ticketRaw);
    expect(readFileSync(lockPath, "utf-8")).toBe(lockRaw);
  });

  test("內容無效（無法解析）→ stale:true，hint 給出確切的手動 rm 指令", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-garbage-ticket-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    await plantLock(lockPath, { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan-L" });
    const garbage = "half-written{{{";
    await writeFile(ticketOf(lockPath), garbage);

    // 自動路徑 fail closed：不回收、不刪票據。
    expect(releaseStaleContentWriteLock(lockPath).released).toBe(false);
    expect(readFileSync(ticketOf(lockPath), "utf-8")).toBe(garbage);
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).token).toBe("orphan-L");

    const status = diagnoseReclaimTicket(lockPath);
    expect(status.present).toBe(true);
    expect(status.readable).toBe(false);
    expect(status.stale).toBe(true);
    // 使用者能直接照做：哪個檔案、為什麼、下一步的手動指令。
    expect(status.hint).toContain(ticketOf(lockPath));
    expect(status.hint).toContain(`rm '${ticketOf(lockPath)}'`);
  });

  test("死持有者＋超過門檻 → stale:true，hint 給出確切的手動 rm 指令", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-stale-ticket-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    await plantLock(lockPath, { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan-L" });
    await writeFile(
      ticketOf(lockPath),
      JSON.stringify({ pid: DEAD_PID, createdAt: oldCreatedAt(), token: "stale-ticket" }),
    );

    const status = diagnoseReclaimTicket(lockPath);
    expect(status.present).toBe(true);
    expect(status.readable).toBe(true);
    expect(status.stale).toBe(true);
    expect(status.heldByPid).toBe(DEAD_PID);
    expect(typeof status.ageSeconds).toBe("number");
    expect(status.hint).toContain(ticketOf(lockPath));
    expect(status.hint).toContain(`rm '${ticketOf(lockPath)}'`);
  });

  test("活持有者 → stale:false，hint 說稍後重試、不用處理", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-live-ticket-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    await plantLock(lockPath, { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan-L" });
    const liveTicket = JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
      token: "live-ticket",
    });
    await writeFile(ticketOf(lockPath), liveTicket);

    const status = diagnoseReclaimTicket(lockPath);
    expect(status.present).toBe(true);
    expect(status.readable).toBe(true);
    expect(status.stale).toBe(false);
    expect(status.heldByPid).toBe(process.pid);
    expect(status.hint).toContain("稍後重試");
    // 自動路徑住手，票據與鎖原封不動。
    expect(releaseStaleContentWriteLock(lockPath).released).toBe(false);
    expect(readFileSync(ticketOf(lockPath), "utf-8")).toBe(liveTicket);
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).token).toBe("orphan-L");
  });

  test("端到端：BUSY → unlockStale 只診斷不刪除 → 使用者手動 rm 後寫入恢復", async () => {
    const root = await tempRoot();
    const fake = await setupWorkflow(root);
    await plantLock(registryLockOf(root), { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan-reg" });
    const garbage = "half-written{{{";
    await writeFile(`${registryLockOf(root)}.reclaim`, garbage);
    const lockRaw = readFileSync(registryLockOf(root), "utf-8");

    // 自動路徑 fail closed：回 BUSY 外框，不拋例外，不刪東西。
    const busy = await callTool(fake, "plan-state-sync", { event: "create", planId: "p1", title: "P1" });
    expect(busy.ok).toBe(false);
    expect(busy.code).toBe("CONTENT_LOCK_BUSY");
    expect(readFileSync(registryLockOf(root), "utf-8")).toBe(lockRaw);
    expect(readFileSync(`${registryLockOf(root)}.reclaim`, "utf-8")).toBe(garbage);

    // 顯式復原只診斷：看得出卡住的資格，但什麼都不刪。
    const diag = await callTool(fake, "plan-content-read", { unlockStale: true });
    expect(diag.ok).toBe(true);
    expect(diag.data.registry.reclaimTicket.present).toBe(true);
    expect(diag.data.registry.reclaimTicket.stale).toBe(true);
    expect(JSON.stringify(diag.data.released)).not.toContain("reclaim");
    expect(readFileSync(registryLockOf(root), "utf-8")).toBe(lockRaw);
    expect(readFileSync(`${registryLockOf(root)}.reclaim`, "utf-8")).toBe(garbage);

    // 使用者照指示手動清除（測試內代勞），之後寫入恢復。
    await rm(`${registryLockOf(root)}.reclaim`, { force: true });
    const ok = await callTool(fake, "plan-state-sync", { event: "create", planId: "p1", title: "P1" });
    expect(ok.ok).toBe(true);
    await fake.registration?.dispose();
  });
});

describe("rm 提示的 shell 安全性：特殊字元路徑不可跳出引號", () => {
  const ticketOf = (lockPath: string) => `${lockPath}.reclaim`;
  const oldCreatedAt = () => new Date(Date.now() - 10 * 60_000).toISOString();

  /** 用真的特殊字元目錄跑，不只比對字串。單引號跳脫的手算期望值（POSIX：' → '\''）。 */
  function expectQuotedRm(hint: string, absolutePath: string) {
    const safe = `'${absolutePath.replace(/'/g, `'\\''`)}'`;
    expect(hint).toContain(`rm ${safe}`);
  }

  /** 從 hint 尾端取出 rm 指令原文（含引號），原樣丟給 sh 執行。s flag 讓路徑換行也能擷取。 */
  function runHintedRm(hint: string, cwd: string) {
    const command = hint.match(/rm '.*'/s)?.[0];
    expect(command).toBeDefined();
    const result = Bun.spawnSync(["sh", "-c", command as string], { cwd });
    expect(result.exitCode).toBe(0);
  }

  test("路徑含單引號：資格檔診斷的 rm 不可跳出引號，且可執行", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-o'brien-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    await plantLock(lockPath, { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan-L" });
    await writeFile(ticketOf(lockPath), "half-written{{{");

    const status = diagnoseReclaimTicket(lockPath);
    expect(status.stale).toBe(true);
    // 手算期望：單引號必須斷開跳脫，不可出現未跳脫的 '拼接。
    expectQuotedRm(status.hint, ticketOf(lockPath));
    expect(status.hint).not.toContain(`rm '${ticketOf(lockPath)}'`);

    // 真的丟給 sh：只刪目標，不報錯、不動別的檔案。
    runHintedRm(status.hint, dir);
    expect(existsSync(ticketOf(lockPath))).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).token).toBe("orphan-L");
  });

  test("路徑含換行：提示的 rm 仍只刪目標，不被斷行切開", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-line1\nline2-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    await plantLock(lockPath, { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan-L" });
    await writeFile(ticketOf(lockPath), "half-written{{{");

    const status = diagnoseReclaimTicket(lockPath);
    expect(status.stale).toBe(true);
    // 單引號引用把換行保留為字面內容：期望值含原樣換行。
    expectQuotedRm(status.hint, ticketOf(lockPath));

    // 真的丟給 sh：不斷行、不多刪，目錄只剩鎖檔。
    runHintedRm(status.hint, dir);
    expect(existsSync(ticketOf(lockPath))).toBe(false);
    expect((await readdir(dir)).sort()).toEqual(["write.lock"]);
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).token).toBe("orphan-L");
  });

  test("組合技（單引號＋$＋反引號＋空白）：跳出引號後什麼都不該執行", async () => {
    // 單引號負責跳出引號，$ 與反引號在引號外才會活過來：舊碼下 sh 會把
    // 反引號當命令執行、$ 展開、rm 砍錯目標；修好後整段都是字面路徑。
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-o'brien-$DOES_NOT_EXIST-`touch PWNED`-with space-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    await plantLock(lockPath, { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan-L" });
    await writeFile(ticketOf(lockPath), "half-written{{{");

    const status = diagnoseReclaimTicket(lockPath);
    expect(status.stale).toBe(true);
    expectQuotedRm(status.hint, ticketOf(lockPath));

    runHintedRm(status.hint, dir);
    // 目標刪掉；反引號沒有被執行（PWNED 不可出現）；$ 沒有展開成別的路徑。
    expect(existsSync(ticketOf(lockPath))).toBe(false);
    expect(existsSync(join(dir, "PWNED"))).toBe(false);
    expect((await readdir(dir)).sort()).toEqual(["write.lock"]);
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).token).toBe("orphan-L");
  });

  test("鎖檔診斷的 rm 提示同樣安全（單引號路徑，可執行）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-o'brien-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    await plantLock(lockPath, { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan-lock" });

    const diagnosis = diagnoseContentWriteLock(lockPath);
    expect(diagnosis.looksStale).toBe(true);
    expectQuotedRm(diagnosis.hint, lockPath);
    expect(diagnosis.hint).not.toContain(`rm '${lockPath}'`);

    runHintedRm(diagnosis.hint, dir);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("目錄無權限時診斷區分「無法確認」與「確認不存在」", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uw-lock-noperm-"));
    roots.push(dir);
    const lockPath = join(dir, "write.lock");
    await plantLock(lockPath, { pid: DEAD_PID, ageMs: 10 * 60_000, token: "orphan-L" });
    await writeFile(ticketOf(lockPath), "half-written{{{");
    // 拿掉目錄執行權：其下的 existsSync／讀檔都會失敗。
    Bun.spawnSync(["chmod", "000", dir]);

    try {
      const status = diagnoseReclaimTicket(lockPath);
      // 不可謊報「沒有卡住」：無法確認是否存在，保守視為可能有東西。
      expect(status.present).toBe(true);
      expect(status.readable).toBe(false);
      expect(status.stale).toBe(false);
      expect(status.hint).toContain(ticketOf(lockPath));
    } finally {
      Bun.spawnSync(["chmod", "755", dir]);
    }
  });
});
