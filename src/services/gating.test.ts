import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { installSeed } from '@/db/seed';
import { japaneseSeed } from '@/db/seed/japanese';
import { commitReview } from './commitReview';
import { completeLessonBatch } from './lessons';
import { createItem, deleteItem, lessonPool } from '@/db/repo/items';
import { recomputeUnlocks } from './gating';
import { HOUR } from '@/engine/time';
import type { Card, Item } from '@/engine/types';

const NOW = Date.UTC(2026, 2, 2, 9, 0);

async function install() {
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
  return installSeed(japaneseSeed, NOW);
}

async function itemsOf(courseId: string): Promise<Item[]> {
  return db.items.where('courseId').equals(courseId).toArray();
}

/** Find by item-type NAME + any field value — previews alone are ambiguous
 *  (the radical 人 and the kanji 人 preview identically). */
async function findItem(courseId: string, typeName: string, value: string): Promise<Item> {
  const items = await itemsOf(courseId);
  const types = await db.itemTypes.where('courseId').equals(courseId).toArray();
  const typeId = types.find((t) => t.name === typeName)?.id;
  const found = items.find(
    (i) => i.typeId === typeId && Object.values(i.fieldValues).includes(value),
  );
  if (!found) throw new Error(`item not found: ${typeName} ${value}`);
  return found;
}

