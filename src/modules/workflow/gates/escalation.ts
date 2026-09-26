import type { KeyValueStorage } from "../../../state/store.ts";

export const ESCALATION_STANDARD_AGENTS = ["implementer", "debugger"] as const;
export const ESCALATION_MIN_ATTEMPTS = 2;
const SESSION_ID = /\bses_[A-Za-z0-9]+\b/g;
const MAX_RECORDS = 2000;

export interface SubagentSessionInfo {
  parentID: string | null;
  agent: string | null;
}

export type SessionLookup = (sessionID: string) => Promise<SubagentSessionInfo | null>;

export interface EscalationRejection {
  sessionID: string;
  reason: string;
}

export type EscalationVerdict =
  | { ok: true; attempts: Array<{ sessionID: string; agent: string }> }
  | { ok: false; attempts: Array<{ sessionID: string; agent: string }>; rejected: EscalationRejection[]; cited: number };

export interface EscalationTracker {
  record(sessionID: string, parentID: unknown, agent: unknown): Promise<void>;
  verify(parentSessionID: string, prompt: string): Promise<EscalationVerdict>;
}

export function createEscalationTracker(
  storage: KeyValueStorage,
  lookup?: SessionLookup,
  now: () => number = Date.now,
): EscalationTracker {
  const key = (sessionID: string) => `session/${sessionID}/escalation`;

  async function resolve(sessionID: string): Promise<SubagentSessionInfo | null> {
    const stored = await storage.get(key(sessionID)) as SubagentSessionInfo | undefined;
    if (stored) return stored;
    if (!lookup) return null;
    try {
      const info = await lookup(sessionID);
      if (info && info.parentID === null && info.agent === null) return null;
      return info;
    } catch {
      return null;
    }
  }

  async function trim(): Promise<void> {
    let after: string | undefined;
    const records: Array<{ key: string; createdAt: number }> = [];
    for (;;) {
      const page = await storage.scan({ prefix: "session/", after, limit: 200 });
      for (const entry of page.entries) {
        if (!entry.key.endsWith("/escalation")) continue;
        const value = entry.value as { createdAt?: unknown } | undefined;
        records.push({
          key: entry.key,
          createdAt: typeof value?.createdAt === "number" ? value.createdAt : 0,
        });
      }
      if (page.next === undefined) break;
      after = page.next;
    }
    records.sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
    for (const record of records.slice(0, Math.max(0, records.length - MAX_RECORDS))) {
      await storage.remove(record.key);
    }
  }

  return {
    async record(sessionID, parentID, agent) {
      if (typeof sessionID !== "string" || !sessionID.trim()) return;
      const previous = await storage.get(key(sessionID)) as (SubagentSessionInfo & { createdAt?: number }) | undefined;
      const parent = typeof parentID === "string" && parentID.trim() ? parentID.trim() : null;
      const role = typeof agent === "string" && agent.trim() ? agent.trim() : null;
      await storage.set(key(sessionID), {
        parentID: parent ?? previous?.parentID ?? null,
        agent: role ?? previous?.agent ?? null,
        createdAt: now(),
      });
      await trim();
    },

    async verify(parentSessionID, prompt) {
      const cited = [...new Set(prompt.match(SESSION_ID) ?? [])].filter((id) => id !== parentSessionID);
      const attempts: Array<{ sessionID: string; agent: string }> = [];
      const rejected: EscalationRejection[] = [];
      for (const sessionID of cited) {
        const info = await resolve(sessionID);
        if (!info) {
          rejected.push({ sessionID, reason: "查不到這個工作階段" });
        } else if (info.parentID !== parentSessionID) {
          rejected.push({ sessionID, reason: "不是從目前這個工作階段派出去的" });
        } else if (!info.agent || !(ESCALATION_STANDARD_AGENTS as readonly string[]).includes(info.agent)) {
          rejected.push({ sessionID, reason: `它是 ${info.agent ?? "無法辨識的角色"}，不是 Implementer 或 Debugger` });
        } else {
          attempts.push({ sessionID, agent: info.agent });
        }
      }
      return attempts.length >= ESCALATION_MIN_ATTEMPTS
        ? { ok: true, attempts }
        : { ok: false, attempts, rejected, cited: cited.length };
    },
  };
}

export function formatEscalationRejection(verdict: Extract<EscalationVerdict, { ok: false }>): string {
  const lines = [
    `派遣 Ultra-Coder 需要引用至少 ${ESCALATION_MIN_ATTEMPTS} 次、從目前這個工作階段派出去的 Implementer 或 Debugger 嘗試，目前只核對到 ${verdict.attempts.length} 次。`,
    "在工作說明的 Known Evidence 裡寫出前兩次嘗試的 sessionID（ses_ 開頭，subagent 工具回傳結果裡的那一個），以及它們各自失敗的證據。",
  ];
  if (!verdict.cited) lines.push("這份工作說明裡沒有引用任何子工作階段。");
  for (const item of verdict.rejected) lines.push(`- ${item.sessionID}：${item.reason}`);
  lines.push("如果這不是兩次失敗後的升級，就改派 Implementer 或 Debugger；高風險的變更要的是獨立審查，不是升級。");
  return lines.join("\n");
}
