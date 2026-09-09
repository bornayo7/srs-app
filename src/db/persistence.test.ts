import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, ensurePresets } from './db';
import { exportAll } from './export';
import { importAll, resetStudyData } from './import';
import { createCourse, deleteCourse } from './repo/courses';
import { createItemType, basicTypeSpec } from './repo/itemTypes';
import { createItem, deleteItem, saveItemEdit } from './repo/items';
import { todayLessonItemCount } from './repo/logs';
import { teachItems, reviewCard } from '@/test/study';
import { undoReview } from '@/services/undo';
import { commitReview } from '@/services/commitReview';
import { studyRevision } from '@/services/studyRevision';

const NOW = 1_800_000_000_000;
beforeEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(db.tables.map((table) => table.clear()));
  await ensurePresets();
});
async function populated() {
  const course = await createCourse({ name: 'Test', ladderPresetId: 'preset-classic' }, NOW);
  const type = await createItemType(course.id, basicTypeSpec(), NOW);
  const item = await createItem(
    {
      courseId: course.id,
      typeId: type.id,
      fieldValues: { [type.fields[0].id]: 'question', [type.fields[1].id]: 'answer' },
    },
    NOW,
  );
  return { course, type, item };
}

describe('trusted backup replacement', () => {
  it('retains consumed daily lessons after item deletion and restores old logs into a ledger', async () => {
    const { item, course } = await populated();
    await teachItems([item.id], 'lesson', NOW);
    const legacy = await exportAll(NOW);
    legacy.formatVersion = 1;
    delete legacy.data.dailyLessons;
    delete legacy.data.cardTombstones;
    delete legacy.data.packetReceipts;
    await importAll(legacy);
    expect(await db.dailyLessons.count()).toBe(1);
    expect(await todayLessonItemCount(course.id, NOW - 10)).toBe(1);
    await deleteItem(item.id, NOW);
    await importAll(await exportAll(NOW));
    expect(await todayLessonItemCount(course.id, NOW)).toBe(1);
    await deleteCourse(course.id);
    expect(await db.dailyLessons.count()).toBe(0);
  });
  it('preserves graduated ghost history while invalidating every pre-restore undo token', async () => {
    const { item, course } = await populated();
    await db.courses.update(course.id, { ghosts: 'on' });
    await teachItems([item.id], 'lesson', NOW);
    const parent = (await db.cards.toArray())[0];
    await reviewCard({
      cardId: parent.id,
      sessionId: 'review',
      outcome: { kind: 'ladder', incorrectCount: 1 },
      now: parent.dueAt!,
    });
    const ghost = (await db.cards.toArray()).find((card) => card.isGhost)!;
    let lastLog = '';
    for (let stage = 0; stage < 4; stage++) {
      const current = (await db.cards.get(ghost.id))!;
      lastLog = (
        await reviewCard({
          cardId: ghost.id,
          sessionId: 'ghost',
          outcome: { kind: 'ladder', incorrectCount: 0 },
          now: current.dueAt!,
        })
      ).logId;
    }
    expect(await db.cards.get(ghost.id)).toBeUndefined();
    await importAll(await exportAll(NOW));
    expect(await db.cardTombstones.get(ghost.id)).toBeUndefined();
    expect(await db.reviewLogs.get(lastLog)).toBeDefined();
    expect((await db.reviewLogs.get(lastLog))?.appliedRev).toBeUndefined();
    expect((await db.reviewLogs.get(lastLog))?.appliedGeneration).toBeUndefined();
    expect(await undoReview(lastLog)).toBeNull();
    await expect(importAll(await exportAll(NOW))).resolves.toBeDefined();
  });
  it('keeps the entire local configuration bundle and excludes it from exports', async () => {
    await populated();
    const local = [
      { key: 'ai:openaiKey', value: 'sentinel' },
      { key: 'ai:openaiBaseUrl', value: 'https://local.invalid/v1' },
      { key: 'ai:futureSetting', value: 'local' },
      { key: 'exchange:dirHandle', value: { local: true } },
      { key: 'devClockOffsetMs', value: 10 },
    ];
    await db.meta.bulkPut(local);
    const backup = await exportAll(NOW);
    expect(backup.data.meta).toEqual([]);
    backup.data.meta = local.map((row) => ({ key: row.key, value: 'foreign' }));
    await importAll(backup);
    expect(await db.meta.bulkGet(local.map((row) => row.key))).toEqual(local);
  });

  it('rejects invalid live references before replacing any data', async () => {
    await populated();
    const backup = await exportAll(NOW);
    const before = await db.cards.toArray();
    (backup.data.cards[0] as { templateId: string }).templateId = 'missing';
    await expect(importAll(backup)).rejects.toThrow(/template/i);
    expect(await db.cards.toArray()).toEqual(before);
  });

  it('rolls back the entire replacement if a later table write fails', async () => {
    await populated();
    const backup = await exportAll(NOW);
    await db.captures.add({ id: 'local-capture', text: 'keep this', createdAt: NOW });
    const before = await exportAll(NOW);
    vi.spyOn(db.cards, 'bulkAdd').mockRejectedValueOnce(new Error('storage failure'));
    await expect(importAll(backup)).rejects.toThrow(/storage failure/);
    expect(await exportAll(NOW)).toEqual(before);
  });

  it('requires format-2 revisions and rejects altered immutable presets', async () => {
    await populated();
    const missing = await exportAll(NOW);
    delete (missing.data.cards[0] as { rev?: number }).rev;
    await expect(importAll(missing)).rejects.toThrow(/revision/);
    const changed = await exportAll(NOW);
    const preset = changed.data.ladders.find(
      (row) => (row as { id: string }).id === 'preset-ghost',
    ) as { stages: { intervalMinutes: number }[] };
    preset.stages[0].intervalMinutes = 999;
    await expect(importAll(changed)).rejects.toThrow(/built-in ladder/);
  });

  it('preserves packet delivery history after content deletion and a backup round-trip', async () => {
    const { course } = await populated();
    const receipt = {
      id: 'delivery',
      digest: 'content-digest',
      importedAt: NOW,
      courseIds: [course.id],
    };
    await db.packetReceipts.add(receipt);
    await deleteCourse(course.id);
    expect(await db.packetReceipts.get(receipt.id)).toEqual(receipt);
    await importAll(await exportAll(NOW));
    expect(await db.packetReceipts.get(receipt.id)).toEqual(receipt);
  });

  it('keeps historical previous ladder stages as history without granting undo authority', async () => {
    const { item, type, course } = await populated();
    const card = (await db.cards.toArray())[0];
    await db.cards.update(card.id, { rev: 1 });
    await db.reviewLogs.add({
      id: 'undo',
      itemId: item.id,
      courseId: course.id,
      cardId: card.id,
      sessionId: 'session',
      ts: NOW,
      kind: 'review',
      appliedRev: 1,
      itemRev: item.rev,
      typeRev: type.rev,
      cardMeta: { templateId: card.templateId },
      prev: {
        state: 'review',
        srs: { kind: 'ladder', stageIndex: 500 },
        dueAt: NOW,
        stats: { reviews: 1, correct: 1, lapses: 0 },
      },
    });
    await importAll(await exportAll(NOW));
    expect((await db.reviewLogs.get('undo'))?.itemRev).toBeUndefined();
    expect((await db.reviewLogs.get('undo'))?.prev.srs).toEqual({
      kind: 'ladder',
      stageIndex: 500,
    });
    expect(await undoReview('undo')).toBeNull();
  });

  it('rejects stale study and author commands after restore even when ids and counters match', async () => {
    const { item, type } = await populated();
    await teachItems([item.id], 'lesson', NOW);
    const card = (await db.cards.toArray())[0];
    const expected = studyRevision(card, item, type);
    await importAll(await exportAll(NOW));
    expect((await db.cards.get(card.id))?.rev).toBe(card.rev);
    await expect(
      commitReview({
        cardId: card.id,
        expected,
        sessionId: 'old-tab',
        outcome: { kind: 'ladder', incorrectCount: 0 },
        now: card.dueAt!,
      }),
    ).rejects.toThrow(/changed/);
    await expect(saveItemEdit({ ...item, note: 'stale draft' }, NOW)).rejects.toThrow(/changed/);
    await expect(
      createItem(
        {
          courseId: item.courseId,
          typeId: type.id,
          fieldValues: item.fieldValues,
          expectedType: type,
        },
        NOW,
      ),
    ).rejects.toThrow(/changed/);
    expect((await db.items.get(item.id))?.note).toBe('');
  });

  it('does not reuse a restored generation after deletion and reimport of the same backup', async () => {
    const { item, course } = await populated();
    const backup = await exportAll(NOW);
    await importAll(backup);
    const first = (await db.items.get(item.id))!;
    await deleteCourse(course.id);
    await importAll(backup);
    const second = (await db.items.get(item.id))!;
    expect(first.rev).toBe(second.rev);
    expect(first.generation).not.toBe(second.generation);
    await expect(saveItemEdit({ ...first, note: 'old restored tab' }, NOW)).rejects.toThrow(
      /changed/,
    );
  });

  it('rolls back author changes if a restored card revision is exhausted', async () => {
    const { item } = await populated();
    const backup = await exportAll(NOW);
    (backup.data.cards[0] as { rev: number }).rev = Number.MAX_SAFE_INTEGER;
    await importAll(backup);
    const current = (await db.items.get(item.id))!;
    await expect(saveItemEdit({ ...current, note: 'cannot commit' }, NOW)).rejects.toThrow(
      /revision/,
    );
    expect(await db.items.get(item.id)).toEqual(current);
  });

  it('rejects missing grading and unsupported scheduling rather than inventing behavior', async () => {
    await populated();
    const missing = await exportAll(NOW);
    delete (missing.data.itemTypes[0] as { templates: { grading?: unknown }[] }).templates[0]
      .grading;
    await expect(importAll(missing)).rejects.toThrow(/grading/i);
    const fsrs = await exportAll(NOW);
    (fsrs.data.courses[0] as { scheduling: unknown }).scheduling = {
      kind: 'fsrs',
      passIntervalDays: 1,
    };
    await expect(importAll(fsrs)).rejects.toThrow(/scheduling|ladder|supported/i);
  });

  it('preserves complete historical ghost logs without granting missing owners authority', async () => {
    const { item, course } = await populated();
    await db.reviewLogs.add({
      id: 'old-log',
      itemId: item.id,
      courseId: course.id,
      cardId: 'graduated-ghost',
      sessionId: 'old',
      ts: NOW,
      kind: 'review',
      prev: {
        state: 'review',
        srs: { kind: 'ladder', stageIndex: 0 },
        dueAt: NOW,
        stats: { reviews: 1, correct: 1, lapses: 0 },
      },
    });
    const backup = await exportAll(NOW);
    await importAll(backup);
    expect((await db.reviewLogs.get('old-log'))?.appliedRev).toBeUndefined();
  });

  it('resets study data atomically while retaining device configuration', async () => {
    await populated();
    await db.meta.bulkPut([
      { key: 'ai:provider', value: 'openai' },
      { key: 'seed:example', value: {} },
    ]);
    await resetStudyData();
    expect(await db.items.count()).toBe(0);
    expect(await db.courses.count()).toBe(0);
    expect(await db.meta.get('ai:provider')).toEqual({ key: 'ai:provider', value: 'openai' });
    expect(await db.meta.get('seed:example')).toBeUndefined();
    expect(await db.ladders.get('preset-classic')).toBeDefined();
  });

  it('captures media and items together before asynchronous byte encoding', async () => {
    const { course, type } = await populated();
    await db.media.add({
      id: 'old',
      name: 'old.png',
      mimeType: 'image/png',
      blob: new Blob(['old']),
      createdAt: NOW,
    });
    let started!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = Blob.prototype.arrayBuffer;
    vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementationOnce(async function (this: Blob) {
      started();
      await gate;
      return original.call(this);
    });
    const exporting = exportAll(NOW);
    await ready;
    await db.media.add({
      id: 'new',
      name: 'new.png',
      mimeType: 'image/png',
      blob: new Blob(['new']),
      createdAt: NOW,
    });
    const changed = {
      ...type,
      fields: [...type.fields, { id: 'photo', name: 'Photo', kind: 'image' as const }],
    };
    await db.itemTypes.put(changed);
    await createItem(
      {
        courseId: course.id,
        typeId: type.id,
        fieldValues: {
          [type.fields[0].id]: 'new question',
          [type.fields[1].id]: 'new answer',
          photo: 'new',
        },
      },
      NOW,
    );
    release();
    const backup = await exporting;
    expect(backup.data.items).toHaveLength(1);
    expect(backup.data.media).toHaveLength(1);
    await expect(importAll(backup)).resolves.toEqual({ courses: 1, items: 1 });
  });

  it('migrates complete format-1 records to revisions without legacy undo authority', async () => {
    await populated();
    const backup = await exportAll(NOW);
    backup.formatVersion = 1;
    for (const rows of [backup.data.items, backup.data.itemTypes, backup.data.cards])
      for (const row of rows) {
        delete (row as { rev?: number }).rev;
        delete (row as { generation?: string }).generation;
      }
    delete backup.data.packetReceipts;
    delete backup.data.cardTombstones;
    await importAll(backup);
    expect((await db.cards.toArray())[0].rev).toBe(0);
    expect((await db.items.toArray())[0].rev).toBe(0);
    expect((await db.itemTypes.toArray())[0].rev).toBe(0);
  });
});