/** Teach an item, then answer every card correctly until it passes (Guru). */
async function passItem(itemId: string, startAt: number): Promise<number> {
  const item = (await db.items.get(itemId))!;
  if (item.status === 'lesson') await completeLessonBatch([itemId], 'sess', startAt);
  let t = startAt;
  for (let i = 0; i < 12; i++) {
    const cards = (await db.cards.where('itemId').equals(itemId).toArray()).filter(
      (c: Card) => !c.isGhost,
    );
    const fresh = await db.items.get(itemId);
    if (fresh?.passedAt !== null && fresh?.passedAt !== undefined) return t;
    for (const card of cards) {
      if (card.state !== 'review') continue;
      t = Math.max(t, card.dueAt ?? t) + HOUR;
      await commitReview({
        cardId: card.id,
        sessionId: 'sess',
        outcome: { kind: 'ladder', incorrectCount: 0 },
        now: t,
      });
    }
  }
  throw new Error(`item never passed: ${itemId}`);
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('Japanese seed wiring', () => {
  it('installs three types, level gating, and locks everything downstream', async () => {
    const courseId = await install();
    const course = (await db.courses.get(courseId))!;
    expect(course.levelMode).toBe('levels');
    expect(course.currentLevel).toBe(1);

    const types = await db.itemTypes.where('courseId').equals(courseId).toArray();
    expect(types.map((t) => t.name).sort()).toEqual(['Kanji', 'Radical', 'Vocab']);
    // the level gate is the Kanji type
    const kanjiType = types.find((t) => t.name === 'Kanji')!;
    expect(course.levelConfig?.gateTypeIds).toEqual([kanjiType.id]);
    // kanji/vocab generate meaning + reading cards
    const kanji = await findItem(courseId, 'Kanji', '人');
    expect(await db.cards.where('itemId').equals(kanji.id).count()).toBe(2);
    const radical = await findItem(courseId, 'Radical', '人');
    expect(await db.cards.where('itemId').equals(radical.id).count()).toBe(1);

    const items = await itemsOf(courseId);
    // only level-1 radicals (no prereqs) are teachable at install
    const open = items.filter((i) => i.status === 'lesson');
    expect(open).toHaveLength(5);
    expect(open.every((i) => i.level === 1 && i.prereqIds.length === 0)).toBe(true);
    // everything else is locked, including all of level 2
    expect(items.filter((i) => i.level === 2).every((i) => i.status === 'locked')).toBe(true);
  });

  it('lesson pool only offers unlocked items', async () => {
    const courseId = await install();
    const pool = await lessonPool(courseId);
    expect(pool).toHaveLength(5);
    expect(pool.every((i) => i.status === 'lesson')).toBe(true);
  });
});

describe('prerequisite cascade', () => {
  it('passing a radical unlocks its kanji, passing the kanji unlocks its vocab', async () => {
    const courseId = await install();
    const radical = await findItem(courseId, 'Radical', '日');
    const kanji = await findItem(courseId, 'Kanji', '日');
    const vocab = await findItem(courseId, 'Vocab', '日本');

    expect((await db.items.get(kanji.id))!.status).toBe('locked');
    const t1 = await passItem(radical.id, NOW);
    expect((await db.items.get(radical.id))!.passedAt).not.toBeNull();
    expect((await db.items.get(kanji.id))!.status).toBe('lesson');
    // the vocab is still gated behind the kanji
    expect((await db.items.get(vocab.id))!.status).toBe('locked');

    await passItem(kanji.id, t1);
    expect((await db.items.get(vocab.id))!.status).toBe('lesson');
  });

  it('a diamond kanji waits for BOTH radicals (and its level)', async () => {
    const courseId = await install();
    // 海 requires the water radical AND the person radical, at level 2
    const sea = await findItem(courseId, 'Kanji', '海');
    expect(sea.prereqIds).toHaveLength(2);
    const [waterId, personId] = sea.prereqIds;
    expect(sea.level).toBe(2);

    await passItem(personId, NOW);
    expect((await db.items.get(sea.id))!.status).toBe('locked'); // water still pending

    // satisfy the second prereq; the LEVEL gate must still hold it shut
    await db.items.update(waterId, { passedAt: NOW + HOUR });
    await recomputeUnlocks(courseId, NOW + HOUR);
    expect((await db.items.get(sea.id))!.status).toBe('locked');

    // only once the course reaches level 2 does the diamond open
    const course = (await db.courses.get(courseId))!;
    await db.courses.put({ ...course, currentLevel: 2 });
    await recomputeUnlocks(courseId, NOW + 2 * HOUR);
    expect((await db.items.get(sea.id))!.status).toBe('lesson');
  });

  it('passedAt is sticky: a later miss does not re-lock dependents', async () => {
    const courseId = await install();
    const radical = await findItem(courseId, 'Radical', '木');
    const kanji = await findItem(courseId, 'Kanji', '木');
    const t = await passItem(radical.id, NOW);
    expect((await db.items.get(kanji.id))!.status).toBe('lesson');

    // tank the radical with a wrong answer
    const card = (await db.cards.where('itemId').equals(radical.id).toArray())[0];
    await commitReview({
      cardId: card.id,
      sessionId: 's',
      outcome: { kind: 'ladder', incorrectCount: 4 },
      now: t + HOUR,
    });
    expect((await db.items.get(radical.id))!.passedAt).not.toBeNull();
    expect((await db.items.get(kanji.id))!.status).toBe('lesson');
  });
});

describe('level ups', () => {
  it('passing 90% of level-1 kanji advances the course and opens level 2', async () => {
    const courseId = await install();
    const items = await itemsOf(courseId);
    const types = await db.itemTypes.where('courseId').equals(courseId).toArray();
    const kanjiTypeId = types.find((t) => t.name === 'Kanji')!.id;
    const l1Kanji = items.filter((i) => i.typeId === kanjiTypeId && i.level === 1);
    expect(l1Kanji).toHaveLength(4); // threshold = ceil(4 * 0.9) = 4

    // pass the moon radical too — its kanji sits in level 2, so the level-up
    // cascade should open it the moment the course advances
    const moonRadical = await findItem(courseId, 'Radical', '月');
    let t = await passItem(moonRadical.id, NOW);
    for (const [idx, kanji] of l1Kanji.entries()) {
      for (const prereqId of kanji.prereqIds) t = await passItem(prereqId, t);
      t = await passItem(kanji.id, t);
      const course = (await db.courses.get(courseId))!;
      // only the last one crosses the threshold
      expect(course.currentLevel).toBe(idx === l1Kanji.length - 1 ? 2 : 1);
    }

    const after = await itemsOf(courseId);
    // level-2 radicals have no prereqs → open immediately on level up
    const l2Radicals = after.filter(
      (i) => i.level === 2 && i.prereqIds.length === 0,
    );
    expect(l2Radicals.length).toBeGreaterThan(0);
    expect(l2Radicals.every((i) => i.status === 'lesson')).toBe(true);
    // 月's radical passed during level 1, so its level-2 kanji opens on level-up
    const moonKanji = after.find(
      (i) => i.typeId === kanjiTypeId && i.prereqIds.includes(moonRadical.id),
    )!;
    expect(moonKanji.level).toBe(2);
    expect(moonKanji.status).toBe('lesson');
    // 火 and 海 stay locked — their radicals are level-2 and unpassed
    const seaKanji = after.find((i) => Object.values(i.fieldValues).includes('海'))!;
    expect(seaKanji.status).toBe('locked');
  });

  it('commitReview reports the cascade for the session summary', async () => {
    const courseId = await install();
    const radical = await findItem(courseId, 'Radical', '口');
    await completeLessonBatch([radical.id], 's', NOW);
    let t = NOW;
    let sawUnlock = false;
    for (let i = 0; i < 6; i++) {
      const card = (await db.cards.where('itemId').equals(radical.id).toArray())[0];
      if (card.state !== 'review') break;
      t = (card.dueAt ?? t) + HOUR;
      const res = await commitReview({
        cardId: card.id,
        sessionId: 's',
        outcome: { kind: 'ladder', incorrectCount: 0 },
        now: t,
      });
      if (res.gating.itemPassed) {
        expect(res.gating.unlockedItemIds.length).toBeGreaterThan(0);
        sawUnlock = true;
        break;
      }
    }
    expect(sawUnlock).toBe(true);
  });
});

describe('flat courses have no level gate', () => {
  it('switching to flat opens items above the current level', async () => {
    const courseId = await install();
    const before = (await itemsOf(courseId)).filter((i) => i.level === 2);
    expect(before.every((i) => i.status === 'locked')).toBe(true);

    const course = (await db.courses.get(courseId))!;
    await db.courses.put({ ...course, levelMode: 'flat' });
    await recomputeUnlocks(courseId, NOW + HOUR);

    const after = (await itemsOf(courseId)).filter((i) => i.level === 2);
    // level-2 items with no prereqs must now be studiable
    expect(after.filter((i) => i.prereqIds.length === 0).every((i) => i.status === 'lesson')).toBe(
      true,
    );
    // prereq gating still applies in flat mode
    expect(after.filter((i) => i.prereqIds.length > 0).every((i) => i.status === 'locked')).toBe(
      true,
    );
  });

  it('createItem in a flat course ignores the level number', async () => {
    const courseId = await install();
    const course = (await db.courses.get(courseId))!;
    await db.courses.put({ ...course, levelMode: 'flat' });
    const types = await db.itemTypes.where('courseId').equals(courseId).toArray();
    const radicalType = types.find((t) => t.name === 'Radical')!;
    const created = await createItem(
      {
        courseId,
        typeId: radicalType.id,
        level: 9,
        fieldValues: {
          [radicalType.fields[0].id]: '囗',
          [radicalType.fields[1].id]: 'enclosure',
        },
      },
      NOW,
    );
    expect(created.status).toBe('lesson');
  });
});

describe('deleteItem repairs the graph', () => {
  it('strips the deleted id from dependents and re-settles them', async () => {
    const courseId = await install();
    const sea = await findItem(courseId, 'Kanji', '海'); // needs water + person
    const [waterId, personId] = sea.prereqIds;
    await passItem(personId, NOW);
    // make the level stop interfering so the prereq effect is visible
    const course = (await db.courses.get(courseId))!;
    await db.courses.put({ ...course, levelMode: 'flat' });
    await recomputeUnlocks(courseId, NOW + HOUR);
    expect((await db.items.get(sea.id))!.status).toBe('locked'); // water pending

    await deleteItem(waterId, NOW + 2 * HOUR);
    const after = (await db.items.get(sea.id))!;
    expect(after.prereqIds).toEqual([personId]); // dangling edge scrubbed
    expect(after.status).toBe('lesson'); // remaining prereq already passed
  });
});

describe('recomputeUnlocks', () => {
  it('re-evaluates the level threshold after a gate-type change', async () => {
    const courseId = await install();
    // pass every level-1 radical, but no kanji
    const radicals = (await itemsOf(courseId)).filter(
      (i) => i.level === 1 && i.prereqIds.length === 0,
    );
    let t = NOW;
    for (const r of radicals) t = await passItem(r.id, t);
    expect((await db.courses.get(courseId))!.currentLevel).toBe(1); // kanji gate unmet

    // switch the gate to Radicals — the threshold is now already satisfied
    const types = await db.itemTypes.where('courseId').equals(courseId).toArray();
    const radicalTypeId = types.find((ty) => ty.name === 'Radical')!.id;
    const course = (await db.courses.get(courseId))!;
    await db.courses.put({
      ...course,
      levelConfig: { gateTypeIds: [radicalTypeId], passPercent: 90 },
    });
    await recomputeUnlocks(courseId, t + HOUR);

    expect((await db.courses.get(courseId))!.currentLevel).toBe(2);
  });

  it('breaks prerequisite cycles instead of locking both items forever', async () => {
    const courseId = await install();
    const a = await findItem(courseId, 'Radical', '人');
    const b = await findItem(courseId, 'Radical', '木');
    await db.items.update(a.id, { prereqIds: [b.id], status: 'locked' });
    await db.items.update(b.id, { prereqIds: [a.id], status: 'locked' });

    await recomputeUnlocks(courseId, NOW + HOUR);
    const [aa, bb] = [(await db.items.get(a.id))!, (await db.items.get(b.id))!];
    // exactly one edge is cut — enough to break the deadlock, and the surviving
    // edge keeps as much of the author's intent as possible
    const edges = aa.prereqIds.length + bb.prereqIds.length;
    expect(edges).toBe(1);
    // and the graph is no longer a cycle: at least one side is studiable now
    expect([aa.status, bb.status]).toContain('lesson');
  });


  it('re-locks items whose prereqs were edited in, and heals dangling refs', async () => {
    const courseId = await install();
    const radical = await findItem(courseId, 'Radical', '人');
    const kanji = await findItem(courseId, 'Kanji', '人');
    await passItem(radical.id, NOW);
    expect((await db.items.get(kanji.id))!.status).toBe('lesson');

    // point the kanji at a prereq that no longer exists + one that hasn't passed
    const unpassed = await findItem(courseId, 'Radical', '月');
    await db.items.update(kanji.id, { prereqIds: ['deleted-item-id', unpassed.id] });
    const res = await recomputeUnlocks(courseId, NOW + HOUR);
    expect(res.changed).toBeGreaterThan(0);

    const healed = (await db.items.get(kanji.id))!;
    expect(healed.prereqIds).toEqual([unpassed.id]); // dangling ref dropped
    expect(healed.status).toBe('locked'); // real prereq still pending
  });

  it('is idempotent on a settled course', async () => {
    const courseId = await install();
    await recomputeUnlocks(courseId, NOW);
    const before = await itemsOf(courseId);
    await recomputeUnlocks(courseId, NOW + HOUR);
    const after = await itemsOf(courseId);
    expect(after.map((i) => i.status).sort()).toEqual(before.map((i) => i.status).sort());
  });
});
