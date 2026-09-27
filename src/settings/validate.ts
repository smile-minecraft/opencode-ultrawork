/**
 * 設定執行期驗證：合併後的原始值逐欄位檢查，無效值記警告並退回預設。
 *
 * 為什麼需要這一層：設定檔是使用者手寫的 JSONC，合併只管疊加、
 * 不管型別。過去 `{"skiller": "off"}` 會讓 skiller 模組在 expandHome
 * 崩潰、`{"workflow": 0}` 會讓 workflow runtime 崩潰，整個外掛載入失敗。
 * 這裡保證出去的設定物件形狀永遠合法：單一欄位壞掉只退回該欄位的
 * 預設值並警告，不靜默忽略，也不丟棄整個設定檔。
 *
 * 純函式、無 IO；呼叫端（loadSettings）負責把 warnings 印出去。
 */

import { DEFAULT_SETTINGS, MODULE_KEYS, type ModuleKey, type UltraworkSettings } from "./defaults.ts";
import { type MemoryBudgets, type MemoryLayerBudget } from "../modules/memory/constants.ts";
import { isPlainObject } from "./merge.ts";

export interface SanitizeResult {
  settings: UltraworkSettings;
  warnings: string[];
}

/**
 * 有效的名稱清單：非空字串組成的陣列。
 *
 * 空陣列算有效（明確清空＝授權名單留空，由呼叫端的 fail-closed／放行
 * 語意決定後果）；0／null／字串／含非字串或空字串的陣列都算無效，
 * 回 undefined 讓呼叫端退回預設。回傳的是拷貝，不沿用輸入陣列。
 */
export function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item): item is string => typeof item === "string" && item.length > 0)) return undefined;
  return [...value];
}

function describeReceived(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function warnInvalidType(warnings: string[], path: string, received: unknown, fallback: unknown): void {
  warnings.push(
    `設定「${path}」的值型別是 ${describeReceived(received)}，不符合預期，已改用預設值 ${JSON.stringify(fallback)}。`,
  );
}

function warnUnknownKey(warnings: string[], path: string, key: string): void {
  warnings.push(`設定「${path}」有多餘的欄位「${key}」，已忽略（可能是拼錯，合法欄位以 schema 為準）。`);
}

function sanitizeModules(raw: unknown, warnings: string[]): Record<ModuleKey, boolean> {
  const modules: Record<ModuleKey, boolean> = { ...DEFAULT_SETTINGS.modules };
  if (raw === undefined) return modules;
  if (!isPlainObject(raw)) {
    warnInvalidType(warnings, "modules", raw, DEFAULT_SETTINGS.modules);
    return modules;
  }
  for (const key of MODULE_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      warnInvalidType(warnings, `modules.${key}`, value, DEFAULT_SETTINGS.modules[key]);
      continue;
    }
    modules[key] = value;
  }
  for (const key of Object.keys(raw)) {
    if (!(MODULE_KEYS as readonly string[]).includes(key)) warnUnknownKey(warnings, "modules", key);
  }
  return modules;
}

function sanitizeSkiller(raw: unknown, warnings: string[]): UltraworkSettings["skiller"] {
  const skiller = { ...DEFAULT_SETTINGS.skiller };
  if (raw === undefined) return skiller;
  if (!isPlainObject(raw)) {
    warnInvalidType(warnings, "skiller", raw, DEFAULT_SETTINGS.skiller);
    return skiller;
  }
  for (const field of ["personalSkillRoot", "agentsDir"] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0) {
      warnInvalidType(warnings, `skiller.${field}`, value, DEFAULT_SETTINGS.skiller[field]);
      continue;
    }
    skiller[field] = value;
  }
  for (const key of Object.keys(raw)) {
    if (key !== "personalSkillRoot" && key !== "agentsDir") warnUnknownKey(warnings, "skiller", key);
  }
  return skiller;
}

function sanitizeSkills(raw: unknown, warnings: string[]): UltraworkSettings["skills"] {
  const skills: UltraworkSettings["skills"] = { ...DEFAULT_SETTINGS.skills };
  if (raw === undefined) return skills;
  if (!isPlainObject(raw)) {
    warnInvalidType(warnings, "skills", raw, DEFAULT_SETTINGS.skills);
    return skills;
  }
  const catalog = raw["catalog"];
  if (catalog !== undefined) {
    if (catalog !== "index" && catalog !== "full") {
      warnInvalidType(warnings, "skills.catalog", catalog, DEFAULT_SETTINGS.skills.catalog);
    } else {
      skills.catalog = catalog;
    }
  }
  for (const key of Object.keys(raw)) {
    if (key !== "catalog") warnUnknownKey(warnings, "skills", key);
  }
  return skills;
}

