import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SrsDB, requestPersistentStorage } from './db';

afterEach(() => vi.unstubAllGlobals());

describe('revision schema migration', () => {
  it.each([4, 5])(
    'upgrades an already-opened v%i database without resetting current revisions',
    async (version) => {
      const name = `migration-v4-${crypto.randomUUID()}`;
      const old = new Dexie(name);
      old.version(4).stores({
        courses: 'id, updatedAt',
        ladders: 'id, courseId',
        itemTypes: 'id, courseId',
        items: 'id, courseId, typeId, *prereqIds, [courseId+status], [courseId+level]',
        cards: 'id, itemId, templateId, [courseId+state+dueAt], [state+dueAt], [courseId+state]',
        reviewLogs: 'id, cardId, itemId, courseId, ts, [courseId+ts], [sessionId+ts]',
        media: 'id',
        meta: 'key',
        captures: 'id, createdAt',
        plans: 'id, courseId',
        proposals: 'id, courseId, planId, [courseId+status], [courseId+level+status]',
        cardTombstones: 'id, itemId, courseId, templateId',
        packetReceipts: 'id, *courseIds',
      });
      if (version === 5) old.version(5).stores({ dailyLessons: 'id, courseId' });
      await old.table('cards').add({ id: 'card', rev: 7 });
      await old
        .table('reviewLogs')
        .add({
          id: 'lesson',
          cardId: 'card',
          itemId: 'item',
          courseId: 'course',
          ts: 1,
          sessionId: 's',
          kind: 'lesson',
        });
      old.close();
      const upgraded = new SrsDB(name);
      try {
        await upgraded.open();
        expect(upgraded.verno).toBe(6);
        expect(await upgraded.cards.get('card')).toMatchObject({ rev: 7, generation: 'legacy' });
        if (version === 4)
          expect(await upgraded.dailyLessons.toArray()).toMatchObject([
            { courseId: 'course', itemIds: ['item'] },
          ]);
      } finally {
        await upgraded.delete();
      }
    },
  );
  it('backfills existing content deterministically and leaves legacy logs without undo authority', async () => {
    const name = `migration-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(3).stores({
      courses: 'id, updatedAt',
      ladders: 'id, courseId',
      itemTypes: 'id, courseId',
      items: 'id, courseId, typeId, *prereqIds, [courseId+status], [courseId+level]',
      cards: 'id, itemId, templateId, [courseId+state+dueAt], [state+dueAt], [courseId+state]',
      reviewLogs: 'id, cardId, ts, [courseId+ts], [sessionId+ts]',
      media: 'id',
      meta: 'key',
      captures: 'id, createdAt',
      plans: 'id, courseId',
      proposals: 'id, courseId, planId, [courseId+status], [courseId+level+status]',
    });
    const fields = [
      { id: 'front', name: 'Front', kind: 'text' },
      { id: 'back', name: 'Back', kind: 'text' },
    ];
    const template = {
      id: 't',
      name: 'Recall',
      promptFieldIds: ['front'],
      answerFieldId: 'back',
      hintFieldIds: [],
      grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
    };
    await old
      .table('itemTypes')
      .add({
        id: 'type',
        courseId: 'course',
        name: 'Basic',
        color: '#fff',
        icon: 'Q',
        fields,
        templates: [template],
        updatedAt: 1,
      });
    await old
      .table('items')
      .add({
        id: 'item',
        courseId: 'course',
        typeId: 'type',
        fieldValues: { front: 'Question', back: 'answer' },
        synonyms: {},
        blockList: {},
        guidance: {},
        level: 1,
        prereqIds: [],
        status: 'active',
        passedAt: null,
        unlockedAt: 1,
        updatedAt: 1,
      });
    await old
      .table('cards')
      .add({
        id: 'card',
        itemId: 'item',
        courseId: 'course',
        templateId: 't',
        state: 'review',
        srs: { kind: 'ladder', stageIndex: 2 },
        dueAt: 1,
        stats: { reviews: 1, correct: 1, lapses: 0 },
        updatedAt: 1,
      });
    await old
      .table('reviewLogs')
      .add({
        id: 'log',
        cardId: 'card',
        itemId: 'item',
        courseId: 'course',
        ts: 1,
        sessionId: 's',
        kind: 'review',
      });
    await old
      .table('reviewLogs')
      .bulkAdd(
        ['lesson1', 'lesson2'].map((id) => ({
          id,
          cardId: 'card',
          itemId: 'item',
          courseId: 'course',
          ts: 1,
          sessionId: 's',
          kind: 'lesson',
        })),
      );
    old.close();
    const upgraded = new SrsDB(name);
    try {
      await upgraded.open();
      expect(await upgraded.cards.get('card')).toMatchObject({ rev: 0, srs: { stageIndex: 2 } });
      expect(await upgraded.items.get('item')).toMatchObject({
        rev: 0,
        fieldValues: { back: 'answer' },
      });
      expect(await upgraded.itemTypes.get('type')).toMatchObject({ rev: 0 });
      expect(await upgraded.reviewLogs.where('itemId').equals('item').count()).toBe(3);
      expect(await upgraded.reviewLogs.get('log')).not.toHaveProperty('appliedRev');
      expect(await upgraded.cardTombstones.count()).toBe(0);
      expect(await upgraded.packetReceipts.count()).toBe(0);
      expect(await upgraded.dailyLessons.toArray()).toMatchObject([
        { courseId: 'course', itemIds: ['item'] },
      ]);
    } finally {
      await upgraded.delete();
    }
  });

  it('persistence denial does not become success and can be retried', async () => {
    const persist = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.stubGlobal('navigator', {
      storage: { persisted: vi.fn().mockResolvedValue(false), persist },
    });
    expect(await requestPersistentStorage()).toBe(false);
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
  });
});
