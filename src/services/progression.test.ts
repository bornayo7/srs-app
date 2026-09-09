import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourse } from '@/db/repo/courses';
import { createItem } from '@/db/repo/items';
import { basicTypeSpec, createItemType } from '@/db/repo/itemTypes';
import { commitReview } from './commitReview';
import { undoReview } from './undo';
import { setCardManual, undoManualBatch } from './manualSrs';
import { studyRevision } from './studyRevision';
import { HOUR } from '@/engine/time';

const NOW = Date.UTC(2026, 8, 8, 10);
beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
});

async function ready() {
  const course = await createCourse({ name: 'Versioned', ladderPresetId: 'preset-classic' }, NOW);
  const type = { ...(await createItemType(course.id, basicTypeSpec(), NOW)), rev: 0 };
  await db.itemTypes.put(type);
  const item = {
    ...(await createItem(
      {
        courseId: course.id,
        typeId: type.id,
        fieldValues: { [type.fields[0].id]: 'Question', [type.fields[1].id]: 'answer' },
      },
      NOW,
    )),
    rev: 0,
  };
  await db.items.put({ ...item, status: 'active' });
  const original = (await db.cards.where('itemId').equals(item.id).first())!;
  const card = {
    ...original,
    rev: 0,
    state: 'review' as const,
    srs: { kind: 'ladder' as const, stageIndex: 0 },
    dueAt: NOW,
  };
  await db.cards.put(card);
  return { course, type, item, card };
}

describe('versioned progression', () => {
  it('the same loaded occurrence can only advance once, even in one millisecond', async () => {
    const { card, item, type } = await ready();
    const input = {
      cardId: card.id,
      sessionId: 'one-occurrence',
      expected: studyRevision(card, item, type),
      outcome: { kind: 'ladder' as const, incorrectCount: 0 },
      now: NOW,
    };
    const results = await Promise.allSettled([commitReview(input), commitReview(input)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.cards.get(card.id)).toMatchObject({
      rev: 1,
      stats: { reviews: 1 },
      srs: { stageIndex: 1 },
    });
  });

  it('review undo refuses to overwrite a newer manual mutation', async () => {
    const { card, item, type } = await ready();
    const res = await commitReview({
      cardId: card.id,
      sessionId: 's',
      expected: studyRevision(card, item, type),
      outcome: { kind: 'ladder', incorrectCount: 0 },
      now: NOW,
    });
    await setCardManual(card.id, { kind: 'setStage', stageIndex: 5 }, NOW);
    expect(await undoReview(res.logId)).toBeNull();
    expect(await db.cards.get(card.id)).toMatchObject({ rev: 2, srs: { stageIndex: 5 } });
    expect(await db.reviewLogs.get(res.logId)).toBeDefined();
  });

  it('undo creates a new revision, so the old question stays stale after state restoration', async () => {
    const { card, item, type } = await ready();
    const input = {
      cardId: card.id,
      sessionId: 's',
      expected: studyRevision(card, item, type),
      outcome: { kind: 'ladder' as const, incorrectCount: 0 },
      now: NOW,
    };
    const result = await commitReview(input);
    expect(await undoReview(result.logId)).toMatchObject({ rev: 2, srs: { stageIndex: 0 } });
    await expect(commitReview(input)).rejects.toThrow(/changed/);
  });

  it('manual batch undo refuses the whole group if one card was reviewed afterward', async () => {
    const { card, item, type } = await ready();
    const batch = await setCardManual(card.id, { kind: 'setStage', stageIndex: 2 }, NOW);
    const current = (await db.cards.get(card.id))!;
    const res = await commitReview({
      cardId: card.id,
      sessionId: 's',
      expected: studyRevision(current, item, type),
      outcome: { kind: 'ladder', incorrectCount: 0 },
      now: NOW + 48 * HOUR,
    });
    expect(await undoManualBatch(batch.sessionId, NOW + 49 * HOUR)).toBe(0);
    expect(await db.cards.get(card.id)).toMatchObject({
      stats: { reviews: 1 },
      srs: { stageIndex: 3 },
    });
    expect(await db.reviewLogs.get(res.logId)).toBeDefined();
  });

  it('a graduated ghost can be undone once, but never after its item is deleted', async () => {
    const { card, item, type } = await ready();
    const ghost = {
      ...card,
      id: 'ghost',
      isGhost: true,
      parentCardId: card.id,
      srs: { kind: 'ladder' as const, stageIndex: 3 },
    };
    await db.cards.add(ghost);
    const first = await commitReview({
      cardId: ghost.id,
      sessionId: 's',
      expected: studyRevision(ghost, item, type),
      outcome: { kind: 'ladder', incorrectCount: 0 },
      now: NOW,
    });
    expect(await db.cards.get(ghost.id)).toBeUndefined();
    expect(await db.cardTombstones.get(ghost.id)).toMatchObject({ rev: 1, logId: first.logId });
    const restored = (await undoReview(first.logId))!;
    expect(restored).toMatchObject({ rev: 2, isGhost: true, srs: { stageIndex: 3 } });
    expect(await undoReview(first.logId)).toBeNull();
    const second = await commitReview({
      cardId: ghost.id,
      sessionId: 'again',
      expected: studyRevision(restored, item, type),
      outcome: { kind: 'ladder', incorrectCount: 0 },
      now: NOW,
    });
    await db.items.delete(item.id);
    expect(await undoReview(second.logId)).toBeNull();
    expect(await db.cards.get(ghost.id)).toBeUndefined();
  });
});
