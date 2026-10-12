/**
 * `workflow-id-check`：找出寫進專案內容的計畫 ID 與任務 ID。唯讀。
 *
 * 角色：
 *   - 比對對象是任務註冊檔案裡實際存在的 ID（見 `../core/workflow-id.ts`），不猜格式。
 *   - 兩種用法：檢查一段文字（例如 commit 訊息），或檢查專案這次的變更。
 *   - `scanProjectForWorkflowIds` 同時給結案檢查與 commit 前的檢查使用，三個入口
 *     共用同一套判斷，結果才不會互相矛盾。
 *
 * 設計重點：
 *   - 只看這次新增的內容：git 變更裡新增的行、新檔案的內容、新檔案的檔名。
 *     既有的內容不算，舊專案裡早就存在的 ID 不會擋住不相干的工作。
 *   - `.ultrawork/` 底下是 ID 該出現的地方，不檢查。
 *   - 不是 git repo、git 無法執行、或宿主沒有提供程序能力時回報「沒辦法檢查」（`available: false`），
 *     不當成乾淨：沒檢查和檢查過沒問題是兩件事。
 *
 * 限制：不寫任何檔案；單一檔案超過上限或是二進位檔就跳過，並計入 `skippedFiles`。
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { jsonResult } from "../../../kit/json.ts";
import { defineTool, type ToolExecutionContext } from "../../../kit/define-tool.ts";
import type { HostProcess } from "../../../kit/process-runner.ts";
import type { PlansRegistry, TasksRegistry } from "../core/types.ts";
import { detectableWorkflowIds, findWorkflowIds } from "../core/workflow-id.ts";
import type { UltraworkRuntimeContext } from "../runtime/context-builder.ts";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** 未追蹤的新檔案超過這個大小就不讀內容；檔名仍然會檢查。 */
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;
/** 回傳的具體發現上限；總數另外回報，避免一次塞滿呼叫者的對話。 */
const MAX_REPORTED_FINDINGS = 50;
const WORKFLOW_DATA_DIR = ".ultrawork/";

export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

export interface WorkflowIdFinding {
  /** `content`＝檔案內容；`path`＝檔名；`text`＝呼叫者直接給的文字。 */
  where: "content" | "path" | "text";
  file?: string;
  /** 檔名的發現沒有行號，固定為 0。 */
  line: number;
  id: string;
  match: string;
}

export interface WorkflowIdScan {
  /** 能不能檢查專案；不是 git repo 或 git 無法執行時為 false。 */
  available: boolean;
  findings: WorkflowIdFinding[];
  skippedFiles: string[];
}

/** 解析 `git diff -U0` 的輸出，取出新增的行與它在新檔案裡的行號。 */
export function parseAddedLines(diff: string): AddedLine[] {
  const added: AddedLine[] = [];
  let file: string | null = null;
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      file = target === "/dev/null" ? null : target.replace(/^"?b\//, "").replace(/"$/, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (file && raw.startsWith("+") && !raw.startsWith("+++")) {
      added.push({ file, line, text: raw.slice(1) });
      line += 1;
    }
  }
  return added;
}

/** 註冊檔裡所有適合比對的 ID，包含已經結束、只剩計畫紀錄的任務。 */
export function knownWorkflowIds(tasks: TasksRegistry, plans: PlansRegistry): string[] {
  const taskIds = new Set(Object.keys(tasks.tasks ?? {}));
  for (const plan of Object.values(plans.plans ?? {})) {
    for (const id of plan.taskIds ?? []) taskIds.add(id);
    for (const id of plan.finishedTaskIds ?? []) taskIds.add(id);
    for (const id of Object.keys(plan.completionTombstones ?? {})) taskIds.add(id);
  }
  return detectableWorkflowIds(taskIds, Object.keys(plans.plans ?? {}));
}

export function findInText(text: string, ids: readonly string[]): WorkflowIdFinding[] {
  return text.split("\n").flatMap((lineText, index) =>
    findWorkflowIds(lineText, ids).map((hit) => ({ where: "text" as const, line: index + 1, id: hit.id, match: hit.match })),
  );
}

async function git(proc: HostProcess, root: string, args: string[]): Promise<string | null> {
  try {
    const result = await proc.run({
      command: "git",
      args: ["-C", root, ...args],
      cwd: root,
      env: { ...process.env },
      timeoutMs: GIT_TIMEOUT_MS,
      stderrMode: "ignore",
      maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    });
    return result.exitCode === 0 && !result.truncated ? result.stdout : null;
  } catch {
    return null;
  }
}

