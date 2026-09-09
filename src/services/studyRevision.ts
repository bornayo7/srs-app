import { db } from '@/db/db';
import type { Card, Item, ItemType, ReviewLog } from '@/engine/types';

export interface StudyRevision {
  cardRev: number;
  itemRev: number;
  typeRev: number;
  cardGeneration: string;
  itemGeneration: string;
  typeGeneration: string;
}

export class StudyConflict extends Error {
  constructor(message = 'This card changed in another action. Reload it before continuing.') {
    super(message);
    this.name = 'StudyConflict';
  }
}

export function studyRevision(card: Card, item: Item, type: ItemType): StudyRevision {
  return {
    cardRev: card.rev,
    itemRev: item.rev,
    typeRev: type.rev,
    cardGeneration: card.generation,
    itemGeneration: item.generation,
    typeGeneration: type.generation,
  };
}

/** Called inside the owning write transaction, never as a preflight check. */
export async function requireStudyRevision(card: Card, expected: StudyRevision) {
  const item = await db.items.get(card.itemId);
  const type = item && (await db.itemTypes.get(item.typeId));
  if (
    !item ||
    !type ||
    item.courseId !== card.courseId ||
    type.courseId !== card.courseId ||
    !type.templates.some((t) => t.id === card.templateId)
  ) {
    throw new StudyConflict('The content for this card no longer exists. Reload the session.');
  }
  if (
    !expected ||
    !card.generation ||
    !item.generation ||
    !type.generation ||
    card.rev !== expected.cardRev ||
    item.rev !== expected.itemRev ||
    type.rev !== expected.typeRev ||
    card.generation !== expected.cardGeneration ||
    item.generation !== expected.itemGeneration ||
    type.generation !== expected.typeGeneration
  ) {
    throw new StudyConflict();
  }
  if (card.isGhost) {
    const parent = card.parentCardId && (await db.cards.get(card.parentCardId));
    if (
      !parent ||
      parent.isGhost ||
      parent.itemId !== card.itemId ||
      parent.courseId !== card.courseId ||
      parent.templateId !== card.templateId
    ) {
      throw new StudyConflict(
        'This drill no longer has its original question. Reload the session.',
      );
    }
  }
  return { item, type };
}

export async function undoContentStillMatches(log: ReviewLog): Promise<boolean> {
  if (
    log.appliedRev === undefined ||
    log.itemRev === undefined ||
    log.typeRev === undefined ||
    !log.appliedGeneration ||
    !log.itemGeneration ||
    !log.typeGeneration
  )
    return false;
  const item = await db.items.get(log.itemId);
  const type = item && (await db.itemTypes.get(item.typeId));
  return (
    !!item &&
    !!type &&
    item.courseId === log.courseId &&
    type.courseId === log.courseId &&
    item.rev === log.itemRev &&
    type.rev === log.typeRev &&
    item.generation === log.itemGeneration &&
    type.generation === log.typeGeneration &&
    !!log.cardMeta &&
    type.templates.some((t) => t.id === log.cardMeta!.templateId)
  );
}
