import { describe, expect, test } from "bun:test";
import { agentListConfigChecks, agentRoleFilesCheck, configuredAgentNames } from "../../../../src/modules/diagnostics/shared.ts";
import { DEFAULT_SETTINGS } from "../../../../src/settings/defaults.ts";

describe("診斷中的角色清單設定", () => {
  test("四個空清單各自警告設定 key 與受影響能力", () => {
    const checks = agentListConfigChecks(DEFAULT_SETTINGS);

    expect(checks.map(({ name, status }) => [name, status])).toEqual([
      ["Verification Run Agent Config", "warn"],
      ["Scope Check Agent Config", "warn"],
      ["Memory Writer Config", "warn"],
      ["Evidence Pack Gate Config", "warn"],
    ]);
    expect(checks.map(({ details }) => details)).toEqual([
      "verification.runAllowedAgents 是空的，沒有 agent 能呼叫 verification_run。",
      "verification.scopeCheckAllowedAgents 是空的，沒有 agent 能呼叫 change-scope-check。",
      "memory.writerAgents 是空的，沒有 agent 能寫記憶，高風險任務將無法結案。",
      "workflow.evidencePack.gatedSubagents 是空的，派遣前的七節格式檢查已停用。",
    ]);
  });

  test("非空清單逐項列出全部名稱，角色檔聯集去重且保留清單順序", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.verification.runAllowedAgents = ["reviewer", "shared"];
    settings.verification.scopeCheckAllowedAgents = ["builder", "shared"];
    settings.memory.writerAgents = ["scribe"];
    settings.workflow.evidencePack.gatedSubagents = ["reviewer", "tester"];

    expect(agentListConfigChecks(settings).map(({ status, details }) => [status, details])).toEqual([
      ["passed", "允許呼叫 verification_run 的 agent：reviewer、shared。"],
      ["passed", "允許呼叫 change-scope-check 的 agent：builder、shared。"],
      ["passed", "允許寫記憶的 agent：scribe。"],
      ["passed", "受七節格式檢查的 agent：reviewer、tester。"],
    ]);
    expect(configuredAgentNames(settings)).toEqual(["reviewer", "shared", "builder", "scribe", "tester"]);
  });

  test("部分清單空白只警告該清單，其餘各自通過", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.verification.runAllowedAgents = ["reviewer"];
    settings.verification.scopeCheckAllowedAgents = [];
    settings.memory.writerAgents = ["scribe"];
    settings.workflow.evidencePack.gatedSubagents = ["tester"];

    expect(agentListConfigChecks(settings).map(({ status }) => status)).toEqual([
      "passed",
      "warn",
      "passed",
      "passed",
    ]);
  });
});

describe("角色檔唯讀檢查", () => {
  test("全部存在時通過，重複名稱只查一次且保持順序", () => {
    const queried: string[] = [];
    const root = "/tmp/config/agents";
    const check = agentRoleFilesCheck(["reviewer", "reviewer", "builder"], (name) => {
      queried.push(name);
      return "exists";
    }, root);

    expect(check.status).toBe("passed");
    expect(check.details).toContain(root);
    expect(queried).toEqual(["reviewer", "builder"]);
  });

  test("缺檔只警告並提示專案層與檢查目錄", () => {
    const root = "/tmp/config/agents";
    const check = agentRoleFilesCheck(["missing"], () => "missing", root);

    expect(check.status).toBe("warn");
    expect(check.details).toContain("角色也可能定義在專案層");
    expect(check.details).toContain("請確認名稱或補上角色檔");
    expect(check.details).toContain(root);
  });

  test("查詢能力缺席明確略過，未知結果不會誤報全部存在", () => {
    const root = "/tmp/config/agents";
    const unavailable = agentRoleFilesCheck(["reviewer"], undefined, root);
    const unknown = agentRoleFilesCheck(["reviewer", "unknown"], (name) =>
      name === "reviewer" ? "exists" : "unknown", root);

    expect(unavailable.status).toBe("skipped");
    expect(unavailable.details).toContain("無法檢查");
    expect(unavailable.details).toContain(root);
    expect(unknown.status).toBe("skipped");
    expect(unknown.details).toContain("無法確認");
  });

  test("含路徑跳脫字元的名稱不交給查詢能力", () => {
    const queried: string[] = [];
    const check = agentRoleFilesCheck(["../outside", "nested/role", "..", "safe"], (name) => {
      queried.push(name);
      return "exists";
    }, "/tmp/config/agents");

    expect(check.status).toBe("skipped");
    expect(check.details).toContain("無法確認");
    expect(queried).toEqual(["safe"]);
  });
});