function sanitizeVerification(
  raw: unknown,
  warnings: string[],
): UltraworkSettings["verification"] {
  const verification: UltraworkSettings["verification"] = {
    runAllowedAgents: [...DEFAULT_SETTINGS.verification.runAllowedAgents],
    scopeCheckAllowedAgents: [...DEFAULT_SETTINGS.verification.scopeCheckAllowedAgents],
  };
  if (raw === undefined) return verification;
  if (!isPlainObject(raw)) {
    warnInvalidType(warnings, "verification", raw, DEFAULT_SETTINGS.verification);
    return verification;
  }
  const fields = [
    ["runAllowedAgents", DEFAULT_SETTINGS.verification.runAllowedAgents],
    ["scopeCheckAllowedAgents", DEFAULT_SETTINGS.verification.scopeCheckAllowedAgents],
  ] as const;
  for (const [field, fallback] of fields) {
    const value = raw[field];
    if (value === undefined) continue;
    const list = asStringList(value);
    if (list === undefined) {
      warnInvalidType(warnings, `verification.${field}`, value, fallback);
      continue;
    }
    verification[field] = list;
  }
  for (const key of Object.keys(raw)) {
    if (key !== "runAllowedAgents" && key !== "scopeCheckAllowedAgents") {
      warnUnknownKey(warnings, "verification", key);
    }
  }
  return verification;
}

function sanitizeWorkflow(raw: unknown, warnings: string[]): UltraworkSettings["workflow"] {
  const workflow: UltraworkSettings["workflow"] = {
    completion: { ...DEFAULT_SETTINGS.workflow.completion },
    evidencePack: { gatedSubagents: [...DEFAULT_SETTINGS.workflow.evidencePack.gatedSubagents] },
  };
  if (raw === undefined) return workflow;
  if (!isPlainObject(raw)) {
    warnInvalidType(warnings, "workflow", raw, DEFAULT_SETTINGS.workflow);
    return workflow;
  }
  const completion = raw["completion"];
  if (completion !== undefined) {
    if (!isPlainObject(completion)) {
      warnInvalidType(warnings, "workflow.completion", completion, DEFAULT_SETTINGS.workflow.completion);
    } else {
      const requireMemoryDisposition = completion["requireMemoryDisposition"];
      if (requireMemoryDisposition !== undefined) {
        if (typeof requireMemoryDisposition !== "boolean") {
          warnInvalidType(
            warnings,
            "workflow.completion.requireMemoryDisposition",
            requireMemoryDisposition,
            DEFAULT_SETTINGS.workflow.completion.requireMemoryDisposition,
          );
        } else {
          workflow.completion.requireMemoryDisposition = requireMemoryDisposition;
        }
      }
      for (const key of Object.keys(completion)) {
        if (key === "requireMemoryReceipt") warnings.push("requireMemoryReceipt 已改名為 requireMemoryDisposition，舊值已忽略。");
        else if (key !== "requireMemoryDisposition") warnUnknownKey(warnings, "workflow.completion", key);
      }
    }
  }
  const evidencePack = raw["evidencePack"];
  if (evidencePack !== undefined) {
    if (!isPlainObject(evidencePack)) {
      warnInvalidType(warnings, "workflow.evidencePack", evidencePack, DEFAULT_SETTINGS.workflow.evidencePack);
    } else {
      const gatedSubagents = evidencePack["gatedSubagents"];
      if (gatedSubagents !== undefined) {
        const list = asStringList(gatedSubagents);
        if (list === undefined) {
          warnInvalidType(
            warnings,
            "workflow.evidencePack.gatedSubagents",
            gatedSubagents,
            DEFAULT_SETTINGS.workflow.evidencePack.gatedSubagents,
          );
        } else {
          workflow.evidencePack.gatedSubagents = list;
        }
      }
      for (const key of Object.keys(evidencePack)) {
        if (key !== "gatedSubagents") warnUnknownKey(warnings, "workflow.evidencePack", key);
      }
    }
  }
  for (const key of Object.keys(raw)) {
    if (key !== "completion" && key !== "evidencePack") warnUnknownKey(warnings, "workflow", key);
  }
  return workflow;
}

/**
 * 把合併後的原始設定整理成合法的 UltraworkSettings。
 *
 * 保證：回傳的 settings 每個欄位都符合型別，呼叫端不用再防禦；
 * 任何退回預設的地方都有一則 warnings。輸入不會被修改，
 * 也永遠不會沿用輸入的陣列（授權清單一律拷貝）。
 */
