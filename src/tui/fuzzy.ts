/** Return exact (0), prefix, hyphen word start, substring or subsequence (4) rank ignoring case, or undefined for no match. */
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
