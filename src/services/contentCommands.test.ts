import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourseWithType, convertCapture, saveCourseSettings } from './contentCommands';
import { createItem, deleteItem, saveItemEdit } from '@/db/repo/items';
import { createItemType, basicTypeSpec } from '@/db/repo/itemTypes';

const NOW = 1_800_000_000_000;
beforeEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(db.tables.map((table) => table.clear()));
  await ensurePresets();
});
async function setup() {
  const course = await createCourseWithType(
    { name: 'Course', ladderPresetId: 'preset-classic' },
    NOW,
  );
  const type = (await db.itemTypes.where('courseId').equals(course.id).toArray())[0];
  const input = {
    courseId: course.id,
    typeId: type.id,
    fieldValues: { [type.fields[0].id]: 'question', [type.fields[1].id]: 'answer' },
  };
  return { course, type, input };
}

describe('atomic content intents', () => {
  it('rolls back course and owned ladder if initial type creation fails', async () => {
    vi.spyOn(db.itemTypes, 'add').mockRejectedValueOnce(new Error('storage failure'));
    await expect(
      createCourseWithType({ name: 'Course', ladderPresetId: 'preset-classic' }, NOW),
    ).rejects.toThrow(/storage failure/);
    expect(await db.courses.count()).toBe(0);
    expect((await db.ladders.toArray()).every((ladder) => ladder.isPreset)).toBe(true);
  });

  it('consumes a capture once across competing calls and preserves it on invalid content', async () => {
    const { input } = await setup();
    await db.captures.add({ id: 'capture', text: 'remember this', createdAt: NOW });
    const results = await Promise.allSettled([
      convertCapture('capture', input, NOW),
      convertCapture('capture', input, NOW),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await db.items.count()).toBe(1);
    await db.captures.add({ id: 'bad', text: 'keep me', createdAt: NOW });
    await expect(convertCapture('bad', { ...input, fieldValues: {} }, NOW)).rejects.toThrow(
      /prompt|answer/,
    );
    expect(await db.captures.get('bad')).toBeDefined();
  });

  it('rejects foreign ownership and duplicate type names before creating rows', async () => {
    const { input, type } = await setup();
    const other = await createCourseWithType(
      { name: 'Other', ladderPresetId: 'preset-classic' },
      NOW,
    );
    await expect(createItem({ ...input, courseId: other.id }, NOW)).rejects.toThrow(
      /another course/,
    );
    await expect(
      createItemType(type.courseId, { ...basicTypeSpec(), name: ' basic ' }, NOW),
    ).rejects.toThrow(/already exists/);
    expect(await db.items.count()).toBe(0);
  });

  it('increments item/card revisions and rejects a same-millisecond stale edit', async () => {
    const { input } = await setup();
    const item = await createItem(input, NOW);
    const before = (await db.cards.where('itemId').equals(item.id).toArray())[0];
    await saveItemEdit({ ...item, note: 'new note' }, NOW);
    await expect(saveItemEdit({ ...item, note: 'stale note' }, NOW)).rejects.toThrow(
      /changed elsewhere/,
    );
    expect((await db.items.get(item.id))?.note).toBe('new note');
    expect((await db.items.get(item.id))?.rev).toBe(item.rev + 1);
    expect((await db.cards.get(before.id))?.rev).toBe(before.rev + 1);
  });

  it('merges settings against current progression and preserves release ownership', async () => {
    const { course } = await setup();
    await db.courses.update(course.id, {
      currentLevel: 4,
      levelConfig: { gateTypeIds: [], passPercent: 90, autoAdvance: false },
    });
    await saveCourseSettings(
      course.id,
      { description: 'edited', levelConfig: { passPercent: 80 } },
      NOW,
    );
    const current = (await db.courses.get(course.id))!;
    expect(current.currentLevel).toBe(4);
    expect(current.levelConfig).toMatchObject({ passPercent: 80, autoAdvance: false });
    await expect(
      saveCourseSettings(course.id, { lessons: { newPerDay: 1.5, batchSize: 5 } }, NOW),
    ).rejects.toThrow(/whole numbers/);
  });

  it('deletes historical logs by item even after the ghost card graduated', async () => {
    const { input, course } = await setup();
    const item = await createItem(input, NOW);
    await db.reviewLogs.add({
      id: 'ghost-log',
      cardId: 'gone',
      itemId: item.id,
      courseId: course.id,
      ts: NOW,
      sessionId: 'old',
      kind: 'review',
      prev: { state: 'new', srs: null, stats: { reviews: 0, correct: 0, lapses: 0 } },
    });
    await deleteItem(item.id, NOW);
    expect(await db.reviewLogs.count()).toBe(0);
    expect(await db.cards.count()).toBe(0);
  });
});
