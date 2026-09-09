import { db } from '../db';
import { newId } from '@/engine/ids';
import { initialStatusFor, wouldCycle } from '@/engine/gating';
import { recomputeUnlocks } from '@/services/gating';
import { collectMediaIds, deleteOrphanMedia } from '@/services/media';
import type { Card, FieldValue, Item, ItemType } from '@/engine/types';
import { assertItemContent } from '@/engine/contentValidation';
import { LEGACY_GENERATION, nextRevision, sameVersion, type Versioned } from '@/engine/revision';

export interface CreateItemInput {
  courseId: string;
  typeId: string;
  expectedType?: Versioned;
  fieldValues: Record<string, FieldValue>;
  level?: number;
  prereqIds?: string[];
  synonyms?: Record<string, string[]>;
  blockList?: Record<string, string[]>;
  guidance?: Item['guidance'];
  note?: string;
}

/** Create an item plus one card per template on its type. */
export async function createItem(input: CreateItemInput, now: number): Promise<Item> {
  return db.transaction(
    'rw',
    [db.items, db.cards, db.itemTypes, db.courses, db.media],
    async () => {
      const itemType = await db.itemTypes.get(input.typeId);
      if (!itemType) throw new Error(`item type not found: ${input.typeId}`);
      if (itemType.courseId !== input.courseId)
        throw new Error('item type belongs to another course');
      if (input.expectedType && !sameVersion(itemType, input.expectedType))
        throw new Error(
          'This item type changed while the draft was open. Reload it before saving.',
        );
      const fieldValues = assertItemContent(input.fieldValues, itemType);
      await assertMediaReferences(fieldValues, itemType);
      assertTemplateMaps(itemType, input);

      const level = input.level ?? 1;
      if (!Number.isInteger(level) || level < 1)
        throw new Error('level must be a positive whole number');
      const prereqIds = [...new Set((input.prereqIds ?? []).filter((id) => id.length > 0))];
      // gating decides whether this starts in the lesson pool or locked
      const course = await db.courses.get(input.courseId);
      if (!course) throw new Error('course not found');
      const prereqs = prereqIds.length > 0 ? await db.items.bulkGet(prereqIds) : [];
      const missing = prereqIds.filter((_, i) => !prereqs[i]);
      if (missing.length > 0) {
        // a dangling prereq would lock this item forever with no visible cause
        throw new Error(`prerequisite item(s) not found: ${missing.join(', ')}`);
      }
      if (prereqs.some((parent) => parent?.courseId !== input.courseId))
        throw new Error('prerequisites must belong to this course');
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
        fieldValues,
        prereqIds,
        status,
        unlockedAt: status === 'locked' ? null : now,
        passedAt: null,
        synonyms: input.synonyms ?? {},
        blockList: input.blockList ?? {},
        guidance: input.guidance ?? {},
        note: input.note ?? '',
        createdAt: now,
        updatedAt: now,
        rev: 0,
        generation: LEGACY_GENERATION,
      };
      await db.items.add(item);
      await db.cards.bulkAdd(buildCardsForItem(item, itemType, now));
      return item;
    },
  );
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
    rev: 0,
    generation: LEGACY_GENERATION,
  }));
}

export async function updateItem(item: Item, now: number): Promise<void> {
  await saveItemEdit(item, now);
}

/** The fields the item editor owns. Everything else is derived state. */
export interface ItemEdit {
  id: string;
  rev: number;
  generation: string;
  fieldValues: Record<string, FieldValue>;
  prereqIds: string[];
  level: number;
  synonyms: Record<string, string[]>;
  blockList: Record<string, string[]>;
  guidance: Item['guidance'];
  note: string;
}

/**
 * The item editor's save path: validates the prerequisite edges (a cycle would
 * lock both items forever), writes the item, frees media it no longer points
 * at, and re-settles gating because level/prereq edits change what's unlocked.
 *
 * Only the editable fields are taken from the caller — status, passedAt and
 * card-derived state are re-read here, so a long-open editor can't resurrect
 * stale progress (the SRS tab writes to the same item while it's open).
 */
