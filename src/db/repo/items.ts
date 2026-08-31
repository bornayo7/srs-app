import { db } from '../db';
import { newId } from '@/engine/ids';
import type { Card, FieldValue, Item, ItemType } from '@/engine/types';

export interface CreateItemInput {
  courseId: string;
  typeId: string;
  fieldValues: Record<string, FieldValue>;
  level?: number;
  prereqIds?: string[];
  synonyms?: Record<string, string[]>;
  note?: string;
}

/** Create an item plus one card per template on its type. */
export async function createItem(input: CreateItemInput, now: number): Promise<Item> {
  return db.transaction('rw', db.items, db.cards, db.itemTypes, async () => {
    const itemType = await db.itemTypes.get(input.typeId);
    if (!itemType) throw new Error(`item type not found: ${input.typeId}`);

    const item: Item = {
      id: newId(),
      courseId: input.courseId,
      typeId: input.typeId,
      level: input.level ?? 1,
      fieldValues: input.fieldValues,
      prereqIds: input.prereqIds ?? [],
      // P1: no gating engine yet — everything starts ready for lessons.
      status: 'lesson',
      unlockedAt: now,
      passedAt: null,
      synonyms: input.synonyms ?? {},
      blockList: {},
      guidance: {},
      note: input.note ?? '',
      createdAt: now,
      updatedAt: now,
    };
    await db.items.add(item);
    await db.cards.bulkAdd(buildCardsForItem(item, itemType, now));
    return item;
  });
}

export function buildCardsForItem(item: Item, itemType: ItemType, now: number): Card[] {
  return itemType.templates.map((tpl) => ({
    id: newId(),
    itemId: item.id,
    courseId: item.courseId,
    templateId: tpl.id,
    state: 'new' as const,
    srs: null,
    stats: { reviews: 0, correct: 0, lapses: 0 },
    updatedAt: now,
  }));
}

export async function updateItem(item: Item, now: number): Promise<void> {
  await db.items.put({ ...item, updatedAt: now });
}

export async function deleteItem(itemId: string): Promise<void> {
  await db.transaction('rw', [db.items, db.cards, db.reviewLogs], async () => {
    const cardIds = await db.cards.where('itemId').equals(itemId).primaryKeys();
    if (cardIds.length > 0) await db.reviewLogs.where('cardId').anyOf(cardIds).delete();
    await db.cards.where('itemId').equals(itemId).delete();
    await db.items.delete(itemId);
  });
}

/** Items waiting in the lesson pool for a course, oldest first within a level. */
export async function lessonPool(courseId: string): Promise<Item[]> {
  const items = await db.items.where('[courseId+status]').equals([courseId, 'lesson']).toArray();
  return items.sort((a, b) => a.level - b.level || a.createdAt - b.createdAt);
}
