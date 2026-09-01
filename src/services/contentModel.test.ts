import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourse } from '@/db/repo/courses';
import { createItem, saveItemEdit } from '@/db/repo/items';
import { basicTypeSpec, createItemType, type SimpleTypeSpec } from '@/db/repo/itemTypes';
import { newId } from '@/engine/ids';
import type { Card, Course, Item, ItemType } from '@/engine/types';
import { createBlankItemType, deleteItemType, saveItemTypeEdit } from './itemTypes';
import {
  lastManualBatch,
  resetItem,
  resumeItem,
  setCardManual,
  setItemStage,
  suspendItem,
  undoManualBatch,
} from './manualSrs';
import { dueCards } from '@/db/repo/cards';
import { completeLessonBatch, nextLessonBatch } from './lessons';
import { recomputeUnlocks } from './gating';

const NOW = Date.UTC(2026, 0, 15, 10, 23);
const PASS_STAGE = 4; // classic ladder: index 4 is the Guru-equivalent

async function wipe() {
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
}
beforeEach(wipe);

/** Two-template type: one item produces a Meaning card and a Reading card. */
const twoCardSpec = (): SimpleTypeSpec => ({
  name: 'Word',
  color: '#f00',
  icon: '🈳',
  fields: [
    { name: 'Word', kind: 'text' },
    { name: 'Meaning', kind: 'text' },
    { name: 'Reading', kind: 'text' },
  ],
  templates: [
    {
      name: 'Meaning',
      promptFieldNames: ['Word'],
      answerFieldName: 'Meaning',
      grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
    },
    {
      name: 'Reading',
      promptFieldNames: ['Word'],
      answerFieldName: 'Reading',
      grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
    },
  ],
});

async function setup(spec = basicTypeSpec()): Promise<{ course: Course; type: ItemType }> {
  const course = await createCourse({ name: 'Test', ladderPresetId: 'preset-classic' }, NOW);
  const type = await createItemType(course.id, spec, NOW);
  return { course, type };
}

function values(type: ItemType, ...vals: string[]): Record<string, string> {
  return Object.fromEntries(type.fields.map((f, i) => [f.id, vals[i] ?? `v${i}`]));
}

const cardsOf = (itemId: string): Promise<Card[]> =>
  db.cards.where('itemId').equals(itemId).toArray();

