/**
 * JSONC 解析：ultrawork.jsonc 允許整行、行尾與區塊註解。
 *
 * 只做註解剝除再交給 JSON.parse，不支援尾逗號。
 * 字串內的 // 與 /* 不會被誤判為註解。
 */

/** 剝除註解，保留字串內容原樣。 */
export function stripJsoncComments(text: string): string {
  let output = "";
  let index = 0;
  const length = text.length;
  while (index < length) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < length) {
        const inner = text[index];
        if (inner === "\\") {
          index += 2;
          continue;
        }
        index += 1;
        if (inner === '"') break;
      }
      output += text.slice(start, index);
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

/** 解析 JSONC，格式錯誤時丟出 SyntaxError。 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsoncComments(text));
}
