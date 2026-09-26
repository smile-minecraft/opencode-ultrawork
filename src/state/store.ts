/**
 * 工作階段狀態：ctx.storage 的包裝。
 *
 * key 一律帶工作階段或專案前綴，避免跨專案互相覆蓋。
 * 外掛重新載入後 storage 還在，所以狀態不會因改設定而消失。
 * 值只接受 JSON 可序列化的資料；工作階段索引設上限並淘汰最舊的。
 */

export interface StorageEntry {
  key: string;
  value: unknown;
}

export interface StorageScanResult {
  entries: readonly StorageEntry[];
  next?: string;
}

/** ctx.storage 的最小結構形狀，照 V2 StorageDomain。 */
export interface KeyValueStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<StorageScanResult>;
}

export interface SessionEvent {
  type: string;
  data: unknown;
}

const SESSION_PREFIX = "session/";
const PROJECT_PREFIX = "project/";
const SESSION_INDEX_KEY = "session/index";
const DEFAULT_MAX_SESSIONS = 500;

function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      return false;
    case "object": {
      if (Array.isArray(value)) return value.every(isJsonValue);
      return Object.values(value).every(isJsonValue);
    }
    default:
      return false;
  }
}

export interface SessionStateStoreOptions {
  maxSessions?: number;
}

export class SessionStateStore {
  private readonly maxSessions: number;

  constructor(
    private readonly storage: KeyValueStorage,
    options: SessionStateStoreOptions = {},
  ) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  sessionKey(sessionID: string, kind: string): string {
    return `${SESSION_PREFIX}${sessionID}/${kind}`;
  }

  projectKey(projectID: string, kind: string): string {
    return `${PROJECT_PREFIX}${projectID}/${kind}`;
  }

  async getSession(sessionID: string, kind: string): Promise<unknown> {
    return this.storage.get(this.sessionKey(sessionID, kind));
  }

  async setSession(sessionID: string, kind: string, value: unknown): Promise<void> {
    assertJsonSerializable(value);
    await this.storage.set(this.sessionKey(sessionID, kind), value);
    await this.trackSession(sessionID);
  }

  async removeSession(sessionID: string, kind: string): Promise<void> {
    await this.storage.remove(this.sessionKey(sessionID, kind));
  }

  async getProject(projectID: string, kind: string): Promise<unknown> {
    return this.storage.get(this.projectKey(projectID, kind));
  }

  async setProject(projectID: string, kind: string, value: unknown): Promise<void> {
    assertJsonSerializable(value);
    await this.storage.set(this.projectKey(projectID, kind), value);
  }

  async scanSession(
    sessionID: string,
    options: { after?: string; limit?: number } = {},
  ): Promise<StorageScanResult> {
    return this.storage.scan({ prefix: `${SESSION_PREFIX}${sessionID}/`, ...options });
  }

  /** 清掉某個工作階段的全部狀態，並從索引移除。 */
  async clearSession(sessionID: string): Promise<void> {
    const prefix = `${SESSION_PREFIX}${sessionID}/`;
    let after: string | undefined;
    for (;;) {
      const result = await this.storage.scan({ prefix, after });
      for (const entry of result.entries) {
        await this.storage.remove(entry.key);
      }
      if (result.next === undefined) break;
      after = result.next;
    }
    const index = await this.readIndex();
    await this.writeIndex(index.filter((id) => id !== sessionID));
  }

  /** 事件入口：工作階段刪除時清掉它的狀態，其他事件忽略。 */
  async handleEvent(event: SessionEvent): Promise<void> {
    if (event.type !== "session.deleted") return;
    const data = event.data as { sessionID?: unknown } | null;
    if (typeof data?.sessionID !== "string") return;
    await this.clearSession(data.sessionID);
  }

  private async readIndex(): Promise<string[]> {
    const stored = await this.storage.get(SESSION_INDEX_KEY);
    return Array.isArray(stored) && stored.every((id) => typeof id === "string") ? stored : [];
  }

  private async writeIndex(index: string[]): Promise<void> {
    await this.storage.set(SESSION_INDEX_KEY, index);
  }

  private async trackSession(sessionID: string): Promise<void> {
    const index = await this.readIndex();
    if (index.includes(sessionID)) return;
    const next = [...index, sessionID];
    while (next.length > this.maxSessions) {
      const oldest = next.shift();
      if (oldest !== undefined) await this.clearSession(oldest);
    }
    await this.writeIndex(next);
  }
}

function assertJsonSerializable(value: unknown): void {
  if (!isJsonValue(value)) {
    throw new Error("狀態值必須是 JSON 可序列化的資料（不接受函式、BigInt、undefined 等）。");
  }
  try {
    JSON.stringify(value);
  } catch {
    throw new Error("狀態值必須是 JSON 可序列化的資料（疑似循環參照）。");
  }
}
