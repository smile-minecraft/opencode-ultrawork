/**
 * 計畫 ID、任務 ID 的格式，以及「專案內容裡有沒有 ID」的比對。
 *
 * 比對以任務註冊檔案裡實際存在的 ID 為準，不猜格式：過去用正規表達式猜格式的檢查，
 * 對不上實際在用的 ID，所以這裡的案例都取自真實出現過的寫法。
 */
import { describe, expect, test } from "bun:test";
import {
  detectableWorkflowIds,
  findWorkflowIds,
  nextTaskId,
  validatePlanId,
  validateTaskId,
} from "../../../../src/modules/workflow/core/workflow-id.ts";

describe("計畫 ID 的格式", () => {
  test.each(["economy-review-hardening", "release-v150", "agy-tool-bridge", "mcc-opencode-player-agent"])("接受 %s", (id) => {
    expect(validatePlanId(id).ok).toBe(true);
  });

  test.each([
    ["hardening", "只有一個單字"],
    ["a-b-c-d-e", "超過四個單字"],
    ["acelib-v150-20261009", "帶日期"],
    ["plan-20260927-economy-review", "帶日期"],
    ["cl-m0", "帶里程碑編號"],
    ["economy-w03", "帶工作項目編號"],
    ["Economy-Review", "大寫"],
    ["economy_review", "底線"],
    ["economy-review-03", "結尾是流水號，會和任務 ID 分不開"],
    ["", "空字串"],
  ])("拒絕 %s（%s）", (id) => {
    const result = validatePlanId(id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("任務 ID 的格式", () => {
  test.each(["economy-review-hardening-03", "login-timeout-fix-01", "release-v150-12"])("接受 %s", (id) => {
    expect(validateTaskId(id).ok).toBe(true);
  });

  test.each(["CL-M0-04", "w03-postcommit-notify", "t-17", "acelib-v150-t28", "pg10-api", "t-dbnet-20261009", "economy-review-3", "economy-review-003", "economy-review", "fix-01"])(
    "拒絕 %s",
    (id) => {
      expect(validateTaskId(id).ok).toBe(false);
    },
  );
});

describe("下一個任務 ID", () => {
  test("沒有同主題的任務時從 01 開始", () => {
    expect(nextTaskId("economy-review", ["other-topic-01"])).toBe("economy-review-01");
  });

  test("接在同主題最大的流水號後面，不補中間的空號", () => {
    expect(nextTaskId("economy-review", ["economy-review-01", "economy-review-04", "economy-review-extra-09"])).toBe("economy-review-05");
  });
});

describe("哪些 ID 拿來比對", () => {
  test("任務 ID 要有數字而且夠長；計畫 ID 只比對帶日期的舊格式", () => {
    const ids = detectableWorkflowIds(
      ["economy-review-03", "CL-M4-01", "t-17", "t-1", "b", "auto-skill-sync"],
      ["economy-review", "acelib-v150-20261009", "release-v150"],
    );
    // 新格式的計畫 ID 只有英文單字，和功能的名稱分不開，所以不比對。
    expect(ids.sort()).toEqual(["CL-M4-01", "acelib-v150-20261009", "economy-review-03", "t-17"]);
  });
});

describe("在文字裡找 ID", () => {
  const ids = ["economy-review-03", "CL-M4-01", "t-17", "acelib-v150-20261009"];

  test.each([
    ['Map.entry("GROUP_CREATE", "CL-M4-01"),', "CL-M4-01"],
    ["feat(bank): route players for t-17", "t-17"],
    ["class EconomyReview03Test {", "economy-review-03"],
    ["SqlEconomyReview03RegressionTest.java", "economy-review-03"],
    ['"economy_review_03.missing"', "economy-review-03"],
    ["// see economy-review-03", "economy-review-03"],
    ["class T17BlockerTest {", "t-17"],
    ["詳見 acelib-v150-20261009 的規劃", "acelib-v150-20261009"],
  ])("找得到：%s", (text, id) => {
    expect(findWorkflowIds(text, ids).map((hit) => hit.id)).toEqual([id]);
  });

  test.each([
    "class EconomyReviewService {",
    "economy-review-030 是別的編號",
    "const at17 = input17;",
    "utf-8 與 sha-256 不是任務",
    "port-17 上的服務",
  ])("不誤判：%s", (text) => {
    expect(findWorkflowIds(text, ids)).toEqual([]);
  });

  test("回報位置和實際出現的寫法，同一行有兩個就回報兩個", () => {
    const hits = findWorkflowIds("x CL-M4-01 y t-17", ids);
    expect(hits.map((hit) => [hit.id, hit.match, hit.index])).toEqual([
      ["CL-M4-01", "CL-M4-01", 2],
      ["t-17", "t-17", 13],
    ]);
  });

  test("沒有可比對的 ID 時不找任何東西", () => {
    expect(findWorkflowIds("CL-M4-01", [])).toEqual([]);
  });
});
