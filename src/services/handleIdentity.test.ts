import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourse } from '@/db/repo/courses';
import { createItem } from '@/db/repo/items';
import { createItemType, basicTypeSpec } from '@/db/repo/itemTypes';
import { addProposals } from '@/db/repo/proposals';
import { exportCoursePackage } from '@/packages/exportPackage';
import { applyPacket } from '@/packages/importPacket';
import { saveCourseSettings } from './contentCommands';
import { acceptProposals } from './proposals';

const NOW = new Date(2026, 8, 8, 10).getTime();
beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
});
async function seed() {
  const course = await createCourse({ name: 'Identity', ladderPresetId: 'preset-classic' }, NOW);
  const type = await createItemType(course.id, basicTypeSpec(), NOW);
  const item = await createItem(
    {
      courseId: course.id,
      typeId: type.id,
      fieldValues: { [type.fields[0].id]: 'Original', [type.fields[1].id]: 'answer' },
    },
    NOW,
  );
  return { course, type, item };
}

describe('prerequisite handles never shadow existing item identities', () => {
  it('rejects a new proposal key that would reinterpret an existing item id', async () => {
    const { course, item } = await seed();
    await expect(
      addProposals(
        course.id,
        null,
        'manual',
        [
          {
            level: 1,
            item: {
              key: item.id,
              fields: { Front: 'Shadow', Back: 'answer' },
            },
            error: null,
            duplicateOf: null,
          },
        ],
        NOW,
      ),
    ).rejects.toThrow(/existing item/);
    expect(await db.proposals.count()).toBe(0);
  });

  it('holds legacy collisions instead of silently redirecting a dependent', async () => {
    const { course, item } = await seed();
    const [shadow, dependent] = await addProposals(
      course.id,
      null,
      'manual',
      [
        {
          level: 1,
          item: { key: 'shadow', fields: { Front: 'Shadow', Back: 'answer' } },
          error: null,
          duplicateOf: null,
        },
        {
          level: 1,
          item: { fields: { Front: 'Dependent', Back: 'answer' }, prereqs: [item.id] },
          error: null,
          duplicateOf: null,
        },
      ],
      NOW,
    );
    await acceptProposals([shadow.id], NOW);
    const accepted = (await db.proposals.get(shadow.id))!;
    await db.proposals.put({ ...accepted, item: { ...accepted.item, key: item.id } });
    const result = await acceptProposals([dependent.id], NOW);
    expect(result.accepted).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/ambiguous/);
    expect((await db.proposals.get(dependent.id))!.status).toBe('pending');
  });

  it('direct add-items also rejects a packet key that shadows a live item id', async () => {
    const { course, item } = await seed();
    await expect(
      applyPacket(
        {
          format: 'srs-packet',
          version: 2,
          kind: 'add-items',
          courseId: course.id,
          items: [
            { key: item.id, fields: { Front: 'Shadow', Back: 'answer' } },
            { prereqs: [item.id], fields: { Front: 'Dependent', Back: 'answer' } },
          ],
        },
        NOW,
      ),
    ).rejects.toThrow(/existing item/);
    expect(await db.items.count()).toBe(1);
  });
});

it('a valid fractional pass threshold exports and imports without changing it', async () => {
  const { course } = await seed();
  await saveCourseSettings(
    course.id,
    { levelMode: 'levels', levelConfig: { passPercent: 92.5 } },
    NOW,
  );
  const packet = await exportCoursePackage(course.id);
  const imported = await applyPacket(packet, NOW);
  expect((await db.courses.get(imported.courseId))!.levelConfig!.passPercent).toBe(92.5);
});
