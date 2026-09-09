import { beforeEach, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourseWithType } from './contentCommands';
import { createItemType } from '@/db/repo/itemTypes';
import { addProposals } from '@/db/repo/proposals';
import { resolvePacketItem } from '@/packages/resolveContent';
import { acceptProposals } from './proposals';
import type { Course, ItemType, ProposalItem } from '@/engine/types';

let course: Course;
let basic: ItemType;
beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
  await ensurePresets();
  course = await createCourseWithType(
    { name: 'Integrity fixture', ladderPresetId: 'preset-classic' },
    1000,
  );
  basic = (await db.itemTypes.where('courseId').equals(course.id).toArray())[0];
});

it('holds incompatible media without rolling back valid proposals in the same batch', async () => {
  const picture = await createItemType(
    course.id,
    {
      name: 'Picture',
      icon: 'P',
      color: '#175f60',
      fields: [
        { name: 'Image', kind: 'image' },
        { name: 'Answer', kind: 'text' },
      ],
      templates: [
        {
          name: 'Identify',
          promptFieldNames: ['Image'],
          answerFieldName: 'Answer',
          grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
        },
      ],
    },
    1000,
  );
  await db.media.add({
    id: 'audio-asset',
    blob: new Blob(['audio']),
    mimeType: 'audio/mpeg',
    name: 'audio.mp3',
    createdAt: 1000,
  });
  const rows = await addProposals(
    course.id,
    null,
    'manual',
    [
      {
        level: 1,
        item: {
          type: basic.name,
          fields: Object.fromEntries(basic.fields.map((field) => [field.name, 'Valid content'])),
        },
        error: null,
        duplicateOf: null,
      },
      {
        level: 1,
        item: {
          type: picture.name,
          fields: { Image: 'audio-asset', Answer: 'This requires a picture' },
        },
        error: null,
        duplicateOf: null,
      },
    ],
    1000,
  );
  const result = await acceptProposals(
    rows.map((row) => row.id),
    2000,
  );
  expect(result.accepted).toEqual([rows[0].id]);
  expect(result.skipped).toEqual([
    { id: rows[1].id, reason: expect.stringContaining('incompatible media') },
  ]);
  expect(await db.items.count()).toBe(1);
  expect((await db.proposals.get(rows[1].id))?.status).toBe('pending');
});

it.each(['synonyms', 'blockList', 'guidance'] as const)(
  'rejects case-colliding %s template names before discarding either value',
  (policy) => {
    const template = basic.templates[0].name;
    const first =
      policy === 'guidance' ? [{ text: 'first', message: 'Keep this rule' }] : ['first'];
    const second =
      policy === 'guidance' ? [{ text: 'second', message: 'Keep this too' }] : ['second'];
    const candidate: ProposalItem = {
      type: basic.name,
      fields: Object.fromEntries(basic.fields.map((field) => [field.name, 'Valid content'])),
      [policy]: { [template.toLowerCase()]: first, [template.toUpperCase()]: second },
    };
    expect(() => resolvePacketItem(candidate, [basic])).toThrow(/repeated template/);
  },
);
