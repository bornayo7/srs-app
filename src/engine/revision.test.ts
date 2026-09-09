import { describe, expect, it } from 'vitest';
import { nextRevision, sameVersion, versionOf } from './revision';

describe('monotonic revision arithmetic', () => {
  it('treats a restored generation as a different record even when counters match', () => {
    const row = { rev: 3, generation: 'before' };
    const observed = versionOf(row);
    row.generation = 'restored';
    expect(sameVersion(row, observed)).toBe(false);
    expect(sameVersion(row, versionOf(row))).toBe(true);
  });
  it('advances valid integers and refuses values that could round or reuse identity', () => {
    expect(nextRevision(0)).toBe(1);
    expect(nextRevision(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of [
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => nextRevision(value)).toThrow(/revision/);
    }
  });
});
