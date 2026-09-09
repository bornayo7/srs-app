import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourse } from '@/db/repo/courses';
import { createItem, deleteItem } from '@/db/repo/items';
import { basicTypeSpec, createItemType } from '@/db/repo/itemTypes';
import { completeLessonBatch, lessonAvailability } from './lessons';
import { studyRevision } from './studyRevision';

const NOW = new Date(2026, 8, 8, 10).getTime();
beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
});
async function batch() {
  const course = await createCourse(
    { name: 'Quota', ladderPresetId: 'preset-classic', newPerDay: 1 },
    NOW,
  );
  const type = await createItemType(course.id, basicTypeSpec(), NOW);
  const observations = [];
  for (const n of ['a', 'b']) {
    const item = await createItem(
      {
        courseId: course.id,
        typeId: type.id,
        fieldValues: { [type.fields[0].id]: n, [type.fields[1].id]: 'answer' },
      },
      NOW,
    );
    const card = (await db.cards.where('itemId').equals(item.id).first())!;
    observations.push({ cardId: card.id, expected: studyRevision(card, item, type) });
  }
  return { course, type, observations };
}

describe('lesson activation is the quota and revision seam', () => {
  it('two competing batches cannot consume the same final daily allowance', async () => {
    const { observations } = await batch();
    const result = await Promise.allSettled(
      observations.map((c, i) => completeLessonBatch([c], `s${i}`, NOW)),
    );
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await db.cards.toArray()).filter((c) => c.state === 'review')).toHaveLength(1);
    expect(await db.reviewLogs.count()).toBe(1);
  });
  it('a cached availability clock cannot hide a newer lesson on the same day', async () => {
    const { course, observations } = await batch();
    await completeLessonBatch([observations[0]], 's', NOW + 1_000);
    expect((await lessonAvailability(course.id, NOW)).remainingToday).toBe(0);
  });
  it('deleting a taught item does not reclaim the consumed daily allowance', async () => {
    const { course, observations } = await batch();
    await completeLessonBatch([observations[0]], 's', NOW);
    const card = (await db.cards.get(observations[0].cardId))!;
    await deleteItem(card.itemId, NOW + 1);
    expect(await db.reviewLogs.count()).toBe(0);
    expect((await lessonAvailability(course.id, NOW + 2)).remainingToday).toBe(0);
    await expect(completeLessonBatch([observations[1]], 's2', NOW + 2)).rejects.toThrow(
      /allowance/,
    );
  });
  it('only the exact observed cards are activated; later-added cards remain untaught', async () => {
    const { observations } = await batch();
    const card = (await db.cards.get(observations[0].cardId))!;
    await db.cards.add({ ...card, id: 'added-later' });
    await completeLessonBatch([observations[0]], 's', NOW);
    expect(await db.cards.get('added-later')).toMatchObject({ state: 'new' });
    expect(await db.items.get(card.itemId)).toMatchObject({ status: 'lesson' });
  });
  it('changed content rejects a stale lesson without writing any completion', async () => {
    const { type, observations } = await batch();
    await db.itemTypes.update(type.id, { rev: type.rev + 1 });
    await expect(completeLessonBatch([observations[0]], 's', NOW)).rejects.toThrow(/changed/);
    expect(await db.reviewLogs.count()).toBe(0);
  });
});
