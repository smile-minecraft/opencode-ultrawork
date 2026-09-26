const HAN = /\p{Script=Han}/u;

/** 把查詢切成詞：先依空白與標點切開，中英文夾雜的再拆成中文段與英文段，中文段再補兩字片段。 */
export function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const word of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    for (const run of word.match(/\p{Script=Han}+|[^\p{Script=Han}]+/gu) ?? []) {
      terms.add(run);
      // 中文沒有空白分詞，整段之外再拆成兩字一組，才對得到描述裡的片段。
      if (HAN.test(run) && run.length > 2) {
        for (let index = 0; index < run.length - 1; index += 1) terms.add(run.slice(index, index + 2));
      }
    }
  }
  return [...terms];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 英文以完整單字比對，避免「ci」命中「decide」；含中文的片段直接比對子字串。 */
export function containsTerm(haystack: string, term: string): boolean {
  if (HAN.test(term)) return haystack.includes(term);
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}($|[^a-z0-9])`).test(haystack);
}

