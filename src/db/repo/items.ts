import { db } from '../db';
import { newId } from '@/engine/ids';
import { initialStatusFor } from '@/engine/gating';
import { recomputeUnlocks } from '@/services/gating';
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
  return db.transaction('rw', [db.items, db.cards, db.itemTypes, db.courses], async () => {
    const itemType = await db.itemTypes.get(input.typeId);
    if (!itemType) throw new Error(`item type not found: ${input.typeId}`);

    const level = input.level ?? 1;
    const prereqIds = (input.prereqIds ?? []).filter((id) => id.length > 0);
    // gating decides whether this starts in the lesson pool or locked
    const course = await db.courses.get(input.courseId);
    const prereqs = prereqIds.length > 0 ? await db.items.bulkGet(prereqIds) : [];
    const missing = prereqIds.filter((_, i) => !prereqs[i]);
    if (missing.length > 0) {
      // a dangling prereq would lock this item forever with no visible cause
      throw new Error(`prerequisite item(s) not found: ${missing.join(', ')}`);
    }
    const prereqsAllPassed = prereqs.every((p) => p?.passedAt != null);
    // flat courses have no level-up path, so their level numbers must not gate
    const levelCeiling =
      course?.levelMode === 'levels' ? course.currentLevel : Number.MAX_SAFE_INTEGER;
    const status = initialStatusFor(level, prereqIds, levelCeiling, prereqsAllPassed);

    const item: Item = {
      id: newId(),
      courseId: input.courseId,
      typeId: input.typeId,
      level,
      fieldValues: input.fieldValues,
      prereqIds,
      status,
      unlockedAt: status === 'locked' ? null : now,
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

export async function deleteItem(itemId: string, now = Date.now()): Promise<void> {
  const item = await db.items.get(itemId);
  await db.transaction('rw', [db.items, db.cards, db.reviewLogs], async () => {
    const cardIds = await db.cards.where('itemId').equals(itemId).primaryKeys();
    if (cardIds.length > 0) await db.reviewLogs.where('cardId').anyOf(cardIds).delete();
    await db.cards.where('itemId').equals(itemId).delete();
    await db.items.delete(itemId);
    // a dangling prereq can never pass, so dependents would stay locked forever
    const dependents = await db.items.where('prereqIds').equals(itemId).toArray();
    for (const dep of dependents) {
      await db.items.put({
        ...dep,
        prereqIds: dep.prereqIds.filter((id) => id !== itemId),
        updatedAt: now,
      });
    }
  });
  // resettle after the transaction commits — recomputeUnlocks opens its own
  // (wider) transaction, which Dexie forbids nesting inside a narrower one
  if (item) await recomputeUnlocks(item.courseId, now);
}

/** Items waiting in the lesson pool for a course, oldest first within a level. */
export async function lessonPool(courseId: string): Promise<Item[]> {
  const items = await db.items.where('[courseId+status]').equals([courseId, 'lesson']).toArray();
  return items.sort((a, b) => a.level - b.level || a.createdAt - b.createdAt);
}
