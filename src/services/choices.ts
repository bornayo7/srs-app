import { db } from '@/db/db';
import { buildMatchContext } from '@/engine/grading/context';
import { matchTypedAnswer } from '@/engine/grading/match';
import {
  buildChoiceOptions,
  MIN_CHOICE_OPTIONS,
  type ChoiceOption,
} from '@/engine/grading/choice';
import type { CardTemplate, FieldValue, Item, ItemType } from '@/engine/types';

/**
 * Distractors for a multiple-choice card: the same question asked of the
 * item's siblings. Items near its level are preferred, because a level-1
 * option next to a level-20 one gives the answer away.
 */

export interface ChoiceCache {
  byType: Map<string, Item[]>;
}

export const newChoiceCache = (): ChoiceCache => ({ byType: new Map() });

async function itemsOfType(typeId: string, cache?: ChoiceCache): Promise<Item[]> {
  const cached = cache?.byType.get(typeId);
  if (cached) return cached;
  const items = await db.items.where('typeId').equals(typeId).toArray();
  cache?.byType.set(typeId, items);
  return items;
}

function firstText(v: FieldValue | undefined): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v) && typeof v[0] === 'string') return (v[0] as string).trim() || null;
  return null; // cloze sentences never make sense as a flat option
}

export async function buildEntryChoices(
  entry: { item: Item; itemType: ItemType; template: CardTemplate },
  seed: number,
  cache?: ChoiceCache,
): Promise<ChoiceOption[] | undefined> {
  const { item, itemType, template } = entry;
  if (template.grading.mode !== 'choice') return undefined;

  const ctx = buildMatchContext(item, itemType, template);
  const answer = ctx.accepted.find((a) => a.trim().length > 0);
  if (!answer) return undefined;

  const siblings = (await itemsOfType(itemType.id, cache)).filter(
    (i) => i.id !== item.id && i.courseId === item.courseId,
  );
  const candidates = siblings
    .map((i) => ({ level: i.level, text: firstText(i.fieldValues[template.answerFieldId]) }))
    .filter((c): c is { level: number; text: string } => c.text !== null)
    // The real grading pipeline is the fairness filter: anything it would
    // accept (a synonym, something inside the typo budget) or bounce with
    // guidance must never be offered as a wrong option.
    .filter((c) => matchTypedAnswer(c.text, ctx).verdict === 'incorrect');

  const target = template.grading.choices;
  const near = candidates.filter((c) => Math.abs(c.level - item.level) <= 1);
  const pool = near.length >= target - 1 ? near : candidates;

  const options = buildChoiceOptions(
    answer,
    pool.map((c) => c.text),
    target,
    seed,
  );
  // one lonely option is a giveaway — the caller falls back to typing
  return options.length >= MIN_CHOICE_OPTIONS ? options : undefined;
}