describe('item-type designer — saving migrates existing content', () => {
  it('adding a template gives every existing item a new card in the lesson queue', async () => {
    const { course, type } = await setup();
    const a = await createItem(
      { courseId: course.id, typeId: type.id, fieldValues: values(type, 'Q', 'A') },
      NOW,
    );
    expect(await cardsOf(a.id)).toHaveLength(1);
    // the item is already being studied — lessons only draw from status 'lesson'
    await completeLessonBatch([a.id], 'sess', NOW);
    expect((await db.items.get(a.id))!.status).toBe('active');

    const added = {
      id: newId(),
      name: 'Reverse',
      promptFieldIds: [type.fields[1].id],
      answerFieldId: type.fields[0].id,
      hintFieldIds: [],
      grading: { mode: 'typed' as const, answerLang: 'latin' as const, typoTolerance: true },
    };
    const res = await saveItemTypeEdit(
      { ...type, templates: [...type.templates, added] },
      NOW + 1000,
    );
    expect(res).toMatchObject({ cardsAdded: 1, cardsRemoved: 0, itemsTouched: 1 });

    const cards = await cardsOf(a.id);
    expect(cards).toHaveLength(2);
    expect(cards.find((c) => c.templateId === added.id)).toMatchObject({
      state: 'new',
      srs: null,
    });
    // …so the item goes back to the lesson queue to teach it, while the
    // original card keeps the schedule it already earned
    expect((await db.items.get(a.id))!.status).toBe('lesson');
    expect(cards.find((c) => c.templateId === type.templates[0].id)!.state).toBe('review');
    expect(await nextLessonBatch(course.id, NOW + 1000)).toHaveLength(1);
  });

  it('removing that template again returns the item to active — nothing left to teach', async () => {
    const { course, type } = await setup();
    const a = await createItem(
      { courseId: course.id, typeId: type.id, fieldValues: values(type, 'Q', 'A') },
      NOW,
    );
    await completeLessonBatch([a.id], 'sess', NOW);

    const added = {
      id: newId(),
      name: 'Reverse',
      promptFieldIds: [type.fields[1].id],
      answerFieldId: type.fields[0].id,
      hintFieldIds: [],
      grading: { mode: 'typed' as const, answerLang: 'latin' as const, typoTolerance: true },
    };
    const withExtra = { ...type, templates: [...type.templates, added] };
    await saveItemTypeEdit(withExtra, NOW + 1000);
    expect((await db.items.get(a.id))!.status).toBe('lesson');

    await saveItemTypeEdit({ ...withExtra, templates: type.templates }, NOW + 2000);
    expect((await db.items.get(a.id))!.status).toBe('active');
  });

  it('removing a template deletes its cards and their review history', async () => {
    const { course, type } = await setup(twoCardSpec());
    const item = await createItem(
      { courseId: course.id, typeId: type.id, fieldValues: values(type, '水', 'water', 'mizu') },
      NOW,
    );
    const [meaning, reading] = await cardsOf(item.id);
    await setCardManual(reading.id, { kind: 'setStage', stageIndex: 2 }, NOW);
    expect(await db.reviewLogs.where('cardId').equals(reading.id).count()).toBe(1);

    const res = await saveItemTypeEdit(
      { ...type, templates: type.templates.filter((t) => t.id !== reading.templateId) },
      NOW + 1000,
    );
    expect(res.cardsRemoved).toBe(1);
    expect((await cardsOf(item.id)).map((c) => c.id)).toEqual([meaning.id]);
    expect(await db.reviewLogs.where('cardId').equals(reading.id).count()).toBe(0);
  });

  it('removing a field drops its values; changing a kind converts them', async () => {
    const { course, type } = await setup(twoCardSpec());
    const item = await createItem(
      { courseId: course.id, typeId: type.id, fieldValues: values(type, '水', 'water, aqua', 'mizu') },
      NOW,
    );
    const [word, meaning, reading] = type.fields;

    await saveItemTypeEdit(
      {
        ...type,
        // Meaning becomes a list; Reading is deleted (its template goes too)
        fields: [word, { ...meaning, kind: 'list' }],
        templates: type.templates.filter((t) => t.answerFieldId !== reading.id),
      },
      NOW + 1000,
    );

    const after = (await db.items.get(item.id))!;
    expect(after.fieldValues[meaning.id]).toEqual(['water', 'aqua']);
    expect(after.fieldValues[reading.id]).toBeUndefined();
  });

  it('refuses an invalid design and changes nothing', async () => {
    const { type } = await setup();
    const broken = {
      ...type,
      templates: [{ ...type.templates[0], promptFieldIds: [type.templates[0].answerFieldId] }],
    };
    await expect(saveItemTypeEdit(broken, NOW)).rejects.toThrow(/both prompt and answer/);
    expect((await db.itemTypes.get(type.id))!.templates[0].promptFieldIds).toEqual(
      type.templates[0].promptFieldIds,
    );
  });

  it('deleting a template can complete an item — its dependents unlock', async () => {
    const { course, type } = await setup(twoCardSpec());
    const radical = await createItem(
      { courseId: course.id, typeId: type.id, fieldValues: values(type, '一', 'one', 'ichi') },
      NOW,
    );
    const kanji = await createItem(
      {
        courseId: course.id,
        typeId: type.id,
        fieldValues: values(type, '二', 'two', 'ni'),
        prereqIds: [radical.id],
      },
      NOW,
    );
    expect((await db.items.get(kanji.id))!.status).toBe('locked');

    // pass only the Meaning card — the item is not passed while Reading lags
    const [meaning, reading] = await cardsOf(radical.id);
    await setCardManual(meaning.id, { kind: 'setStage', stageIndex: PASS_STAGE }, NOW);
    expect((await db.items.get(radical.id))!.passedAt).toBeNull();

    await saveItemTypeEdit(
      { ...type, templates: type.templates.filter((t) => t.id !== reading.templateId) },
      NOW + 1000,
    );
    expect((await db.items.get(radical.id))!.passedAt).not.toBeNull();
    expect((await db.items.get(kanji.id))!.status).toBe('lesson');
  });
});

