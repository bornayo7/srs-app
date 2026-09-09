import { beforeEach, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { deleteItem } from '@/db/repo/items';
import { planForCourse } from '@/db/repo/plans';
import { applyPacket } from '@/packages/importPacket';
import { parsePacket } from '@/packages/schema';
import { appendUnit, updateUnit } from './plans';
import { acceptProposals } from './proposals';
import { parseReleaseAt } from './releaseDates';

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
  await ensurePresets();
});
const packet = () =>
  parsePacket({
    format: 'srs-packet',
    version: 2,
    id: 'stable-delivery',
    kind: 'course-plan',
    course: { name: 'Integrity', releaseMode: 'manual' },
    itemTypes: [
      {
        name: 'Term',
        fields: [{ name: 'Front' }, { name: 'Back' }],
        templates: [{ name: 'Recall', promptFields: ['Front'], answerField: 'Back' }],
      },
    ],
    units: [
      {
        title: 'First',
        items: [
          { key: 'root', fields: { Front: 'Root', Back: 'First' } },
          { key: 'child', prereqs: ['root'], fields: { Front: 'Child', Back: 'Next' } },
          { fields: { Front: 'Sibling', Back: 'Independent' } },
        ],
      },
      { title: 'Second' },
    ],
  });

it('does not reapply a stable delivery and rejects the same ID carrying other content', async () => {
  const source = packet();
  await applyPacket(source, 100);
  expect(await applyPacket(source, 101)).toMatchObject({ alreadyImported: true });
  expect(await db.courses.count()).toBe(1);
  await expect(
    applyPacket(parsePacket({ ...source, material: 'changed bytes' }), 102),
  ).rejects.toThrow(/different content/);
  expect(await db.proposals.count()).toBe(3);
});

it('deduplicates a repeated selection before accepting candidates', async () => {
  await applyPacket(packet(), 100);
  const root = (await db.proposals.toArray()).find((proposal) => proposal.item.key === 'root')!;
  const result = await acceptProposals([root.id, root.id], 101);
  expect(result.accepted).toEqual([root.id]);
  expect(await db.items.count()).toBe(1);
});

it('holds a deleted accepted prerequisite while committing an unrelated valid sibling', async () => {
  await applyPacket(packet(), 100);
  const rows = await db.proposals.toArray();
  const root = rows.find((proposal) => proposal.item.key === 'root')!;
  const child = rows.find((proposal) => proposal.item.key === 'child')!;
  const sibling = rows.find((proposal) => proposal.item.fields.Front === 'Sibling')!;
  const accepted = await acceptProposals([root.id], 101);
  await deleteItem(accepted.itemIds[0], 102);
  const result = await acceptProposals([child.id, sibling.id], 103);
  expect(result.accepted).toEqual([sibling.id]);
  expect(result.skipped).toEqual([
    expect.objectContaining({ id: child.id, reason: expect.stringMatching(/deleted|missing/) }),
  ]);
});

it('preserves simultaneous unit patches and appends', async () => {
  const { courseId } = await applyPacket(packet(), 100);
  await Promise.all([
    updateUnit(courseId, 1, { title: 'Edited first' }, 101),
    updateUnit(courseId, 2, { title: 'Edited second' }, 101),
  ]);
  await Promise.all(
    ['Third', 'Fourth'].map((title) =>
      appendUnit(courseId, { title, summary: '', topics: [], targetCount: 5 }, 102),
    ),
  );
  const units = (await planForCourse(courseId))!.units;
  expect(units.slice(0, 2).map((unit) => unit.title)).toEqual(['Edited first', 'Edited second']);
  expect(units.map((unit) => unit.level)).toEqual([1, 2, 3, 4]);
  expect(new Set(units.slice(2).map((unit) => unit.title))).toEqual(new Set(['Third', 'Fourth']));
});

it('refuses duplicate live proposal handles', async () => {
  const { courseId } = await applyPacket(packet(), 100);
  await expect(
    applyPacket(
      parsePacket({
        format: 'srs-packet',
        version: 2,
        kind: 'propose-items',
        courseId,
        items: [{ key: 'root', fields: { Front: 'Other', Back: 'Meaning' } }],
      }),
      101,
    ),
  ).rejects.toThrow(/already|used|duplicate/i);
  expect(await db.proposals.count()).toBe(3);
});

it('validates actual calendar values and rejects nonfinite persisted dates', async () => {
  expect(parseReleaseAt('2026-02-30')).toBeNull();
  expect(parseReleaseAt('2028-02-29')).toBe(Date.UTC(2028, 1, 29));
  expect(parseReleaseAt('2026-09')).toBeNull();
  const { courseId } = await applyPacket(packet(), 100);
  await expect(updateUnit(courseId, 1, { releaseAt: NaN }, 101)).rejects.toThrow(/date/);
  expect((await planForCourse(courseId))!.units[0].releaseAt).toBeUndefined();
});
