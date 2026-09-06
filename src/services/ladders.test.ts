import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourse } from '@/db/repo/courses';
import { createItem } from '@/db/repo/items';
import { basicTypeSpec, createItemType } from '@/db/repo/itemTypes';
import type { Card, SrsLadder } from '@/engine/types';
import { saveLadderEdit } from './ladders';
import { resumeItem, setItemStage, suspendItem } from './manualSrs';

const NOW = Date.UTC(2026, 0, 15, 10, 23);

async function setup() {
  const course = await createCourse({ name: 'L', ladderPresetId: 'preset-classic' }, NOW);
  const type = await createItemType(course.id, basicTypeSpec(), NOW);
  const item = await createItem(
    {
      courseId: course.id,
      typeId: type.id,
      fieldValues: { [type.fields[0].id]: 'q', [type.fields[1].id]: 'a' },
    },
    NOW,
  );
  const ladder = (await db.ladders.where('courseId').equals(course.id).first())!;
  return { course, item, ladder };
}

const cardOf = async (itemId: string): Promise<Card> =>
  (await db.cards.where('itemId').equals(itemId).toArray())[0];

const keepStages = (ladder: SrsLadder, n: number): SrsLadder => ({
  ...ladder,
  stages: ladder.stages.slice(0, n),
});

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
});

describe('saveLadderEdit keeps every card inside the new ladder', () => {
  it('a suspended card past the new top resumes at the last stage instead of burning', async () => {
    const { item, ladder } = await setup();
    await setItemStage(item.id, 6, NOW); // Master on the 8-stage classic ladder
    await suspendItem(item.id, NOW + 1);

    await saveLadderEdit(keepStages(ladder, 5), NOW + 2);
    expect((await cardOf(item.id)).srs).toEqual({ kind: 'ladder', stageIndex: 4 });

    await resumeItem(item.id, NOW + 3);
    const card = await cardOf(item.id);
    expect(card.state).toBe('review');
    expect(card.srs).toEqual({ kind: 'ladder', stageIndex: 4 });
  });

  it('a burned card stays "past the top" whether the ladder shrinks or grows', async () => {
    const { item, ladder } = await setup();
    await setItemStage(item.id, ladder.stages.length, NOW); // burn outright
    expect((await cardOf(item.id)).state).toBe('burned');

    const shorter = keepStages(ladder, 5);
    await saveLadderEdit(shorter, NOW + 1);
    expect(await cardOf(item.id)).toMatchObject({
      state: 'burned',
      srs: { kind: 'ladder', stageIndex: 5 },
    });

    const longer: SrsLadder = {
      ...shorter,
      stages: [...shorter.stages, { id: 'extra', name: 'Extra', intervalMinutes: 60 }],
    };
    await saveLadderEdit(longer, NOW + 2);
    expect((await cardOf(item.id)).srs).toEqual({ kind: 'ladder', stageIndex: 6 });
  });

  it('review cards follow their stage by id when an earlier stage is removed', async () => {
    const { item, ladder } = await setup();
    await setItemStage(item.id, 3, NOW);
    const before = await cardOf(item.id);
    const edited = { ...ladder, stages: ladder.stages.filter((_, i) => i !== 1) };
    await saveLadderEdit(edited, NOW + 1);
    const card = await cardOf(item.id);
    expect(card.srs).toEqual({ kind: 'ladder', stageIndex: 2 });
    expect(card.dueAt).toBe(before.dueAt); // the existing schedule is kept
  });

  it('untouched cards are left alone', async () => {
    const { item, ladder } = await setup();
    const before = await cardOf(item.id); // still new
    await saveLadderEdit({ ...ladder, name: 'Renamed' }, NOW + 1);
    expect(await cardOf(item.id)).toEqual(before);
  });
});