describe('item-type lifecycle', () => {
  it('a new blank type never collides with an existing name', async () => {
    const { course } = await setup();
    const first = await createBlankItemType(course.id, NOW);
    const second = await createBlankItemType(course.id, NOW);
    expect(first.name).toBe('New type');
    expect(second.name).toBe('New type 2');
  });

  it('deleting a type refuses while items use it, and takes them along when forced', async () => {
    const { course, type } = await setup();
    const other = await createBlankItemType(course.id, NOW);
    await createItem(
      { courseId: course.id, typeId: type.id, fieldValues: values(type, 'Q', 'A') },
      NOW,
    );
    await expect(deleteItemType(type.id, NOW)).rejects.toThrow(/still use/);

    const res = await deleteItemType(type.id, NOW, { withItems: true });
    expect(res.itemsDeleted).toBe(1);
    expect(await db.items.count()).toBe(0);
    expect(await db.cards.count()).toBe(0);
    // the last remaining type is protected — a course with none is unusable
    await expect(deleteItemType(other.id, NOW)).rejects.toThrow(/at least one item type/);
  });

  it('deleting a gate type drops it from the level config instead of stalling level-ups', async () => {
    const { course, type } = await setup();
    const gate = await createBlankItemType(course.id, NOW);
    await db.courses.put({
      ...course,
      levelMode: 'levels',
      levelConfig: { gateTypeIds: [gate.id, type.id], passPercent: 90 },
    });
    await deleteItemType(gate.id, NOW);
    expect((await db.courses.get(course.id))!.levelConfig!.gateTypeIds).toEqual([type.id]);
  });
});

describe('manual SRS control', () => {
  async function seedChain(): Promise<{ course: Course; type: ItemType; a: Item; b: Item }> {
    const { course, type } = await setup();
    const a = await createItem(
      { courseId: course.id, typeId: type.id, fieldValues: values(type, 'A', 'a') },
      NOW,
    );
    const b = await createItem(
      {
        courseId: course.id,
        typeId: type.id,
        fieldValues: values(type, 'B', 'b'),
        prereqIds: [a.id],
      },
      NOW,
    );
    return { course, type, a, b };
  }

  it('setting a stage schedules the card and logs the previous state', async () => {
    const { a } = await seedChain();
    await setItemStage(a.id, 1, NOW); // classic stage 2 = 8h

    const card = (await cardsOf(a.id))[0];
    expect(card).toMatchObject({ state: 'review', srs: { kind: 'ladder', stageIndex: 1 } });
    expect(card.dueAt).toBe(Date.UTC(2026, 0, 15, 18)); // +8h, floored to the hour

    const logs = await db.reviewLogs.toArray();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ kind: 'manual', prev: { state: 'new', srs: null } });
    expect(logs[0].prev.dueAt).toBeUndefined();
  });

  it('promoting an item to the pass stage unlocks what depends on it', async () => {
    const { a, b } = await seedChain();
    expect((await db.items.get(b.id))!.status).toBe('locked');

    const res = await setItemStage(a.id, PASS_STAGE, NOW);
    expect(res.gating.itemPassed).toBe(true);
    expect(res.gating.unlockedItemIds).toEqual([b.id]);
    expect((await db.items.get(b.id))!.status).toBe('lesson');
  });

  it('resetting an item un-passes it and re-locks its queued dependents', async () => {
    const { a, b } = await seedChain();
    await setItemStage(a.id, PASS_STAGE, NOW);

    await resetItem(a.id, NOW + 1000);
    const card = (await cardsOf(a.id))[0];
    expect(card).toMatchObject({ state: 'new', srs: null });
    expect(card.dueAt).toBeUndefined();
    expect((await db.items.get(a.id))!.passedAt).toBeNull();
    expect((await db.items.get(b.id))!.status).toBe('locked');
  });

  it('undo restores the whole operation, including the pass it had cleared', async () => {
    const { a, b } = await seedChain();
    await setItemStage(a.id, PASS_STAGE, NOW);
    await resetItem(a.id, NOW + 1000);

    const batch = await lastManualBatch(a.id);
    expect(batch).not.toBeNull();
    expect(await undoManualBatch(batch!.sessionId, NOW + 2000)).toBe(1);

    const card = (await cardsOf(a.id))[0];
    expect(card).toMatchObject({ state: 'review', srs: { kind: 'ladder', stageIndex: PASS_STAGE } });
    // passedAt is re-derived from the restored cards, so the dependent reopens
    expect((await db.items.get(a.id))!.passedAt).not.toBeNull();
    expect((await db.items.get(b.id))!.status).toBe('lesson');
    expect(await db.reviewLogs.where('cardId').equals(card.id).count()).toBe(1);
  });

  it('suspending pulls a card out of reviews; resuming makes it due now', async () => {
    const { course, a } = await seedChain();
    await setItemStage(a.id, 0, NOW);
    expect(await dueCards(course.id, NOW + 5 * 60 * 60 * 1000)).toHaveLength(1);

    await suspendItem(a.id, NOW);
    const suspended = (await cardsOf(a.id))[0];
    expect(suspended.state).toBe('suspended');
    expect(suspended.dueAt).toBeUndefined();
    expect(await dueCards(course.id, NOW + 5 * 60 * 60 * 1000)).toHaveLength(0);

    await resumeItem(a.id, NOW + 60_000);
    const resumed = (await cardsOf(a.id))[0];
    expect(resumed).toMatchObject({ state: 'review', dueAt: NOW + 60_000 });
    expect(resumed.srs).toEqual({ kind: 'ladder', stageIndex: 0 }); // stage survived
  });

  it('burning through the top stage retires the card', async () => {
    const { a } = await seedChain();
    const ladder = (await db.ladders.where('courseId').notEqual('').toArray())[0];
    await setItemStage(a.id, ladder.stages.length, NOW);
    const card = (await cardsOf(a.id))[0];
    expect(card.state).toBe('burned');
    expect(card.dueAt).toBeUndefined();
  });
});

