import { LEGACY_GENERATION, nextRevision, sameVersion } from '@/engine/revision';
import { db } from '@/db/db';
import { newId } from '@/engine/ids';
import {
  diffItemType,
  migrateFieldValues,
  pruneTemplateMap,
  studyStatus,
  type TypeDiff,
} from '@/engine/typeDesign';
import type { Card, ItemType } from '@/engine/types';
import { recomputeUnlocks } from './gating';
import { deleteItem } from '@/db/repo/items';
import { assertItemContent, assertValidItemType } from '@/engine/contentValidation';
import { collectMediaIds, deleteOrphanMedia } from './media';
import { StudyConflict } from './studyRevision';
import { recheckPending } from './proposals';

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
        .join(
          ', ',
        )} and returns to the lesson queue to learn it. Existing cards keep their schedule.`,
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
    if (c.from === 'image' || c.from === 'audio' || c.to === 'image' || c.to === 'audio') {
      lines.push(
        'Nonempty media values must be explicitly cleared or replaced before changing this field kind.',
      );
    }
    if (c.from === 'clozeSentences') {
      lines.push(
        'Sentence translations and hints must be preserved in another field before conversion; otherwise the change is refused.',
      );
    }
  }
  return lines;
}

export async function saveItemTypeEdit(
  draft: ItemType,
  now: number,
  opts: { create?: boolean } = {},
): Promise<SaveTypeResult> {
  return db.transaction(
    'rw',
    [
      db.itemTypes,
      db.items,
      db.cards,
      db.reviewLogs,
      db.courses,
      db.ladders,
      db.media,
      db.cardTombstones,
      db.proposals,
    ],
    async () => {
      const prev = await db.itemTypes.get(draft.id);
      if (!(await db.courses.get(draft.courseId))) throw new Error('Course not found.');
      assertValidItemType(
        draft,
        await db.itemTypes.where('courseId').equals(draft.courseId).toArray(),
      );
      if (!prev) {
        if (!opts.create || draft.rev !== 0)
          throw new StudyConflict('This item type was deleted. Reload the course.');
        await db.itemTypes.add({ ...draft, rev: 0, updatedAt: now });
        await recheckPending(draft.courseId, now);
        return { cardsAdded: 0, cardsRemoved: 0, itemsTouched: 0 };
      }
      if (prev.courseId !== draft.courseId || !sameVersion(prev, draft))
        throw new StudyConflict('This item type changed. Reload the designer before saving.');
      const diff = diffItemType(prev, draft);
      await db.itemTypes.put({ ...draft, rev: nextRevision(prev.rev), updatedAt: now });

      const items = await db.items.where('typeId').equals(draft.id).toArray();
      const removedTemplates = new Set(diff.removedTemplateIds);
      let cardsAdded = 0;
      let cardsRemoved = 0;
      const discardedMedia: string[] = [];

      const needsItemWrite =
        diff.removedFieldIds.length > 0 ||
        diff.kindChanges.length > 0 ||
        diff.removedTemplateIds.length > 0 ||
        diff.addedTemplates.length > 0 ||
        prev.fields.length !== draft.fields.length;

      const cardsChange = removedTemplates.size > 0 || diff.addedTemplates.length > 0;

      for (const item of items) {
        let fieldValues;
        try {
          fieldValues = assertItemContent(
            migrateFieldValues(item.fieldValues, prev.fields, draft.fields),
            draft,
          );
        } catch (err) {
          throw new Error(
            `Item ${item.id}: ${err instanceof Error ? err.message : 'content cannot be converted'}. No changes were saved.`,
          );
        }
        const retainedMedia = new Set(collectMediaIds({ ...item, fieldValues }, draft));
        discardedMedia.push(...collectMediaIds(item, prev).filter((id) => !retainedMedia.has(id)));
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
          const oldGhosts = (
            await db.cardTombstones.where('itemId').equals(item.id).toArray()
          ).filter((c) => removedTemplates.has(c.templateId));
          await db.reviewLogs.bulkDelete(oldGhosts.map((c) => c.logId));
          await db.cardTombstones.bulkDelete(oldGhosts.map((c) => c.id));
          // Graduated ghost history is owned by item/template, not a live card.
          const history = await db.reviewLogs.where('itemId').equals(item.id).toArray();
          await db.reviewLogs.bulkDelete(
            history
              .filter((l) => l.cardMeta && removedTemplates.has(l.cardMeta.templateId))
              .map((l) => l.id),
          );
        }

        if (diff.addedTemplates.length > 0) {
          const fresh: Card[] = diff.addedTemplates.map((tpl) => ({
            generation: LEGACY_GENERATION,
            rev: 0,
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

        const added = new Set(diff.addedTemplates.map((t) => t.id));
        await db.cards
          .where('itemId')
          .equals(item.id)
          .filter((c) => !added.has(c.templateId))
          .modify((c) => {
            c.rev = nextRevision(c.rev);
            c.updatedAt = now;
          });

        if (needsItemWrite) {
          await db.items.put({
            ...item,
            rev: nextRevision(item.rev),
            fieldValues,
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

      await recomputeUnlocks(draft.courseId, now);
      await deleteOrphanMedia(discardedMedia);
      await recheckPending(draft.courseId, now);
      return { cardsAdded, cardsRemoved, itemsTouched: items.length };
    },
  );
}

/** A fresh front→back type the user can rename and reshape in the designer. */
export function makeBlankItemType(courseId: string, now: number): ItemType {
  const front = { id: newId(), name: 'Front', kind: 'text' as const };
  const back = { id: newId(), name: 'Back', kind: 'text' as const };
  const type: ItemType = {
    generation: LEGACY_GENERATION,
    rev: 0,
    id: newId(),
    courseId,
    name: 'New type',
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
  return type;
}

/** Explicit creation convenience; the designer should save its local draft. */
export async function createBlankItemType(courseId: string, now: number): Promise<ItemType> {
  return db.transaction('rw', [db.itemTypes, db.courses, db.proposals, db.items], async () => {
    if (!(await db.courses.get(courseId))) throw new Error('Course not found.');
    const existing = await db.itemTypes.where('courseId').equals(courseId).toArray();
    const taken = new Set(existing.map((t) => t.name.trim().toLowerCase()));
    const type = makeBlankItemType(courseId, now);
    for (let n = 2; taken.has(type.name.toLowerCase()); n++) type.name = `New type ${n}`;
    await db.itemTypes.add(type);
    await recheckPending(courseId, now);
    return type;
  });
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
  return db.transaction('rw', db.tables, async () => {
    const type = await db.itemTypes.get(typeId);
    if (!type) return { itemsDeleted: 0 };
    const remaining = await db.itemTypes.where('courseId').equals(type.courseId).count();
    if (remaining <= 1) throw new Error('a course needs at least one item type');
    const course = await db.courses.get(type.courseId);
    if (
      course?.levelConfig?.gateTypeIds.length === 1 &&
      course.levelConfig.gateTypeIds[0] === typeId
    ) {
      throw new Error(
        'This is the only selected gate type. Choose another gate type, or choose all types in course settings, before deleting it.',
      );
    }

    const itemIds = await db.items.where('typeId').equals(typeId).primaryKeys();
    if (itemIds.length > 0 && !opts.withItems) {
      throw new Error(
        `${itemIds.length} item(s) still use "${type.name}" — delete or re-type them first.`,
      );
    }
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
    await recheckPending(type.courseId, now);
    return { itemsDeleted: itemIds.length };
  });
}
