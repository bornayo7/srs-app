import { db } from '@/db/db';
import { newId } from '@/engine/ids';
import {
  diffItemType,
  migrateFieldValues,
  pruneTemplateMap,
  studyStatus,
  validateItemType,
  type TypeDiff,
} from '@/engine/typeDesign';
import type { Card, ItemType } from '@/engine/types';
import { recomputeUnlocks } from './gating';
import { deleteItem } from '@/db/repo/items';

/**
 * Saving an item-type edit is a schema migration for every item of that type:
 * added templates need a card per item, removed templates take their cards and
 * history with them, removed fields drop their stored values, and a changed
 * field kind converts them. All of it in one transaction — a half-applied type
 * edit would leave cards pointing at templates that no longer exist.
 */

export interface SaveTypeResult {
  cardsAdded: number;
  cardsRemoved: number;
  itemsTouched: number;
}

/** What saving this draft would do — shown in the designer before the user commits. */
export function describeTypeImpact(diff: TypeDiff, itemCount: number): string[] {
  const lines: string[] = [];
  if (diff.addedTemplates.length > 0) {
    lines.push(
      `+ ${diff.addedTemplates.length * itemCount} new card(s) — every item gets ${diff.addedTemplates
        .map((t) => `"${t.name}"`)
        .join(', ')} and returns to the lesson queue to learn it. Existing cards keep their schedule.`,
    );
  }
  if (diff.removedTemplateIds.length > 0) {
    lines.push(
      `− ${diff.removedTemplateIds.length * itemCount} card(s) and their review history are deleted permanently.`,
    );
  }
  if (diff.removedFieldIds.length > 0) {
    lines.push(`− Field values are deleted from ${itemCount} item(s).`);
  }
  for (const c of diff.kindChanges) {
    lines.push(`↻ A field changes ${c.from} → ${c.to}; existing values are converted.`);
  }
  return lines;
}

export async function saveItemTypeEdit(draft: ItemType, now: number): Promise<SaveTypeResult> {
  const issues = validateItemType(draft);
  if (issues.length > 0) {
    throw new Error(issues.map((i) => `${i.path}: ${i.message}`).join(' · '));
  }

  const result = await db.transaction(
    'rw',
    [db.itemTypes, db.items, db.cards, db.reviewLogs],
    async () => {
      const prev = await db.itemTypes.get(draft.id);
      if (!prev) throw new Error('item type not found');
      const diff = diffItemType(prev, draft);
      await db.itemTypes.put({ ...draft, updatedAt: now });

      const items = await db.items.where('typeId').equals(draft.id).toArray();
      const removedTemplates = new Set(diff.removedTemplateIds);
      let cardsAdded = 0;
      let cardsRemoved = 0;

      const needsItemWrite =
        diff.removedFieldIds.length > 0 ||
        diff.kindChanges.length > 0 ||
        diff.removedTemplateIds.length > 0 ||
        diff.addedTemplates.length > 0 ||
        prev.fields.length !== draft.fields.length;

      const cardsChange = removedTemplates.size > 0 || diff.addedTemplates.length > 0;

      for (const item of items) {
        // cards first: the item's status depends on what it ends up holding
        if (removedTemplates.size > 0) {
          const cards = await db.cards.where('itemId').equals(item.id).toArray();
          const doomed = cards.filter((c) => removedTemplates.has(c.templateId));
          if (doomed.length > 0) {
            const ids = doomed.map((c) => c.id);
            await db.reviewLogs.where('cardId').anyOf(ids).delete();
            await db.cards.bulkDelete(ids);
            cardsRemoved += ids.length;
          }
        }

        if (diff.addedTemplates.length > 0) {
          const fresh: Card[] = diff.addedTemplates.map((tpl) => ({
            id: newId(),
            itemId: item.id,
            courseId: item.courseId,
            templateId: tpl.id,
            state: 'new' as const,
            srs: null,
            stats: { reviews: 0, correct: 0, lapses: 0 },
            updatedAt: now,
          }));
          await db.cards.bulkAdd(fresh);
          cardsAdded += fresh.length;
        }

        if (needsItemWrite) {
          await db.items.put({
            ...item,
            fieldValues: migrateFieldValues(item.fieldValues, prev.fields, draft.fields),
            synonyms: pruneTemplateMap(item.synonyms, diff.removedTemplateIds),
            blockList: pruneTemplateMap(item.blockList, diff.removedTemplateIds),
            guidance: pruneTemplateMap(item.guidance, diff.removedTemplateIds),
            ...(cardsChange
              ? {
                  status: studyStatus(
                    item.status,
                    (await db.cards.where('itemId').equals(item.id).toArray()).filter(
                      (c) => !c.isGhost,
                    ),
                  ),
                }
              : {}),
            updatedAt: now,
          });
        }
      }

      return { cardsAdded, cardsRemoved, itemsTouched: items.length, courseId: draft.courseId };
    },
  );

  // Removing a template can complete an item's pass (its last unpassed card is
  // gone); adding one can't un-pass it (passedAt is sticky) but the gate tally
  // still wants refreshing. Runs after commit — recomputeUnlocks opens its own
  // wider transaction, which Dexie forbids nesting inside a narrower one.
  await recomputeUnlocks(result.courseId, now);
  return result;
}

