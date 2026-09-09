import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { addProposals } from '@/db/repo/proposals';
import { dryRunProposal } from '@/packages/resolveContent';
import type { Course, ItemType, ProposalItem } from '@/engine/types';
import { createCourseWithType } from './contentCommands';
import {
  createBlankItemType,
  deleteItemType,
  makeBlankItemType,
  saveItemTypeEdit,
} from './itemTypes';
import { acceptProposals } from './proposals';

const NOW = 1000;
let course: Course;
let type: ItemType;
beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
  await ensurePresets();
  course = await createCourseWithType({ name: 'Proposals', ladderPresetId: 'preset-classic' }, NOW);
  type = (await db.itemTypes.where('courseId').equals(course.id).toArray())[0];
});
afterEach(() => vi.restoreAllMocks());

async function propose(item: ProposalItem) {
  const types = await db.itemTypes.where('courseId').equals(course.id).toArray();
  const [proposal] = await addProposals(
    course.id,
    null,
    'manual',
    [{ level: 1, item, ...dryRunProposal(item, types, []) }],
    NOW,
  );
  return proposal;
}

it('correcting a type clears its stale proposal error and makes the row individually acceptable', async () => {
  const proposal = await propose({
    type: type.name,
    fields: { Front: 'Question', Answer: 'Answer' },
  });
  expect(proposal.error).not.toBeNull();
  await saveItemTypeEdit(
    {
      ...type,
      fields: type.fields.map((field) =>
        field.name === 'Back' ? { ...field, name: 'Answer' } : field,
      ),
    },
    NOW + 1,
  );
  expect(await db.proposals.get(proposal.id)).toMatchObject({ error: null, updatedAt: NOW + 1 });
  expect((await acceptProposals([proposal.id], NOW + 2)).accepted).toEqual([proposal.id]);
});

it.each(['draft', 'blank'] as const)(
  'creating a %s type resolves pending unknown-type errors',
  async (creation) => {
    const proposal = await propose({
      type: 'New type',
      fields: { Front: 'Question', Back: 'Answer' },
    });
    expect(proposal.error).not.toBeNull();
    if (creation === 'draft')
      await saveItemTypeEdit(makeBlankItemType(course.id, NOW), NOW + 1, { create: true });
    else await createBlankItemType(course.id, NOW + 1);
    expect(await db.proposals.get(proposal.id)).toMatchObject({ error: null, updatedAt: NOW + 1 });
  },
);

it('deleting a type marks its pending proposals invalid in the same command', async () => {
  const extra = await createBlankItemType(course.id, NOW);
  const proposal = await propose({
    type: extra.name,
    fields: { Front: 'Question', Back: 'Answer' },
  });
  expect(proposal.error).toBeNull();
  await deleteItemType(extra.id, NOW + 1);
  expect((await db.proposals.get(proposal.id))?.error).toMatch(/unknown item type/i);
});

it('a failed proposal refresh rolls back the type edit and keeps the old validation together', async () => {
  const proposal = await propose({
    type: type.name,
    fields: { Front: 'Question', Answer: 'Answer' },
  });
  const write = vi
    .spyOn(db.proposals, 'put')
    .mockRejectedValueOnce(new Error('validation storage failed'));
  await expect(
    saveItemTypeEdit(
      {
        ...type,
        fields: type.fields.map((field) =>
          field.name === 'Back' ? { ...field, name: 'Answer' } : field,
        ),
      },
      NOW + 1,
    ),
  ).rejects.toThrow('validation storage failed');
  write.mockRestore();
  expect(await db.itemTypes.get(type.id)).toEqual(type);
  expect(await db.proposals.get(proposal.id)).toEqual(proposal);
});