export async function saveItemEdit(edit: ItemEdit, now: number): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    const prev = await db.items.get(edit.id);
    if (!prev) throw new Error('item not found');
    if (!sameVersion(prev, edit))
      throw new Error('This item changed elsewhere. Reopen it before saving your edits.');
    const itemType = await db.itemTypes.get(prev.typeId);
    if (!itemType || itemType.courseId !== prev.courseId)
      throw new Error('item type no longer exists in this course');
    const fieldValues = assertItemContent(edit.fieldValues, itemType);
    await assertMediaReferences(fieldValues, itemType);
    assertTemplateMaps(itemType, edit);
    if (!Number.isInteger(edit.level) || edit.level < 1)
      throw new Error('level must be a positive whole number');

    const prereqIds = [...new Set(edit.prereqIds.filter((id) => id && id !== edit.id))];
    const siblings = (await db.items.where('courseId').equals(prev.courseId).toArray()).filter(
      (i) => i.id !== edit.id,
    );
    const known = new Set(siblings.map((i) => i.id));
    const missing = prereqIds.filter((id) => !known.has(id));
    if (missing.length > 0) throw new Error('a selected prerequisite no longer exists');
    if (wouldCycle(siblings, edit.id, prereqIds)) {
      throw new Error('those prerequisites form a loop — the items would lock each other forever');
    }

    const next: Item = {
      ...prev,
      fieldValues,
      synonyms: edit.synonyms,
      blockList: edit.blockList,
      guidance: edit.guidance,
      note: edit.note,
      prereqIds,
      level: Math.max(1, edit.level),
      updatedAt: now,
      rev: nextRevision(prev.rev),
    };
    await db.items.put(next);
    await db.cards
      .where('itemId')
      .equals(prev.id)
      .modify((card) => {
        card.rev = nextRevision(card.rev);
        card.updatedAt = now;
      });

    if (itemType) {
      const before = collectMediaIds(prev, itemType);
      const after = new Set(collectMediaIds(next, itemType));
      await deleteOrphanMedia(before.filter((id) => !after.has(id)));
    }
    await recomputeUnlocks(prev.courseId, now);
  });
}

export async function deleteItem(itemId: string, now = Date.now()): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    const item = await db.items.get(itemId);
    const itemType = item ? await db.itemTypes.get(item.typeId) : undefined;
    const mediaIds = item && itemType ? collectMediaIds(item, itemType) : [];
    await db.reviewLogs.where('itemId').equals(itemId).delete();
    await db.cardTombstones.where('itemId').equals(itemId).delete();
    await db.cards.where('itemId').equals(itemId).delete();
    await db.items.delete(itemId);
    // a dangling prereq can never pass, so dependents would stay locked forever
    const dependents = await db.items.where('prereqIds').equals(itemId).toArray();
    for (const dep of dependents) {
      await db.items.put({
        ...dep,
        prereqIds: dep.prereqIds.filter((id) => id !== itemId),
        updatedAt: now,
        rev: nextRevision(dep.rev),
      });
    }
    if (item) await recomputeUnlocks(item.courseId, now);
    await deleteOrphanMedia(mediaIds);
  });
}

export async function assertMediaReferences(
  values: Record<string, FieldValue>,
  type: ItemType,
): Promise<void> {
  for (const field of type.fields) {
    if (field.kind !== 'image' && field.kind !== 'audio') continue;
    const id = values[field.id];
    if (typeof id !== 'string' || !id) continue;
    const asset = await db.media.get(id);
    if (!asset || !asset.mimeType.startsWith(`${field.kind}/`))
      throw new Error(
        `"${field.name}" references missing or incompatible media. Pick the file again.`,
      );
  }
}

function assertTemplateMaps(
  type: ItemType,
  candidate: Pick<CreateItemInput, 'synonyms' | 'blockList' | 'guidance'>,
): void {
  const ids = new Set(type.templates.map((template) => template.id));
  for (const map of [candidate.synonyms, candidate.blockList, candidate.guidance]) {
    if (map !== undefined && (typeof map !== 'object' || map === null || Array.isArray(map)))
      throw new Error('Answer settings must be named template maps.');
    for (const key of Object.keys(map ?? {}))
      if (!ids.has(key)) throw new Error(`Answer settings reference unknown template "${key}"`);
  }
  for (const map of [candidate.synonyms, candidate.blockList]) {
    for (const answers of Object.values(map ?? {})) {
      if (!Array.isArray(answers) || answers.some((answer) => typeof answer !== 'string'))
        throw new Error('Synonyms and blocked answers must be lists of text.');
    }
  }
  for (const answers of Object.values(candidate.guidance ?? {})) {
    if (
      !Array.isArray(answers) ||
      answers.some(
        (answer) =>
          typeof answer !== 'object' ||
          answer === null ||
          typeof answer.text !== 'string' ||
          typeof answer.message !== 'string',
      )
    )
      throw new Error('Guidance must contain an answer and a message.');
  }
}

/** Items waiting in the lesson pool for a course, oldest first within a level. */
export async function lessonPool(courseId: string): Promise<Item[]> {
  const items = await db.items.where('[courseId+status]').equals([courseId, 'lesson']).toArray();
  return items.sort((a, b) => a.level - b.level || a.createdAt - b.createdAt);
}
