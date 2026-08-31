import type { CardTemplate, ClozeSentence, FieldValue, Item } from '../types';
import { mulberry32 } from '../queue';
import { normalizeAnswer } from './normalize';

/**
 * Sentence-cloze (Bunpro-style): each item carries several example sentences
 * with the target marked ⟦like this⟧; every review shows a different sentence
 * with the blank masked, and the user types the blank.
 */

export const BLANK_RE = /⟦([^⟧]+)⟧/g;

export interface ClozePick {
  sentenceIndex: number;
  masked: string; // sentence with blanks replaced by ____
  blank: string; // the text to type
  translation?: string;
  hint?: string;
}

export function isClozeSentences(v: FieldValue | undefined): v is ClozeSentence[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    typeof v[0] === 'object' &&
    v[0] !== null &&
    'text' in (v[0] as object)
  );
}

/**
 * First blank is the answer. All marks are masked only when they share the
 * same text (repeated-word drills); differing marks would be ambiguous, so
 * only the first is masked and the rest are revealed. Blanks that normalize
 * to nothing ('⟦ ⟧', '⟦.⟧') are unanswerable → treated as no blank at all.
 */
export function extractBlank(sentence: ClozeSentence): { masked: string; blank: string } | null {
  const matches = [...sentence.text.matchAll(BLANK_RE)];
  if (matches.length === 0) return null;
  const blank = matches[0][1].trim();
  if (normalizeAnswer(blank).length === 0) return null;

  const texts = matches.map((m) => m[1].trim());
  const allSame = new Set(texts).size === 1;
  let first = true;
  const masked = sentence.text.replace(BLANK_RE, (_, b: string) => {
    if (allSame) return '＿＿＿';
    if (first) {
      first = false;
      return '＿＿＿';
    }
    return b; // differing later blanks stay revealed — unambiguous prompt
  });
  return { blank, masked };
}

/** Show the sentence with the blank revealed (lesson study / after grading). */
export function revealBlank(text: string): string {
  return text.replace(BLANK_RE, (_, b: string) => b);
}

/**
 * Deterministically pick a sentence for this review from a seed — 'random'
 * rotation varies by seed (session), 'sequential' walks by review count.
 */
export function pickClozeSentence(
  item: Item,
  template: CardTemplate,
  seed: number,
  reviews: number,
): ClozePick | null {
  if (template.grading.mode !== 'sentenceCloze') return null;
  const value = item.fieldValues[template.grading.sentencesFieldId];
  if (!isClozeSentences(value)) return null;

  const usable = value
    .map((s, sentenceIndex) => ({ s, sentenceIndex, extracted: extractBlank(s) }))
    .filter((x): x is typeof x & { extracted: NonNullable<typeof x.extracted> } => x.extracted !== null);
  if (usable.length === 0) return null;

  const idx =
    template.grading.rotation === 'sequential'
      ? reviews % usable.length
      : Math.floor(mulberry32(seed)() * usable.length);
  const chosen = usable[idx];
  return {
    sentenceIndex: chosen.sentenceIndex,
    masked: chosen.extracted.masked,
    blank: chosen.extracted.blank,
    translation: chosen.s.translation,
    hint: chosen.s.hint,
  };
}

/**
 * Parse editor input: one sentence per line, blank marked ⟦…⟧, optional
 * " :: translation" suffix (spaced, so "std::vector" survives). Returns
 * sentences or a per-line error.
 */
export function parseClozeLines(raw: string): { sentences: ClozeSentence[]; error: string | null } {
  const sentences: ClozeSentence[] = [];
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { sentences: [], error: 'Add at least one sentence.' };
  for (const [i, line] of lines.entries()) {
    const sepIdx = line.indexOf(' :: ');
    const text = (sepIdx === -1 ? line : line.slice(0, sepIdx)).trim();
    const translation = sepIdx === -1 ? undefined : line.slice(sepIdx + 4).trim();
    if (extractBlank({ text }) === null) {
      return {
        sentences: [],
        error: `Line ${i + 1}: mark a non-empty blank with ⟦double brackets⟧, e.g. "The cat sat ⟦on⟧ the mat."`,
      };
    }
    sentences.push({ text, ...(translation ? { translation } : {}) });
  }
  return { sentences, error: null };
}

/** Compact display text for previews/snapshots. */
export function clozeSummary(v: ClozeSentence[]): string {
  return v.map((s) => revealBlank(s.text)).join(' / ');
}
