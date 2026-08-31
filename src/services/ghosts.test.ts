import { describe, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourse, updateCourse } from '@/db/repo/courses';
import { createItem } from '@/db/repo/items';
import { createItemType, basicTypeSpec } from '@/db/repo/itemTypes';
import { commitReview } from './commitReview';
import { completeLessonBatch } from './lessons';
import { undoReview } from './undo';
import { HOUR } from '@/engine/time';
import type { Card, Course } from '@/engine/types';

const NOW = Date.UTC(2026, 1, 10, 9, 30);

async function setup(ghosts: Course['ghosts']): Promise<{ course: Course; card: Card }> {
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
  const course = await createCourse({ name: 'G', ladderPresetId: 'preset-classic' }, NOW);
  await updateCourse({ ...course, ghosts }, NOW);
  const type = await createItemType(course.id, basicTypeSpec(), NOW);
  const item = await createItem(
    {
      courseId: course.id,
      typeId: type.id,
      fieldValues: { [type.fields[0].id]: 'Q', [type.fields[1].id]: 'answer' },
    },
    NOW,
  );
  await completeLessonBatch([item.id], 's', NOW);
  const card = (await db.cards.where('itemId').equals(item.id).toArray())[0];
  return { course: (await db.courses.get(course.id))!, card };
}

function miss(cardId: string, at: number) {
  return commitReview({
    cardId,
    sessionId: 's',
    outcome: { kind: 'ladder', incorrectCount: 1 },
    now: at,
  });
}

async function ghostsOf(parentId: string): Promise<Card[]> {
  return (await db.cards.toArray()).filter((c) => c.isGhost && c.parentCardId === parentId);
}

describe('ghost reviews', () => {
  it("policy 'on': a miss spawns one ghost on the ghost ladder, due in ~1h", async () => {
    const { card } = await setup('on');
    await miss(card.id, card.dueAt!);
    const ghosts = await ghostsOf(card.id);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].state).toBe('review');
    expect(ghosts[0].srs).toEqual({ kind: 'ladder', stageIndex: 0 });
    // ghost ladder stage 0 = 1h, floored to the hour
    expect(ghosts[0].dueAt).toBeLessThanOrEqual(card.dueAt! + HOUR);
    expect(ghosts[0].dueAt).toBeGreaterThan(card.dueAt!);
  });

  it("policy 'off': no ghost", async () => {
    const { card } = await setup('off');
    await miss(card.id, card.dueAt!);
    expect(await ghostsOf(card.id)).toHaveLength(0);
  });

  it("policy 'minimal': ghost only on the second recent miss", async () => {
    const { card } = await setup('minimal');
    await miss(card.id, card.dueAt!);
    expect(await ghostsOf(card.id)).toHaveLength(0);
    await miss(card.id, card.dueAt! + 5 * HOUR);
    expect(await ghostsOf(card.id)).toHaveLength(1);
  });

  it('never spawns a second live ghost for the same card', async () => {
    const { card } = await setup('on');
    await miss(card.id, card.dueAt!);
    await miss(card.id, card.dueAt! + 5 * HOUR);
    expect(await ghostsOf(card.id)).toHaveLength(1);
  });

  it('ghost reviews use the ghost ladder and graduation deletes the ghost', async () => {
    const { card } = await setup('on');
    await miss(card.id, card.dueAt!);
    let [ghost] = await ghostsOf(card.id);
    // climb the 4-stage ghost ladder: 4 correct answers → graduated (deleted)
    let t = ghost.dueAt! + 1;
    for (let i = 0; i < 4; i++) {
      const res = await commitReview({
        cardId: ghost.id,
        sessionId: 's',
        outcome: { kind: 'ladder', incorrectCount: 0 },
        now: t,
      });
      t += 25 * HOUR;
      if (i < 3) {
        expect(res.burned).toBe(false);
        ghost = (await db.cards.get(ghost.id))!;
      } else {
        expect(res.burned).toBe(true);
      }
    }
    expect(await db.cards.get(ghost.id)).toBeUndefined();
    // the parent card is untouched by ghost drilling
    const parent = (await db.cards.get(card.id))!;
    expect(parent.state).toBe('review');
  });

  it('undo resurrects a graduated ghost from the log', async () => {
    const { card } = await setup('on');
    await miss(card.id, card.dueAt!);
    const [ghost] = await ghostsOf(card.id);
    await db.cards.update(ghost.id, { srs: { kind: 'ladder', stageIndex: 3 } });
    const res = await commitReview({
      cardId: ghost.id,
      sessionId: 's',
      outcome: { kind: 'ladder', incorrectCount: 0 },
      now: NOW + 10 * HOUR,
    });
    expect(res.burned).toBe(true);
    expect(await db.cards.get(ghost.id)).toBeUndefined();

    const restored = await undoReview(res.logId);
    expect(restored).not.toBeNull();
    const back = (await db.cards.get(ghost.id))!;
    expect(back.isGhost).toBe(true);
    expect(back.parentCardId).toBe(card.id);
    expect(back.state).toBe('review');
    expect(back.srs).toEqual({ kind: 'ladder', stageIndex: 3 });
  });

  it('a missed ghost never spawns a ghost of a ghost', async () => {
    const { card } = await setup('on');
    await miss(card.id, card.dueAt!);
    const [ghost] = await ghostsOf(card.id);
    await miss(ghost.id, ghost.dueAt!);
    const all = (await db.cards.toArray()).filter((c) => c.isGhost);
    expect(all).toHaveLength(1);
  });
});
