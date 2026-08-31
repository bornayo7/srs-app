/**
 * Optimal String Alignment distance (Damerau-Levenshtein restricted to
 * adjacent transpositions). Hand-rolled because typo tolerance must count
 * "recieve" → "receive" as ONE edit, which plain Levenshtein libraries miss.
 */
export function osaDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // (m+1) × (n+1) DP table, flattened.
  const w = n + 1;
  const d = new Array<number>((m + 1) * w);
  for (let i = 0; i <= m; i++) d[i * w] = i;
  for (let j = 0; j <= n; j++) d[j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        d[(i - 1) * w + j] + 1, // deletion
        d[i * w + (j - 1)] + 1, // insertion
        d[(i - 1) * w + (j - 1)] + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[(i - 2) * w + (j - 2)] + 1); // transposition
      }
      d[i * w + j] = best;
    }
  }
  return d[m * w + n];
}

/** WK-style edit budget scaled to answer length. */
export function typoBudget(answerLength: number): number {
  if (answerLength < 4) return 0;
  if (answerLength < 8) return 1;
  return 2;
}
