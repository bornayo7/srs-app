import { mulberry32, seededShuffle } from '../queue';
import { normalizeAnswer } from './normalize';

/**
 * Multiple choice: the item's real answer plus distractors drawn from its
 * siblings. Pure and seeded, so the same card renders the same options for a
 * given seed (and a re-presentation after a miss keeps its layout).
 *
 * Fairness is enforced by the CALLER, which must only pass distractors the
 * grading pipeline would mark incorrect — otherwise a "wrong" option could be
 * an accepted synonym or land inside the typo budget.
 */

export interface ChoiceOption {
  text: string;
  correct: boolean;
}

export const MIN_CHOICE_OPTIONS = 2;
export const MAX_CHOICE_OPTIONS = 6;
export const DEFAULT_CHOICE_COUNT = 4;

export function clampChoiceCount(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CHOICE_COUNT;
  return Math.min(MAX_CHOICE_OPTIONS, Math.max(MIN_CHOICE_OPTIONS, Math.round(n)));
}

/**
 * Build the option list. Returns fewer than `count` options when the pool is
 * thin, and a single option when there are no usable distractors at all —
 * callers treat that as "not enough material, fall back to typing".
 */
export function buildChoiceOptions(
  answer: string,
  distractors: string[],
  count: number,
  seed: number,
): ChoiceOption[] {
  const target = clampChoiceCount(count);
  const seen = new Set([normalizeAnswer(answer)]);
  const unique: string[] = [];
  for (const d of distractors) {
    const key = normalizeAnswer(d);
    if (!key || seen.has(key)) continue; // never show the answer twice
    seen.add(key);
    unique.push(d.trim());
  }

  const picked = seededShuffle(unique, mulberry32(seed)).slice(0, target - 1);
  const options: ChoiceOption[] = [
    { text: answer, correct: true },
    ...picked.map((text) => ({ text, correct: false })),
  ];
  // a second, differently-seeded shuffle so the answer isn't always first
  return seededShuffle(options, mulberry32(seed ^ 0x5f3759df));
}
