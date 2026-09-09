import { db } from '@/db/db';
import { commitReview, type CommitReviewInput } from '@/services/commitReview';
import { completeLessonBatch } from '@/services/lessons';
import { studyRevision } from '@/services/studyRevision';

/** Test setup crosses the same observed-question seam as an actual study page. */
export async function teachItems(itemIds: string[], sessionId: string, now: number) {
  const taught = [];
  for (const card of await db.cards.where('itemId').anyOf(itemIds).toArray()) {
    if (card.state !== 'new' || card.isGhost) continue;
    const item = (await db.items.get(card.itemId))!;
    const type = (await db.itemTypes.get(item.typeId))!;
    taught.push({ cardId: card.id, expected: studyRevision(card, item, type) });
  }
  return completeLessonBatch(taught, sessionId, now);
}

export async function reviewCard(input: Omit<CommitReviewInput, 'expected'>) {
  const card = (await db.cards.get(input.cardId))!;
  const item = (await db.items.get(card.itemId))!;
  const type = (await db.itemTypes.get(item.typeId))!;
  return commitReview({ ...input, expected: studyRevision(card, item, type) });
}
