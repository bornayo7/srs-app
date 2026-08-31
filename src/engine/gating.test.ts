import { describe, expect, it } from 'vitest';
import {
  computeStatuses,
  initialStatusFor,
  meetsUnlockConditions,
  statusChanges,
  wouldCycle,
  type GateItem,
} from './gating';
import { levelProgress, levelUpThreshold, shouldLevelUp } from './levels';

const item = (over: Partial<GateItem> & { id: string }): GateItem => ({
  level: 1,
  prereqIds: [],
  status: 'locked',
  passedAt: null,
  ...over,
});

describe('unlock conditions', () => {
  it('needs both the level and every prerequisite', () => {
    const passed = new Set(['a']);
    expect(meetsUnlockConditions(item({ id: 'x', prereqIds: ['a'] }), passed, 1)).toBe(true);
    expect(meetsUnlockConditions(item({ id: 'x', prereqIds: ['a', 'b'] }), passed, 1)).toBe(false);
    expect(meetsUnlockConditions(item({ id: 'x', level: 2 }), passed, 1)).toBe(false);
    expect(meetsUnlockConditions(item({ id: 'x', level: 2 }), passed, 2)).toBe(true);
  });
});

describe('computeStatuses', () => {
  it('unlocks a chain one link at a time', () => {
    // a → b → c, only a has passed
    const items = [
      item({ id: 'a', status: 'active', passedAt: 1 }),
      item({ id: 'b', prereqIds: ['a'] }),
      item({ id: 'c', prereqIds: ['b'] }),
    ];
    const s = computeStatuses(items, 1);
    expect(s.get('b')).toBe('lesson');
    expect(s.get('c')).toBe('locked');

    // b passes too → c opens
    items[1] = item({ id: 'b', prereqIds: ['a'], status: 'active', passedAt: 2 });
    expect(computeStatuses(items, 1).get('c')).toBe('lesson');
  });

  it('diamond: d needs BOTH b and c', () => {
    const mk = (bPassed: boolean, cPassed: boolean) => [
      item({ id: 'a', status: 'active', passedAt: 1 }),
      item({ id: 'b', prereqIds: ['a'], status: 'active', passedAt: bPassed ? 2 : null }),
      item({ id: 'c', prereqIds: ['a'], status: 'active', passedAt: cPassed ? 2 : null }),
      item({ id: 'd', prereqIds: ['b', 'c'] }),
    ];
    expect(computeStatuses(mk(true, false), 1).get('d')).toBe('locked');
    expect(computeStatuses(mk(false, true), 1).get('d')).toBe('locked');
    expect(computeStatuses(mk(true, true), 1).get('d')).toBe('lesson');
  });

  it('never demotes an active item, but re-locks an unsatisfied lesson item', () => {
    const items = [
      item({ id: 'gone' }), // prereq not passed
      item({ id: 'active', prereqIds: ['gone'], status: 'active' }),
      item({ id: 'queued', prereqIds: ['gone'], status: 'lesson' }),
    ];
    const s = computeStatuses(items, 1);
    expect(s.get('active')).toBe('active'); // progress outranks gating
    expect(s.get('queued')).toBe('locked');
  });

  it('statusChanges reports only real transitions', () => {
    const items = [
      item({ id: 'a', status: 'lesson' }),
      item({ id: 'b', prereqIds: ['a'], status: 'locked' }),
    ];
    expect(statusChanges(items, 1)).toEqual([]); // a already lesson, b correctly locked
  });
});

describe('inputs that actually break in production', () => {
  it('a dangling prereq id keeps the item locked (never silently passes)', () => {
    const items = [item({ id: 'a', prereqIds: ['deleted-id'] })];
    expect(computeStatuses(items, 1).get('a')).toBe('locked');
  });

  it('a level with zero gate items never advances on its own', () => {
    expect(shouldLevelUp(0, 0, 90)).toBe(false);
    expect(shouldLevelUp(5, 0, 90)).toBe(false);
    expect(levelProgress(2, 0, 0, 90).stalled).toBe(true);
    expect(levelProgress(2, 4, 0, 90).stalled).toBe(false);
  });
});

describe('cycle guard', () => {
  it('rejects self and transitive cycles', () => {
    const items = [item({ id: 'a' }), item({ id: 'b', prereqIds: ['a'] })];
    expect(wouldCycle(items, 'a', ['a'])).toBe(true);
    expect(wouldCycle(items, 'a', ['b'])).toBe(true); // b already depends on a
    expect(wouldCycle(items, 'b', ['a'])).toBe(false);
  });
});

describe('initialStatusFor', () => {
  it('locks above-level or unsatisfied items, opens the rest', () => {
    expect(initialStatusFor(2, [], 1, true)).toBe('locked');
    expect(initialStatusFor(1, [], 1, true)).toBe('lesson');
    expect(initialStatusFor(1, ['a'], 1, false)).toBe('locked');
    expect(initialStatusFor(1, ['a'], 1, true)).toBe('lesson');
  });
});

describe('levels', () => {
  it('threshold is a ceiling of the percentage', () => {
    expect(levelUpThreshold(10, 90)).toBe(9);
    expect(levelUpThreshold(9, 90)).toBe(9); // ceil(8.1)
    expect(levelUpThreshold(1, 90)).toBe(1);
    expect(levelUpThreshold(0, 90)).toBe(0);
  });

  it('9/10 levels up, 8/10 does not', () => {
    expect(shouldLevelUp(9, 10, 90)).toBe(true);
    expect(shouldLevelUp(8, 10, 90)).toBe(false);
    expect(shouldLevelUp(0, 0, 90)).toBe(false); // empty level never advances
  });

  it('progress reports what is left', () => {
    const p = levelProgress(3, 10, 4, 90);
    expect(p).toMatchObject({ level: 3, needed: 9, remaining: 5 });
    expect(p.percent).toBe(44);
  });
});
