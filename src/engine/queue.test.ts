import { describe, expect, it } from 'vitest';
import {
  REINSERT_MAX_GAP,
  REINSERT_MIN_GAP,
  mulberry32,
  orderEntries,
  reinsertIndex,
  seededShuffle,
} from './queue';
import { buildForecast } from './forecast';
import { DAY, HOUR, startOfLocalDay } from './time';

const entries = Array.from({ length: 12 }, (_, i) => ({
  id: `c${i}`,
  itemId: `item${Math.floor(i / 2)}`, // two cards per item
  typeId: i % 3 === 0 ? 'a' : 'b',
  level: (i % 4) + 1,
}));

describe('queue ordering', () => {
  it('seeded shuffle is deterministic and a permutation', () => {
    const a = seededShuffle(entries, mulberry32(42));
    const b = seededShuffle(entries, mulberry32(42));
    const c = seededShuffle(entries, mulberry32(43));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect([...a].sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      [...entries].sort((x, y) => x.id.localeCompare(y.id)),
    );
  });

  it('byLevel sorts ascending by level', () => {
    const r = orderEntries(entries, 'byLevel', 1);
    for (let i = 1; i < r.length; i++) expect(r[i].level).toBeGreaterThanOrEqual(r[i - 1].level);
  });

  it('paired keeps same-item cards adjacent', () => {
    const r = orderEntries(entries, 'paired', 7);
    for (let i = 0; i < r.length; i += 2) expect(r[i].itemId).toBe(r[i + 1].itemId);
  });

  it('reinsertIndex lands 4–8 ahead, clamped to queue length', () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 50; i++) {
      const idx = reinsertIndex(20, rng);
      expect(idx).toBeGreaterThanOrEqual(REINSERT_MIN_GAP);
      expect(idx).toBeLessThanOrEqual(REINSERT_MAX_GAP);
    }
    expect(reinsertIndex(2, rng)).toBe(2); // clamp
  });
});

describe('buildForecast', () => {
  const now = Date.now();
  const today = startOfLocalDay(now);

  it('buckets due-now, per-day, and beyond correctly with cumulative totals', () => {
    const cards = [
      { state: 'review', dueAt: now - HOUR }, // due now
      { state: 'review', dueAt: now - 1 }, // due now
      { state: 'review', dueAt: now + HOUR }, // later today (if not near midnight, else tomorrow)
      { state: 'review', dueAt: today + DAY + 10 * HOUR }, // tomorrow
      { state: 'review', dueAt: today + 3 * DAY + HOUR }, // day 3
      { state: 'review', dueAt: today + 30 * DAY }, // beyond
      { state: 'burned', dueAt: now - HOUR }, // ignored
      { state: 'new' }, // ignored
    ];
    const f = buildForecast(cards, now, 7);
    expect(f.dueNow).toBe(2);
    const inWindow = f.days.reduce((s, d) => s + d.count, 0);
    expect(inWindow).toBe(3);
    expect(f.beyond).toBe(1);
    expect(f.days[6].cumulative).toBe(f.dueNow + inWindow);
    // cumulative is monotonic
    for (let i = 1; i < f.days.length; i++) {
      expect(f.days[i].cumulative).toBeGreaterThanOrEqual(f.days[i - 1].cumulative);
    }
  });
});
