/** 記憶 writer 政策的唯一可讀文字格式，供工具、結案驗證與 context 注入共用。 */
export function memoryWriterPolicyText(writerAgents: readonly string[]): string {
  if (writerAgents.length === 0) {
    return "目前沒有 agent 能寫入記憶；請在設定 key `memory.writerAgents` 指定可寫入的 agent。";
  }
  return `具記憶寫入權的 agent：${writerAgents.join("、")}。`;
}