function splitNul(raw: string | null): string[] {
  return (raw ?? "").split("\0").filter(Boolean);
}

/**
 * 檢查專案這次的變更。`staged` 為 true 時只看已經暫存的內容（commit 前使用），
 * 否則看工作區相對於 HEAD 的全部變更，加上未追蹤的新檔案。
 */
export async function scanProjectForWorkflowIds(
  root: string,
  ids: readonly string[],
  proc: HostProcess | undefined,
  options: { staged?: boolean } = {},
): Promise<WorkflowIdScan> {
  const unavailable: WorkflowIdScan = { available: false, findings: [], skippedFiles: [] };
  if (!proc) return unavailable;
  if ((await git(proc, root, ["rev-parse", "--is-inside-work-tree"]))?.trim() !== "true") return unavailable;
  if (ids.length === 0) return { available: true, findings: [], skippedFiles: [] };

  // 還沒有任何 commit 的 repo 沒有 HEAD，這時暫存區就是全部的新內容。
  const hasHead = (await git(proc, root, ["rev-parse", "--verify", "--quiet", "HEAD"])) !== null;
  const range = options.staged || !hasHead ? ["--cached"] : ["HEAD"];
  const diff = await git(proc, root, ["diff", ...range, "-U0", "--no-color", "--no-ext-diff", "--no-renames"]);
  if (diff === null) return unavailable;
  const newTracked = splitNul(await git(proc, root, ["diff", ...range, "--name-only", "--diff-filter=A", "--no-renames", "-z"]));
  const untracked = options.staged ? [] : splitNul(await git(proc, root, ["ls-files", "--others", "--exclude-standard", "-z"]));

  const inScope = (file: string) => !file.startsWith(WORKFLOW_DATA_DIR);
  const findings: WorkflowIdFinding[] = [];
  const skippedFiles: string[] = [];

  for (const added of parseAddedLines(diff)) {
    if (!inScope(added.file)) continue;
    for (const hit of findWorkflowIds(added.text, ids)) {
      findings.push({ where: "content", file: added.file, line: added.line, id: hit.id, match: hit.match });
    }
  }
  for (const file of untracked.filter(inScope)) {
    let content: string;
    try {
      if (statSync(join(root, file)).size > MAX_UNTRACKED_FILE_BYTES) throw new Error("too large");
      content = readFileSync(join(root, file), "utf8");
      if (content.includes("\0")) throw new Error("binary");
    } catch {
      skippedFiles.push(file);
      continue;
    }
    content.split("\n").forEach((text, index) => {
      for (const hit of findWorkflowIds(text, ids)) {
        findings.push({ where: "content", file, line: index + 1, id: hit.id, match: hit.match });
      }
    });
  }
  for (const file of [...newTracked, ...untracked].filter(inScope)) {
    for (const hit of findWorkflowIds(file, ids)) {
      findings.push({ where: "path", file, line: 0, id: hit.id, match: hit.match });
    }
  }
  return { available: true, findings, skippedFiles };
}

/** 給錯誤訊息用的短清單：每個發現一行，最多列幾個。 */
export function describeFindings(findings: readonly WorkflowIdFinding[], limit = 8): string {
  const lines = findings.slice(0, limit).map((finding) => {
    if (finding.where === "text") return `第 ${finding.line} 行：「${finding.match}」`;
    if (finding.where === "path") return `${finding.file}（檔名）：「${finding.match}」`;
    return `${finding.file}:${finding.line}：「${finding.match}」`;
  });
  if (findings.length > limit) lines.push(`…另外還有 ${findings.length - limit} 處`);
  return lines.join("\n");
}

export const WORKFLOW_ID_FIX_HINT = "計畫 ID 和任務 ID 只能出現在任務註冊檔案、.ultrawork/plans/ 的內容檔、工作說明和回報裡。把專案內容裡的 ID 拿掉，類別、檔案和測試資料照它做的事命名。";

/**
 * 這個 shell 指令是不是在執行 `git commit`。只認真的在執行 git 的寫法（可以帶 `-C <路徑>`、
 * 前面可以有 `rtk`），字串裡剛好提到 commit 的指令不算，例如 `git log --grep commit`。
 */
