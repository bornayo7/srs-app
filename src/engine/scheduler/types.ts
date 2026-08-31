import type { ReviewOutcome, SrsState } from '../types';

/**
 * Pluggable scheduling contract. Both the WaniKani-style ladder and (P5) FSRS
 * satisfy it, so gating/levels/queue logic never cares which one a course uses.
 * Pure and clock-injected — `now` is always a parameter.
 */
export interface Scheduler {
  kind: 'ladder' | 'fsrs';
  /** State for a card the moment its lesson completes. */
  initialState(now: number): { srs: SrsState; dueAt: number };
  /** Apply one review. `dueAt: null` means retired (burned). */
  applyReview(
    srs: SrsState,
    outcome: ReviewOutcome,
    now: number,
  ): { srs: SrsState; dueAt: number | null };
  /** "Guru-equivalent" — feeds prerequisite gating and level-ups. */
  isPassed(srs: SrsState): boolean;
}
