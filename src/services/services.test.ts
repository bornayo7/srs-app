import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourse } from '@/db/repo/courses';
import { createItem } from '@/db/repo/items';
import { createItemType, basicTypeSpec } from '@/db/repo/itemTypes';
import { dueCards } from '@/db/repo/cards';
import { commitReview } from './commitReview';
import { completeLessonBatch, lessonAvailability, nextLessonBatch } from './lessons';
import { undoReview } from './undo';
import { exportAll } from '@/db/export';
import { importAll } from '@/db/import';
import { HOUR } from '@/engine/time';
import type { Card, Course, Item } from '@/engine/types';

const NOW = Date.UTC(2026, 0, 15, 10, 23);

async function wipe() {
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
}

async function seedOneItem(): Promise<{ course: Course; item: Item; card: Card }> {
  const course = await createCourse({ name: 'Test', ladderPresetId: 'preset-classic' }, NOW);
  const type = await createItemType(course.id, basicTypeSpec(), NOW);
  const front = type.fields[0].id;
  const back = type.fields[1].id;
  const item = await createItem(
    { courseId: course.id, typeId: type.id, fieldValues: { [front]: 'Q', [back]: 'answer' } },
    NOW,
  );
  const card = (await db.cards.where('itemId').equals(item.id).toArray())[0];
  return { course, item, card };
}

beforeEach(wipe);

describe('lesson flow', () => {
  it('lesson completion activates the item and schedules cards at stage 0 (+4h floored)', async () => {
    const { course, item, card } = await seedOneItem();
    expect(card.state).toBe('new');

    const batch = await nextLessonBatch(course.id, NOW);
    expect(batch.map((i) => i.id)).toEqual([item.id]);

    await completeLessonBatch([item.id], 'sess1', NOW);

    const after = (await db.cards.get(card.id))!;
    expect(after.state).toBe('review');
    expect(after.srs).toEqual({ kind: 'ladder', stageIndex: 0 });
    expect(after.dueAt).toBe(Date.UTC(2026, 0, 15, 14));
    expect((await db.items.get(item.id))!.status).toBe('active');

    const logs = await db.reviewLogs.toArray();
    expect(logs).toHaveLength(1);
    expect(logs[0].kind).toBe('lesson');
  });

  it('daily lesson limit counts distinct items for the local day', async () => {
    const course = await createCourse(
      { name: 'Limited', ladderPresetId: 'preset-classic', newPerDay: 2, batchSize: 5 },
      NOW,
    );
    const type = await createItemType(course.id, basicTypeSpec(), NOW);
    const [f, b] = [type.fields[0].id, type.fields[1].id];
    for (let i = 0; i < 4; i++) {
      await createItem(
        { courseId: course.id, typeId: type.id, fieldValues: { [f]: `Q${i}`, [b]: `a${i}` } },
        NOW + i,
      );
    }
    let avail = await lessonAvailability(course.id, NOW);
    expect(avail).toEqual({ poolSize: 4, remainingToday: 2, available: 2 });

    const batch = await nextLessonBatch(course.id, NOW);
    expect(batch).toHaveLength(2);
    await completeLessonBatch(batch.map((i) => i.id), 's', NOW);

    avail = await lessonAvailability(course.id, NOW + HOUR);
    expect(avail.available).toBe(0);
    expect(await nextLessonBatch(course.id, NOW + HOUR)).toHaveLength(0);
  });
});