export function isGitCommit(command: string): boolean {
  return /(?:^|[;&|(]\s*|&&\s*)(?:rtk\s+)?git(?:\s+-[Cc]\s+\S+)*\s+commit(?:\s|$)/.test(command.trim());
}

/**
 * 結案前的檢查：工作區這次的變更裡有沒有 ID。回傳要擋下時的錯誤訊息；沒問題回 null。
 * 無法檢查（不是 git repo 等）時不擋，由呼叫端決定要不要提醒。
 */
export async function blockMessageForProject(
  root: string,
  ids: readonly string[],
  proc: HostProcess | undefined,
  options: { staged?: boolean } = {},
): Promise<{ available: boolean; message: string | null }> {
  const scan = await scanProjectForWorkflowIds(root, ids, proc, options);
  if (!scan.available) return { available: false, message: null };
  if (scan.findings.length === 0) return { available: true, message: null };
  return {
    available: true,
    message: `這次的變更裡有 ${scan.findings.length} 處計畫 ID 或任務 ID：\n${describeFindings(scan.findings)}\n${WORKFLOW_ID_FIX_HINT}`,
  };
}

/** commit 前的檢查：指令本身（含訊息）與已暫存的內容。回傳要擋下時的錯誤訊息；沒問題回 null。 */
export async function blockMessageForCommit(
  command: string,
  root: string,
  ids: readonly string[],
  proc: HostProcess | undefined,
): Promise<string | null> {
  const inMessage = findInText(command, ids);
  if (inMessage.length > 0) {
    return `commit 訊息裡有計畫 ID 或任務 ID：${inMessage.map((finding) => `「${finding.match}」`).join("、")}。訊息寫這次改動解決的問題和影響，不寫 ID。`;
  }
  const staged = await blockMessageForProject(root, ids, proc, { staged: true });
  return staged.message ? `已經暫存、準備 commit 的內容有問題。${staged.message}` : null;
}

export function createWorkflowIdCheckTool(runtime: UltraworkRuntimeContext, proc: HostProcess | undefined) {
  return defineTool({
    name: "workflow-id-check",
    description: "找出寫進專案內容的計畫 ID 與任務 ID（比對任務註冊檔案裡實際存在的 ID）。不帶參數時檢查專案這次的變更：新增的行、新檔案的內容和檔名；staged:true 只看已經暫存的變更；帶 text 時只檢查那段文字，例如 commit 訊息。唯讀。",
    inputSchema: z.object({
      text: z.string().optional().describe("要檢查的文字，例如 commit 訊息。有帶就只檢查這段文字，不看專案。"),
      staged: z.boolean().optional().describe("true 時只看已經暫存（git add）的變更；預設看工作區相對於 HEAD 的全部變更與未追蹤的新檔案。"),
    }),
    async execute({ text, staged }, context: ToolExecutionContext) {
      const ids = knownWorkflowIds(runtime.readRegistry(context, false), runtime.readPlansRegistry(context, false));
      if (typeof text === "string") {
        const findings = findInText(text, ids);
        return jsonResult(
          { ok: true, mode: "text", available: true, clean: findings.length === 0, checkedIdCount: ids.length, totalFindings: findings.length, findings: findings.slice(0, MAX_REPORTED_FINDINGS) },
          findings.length === 0 ? "這段文字裡沒有計畫 ID 或任務 ID。" : `這段文字裡有 ${findings.length} 處計畫 ID 或任務 ID。${WORKFLOW_ID_FIX_HINT}`,
        );
      }
      const scan = await scanProjectForWorkflowIds(runtime.resolveProjectRoot(context), ids, proc, { staged: staged === true });
      if (!scan.available) {
        return jsonResult(
          { ok: true, mode: "project", available: false, clean: null, checkedIdCount: ids.length, totalFindings: 0, findings: [], skippedFiles: [] },
          "沒辦法比對這次的變更：這個專案不是 git repo、git 無法執行，或是宿主沒有提供執行程序的能力。這不代表沒有問題，請自己讀 diff 確認。",
        );
      }
      return jsonResult(
        { ok: true, mode: "project", available: true, clean: scan.findings.length === 0, checkedIdCount: ids.length, totalFindings: scan.findings.length, findings: scan.findings.slice(0, MAX_REPORTED_FINDINGS), skippedFiles: scan.skippedFiles },
        scan.findings.length === 0 ? "這次的變更裡沒有計畫 ID 或任務 ID。" : `這次的變更裡有 ${scan.findings.length} 處計畫 ID 或任務 ID。${WORKFLOW_ID_FIX_HINT}`,
      );
    },
  });
}
