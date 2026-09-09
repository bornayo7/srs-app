import { db } from '@/db/db';
import type { Card, Item, ItemType } from '@/engine/types';
import {
  questionProblem,
  withClozePick,
  type QuestionProblem,
  type SessionEntry,
} from '@/engine/question';
import { buildEntryChoices, newChoiceCache } from './choices';

/** One preparation path for reviews, lesson quizzes, and extra study. */
export async function prepareQuestions(
  cards: Card[],
  seed: number,
): Promise<{ entries: SessionEntry[]; problems: QuestionProblem[] }> {
  const items = new Map(
    (await db.items.bulkGet([...new Set(cards.map((c) => c.itemId))]))
      .filter((i): i is Item => !!i)
      .map((i) => [i.id, i]),
  );
  const types = new Map(
    (await db.itemTypes.bulkGet([...new Set([...items.values()].map((i) => i.typeId))]))
      .filter((t): t is ItemType => !!t)
      .map((t) => [t.id, t]),
  );
  const entries: SessionEntry[] = [];
  const problems: QuestionProblem[] = [];
  const cache = newChoiceCache();
  for (const [i, card] of cards.entries()) {
    const item = items.get(card.itemId);
    const itemType = item && types.get(item.typeId);
    const template = itemType?.templates.find((t) => t.id === card.templateId);
    if (
      !item ||
      !itemType ||
      !template ||
      item.courseId !== card.courseId ||
      itemType.courseId !== card.courseId
    ) {
      problems.push({
        cardId: card.id,
        itemId: card.itemId,
        message: 'This question no longer has matching content. Reload or repair the item.',
      });
      continue;
    }
    try {
      const entry = withClozePick({ card, item, itemType, template }, seed + i);
      const problem = questionProblem(entry);
      if (problem) {
        problems.push(problem);
        continue;
      }
      const mediaIds = template.promptFieldIds.flatMap((id) => {
        const field = itemType.fields.find((f) => f.id === id);
        return field && (field.kind === 'image' || field.kind === 'audio')
          ? [String(item.fieldValues[id])]
          : [];
      });
      if ((await db.media.bulkGet(mediaIds)).some((asset) => !asset)) {
        problems.push({
          cardId: card.id,
          itemId: item.id,
          message: 'A prompt image or audio file is missing. Replace it in the item editor.',
        });
        continue;
      }
      const choices = await buildEntryChoices(entry, seed + i, cache);
      entries.push(choices ? { ...entry, choices } : entry);
    } catch {
      problems.push({
        cardId: card.id,
        itemId: item.id,
        message: 'The stored question is incomplete. Edit it before studying.',
      });
    }
  }
  return { entries, problems };
}
