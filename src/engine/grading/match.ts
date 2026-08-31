import type { GuidanceAnswer } from '../types';
import { containsKana, containsLatin, normalizeAnswer } from './normalize';
import { osaDistance, typoBudget } from './distance';

export interface MatchContext {
  /** Answer-field value(s) plus user synonyms for this template. */
  accepted: string[];
  /** Similar-but-wrong answers that must never be rescued by fuzzy matching. */
  blocked: string[];
  /** Bunpro-style "almost" answers → retry with a custom message (P5). */
  guidance: GuidanceAnswer[];
  /** Accepted answers of the item's OTHER templates (wrong-facet detection). */
  siblingAccepted: string[];
  answerLang: 'latin' | 'kana';
  typoTolerance: boolean;
}

export type MatchVerdict =
  | { verdict: 'correct'; matched: string }
  | { verdict: 'correctWithTypo'; matched: string; distance: number }
  | { verdict: 'retry'; reason: 'empty' | 'alphabet' | 'wrongFacet' | 'guidance'; message?: string }
  | { verdict: 'incorrect' };

/**
 * The grading pipeline:
 * normalize → empty → retry
 * → exact vs accepted → correct   (before the script guard, so a mixed-script
 *   accepted answer like "kabuki 歌舞伎" stays answerable)
 * → wrong-alphabet → retry (shake, no penalty)
 * → block list → incorrect (defeats fuzzy)
 * → guidance → retry with message
 * → edit distance (latin + tolerance only) → correctWithTypo
 * → sibling-template exact match → retry (typed the reading on the meaning card)
 * → incorrect
 */
export function matchTypedAnswer(raw: string, ctx: MatchContext): MatchVerdict {
  const input = normalizeAnswer(raw);

  if (input.length === 0) return { verdict: 'retry', reason: 'empty' };

  const accepted = ctx.accepted.map(normalizeAnswer).filter((s) => s.length > 0);

  for (const a of accepted) {
    if (a === input) return { verdict: 'correct', matched: a };
  }

  if (ctx.answerLang === 'kana' && containsLatin(input)) {
    return { verdict: 'retry', reason: 'alphabet' };
  }
  if (ctx.answerLang === 'latin' && containsKana(input)) {
    return { verdict: 'retry', reason: 'alphabet' };
  }

  if (ctx.blocked.some((b) => normalizeAnswer(b) === input)) {
    return { verdict: 'incorrect' };
  }

  for (const g of ctx.guidance) {
    if (normalizeAnswer(g.text) === input) {
      return { verdict: 'retry', reason: 'guidance', message: g.message };
    }
  }

  if (ctx.typoTolerance && ctx.answerLang === 'latin') {
    let best: { matched: string; distance: number } | null = null;
    for (const a of accepted) {
      const budget = typoBudget(a.length);
      if (budget === 0) continue;
      const dist = osaDistance(a, input);
      if (dist <= budget && (best === null || dist < best.distance)) {
        best = { matched: a, distance: dist };
      }
    }
    if (best) return { verdict: 'correctWithTypo', ...best };
  }

  if (ctx.siblingAccepted.some((s) => normalizeAnswer(s) === input)) {
    return { verdict: 'retry', reason: 'wrongFacet' };
  }

  return { verdict: 'incorrect' };
}
