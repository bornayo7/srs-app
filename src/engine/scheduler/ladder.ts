import type { SrsLadder, SrsState } from '../types';
import type { Scheduler } from './types';
import { floorToHour, minutesToMs } from '../time';

/**
 * WaniKani-style stage ladder.
 * - correct → stage + 1
 * - wrong   → max(0, stage − ceil(incorrectCount / 2) × penalty),
 *             penalty 2 at/above passesAtIndex, else 1  (WK formula)
 * - past the top stage → burned (dueAt null), or repeat the last interval
 *   forever when the ladder has burning disabled.
 * All due times floor to the top of the hour.
 *
 * A burned card is represented as stageIndex === stages.length.
 */
export function makeLadderScheduler(ladder: SrsLadder): Scheduler {
  const top = ladder.stages.length;

  function dueFor(stageIndex: number, now: number): number {
    const stage = ladder.stages[stageIndex];
    const target = now + minutesToMs(stage.intervalMinutes);
    const floored = floorToHour(target);
    // Hour-floor (WK behavior) — but never floor into the past: a custom
    // sub-hour stage (e.g. 30m) must keep its real delay.
    return floored > now ? floored : target;
  }

  return {
    kind: 'ladder',

    initialState(now) {
      return { srs: { kind: 'ladder', stageIndex: 0 }, dueAt: dueFor(0, now) };
    },

    applyReview(srs, outcome, now) {
      if (srs.kind !== 'ladder') throw new Error('ladder scheduler received non-ladder state');
      if (outcome.kind !== 'ladder') throw new Error('ladder scheduler received non-ladder outcome');

      const current = Math.min(srs.stageIndex, top - 1);
      let next: number;
      if (outcome.incorrectCount === 0) {
        next = current + 1;
      } else {
        const penalty = current >= ladder.passesAtIndex ? 2 : 1;
        next = Math.max(0, current - Math.ceil(outcome.incorrectCount / 2) * penalty);
      }

      if (next >= top) {
        if (ladder.burnEnabled) {
          return { srs: { kind: 'ladder', stageIndex: top }, dueAt: null };
        }
        next = top - 1; // no burning: keep repeating the last interval
      }
      return { srs: { kind: 'ladder', stageIndex: next }, dueAt: dueFor(next, now) };
    },

    isPassed(srs) {
      return srs.kind === 'ladder' && srs.stageIndex >= ladder.passesAtIndex;
    },
  };
}

/** Display name for a stage index, handling the burned pseudo-stage. */
export function stageName(ladder: SrsLadder, srs: SrsState | null): string {
  if (!srs) return 'New';
  if (srs.kind !== 'ladder') return 'FSRS';
  if (srs.stageIndex >= ladder.stages.length) return 'Burned';
  return ladder.stages[srs.stageIndex].name;
}
