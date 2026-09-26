/**
 * 只組裝主代理提供的內容；不補證據、不派遣，也不核准權限。
 *
 * 驗收條件的來源（v4.4）：
 *   本工具原本只收呼叫端手打的 `acceptanceCriteria`，從來不讀任務註冊檔案。
 *   於是同一個任務會有兩份驗收條件——一份記在任務上、一份寫在工作說明裡，
 *   兩者可以完全不一樣，而且沒有任何機制會發現。現在傳 `taskId` 就會直接
 *   採用任務上那一份；兩份都給而且不一致時直接擋下，不猜哪一份才算數。
 *
 * 回傳的是代號，不是全文：全文存在 work-order-store，派遣時由 task hook
 * 換回並照常做格式檢查。原因見 work-order-store.ts。
 */
import { z } from "zod";
import { defineTool, type ToolExecutionContext } from "../../../kit/define-tool.ts";
type ToolContext = ToolExecutionContext;
import { EVIDENCE_PACK_SECTIONS, validateEvidencePack } from "../gates/evidence-pack.ts";
import { jsonResult } from "../../../kit/json.ts";
import type { UltraworkRuntimeContext } from "../runtime/context-builder.ts";
import { WORK_ORDER_REF_PREFIX, type WorkOrderStore } from "./work-order-store.ts";

const textFields = ["taskIdentity", "objective", "knownEvidence", "constraints", "tddRequirements", "requiredReturn"] as const;

export function createWorkOrderBuildTool(runtime: UltraworkRuntimeContext, store: WorkOrderStore) {
  return defineTool({
    name: "work-order-build",
    description: "將主代理提供的內容組成七節工作說明；只檢查格式，不核准語意、權限或派遣。成功後把 data.workOrderRef 原文當成 task 的 prompt，派遣前會自動換回全文並再檢查一次。",
    inputSchema: z.object({
      taskIdentity: z.string().min(1).describe("任務與專案識別"),
      objective: z.string().min(1).describe("預期行為與目標"),
      knownEvidence: z.string().min(1).describe("已確認的來源與待驗證假說，請分清楚"),
      constraints: z.string().min(1).describe("修改範圍、安全邊界與需要交回主代理的條件"),
      tddRequirements: z.string().min(1).describe("可區分正誤的測試或替代驗證"),
      acceptanceCriteria: z.array(z.string().min(1)).min(1).optional().describe("每項單行；工具加上未完成 checkbox。已傳 taskId 且任務上有驗收條件時可以省略。"),
      taskId: z.string().optional().describe("帶上任務 ID，就直接採用任務註冊檔案裡的驗收條件，不必手抄一份。"),
      requiredReturn: z.string().min(1).describe("需要回傳的證據與未知"),
    }),
    async execute(args, context) {
      // 工具可能被直接呼叫，不能只依賴框架先驗證 schema。
      const input = args as unknown as Record<string, unknown> | null;
      const invalidFields: string[] = [];
      for (const field of textFields) {
        if (typeof input?.[field] !== "string" || !(input[field] as string).trim()) invalidFields.push(field);
      }
      // 驗收條件：任務上那一份是正式來源，手打的那份只在沒有 taskId 時採用。
      const requestedTaskId = typeof input?.taskId === "string" ? input.taskId.trim() : "";
      const provided = Array.isArray(input?.acceptanceCriteria) ? (input!.acceptanceCriteria as unknown[]) : null;
      let registryCriteria: string[] | null = null;
      if (requestedTaskId) {
        const task = runtime.readRegistry(context, false).tasks[requestedTaskId];
        if (!task) {
          return jsonResult({ ok: false, code: "TASK_NOT_FOUND", taskId: requestedTaskId },
            `找不到任務 ${requestedTaskId}。`, "請確認任務 ID，或先建立任務再組裝工作說明。");
        }
        const fromRegistry = (task.acceptanceCriteria || []).map(String).map(c => c.trim()).filter(Boolean);
        if (fromRegistry.length > 0) registryCriteria = fromRegistry;
      }
      if (registryCriteria && provided) {
        const handwritten = provided.map(item => String(item).trim());
        const differs = handwritten.length !== registryCriteria.length
          || handwritten.some((item, index) => item !== registryCriteria![index]);
        if (differs) {
          return jsonResult(
            { ok: false, code: "ACCEPTANCE_CRITERIA_MISMATCH", taskId: requestedTaskId, registryCriteria, provided: handwritten },
            "工作說明裡的驗收條件和任務上記的那一份不一樣。",
            "兩份驗收條件不一致，工具不猜哪一份算數。要嘛拿掉 acceptanceCriteria 直接採用任務上那份，要嘛先用 plan-task-link 把任務上的條件改成你要的。",
          );
        }
      }
      const criteria: unknown[] | null = registryCriteria ?? provided;
      if (!Array.isArray(criteria) || !criteria.length || criteria.some(item => typeof item !== "string" || !item.trim() || /[\r\n\u2028\u2029]/.test(item))) {
        invalidFields.push("acceptanceCriteria");
      }
      if (invalidFields.length) {
        return jsonResult({ ok: false, code: "INVALID_WORK_ORDER_INPUT", invalidFields },
          "工作說明欄位缺漏或格式不正確。", "請補齊非空文字；acceptanceCriteria 必須是非空陣列，每項為非空單行文字（或改傳有驗收條件的 taskId）。");
      }
      const bodies = textFields.slice(0, 5).map(field => input![field] as string);
      bodies.push((criteria as string[]).map(item => `- [ ] ${item}`).join("\n"), input!.requiredReturn as string);
      const prompt = EVIDENCE_PACK_SECTIONS.map((name, index) => `### ${index + 1}. ${name}\n${bodies[index]}`).join("\n\n");
      const validation = validateEvidencePack(prompt);
      if (!validation.valid) {
        return jsonResult({ ok: false, code: "INVALID_WORK_ORDER_FORMAT", errors: validation.errors },
          "輸入內容破壞了七節工作說明格式。", "請依 errors 修正重複章節、標題或未關閉的程式碼區塊，再重新組裝。");
      }
      const id = await store.save(prompt, typeof context?.sessionID === "string" ? context.sessionID : null);
      return jsonResult({
        ok: true,
        workOrderRef: `${WORK_ORDER_REF_PREFIX}${id}`,
        promptChars: prompt.length,
        acceptanceCriteriaCount: (criteria as string[]).length,
        acceptanceCriteriaSource: registryCriteria ? "task" : "input",
      }, "七節格式檢查通過；這不代表語意、權限或派遣已核准。", "派遣時 task 的 prompt 只填 workOrderRef 原文，不要加其他文字；要改內容就重新組裝。");
    },
  });
}
