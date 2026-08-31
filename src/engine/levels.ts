/**
 * Levels — WaniKani's pacing device. A course sits at `currentLevel`; when
 * enough of the current level's *gate* items have passed, the level ticks up
 * and the next level's items unlock (subject to their own prerequisites).
 */

export const DEFAULT_PASS_PERCENT = 90;

/** How many gate items must pass to advance (ceil of the percentage). */
export function levelUpThreshold(gateCount: number, passPercent: number): number {
  if (gateCount <= 0) return 0;
  const pct = Math.min(100, Math.max(1, passPercent));
  return Math.max(1, Math.ceil((gateCount * pct) / 100));
}

export function shouldLevelUp(
  passedGateCount: number,
  gateCount: number,
  passPercent: number,
): boolean {
  if (gateCount <= 0) return false;
  return passedGateCount >= levelUpThreshold(gateCount, passPercent);
}

export interface LevelProgress {
  level: number;
  gateCount: number;
  passedCount: number;
  needed: number;
  remaining: number;
  percent: number;
  /** No gate items at this level → the level can never advance on its own. */
  stalled: boolean;
}

export function levelProgress(
  level: number,
  gateCount: number,
  passedCount: number,
  passPercent: number,
): LevelProgress {
  const needed = levelUpThreshold(gateCount, passPercent);
  return {
    level,
    gateCount,
    passedCount,
    needed,
    remaining: Math.max(0, needed - passedCount),
    percent: needed === 0 ? 0 : Math.min(100, Math.round((passedCount / needed) * 100)),
    stalled: gateCount === 0,
  };
}
