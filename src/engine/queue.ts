// Review-queue ordering. Pure and seeded so tests are deterministic.

export interface QueueSortable {
  itemId: string;
  typeId: string;
  level: number;
}

export type OrderStrategy = 'shuffle' | 'byLevel' | 'paired';

/** mulberry32 — tiny seeded PRNG, good enough for shuffling. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Order a session's entries.
 * - shuffle: full random
 * - byLevel: ascending level, shuffled within a level
 * - paired: same-item cards kept adjacent (meaning right after reading), item order shuffled
 */
export function orderEntries<T extends QueueSortable>(
  entries: readonly T[],
  strategy: OrderStrategy,
  seed: number,
): T[] {
  const rng = mulberry32(seed);
  switch (strategy) {
    case 'shuffle':
      return seededShuffle(entries, rng);
    case 'byLevel': {
      const shuffled = seededShuffle(entries, rng);
      return shuffled.sort((a, b) => a.level - b.level);
    }
    case 'paired': {
      const groups = new Map<string, T[]>();
      for (const e of entries) {
        const g = groups.get(e.itemId) ?? [];
        g.push(e);
        groups.set(e.itemId, g);
      }
      const order = seededShuffle([...groups.keys()], rng);
      return order.flatMap((id) => groups.get(id)!);
    }
  }
}

export const REINSERT_MIN_GAP = 4;
export const REINSERT_MAX_GAP = 8;

/**
 * Where to reinsert a just-missed card: a random slot 4–8 positions ahead,
 * clamped to the end of the queue.
 */
export function reinsertIndex(remainingLength: number, rng: () => number): number {
  const gap =
    REINSERT_MIN_GAP + Math.floor(rng() * (REINSERT_MAX_GAP - REINSERT_MIN_GAP + 1));
  return Math.min(gap, remainingLength);
}