describe('recomputeUnlocks heals lesson/active drift', () => {
  it('promotes a lesson-queue item whose cards are all scheduled', async () => {
    const { course, type } = await setup();
    const a = await createItem(
      { courseId: course.id, typeId: type.id, fieldValues: values(type, 'Q', 'A') },
      NOW,
    );
    await completeLessonBatch([a.id], 'sess', NOW);
    // simulate the stale state a pre-fix type edit could leave behind
    await db.items.put({ ...(await db.items.get(a.id))!, status: 'lesson' });

    const res = await recomputeUnlocks(course.id, NOW + 1000);
    expect(res.changed).toBeGreaterThan(0);
    expect((await db.items.get(a.id))!.status).toBe('active');
  });
});

describe('item editor save path', () => {
  it('rejects a prerequisite loop instead of locking both items forever', async () => {
    const { course, type } = await setup();
    const a = await createItem(
      { courseId: course.id, typeId: type.id, fieldValues: values(type, 'A', 'a') },
      NOW,
    );
    const b = await createItem(
      {
        courseId: course.id,
        typeId: type.id,
        fieldValues: values(type, 'B', 'b'),
        prereqIds: [a.id],
      },
      NOW,
    );
    await expect(saveItemEdit({ ...a, prereqIds: [b.id] }, NOW)).rejects.toThrow(/loop/);
    expect((await db.items.get(a.id))!.prereqIds).toEqual([]);
  });

  it('drops self-references and re-settles gating after an edit', async () => {
    const { course, type } = await setup();
    const a = await createItem(
      { courseId: course.id, typeId: type.id, fieldValues: values(type, 'A', 'a') },
      NOW,
    );
    const b = await createItem(
      { courseId: course.id, typeId: type.id, fieldValues: values(type, 'B', 'b') },
      NOW,
    );
    expect((await db.items.get(b.id))!.status).toBe('lesson');

    await saveItemEdit({ ...b, prereqIds: [a.id, b.id] }, NOW + 1000);
    const after = (await db.items.get(b.id))!;
    expect(after.prereqIds).toEqual([a.id]); // self-edge dropped
    expect(after.status).toBe('locked'); // now waiting on A
  });
});
