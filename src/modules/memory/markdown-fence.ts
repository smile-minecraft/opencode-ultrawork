/**
 * CommonMark fenced-code-block 偵測：自舊外掛 core/markdown-fence 逐字搬入。
 *
 * `lineFenceState(lines)` 回傳 per-line boolean mask，標示該行是否位於
 * fenced code block 內，供 heading／section 掃描避開 fenced 範例。
 * 純函式，僅依賴字串處理，不引入 IO。
 */

/**
 * Build a per-line mask indicating whether each line sits inside a fenced
 * code block.
 *
 * Recognises CommonMark-style fences:
 *   - Backtick fences: three or more consecutive `` ` `` characters.
 *   - Tilde fences: three or more consecutive `~` characters.
 *   - Opening fences may carry an info string (anything after the fence
 *     marker on the same line); closing fences must not.
 *   - For backtick opening fences the info string must not itself contain
 *     any backtick characters. A line such as ```` ``` ` ```` is therefore
 *     not a valid opening fence and leaves `inFence` untouched.
 *   - Closing fences must use the same character and a length greater than
 *     or equal to the opening fence's length.
 *   - Lines may be indented by up to three spaces.
 *
 * The mask entry for a fence line reflects the state *before* that line is
 * processed, so opening and closing fence markers are both reported as
 * belonging to the fenced region. This mirrors how fences delimit a code
 * block: the markers themselves are part of the block syntax, not visible
 * body content.
 */
export function lineFenceState(lines: string[]): boolean[] {
  const mask: boolean[] = new Array(lines.length).fill(false);
  let inFence = false;
  let fenceChar: "`" | "~" | null = null;
  let fenceLength = 0;
  const fencePattern = /^( {0,3})(`{3,}|~{3,})(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    mask[i] = inFence;
    const match = fencePattern.exec(lines[i]!);
    if (!match) continue;
    const chars = match[2]!;
    const char = chars[0] as "`" | "~";
    const length = chars.length;
    const rest = match[3]!;
    if (!inFence) {
      // CommonMark: a backtick opening fence's info string cannot itself
      // contain backticks. A line that violates this rule does not open a
      // fence, so we leave the state untouched and let the closing branch
      // (if any) skip over the line as malformed.
      if (char === "`" && rest.includes("`")) continue;
      inFence = true;
      fenceChar = char;
      fenceLength = length;
    } else if (char === fenceChar && length >= fenceLength && rest.trim() === "") {
      inFence = false;
      fenceChar = null;
      fenceLength = 0;
    }
  }
  return mask;
}
