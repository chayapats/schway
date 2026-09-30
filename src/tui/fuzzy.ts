/** Rank a case-insensitive subsequence from exact (0) through prefix, hyphen word start, substring and subsequence (4). */
export function fuzzyRank(query: string, candidate: string): number | undefined {
  const needle = query.toLowerCase();
  const haystack = candidate.toLowerCase();
  if (!needle || haystack === needle) return 0;
  if (haystack.startsWith(needle)) return 1;
  if (haystack.includes(`-${needle}`)) return 2;
  if (haystack.includes(needle)) return 3;
  const characters = [...needle];
  let matched = 0;
  for (const character of haystack) {
    if (character === characters[matched]) matched++;
    if (matched === characters.length) return 4;
  }
  return undefined;
}
