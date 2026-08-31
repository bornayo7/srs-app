import { describe, expect, it } from 'vitest';
import { makeLadderScheduler } from './ladder';
import { LADDER_PRESETS } from './presets';
import { HOUR } from '../time';
import type { SrsLadder, SrsState } from '../types';

const classic = LADDER_PRESETS.find((l) => l.id === 'preset-classic')!;
const gentle = LADDER_PRESETS.find((l) => l.id === 'preset-gentle')!;

const at = (stageIndex: number): SrsState => ({ kind: 'ladder', stageIndex });
// A fixed "now" that is NOT on an hour boundary.
const NOW = Date.UTC(2026, 0, 15, 10, 23, 45, 123);

describe('ladder scheduler', () => {
  const s = makeLadderScheduler(classic);

  it('initial state starts at stage 0, due in 4h floored to the hour', () => {
    const { srs, dueAt } = s.initialState(NOW);
    expect(srs).toEqual(at(0));
    expect(dueAt).toBe(Date.UTC(2026, 0, 15, 14, 0, 0, 0));
    expect(dueAt! % HOUR).toBe(0);
  });

  it('correct answer promotes one stage', () => {
    const r = s.applyReview(at(2), { kind: 'ladder', incorrectCount: 0 }, NOW);
    expect(r.srs).toEqual(at(3));
    expect(r.dueAt).not.toBeNull();
    expect(r.dueAt! % HOUR).toBe(0);
  });

  it('drop: stage 2, 1 wrong, penalty 1 → stage 1', () => {
    const r = s.applyReview(at(2), { kind: 'ladder', incorrectCount: 1 }, NOW);
    expect(r.srs).toEqual(at(1));
  });

  it('drop: stage 5 (≥ passesAtIndex), 3 wrong, penalty 2 → stage 1', () => {
    // ceil(3/2)=2, 2×2=4, 5−4=1
    const r = s.applyReview(at(5), { kind: 'ladder', incorrectCount: 3 }, NOW);
    expect(r.srs).toEqual(at(1));
  });

  it('drop clamps at 0: stage 6, 5 wrong → 0', () => {
    // ceil(5/2)=3, 3×2=6, 6−6=0
    const r = s.applyReview(at(6), { kind: 'ladder', incorrectCount: 5 }, NOW);
    expect(r.srs).toEqual(at(0));
  });

  it('penalty boundary: stage 4 (= passesAtIndex) uses penalty 2', () => {
    const r = s.applyReview(at(4), { kind: 'ladder', incorrectCount: 1 }, NOW);
    expect(r.srs).toEqual(at(2)); // 4 − ceil(1/2)×2 = 2
  });

  it('penalty boundary: stage 3 (just below) uses penalty 1', () => {
    const r = s.applyReview(at(3), { kind: 'ladder', incorrectCount: 1 }, NOW);
    expect(r.srs).toEqual(at(2));
  });

  it('correct at the top stage burns (dueAt null, stageIndex = length)', () => {
    const r = s.applyReview(at(7), { kind: 'ladder', incorrectCount: 0 }, NOW);
    expect(r.srs).toEqual(at(8));
    expect(r.dueAt).toBeNull();
    expect(s.isPassed(r.srs)).toBe(true);
  });

  it('burnEnabled:false repeats the last interval instead of burning', () => {
    const g = makeLadderScheduler(gentle);
    const topIdx = gentle.stages.length - 1;
    const r = g.applyReview(at(topIdx), { kind: 'ladder', incorrectCount: 0 }, NOW);
    expect(r.srs).toEqual(at(topIdx));
    expect(r.dueAt).not.toBeNull();
  });

  it('isPassed at/above passesAtIndex only', () => {
    expect(s.isPassed(at(3))).toBe(false);
    expect(s.isPassed(at(4))).toBe(true);
    expect(s.isPassed(at(7))).toBe(true);
  });

  it('23h/47h intervals keep the review hour stable across days (WK trick)', () => {
    // Interpret in UTC to stay machine-timezone-independent.
    const start = Date.UTC(2026, 2, 1, 9, 30); // reviews land ~09:00
    const first = s.applyReview(at(1), { kind: 'ladder', incorrectCount: 0 }, start);
    // stage 2 = 23h → next day 08:00 (one hour EARLIER, never later)
    expect(new Date(first.dueAt!).getUTCHours()).toBe(8);
    const second = s.applyReview(first.srs, { kind: 'ladder', incorrectCount: 0 }, first.dueAt!);
    // stage 3 = 47h → two days on at 07:00
    expect(new Date(second.dueAt!).getUTCHours()).toBe(7);
  });

  it('sub-hour intervals never floor into the past — the real delay is kept', () => {
    const quick: SrsLadder = {
      ...classic,
      id: 'q',
      stages: classic.stages.map((st, i) => (i === 0 ? { ...st, intervalMinutes: 30 } : st)),
    };
    const q = makeLadderScheduler(quick);
    const { dueAt } = q.initialState(NOW); // 10:23:45 + 30m = 10:53:45 → floor would be 10:00 (past)
    expect(dueAt).toBeGreaterThan(NOW);
    expect(dueAt).toBe(NOW + 30 * 60_000);
    // a 90-minute interval still floors to the hour as usual
    const long: SrsLadder = {
      ...quick,
      stages: quick.stages.map((st, i) => (i === 0 ? { ...st, intervalMinutes: 90 } : st)),
    };
    expect(makeLadderScheduler(long).initialState(NOW).dueAt).toBe(Date.UTC(2026, 0, 15, 11));
  });

  it('custom ladder edits honor new intervals', () => {
    const custom: SrsLadder = {
      ...classic,
      id: 'x',
      stages: classic.stages.map((st, i) => (i === 0 ? { ...st, intervalMinutes: 120 } : st)),
    };
    const c = makeLadderScheduler(custom);
    const { dueAt } = c.initialState(NOW);
    expect(dueAt).toBe(Date.UTC(2026, 0, 15, 12, 0, 0, 0));
  });
});
