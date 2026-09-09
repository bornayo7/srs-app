/** Revision arithmetic must never round and accidentally reuse an earlier identity. */
export function nextRevision(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new Error(
      'This record has an invalid or exhausted revision. Restore a valid backup before editing it.',
    );
  }
  return current + 1;
}
export const LEGACY_GENERATION = 'legacy';

export interface Versioned {
  rev: number;
  generation: string;
}

export function versionOf(row: Versioned): Versioned {
  return { rev: row.rev, generation: row.generation };
}

export function sameVersion(current: Versioned, expected: Versioned): boolean {
  return (
    Number.isSafeInteger(current.rev) &&
    current.rev >= 0 &&
    typeof current.generation === 'string' &&
    current.generation.length > 0 &&
    current.rev === expected.rev &&
    current.generation === expected.generation
  );
}