export function sanitizeSettings(raw: unknown): SanitizeResult {
  const warnings: string[] = [];
  const source = isPlainObject(raw) ? raw : {};
  if (!isPlainObject(raw)) {
    warnInvalidType(warnings, "(整份設定)", raw, "(內建預設)");
  }
  const settings: UltraworkSettings = {
    modules: sanitizeModules(source["modules"], warnings),
    skiller: sanitizeSkiller(source["skiller"], warnings),
    skills: sanitizeSkills(source["skills"], warnings),
    verification: sanitizeVerification(source["verification"], warnings),
    memory: sanitizeMemory(source["memory"], warnings),
    workflow: sanitizeWorkflow(source["workflow"], warnings),
  };
  for (const key of Object.keys(source)) {
    // $schema 是給編輯器的提示（見 schema 檔），不屬於執行期設定：安靜丟掉，不警告。
    if (key === "$schema") continue;
    if (!["modules", "skiller", "skills", "verification", "workflow", "memory"].includes(key)) {
      warnUnknownKey(warnings, "(根層)", key);
    }
  }
  return { settings, warnings };
}

function sanitizeMemory(raw: unknown, warnings: string[]): UltraworkSettings["memory"] {
  const memory: UltraworkSettings["memory"] = {
    writerAgents: [...DEFAULT_SETTINGS.memory.writerAgents],
    inject: DEFAULT_SETTINGS.memory.inject,
    budget: {
      global: { ...DEFAULT_SETTINGS.memory.budget.global },
      project: { ...DEFAULT_SETTINGS.memory.budget.project },
    },
  };
  if (raw === undefined) return memory;
  if (!isPlainObject(raw)) {
    warnInvalidType(warnings, "memory", raw, memory);
    return memory;
  }
  if (raw.writerAgents !== undefined) {
    const agents = asStringList(raw.writerAgents);
    if (agents) memory.writerAgents = agents;
    else warnInvalidType(warnings, "memory.writerAgents", raw.writerAgents, memory.writerAgents);
  }
  if (raw.inject !== undefined) {
    if (typeof raw.inject === "boolean") memory.inject = raw.inject;
    else warnInvalidType(warnings, "memory.inject", raw.inject, true);
  }
  if (raw.budget !== undefined) {
    memory.budget = sanitizeMemoryBudget(raw.budget, warnings);
  }
  for (const key of Object.keys(raw)) {
    if (key !== "writerAgents" && key !== "inject" && key !== "budget") warnUnknownKey(warnings, "memory", key);
  }
  return memory;
}

/**
 * 每層預算的七個欄位：正整數才收（`maxTopics` 允許 0＝不限制），
 * 型別或範圍錯誤退回該欄位的預設值並警告，不讓壞值流進模組。
 */
const MEMORY_BUDGET_FIELDS: ReadonlyArray<{ key: keyof MemoryLayerBudget; allowZero: boolean }> = [
  { key: "indexCharLimit", allowZero: false },
  { key: "topicCharLimit", allowZero: false },
  { key: "descriptionCharLimit", allowZero: false },
  { key: "maxTopics", allowZero: true },
  { key: "pinnedLimit", allowZero: false },
  { key: "pinnedInjectBudget", allowZero: false },
  { key: "noteCharLimit", allowZero: false },
];

function sanitizeMemoryBudget(raw: unknown, warnings: string[]): MemoryBudgets {
  const fallback = DEFAULT_SETTINGS.memory.budget;
  if (!isPlainObject(raw)) {
    warnInvalidType(warnings, "memory.budget", raw, fallback);
    return { global: { ...fallback.global }, project: { ...fallback.project } };
  }
  const budget: MemoryBudgets = {
    global: sanitizeMemoryLayerBudget(raw["global"], "memory.budget.global", warnings, fallback.global),
    project: sanitizeMemoryLayerBudget(raw["project"], "memory.budget.project", warnings, fallback.project),
  };
  for (const key of Object.keys(raw)) {
    if (key !== "global" && key !== "project") warnUnknownKey(warnings, "memory.budget", key);
  }
  return budget;
}

function sanitizeMemoryLayerBudget(
  raw: unknown,
  path: string,
  warnings: string[],
  fallback: MemoryLayerBudget,
): MemoryLayerBudget {
  const layer = { ...fallback };
  if (raw === undefined) return layer;
  if (!isPlainObject(raw)) {
    warnInvalidType(warnings, path, raw, fallback);
    return layer;
  }
  for (const { key, allowZero } of MEMORY_BUDGET_FIELDS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || (value === 0 && !allowZero)) {
      warnInvalidType(warnings, `${path}.${key}`, value, fallback[key]);
      continue;
    }
    layer[key] = value;
  }
  for (const key of Object.keys(raw)) {
    if (!MEMORY_BUDGET_FIELDS.some((field) => field.key === key)) {
      warnUnknownKey(warnings, path, key);
    }
  }
  return layer;
}