/** A fresh front→back type the user can rename and reshape in the designer. */
export async function createBlankItemType(courseId: string, now: number): Promise<ItemType> {
  const existing = await db.itemTypes.where('courseId').equals(courseId).toArray();
  const taken = new Set(existing.map((t) => t.name.toLowerCase()));
  let name = 'New type';
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `New type ${n}`;

  const front = { id: newId(), name: 'Front', kind: 'text' as const };
  const back = { id: newId(), name: 'Back', kind: 'text' as const };
  const type: ItemType = {
    id: newId(),
    courseId,
    name,
    color: '#8b5cf6',
    icon: '📇',
    fields: [front, back],
    templates: [
      {
        id: newId(),
        name: 'Recall',
        promptFieldIds: [front.id],
        answerFieldId: back.id,
        hintFieldIds: [],
        grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
      },
    ],
    updatedAt: now,
  };
  await db.itemTypes.add(type);
  return type;
}

/**
 * Delete a type. Refuses while items still use it unless `withItems` is set —
 * orphaned items can't render and would haunt the lesson queue forever.
 */
export async function deleteItemType(
  typeId: string,
  now: number,
  opts: { withItems?: boolean } = {},
): Promise<{ itemsDeleted: number }> {
  const type = await db.itemTypes.get(typeId);
  if (!type) return { itemsDeleted: 0 };
  const remaining = await db.itemTypes.where('courseId').equals(type.courseId).count();
  if (remaining <= 1) throw new Error('a course needs at least one item type');

  const itemIds = await db.items.where('typeId').equals(typeId).primaryKeys();
  if (itemIds.length > 0 && !opts.withItems) {
    throw new Error(
      `${itemIds.length} item(s) still use "${type.name}" — delete or re-type them first.`,
    );
  }
  // deleteItem scrubs prereq edges and re-settles gating; it opens its own
  // transaction per item, so it must run before we touch the type row
  for (const id of itemIds) await deleteItem(id as string, now);

  await db.transaction('rw', [db.itemTypes, db.courses], async () => {
    await db.itemTypes.delete(typeId);
    const course = await db.courses.get(type.courseId);
    // a deleted gate type would silently stall level-ups
    if (course?.levelConfig?.gateTypeIds.includes(typeId)) {
      await db.courses.put({
        ...course,
        levelConfig: {
          ...course.levelConfig,
          gateTypeIds: course.levelConfig.gateTypeIds.filter((id) => id !== typeId),
        },
        updatedAt: now,
      });
    }
  });
  await recomputeUnlocks(type.courseId, now);
  return { itemsDeleted: itemIds.length };
}
