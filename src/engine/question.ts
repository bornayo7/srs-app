import type { Card, CardTemplate, Item, ItemType } from './types';
import { buildMatchContext } from './grading/context';
import { pickClozeSentence, type ClozePick } from './grading/cloze';
import { containsKana, isKanaTypeable, normalizeAnswer } from './grading/normalize';
import { matchTypedAnswer, type MatchContext, type MatchVerdict } from './grading/match';
import type { ChoiceOption } from './grading/choice';
import { validateItemContent } from './contentValidation';

/** The content of one question, independent of any React store or session mode. */
export interface SessionEntry {
  card: Card;
  item: Item;
  itemType: ItemType;
  template: CardTemplate;
  cloze?: ClozePick;
  choices?: ChoiceOption[];
}

export interface QuestionProblem {
  cardId: string;
  itemId: string;
  message: string;
}

export type Feedback =
  | { kind: 'correct'; typo: boolean; toStage: number | null; burned: boolean }
  | { kind: 'incorrect'; accepted: string[] }
  | { kind: 'retry'; reason: string; message?: string; nonce: number };

/** A learner's explicit grade stays provisional until they continue. */
export function overrideFeedback(entry: SessionEntry, correct: boolean): Feedback {
  return correct
    ? { kind: 'correct', typo: false, toStage: null, burned: false }
    : { kind: 'incorrect', accepted: entryMatchContext(entry).accepted };
}

/** Practice gets the same verdicts as review, without a persistence outcome. */
export function practiceFeedback(entry: SessionEntry, response: string): Feedback {
  const result = gradeQuestion(entry, response);
  if (result.verdict === 'retry')
    return { kind: 'retry', reason: result.reason, message: result.message, nonce: Date.now() };
  if (result.verdict === 'incorrect')
    return { kind: 'incorrect', accepted: entryMatchContext(entry).accepted };
  return {
    kind: 'correct',
    typo: result.verdict === 'correctWithTypo',
    toStage: null,
    burned: false,
  };
}

export function entryMatchContext(entry: SessionEntry): MatchContext {
  if (!entry.cloze) return buildMatchContext(entry.item, entry.itemType, entry.template);
  return {
    accepted: [entry.cloze.blank, ...(entry.item.synonyms[entry.template.id] ?? [])],
    blocked: entry.item.blockList[entry.template.id] ?? [],
    guidance: entry.item.guidance[entry.template.id] ?? [],
    siblingAccepted: [],
    // Keyboard conversion is a presentation choice, never an alphabet guard.
    answerLang: 'any',
    typoTolerance: !containsKana(entry.cloze.blank),
  };
}

export function entryAnswerLang(entry: SessionEntry): 'latin' | 'kana' {
  if (entry.template.grading.mode === 'typed') return entry.template.grading.answerLang;
  const answers = entryMatchContext(entry).accepted.filter((a) => normalizeAnswer(a));
  return answers.length > 0 && answers.every(isKanaTypeable) ? 'kana' : 'latin';
}

export function withClozePick<T extends Omit<SessionEntry, 'cloze'>>(
  entry: T,
  seed: number,
): T & { cloze?: ClozePick } {
  const cloze = pickClozeSentence(entry.item, entry.template, seed, entry.card.stats.reviews);
  return cloze ? { ...entry, cloze } : entry;
}

export function questionProblem(entry: SessionEntry): QuestionProblem | null {
  const fail = (message: string): QuestionProblem => ({
    cardId: entry.card.id,
    itemId: entry.item.id,
    message,
  });
  const mode = entry.template.grading.mode;
  if (!['typed', 'choice', 'sentenceCloze'].includes(mode))
    return fail('This question uses an unsupported answer mode. Edit its template.');
  const content = validateItemContent(entry.item.fieldValues, {
    ...entry.itemType,
    templates: [entry.template],
  });
  if (content.problems.length) return fail(content.problems.map((p) => p.message).join(' '));
  if (mode === 'sentenceCloze' && !entry.cloze)
    return fail('Add a valid marked sentence before studying this item.');
  if (!entryMatchContext(entry).accepted.some((a) => normalizeAnswer(a)))
    return fail('This question needs an answer. Edit the item to continue studying it.');
  const hasPrompt = entry.template.promptFieldIds.some((id) => {
    const value = entry.item.fieldValues[id];
    return typeof value === 'string'
      ? value.trim().length > 0
      : Array.isArray(value) && value.length > 0;
  });
  if (!entry.cloze && !hasPrompt)
    return fail('This question needs prompt content. Edit the item to continue studying it.');
  return null;
}

export function gradeQuestion(entry: SessionEntry, response: string): MatchVerdict {
  if (entry.choices) {
    const option = entry.choices.find((o) => normalizeAnswer(o.text) === normalizeAnswer(response));
    if (option)
      return option.correct
        ? { verdict: 'correct', matched: option.text }
        : { verdict: 'incorrect' };
  }
  return matchTypedAnswer(response, entryMatchContext(entry));
}