describe('commitReview', () => {
  async function activated() {
    const seeded = await seedOneItem();
    await completeLessonBatch([seeded.item.id], 's', NOW);
    return { ...seeded, card: (await db.cards.get(seeded.card.id))! };
  }

  it('correct answer promotes, logs with prev snapshot, updates stats', async () => {
    const { card } = await activated();
    const later = card.dueAt! + 1;
    const res = await commitReview({
      cardId: card.id,
      sessionId: 's',
      outcome: { kind: 'ladder', incorrectCount: 0 },
      now: later,
    });
    expect(res.fromStage).toBe(0);
    expect(res.toStage).toBe(1);
    expect(res.card.stats).toEqual({ reviews: 1, correct: 1, lapses: 0 });

    const log = (await db.reviewLogs.get(res.logId))!;
    expect(log.outcome).toMatchObject({ kind: 'ladder', fromStage: 0, toStage: 1 });
    expect(log.prev.srs).toEqual({ kind: 'ladder', stageIndex: 0 });
  });

  it('wrong answers drop stages and count a lapse', async () => {
    const { card } = await activated();
    // climb to stage 2 first
    let t = card.dueAt! + 1;
    await commitReview({ cardId: card.id, sessionId: 's', outcome: { kind: 'ladder', incorrectCount: 0 }, now: t });
    t += 9 * HOUR;
    await commitReview({ cardId: card.id, sessionId: 's', outcome: { kind: 'ladder', incorrectCount: 0 }, now: t });
    t += 24 * HOUR;
    const res = await commitReview({
      cardId: card.id,
      sessionId: 's',
      outcome: { kind: 'ladder', incorrectCount: 1 },
      now: t,
    });
    expect(res.fromStage).toBe(2);
    expect(res.toStage).toBe(1);
    expect(res.card.stats.lapses).toBe(1);
  });

  it('undo restores the exact previous card state (identity property)', async () => {
    const { card } = await activated();
    const before = (await db.cards.get(card.id))!;
    const res = await commitReview({
      cardId: card.id,
      sessionId: 's',
      outcome: { kind: 'ladder', incorrectCount: 2 },
      now: card.dueAt! + 1,
    });
    const restored = await undoReview(res.logId);
    expect(restored).not.toBeNull();
    const after = (await db.cards.get(card.id))!;
    expect(after.state).toBe(before.state);
    expect(after.srs).toEqual(before.srs);
    expect(after.dueAt).toBe(before.dueAt);
    expect(after.stats).toEqual(before.stats);
    expect(await db.reviewLogs.get(res.logId)).toBeUndefined();
  });

  it('is atomic: a failing review leaves no log and no card change', async () => {
    const { card } = await activated();
    // Corrupt the srs so the scheduler throws mid-transaction.
    await db.cards.update(card.id, { srs: { kind: 'fsrs' } as never });
    const snapshotBefore = await db.cards.get(card.id);
    await expect(
      commitReview({
        cardId: card.id,
        sessionId: 's',
        outcome: { kind: 'ladder', incorrectCount: 0 },
        now: card.dueAt! + 1,
      }),
    ).rejects.toThrow();
    expect(await db.reviewLogs.count()).toBe(1); // just the lesson log
    expect(await db.cards.get(card.id)).toEqual(snapshotBefore);
  });

  it('burning: a correct answer at the top stage retires the card out of the due index', async () => {
    const { card } = await activated();
    await db.cards.update(card.id, { srs: { kind: 'ladder', stageIndex: 7 } });
    const res = await commitReview({
      cardId: card.id,
      sessionId: 's',
      outcome: { kind: 'ladder', incorrectCount: 0 },
      now: NOW + HOUR,
    });
    expect(res.burned).toBe(true);
    const after = (await db.cards.get(card.id))!;
    expect(after.state).toBe('burned');
    expect('dueAt' in after).toBe(false);
    expect(await dueCards(card.courseId, NOW + 100 * HOUR)).toHaveLength(0);
  });
});

describe('backup round trip', () => {
  it('export → wipe → import restores identical table contents', async () => {
    const { course, item, card } = await seedOneItem();
    await completeLessonBatch([item.id], 's', NOW);
    await commitReview({
      cardId: card.id,
      sessionId: 's',
      outcome: { kind: 'ladder', incorrectCount: 0 },
      now: NOW + 5 * HOUR,
    });

    const backup = await exportAll(NOW + 6 * HOUR);
    const dump = async () => ({
      courses: await db.courses.orderBy('id').toArray(),
      ladders: (await db.ladders.toCollection().sortBy('id')).filter((l) => !l.isPreset),
      itemTypes: await db.itemTypes.toCollection().sortBy('id'),
      items: await db.items.toCollection().sortBy('id'),
      cards: await db.cards.toCollection().sortBy('id'),
      logs: await db.reviewLogs.toCollection().sortBy('id'),
    });
    const before = await dump();

    // simulate a fresh profile, then restore from the parsed JSON text
    await Promise.all(db.tables.map((t) => t.clear()));
    const counts = await importAll(JSON.parse(JSON.stringify(backup)));
    expect(counts).toEqual({ courses: 1, items: 1 });

    const after = await dump();
    expect(after).toEqual(before);
    expect((await db.courses.get(course.id))!.name).toBe('Test');
  });

  it('rejects malformed backups without touching data', async () => {
    await seedOneItem();
    const coursesBefore = await db.courses.count();
    await expect(importAll({ app: 'srs-app', formatVersion: 99 })).rejects.toThrow();
    expect(await db.courses.count()).toBe(coursesBefore);
  });

  it('restore preserves local-only meta keys and the ladder presets', async () => {
    await seedOneItem();
    const backup = await exportAll(NOW);
    await db.meta.bulkPut([
      { key: 'ai:apiKey', value: 'sk-ant-local-secret' },
      { key: 'exchange:dirHandle', value: { fake: 'handle' } },
    ]);
    await importAll(JSON.parse(JSON.stringify(backup)));
    expect((await db.meta.get('ai:apiKey'))?.value).toBe('sk-ant-local-secret');
    expect((await db.meta.get('exchange:dirHandle'))?.value).toEqual({ fake: 'handle' });
    // built-in presets exist after restore, so course creation keeps working
    expect(await db.ladders.get('preset-classic')).toBeDefined();
  });

  it('never exports the AI key or the exchange folder handle', async () => {
    await seedOneItem();
    await db.meta.bulkPut([
      { key: 'ai:apiKey', value: 'sk-ant-secret' },
      { key: 'exchange:dirHandle', value: { fake: 'handle' } },
      { key: 'devClockOffsetMs', value: 0 },
    ]);
    const backup = await exportAll(NOW);
    const keys = (backup.data.meta as { key: string }[]).map((m) => m.key);
    expect(keys).not.toContain('ai:apiKey');
    expect(keys).not.toContain('exchange:dirHandle');
    expect(keys).toContain('devClockOffsetMs');
  });
});
