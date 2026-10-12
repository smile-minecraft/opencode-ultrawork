/**
 * 計畫 ID 與任務 ID：格式規則，以及在文字裡找出已登記 ID 的比對。
 *
 * 角色：
 *   - `validatePlanId`／`validateTaskId` 給 `create` 事件用，只擋新建立的 ID；
 *     已經存在的 ID 不經過這裡，所以舊專案照常運作。
 *   - `detectableWorkflowIds`＋`findWorkflowIds` 給「專案內容裡有沒有 ID」的檢查用。
 *
 * 設計重點：
 *   - 比對以任務註冊檔案裡實際存在的 ID 為準，不用正規表達式猜格式。猜格式的檢查
 *     只認得出它預想的寫法，實際在用的 ID 幾乎都對不上。
 *   - 新格式的 ID 沒有 `w03`、`t06` 這種短編號：這類編號最容易被拿去當類別或檔案
 *     名稱的開頭。順序與分組由 `planStep`／`parallelGroup`／`dependsOn` 表達。
 *   - 新格式的計畫 ID 只有英文單字，和功能的名稱分不開，所以不拿來比對；
 *     任務 ID 帶流水號，出現在專案內容裡幾乎不可能是巧合。
 *
 * 限制：純函式，不做 IO，不 import 其他模組。
 */

/** 一個單字：兩個以上的英文字母，或是版本（`v` 加數字）。 */
const WORD = "(?:[a-z]{2,}|v\\d+)";
/** 主題：二到四個單字，第一個一定是英文字母。 */
const TOPIC = `[a-z]{2,}(?:-${WORD}){1,3}`;
const PLAN_ID_RE = new RegExp(`^${TOPIC}$`);
const TASK_ID_RE = new RegExp(`^(${TOPIC})-(\\d{2})$`);
/** 舊格式計畫 ID 裡的日期，例如 `acelib-v150-20261009`。 */
const DATE_RE = /20\d{6}/;
/** 舊格式的任務 ID 短於這個長度就不比對，例如 `t-1`：太短，誤判的機會比抓到的機會高。 */
const MIN_DETECTABLE_LENGTH = 4;

const PLAN_ID_HINT = "計畫 ID 要用二到四個小寫的英文單字，以連字號連接，例如 economy-review-hardening；版本寫成 v 加數字，例如 release-v150。不放日期、流水號、里程碑或階段的編號。";
const TASK_ID_HINT = "任務 ID 要用「主題-兩位數流水號」，主題的格式和計畫 ID 相同，例如 economy-review-hardening-03。有計畫的任務用計畫 ID 當主題。";

export type WorkflowIdCheck = { ok: true } | { ok: false; reason: string };

export function validatePlanId(id: string): WorkflowIdCheck {
  return PLAN_ID_RE.test(id) ? { ok: true } : { ok: false, reason: PLAN_ID_HINT };
}

export function validateTaskId(id: string): WorkflowIdCheck {
  return TASK_ID_RE.test(id) ? { ok: true } : { ok: false, reason: TASK_ID_HINT };
}

/** 同一個主題的下一個任務 ID；接在最大的流水號後面，不回頭補空號，避免重用已經出現過的 ID。 */
export function nextTaskId(topic: string, existingTaskIds: Iterable<string>): string {
  let max = 0;
  for (const id of existingTaskIds) {
    const match = TASK_ID_RE.exec(id);
    if (match && match[1] === topic) max = Math.max(max, Number(match[2]));
  }
  return `${topic}-${String(max + 1).padStart(2, "0")}`;
}

/** 從註冊檔的 ID 裡挑出適合比對的：任務 ID 要有數字而且夠長，計畫 ID 只取帶日期的舊格式。 */
export function detectableWorkflowIds(taskIds: Iterable<string>, planIds: Iterable<string>): string[] {
  const picked = new Set<string>();
  for (const id of taskIds) {
    if (id.length >= MIN_DETECTABLE_LENGTH && /\d/.test(id)) picked.add(id);
  }
  for (const id of planIds) {
    if (DATE_RE.test(id)) picked.add(id);
  }
  return [...picked];
}

export interface WorkflowIdHit {
  /** 註冊檔裡的 ID。 */
  id: string;
  /** 文字裡實際出現的寫法，例如 `EconomyReview03`。 */
  match: string;
  index: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 一個 ID 的比對式。分段之間容許不同的分隔寫法，這樣駝峰（`EconomyReview03`）、
 * 底線和去掉連字號的寫法都找得到。
 *
 * 新格式的任務 ID 前後不設邊界：它夠長又帶流水號，夾在識別字中間也要找得到。
 * 舊格式常常很短（`t-17`），所以前面不能緊接英數字，否則 `port-17` 會被誤判。
 */
function patternFor(id: string): RegExp {
  const segments = id.split("-").filter(Boolean).map(escapeRegExp);
  if (TASK_ID_RE.test(id)) return new RegExp(`${segments.join("[-_. ]?")}(?!\\d)`, "gi");
  return new RegExp(`(?<![A-Za-z0-9])${segments.join("[-_]?")}(?!\\d)`, "gi");
}

/** 在一段文字裡找出已登記的 ID，依出現位置排序。 */
export function findWorkflowIds(text: string, ids: readonly string[]): WorkflowIdHit[] {
  const hits: WorkflowIdHit[] = [];
  for (const id of ids) {
    for (const match of text.matchAll(patternFor(id))) {
      hits.push({ id, match: match[0], index: match.index });
    }
  }
  return hits.sort((a, b) => a.index - b.index || b.match.length - a.match.length);
}
