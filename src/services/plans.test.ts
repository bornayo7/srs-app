import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { planForCourse } from '@/db/repo/plans';
import { proposalsForCourse } from '@/db/repo/proposals';
import { applyPacket } from '@/packages/importPacket';
import { parsePacket, PACKET_FORMAT, PACKET_VERSION } from '@/packages/schema';
import type { Proposal } from '@/engine/types';
import {
  acceptAllValid,
  acceptProposals,
  recheckPending,
  rejectProposals,
  restoreProposals,
  updateProposalItem,
} from './proposals';
import {
  appendUnit,
  createPlannedCourse,
  planProgress,
  releaseNextUnit,
  setReleaseMode,
  syncAllScheduledReleases,
  syncScheduledRelease,
  updateUnit,
} from './plans';

const NOW = Date.UTC(2026, 8, 1, 9, 0); // 2026-09-01

const SEP_10 = Date.UTC(2026, 8, 10);
const SEP_20 = Date.UTC(2026, 8, 20);
const OCT_5 = Date.UTC(2026, 9, 5);

const termType = {
  name: 'Term',
  fields: [{ name: 'Term' }, { name: 'Definition' }],
  templates: [{ name: 'Define', promptFields: ['Term'], answerField: 'Definition' }],
};

function planPacket(releaseMode: 'progress' | 'schedule' | 'manual' = 'manual') {
  return parsePacket({
    format: PACKET_FORMAT,
    version: PACKET_VERSION,
    kind: 'course-plan',
    course: { name: 'Bio', releaseMode },
    itemTypes: [termType],
    units: [
      {
        title: 'Cells',
        releaseAt: '2026-09-01',
        items: [
          { key: 'cell', fields: { Term: 'cell', Definition: 'basic unit of life' } },
          { key: 'membrane', prereqs: ['cell'], fields: { Term: 'membrane', Definition: 'boundary' } },
          { fields: { Term: 'bad', Nope: 'x' } },
        ],
      },
      {
        title: 'Genetics',
        releaseAt: '2026-09-15',
        items: [{ key: 'gene', prereqs: ['membrane'], fields: { Term: 'gene', Definition: 'unit of heredity' } }],
      },
      { title: 'Evolution', releaseAt: '2026-10-01' },
    ],
  });
}

async function setup(releaseMode: 'progress' | 'schedule' | 'manual' = 'manual') {
  const res = await applyPacket(planPacket(releaseMode), NOW);
  const proposals = await proposalsForCourse(res.courseId);
  const byTerm = (term: string): Proposal =>
    proposals.find((p) => p.item.fields.Term === term) ??
    (() => {
      throw new Error(`no proposal ${term}`);
    })();
  return { courseId: res.courseId, byTerm };
}

const item = (id: string) => db.items.get(id).then((i) => i!);
const course = (id: string) => db.courses.get(id).then((c) => c!);

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
});

describe('acceptProposals', () => {
  it('creates items at the unit level — lesson if released, locked otherwise — and resolves keys across batches', async () => {
    const { byTerm } = await setup();
    const first = await acceptProposals([byTerm('cell').id], NOW + 1);
    expect(first.accepted).toEqual([byTerm('cell').id]);
    const cell = await item(first.itemIds[0]);
    expect(cell.level).toBe(1);
    expect(cell.status).toBe('lesson');
    expect((await db.proposals.get(byTerm('cell').id))!).toMatchObject({
      status: 'accepted',
      acceptedItemId: cell.id,
      decidedAt: NOW + 1,
    });

    const second = await acceptProposals([byTerm('membrane').id], NOW + 2);
    const membrane = await item(second.itemIds[0]);
    expect(membrane.prereqIds).toEqual([cell.id]); // handle → the accepted item
    expect(membrane.status).toBe('locked'); // cell hasn't passed yet

    const third = await acceptProposals([byTerm('gene').id], NOW + 3);
    const gene = await item(third.itemIds[0]);
    expect(gene.level).toBe(2);
    expect(gene.prereqIds).toEqual([membrane.id]);
    expect(gene.status).toBe('locked'); // unit 2 isn't released
    expect(third.warnings).toEqual([]);
  });

  it('holds an item whose prerequisite is still pending, and drops a rejected one with a warning', async () => {
    const { byTerm } = await setup();
    const held = await acceptProposals([byTerm('membrane').id], NOW + 1);
    expect(held.accepted).toEqual([]);
    expect(held.skipped[0].reason).toMatch(/"cell" hasn't been accepted yet/);
    const row = (await db.proposals.get(byTerm('membrane').id))!;
    expect(row.status).toBe('pending');
    expect(row.error).toMatch(/hasn't been accepted/);

    await rejectProposals([byTerm('cell').id], 'trivial', NOW + 2);
    const dropped = await acceptProposals([byTerm('membrane').id], NOW + 3);
    expect(dropped.accepted).toHaveLength(1);
    expect(dropped.warnings[0]).toMatch(/dropped prerequisite "cell"/);
    const membrane = await item(dropped.itemIds[0]);
    expect(membrane.prereqIds).toEqual([]);
    expect(membrane.status).toBe('lesson');
    expect((await db.proposals.get(byTerm('membrane').id))!.error).toBeNull();
  });

  it('accepts a dependent and its prerequisite in the same batch, whatever the id order', async () => {
    const { byTerm } = await setup();
    const res = await acceptProposals([byTerm('membrane').id, byTerm('cell').id], NOW + 1);
    expect(res.accepted).toHaveLength(2);
    expect(res.skipped).toEqual([]);
    const cellId = (await db.proposals.get(byTerm('cell').id))!.acceptedItemId!;
    const membraneId = (await db.proposals.get(byTerm('membrane').id))!.acceptedItemId!;
    expect((await item(membraneId)).prereqIds).toEqual([cellId]);
  });

  it('skips a row that fails validation, keeps it pending with the error, and accepts it once edited', async () => {
    const { byTerm } = await setup();
    const bad = byTerm('bad');
    expect(bad.error).toMatch(/unknown field "Nope"/);
    const res = await acceptProposals([bad.id], NOW + 1);
    expect(res.accepted).toEqual([]);
    expect(res.skipped[0].reason).toMatch(/unknown field/);
    expect((await db.proposals.get(bad.id))!.status).toBe('pending');

    const fixed = await updateProposalItem(
      bad.id,
      { fields: { Term: 'allele', Definition: 'gene variant' } },
      NOW + 2,
    );
    expect(fixed.error).toBeNull();
    expect(fixed.item.level).toBe(1); // the unit still owns the level
    const ok = await acceptProposals([bad.id], NOW + 3);
    expect(ok.accepted).toEqual([bad.id]);
    expect(Object.values((await item(ok.itemIds[0])).fieldValues)).toContain('allele');
  });

  it('ignores ids that are not pending and refuses mixed courses', async () => {
    const { courseId, byTerm } = await setup();
    await acceptProposals([byTerm('cell').id], NOW + 1);
    const again = await acceptProposals([byTerm('cell').id, 'nope'], NOW + 2);
    expect(again.accepted).toEqual([]);
    expect(await db.items.where('courseId').equals(courseId).count()).toBe(1);

    const other = await applyPacket(planPacket(), NOW + 5);
    const otherPending = await proposalsForCourse(other.courseId, 'pending');
    await expect(
      acceptProposals([byTerm('membrane').id, otherPending[0].id], NOW + 6),
    ).rejects.toThrow(/more than one course/);
  });
});

describe('review verbs', () => {
  it('reject records the reason; restore returns to pending with fresh checks', async () => {
    const { byTerm } = await setup();
    expect(await rejectProposals([byTerm('cell').id], '  too easy ', NOW + 1)).toBe(1);
    const rejected = (await db.proposals.get(byTerm('cell').id))!;
    expect(rejected).toMatchObject({ status: 'rejected', rejectReason: 'too easy', decidedAt: NOW + 1 });
    // rejecting twice is a no-op
    expect(await rejectProposals([byTerm('cell').id], 'again', NOW + 2)).toBe(0);

    expect(await restoreProposals([byTerm('cell').id], NOW + 3)).toBe(1);
    const restored = (await db.proposals.get(byTerm('cell').id))!;
    expect(restored).toMatchObject({ status: 'pending', rejectReason: null, decidedAt: null, error: null });
  });

  it('editing a rejected row brings it back as pending; accepted rows are read-only', async () => {
    const { byTerm } = await setup();
    await rejectProposals([byTerm('cell').id], '', NOW + 1);
    const edited = await updateProposalItem(
      byTerm('cell').id,
      { key: 'cell', fields: { Term: 'the cell', Definition: 'basic unit of life' } },
      NOW + 2,
    );
    expect(edited.status).toBe('pending');
    expect(edited.rejectReason).toBeNull();
    expect(edited.item.key).toBe('cell');

    await acceptProposals([byTerm('cell').id], NOW + 3);
    await expect(
      updateProposalItem(byTerm('cell').id, { fields: { Term: 'x', Definition: 'y' } }, NOW + 4),
    ).rejects.toThrow(/already accepted/);
  });

  it('acceptAllValid takes every clean pending row of a unit and leaves the flawed one', async () => {
    const { courseId, byTerm } = await setup();
    const res = await acceptAllValid(courseId, NOW + 1, 1);
    expect(res.accepted.sort()).toEqual([byTerm('cell').id, byTerm('membrane').id].sort());
    expect((await db.proposals.get(byTerm('bad').id))!.status).toBe('pending');
    expect((await db.proposals.get(byTerm('gene').id))!.status).toBe('pending'); // unit 2 untouched
  });

  it('recheckPending flags a new duplicate once a matching item exists', async () => {
    const { courseId, byTerm } = await setup();
    await acceptProposals([byTerm('cell').id], NOW + 1);
    // a second "cell" proposal arrives later via propose-items
    await applyPacket(
      parsePacket({
        format: PACKET_FORMAT,
        version: PACKET_VERSION,
        kind: 'propose-items',
        courseId,
        items: [{ fields: { Term: 'Cell', Definition: 'dup' } }],
      }),
      NOW + 2,
    );
    const dup = (await proposalsForCourse(courseId, 'pending')).find((p) => p.item.fields.Term === 'Cell')!;
    expect(dup.duplicateOf).toBe((await db.proposals.get(byTerm('cell').id))!.acceptedItemId);
    // clear it by hand, then recheck restores the flag
    await db.proposals.put({ ...dup, duplicateOf: null });
    expect(await recheckPending(courseId, NOW + 3)).toBe(1);
    expect((await db.proposals.get(dup.id))!.duplicateOf).not.toBeNull();
  });
});

describe('release', () => {
  it('manual: releaseNextUnit opens the next unit, unlocks its items, and stops at the last unit', async () => {
    const { courseId } = await setup('manual');
    await applyPacket(
      parsePacket({
        format: PACKET_FORMAT,
        version: PACKET_VERSION,
        kind: 'propose-items',
        courseId,
        unit: 2,
        items: [{ fields: { Term: 'allele', Definition: 'variant' } }],
      }),
      NOW + 1,
    );
    const allele = (await proposalsForCourse(courseId, 'pending')).find((p) => p.item.fields.Term === 'allele')!;
    const res = await acceptProposals([allele.id], NOW + 2);
    expect((await item(res.itemIds[0])).status).toBe('locked');

    expect(await releaseNextUnit(courseId, NOW + 3)).toBe(2);
    expect((await course(courseId)).currentLevel).toBe(2);
    expect((await item(res.itemIds[0])).status).toBe('lesson');

    expect(await releaseNextUnit(courseId, NOW + 4)).toBe(3);
    expect(await releaseNextUnit(courseId, NOW + 5)).toBeNull(); // no unit 4
    expect((await course(courseId)).currentLevel).toBe(3);
  });

  it('schedule: the level floor follows unit dates and never goes backwards', async () => {
    const { courseId } = await setup('schedule');
    expect((await course(courseId)).levelConfig?.autoAdvance).toBe(false);
    expect(await syncScheduledRelease(courseId, SEP_10)).toBeNull(); // unit 2 opens Sep 15
    expect((await course(courseId)).currentLevel).toBe(1);
    expect(await syncScheduledRelease(courseId, SEP_20)).toBe(2);
    expect(await syncScheduledRelease(courseId, SEP_10)).toBeNull(); // clock went back: hold
    expect((await course(courseId)).currentLevel).toBe(2);
    expect(await syncScheduledRelease(courseId, OCT_5)).toBe(3);
  });

  it('syncAllScheduledReleases touches only schedule-mode plans', async () => {
    const scheduled = await setup('schedule');
    const manual = await setup('manual');
    const moved = await syncAllScheduledReleases(OCT_5);
    expect(moved).toEqual([{ courseId: scheduled.courseId, level: 3 }]);
    expect((await course(manual.courseId)).currentLevel).toBe(1);
  });

  it('setReleaseMode hands the level to the engine and back', async () => {
    const { courseId } = await setup('manual');
    await setReleaseMode(courseId, 'progress', NOW + 1);
    expect((await course(courseId)).levelConfig?.autoAdvance).toBe(true);
    expect((await planForCourse(courseId))!.releaseMode).toBe('progress');

    await setReleaseMode(courseId, 'schedule', SEP_20);
    expect((await course(courseId)).levelConfig?.autoAdvance).toBe(false);
    expect((await course(courseId)).currentLevel).toBe(2); // caught up with the calendar
  });

  it('updateUnit edits metadata, a new date can release immediately, and appendUnit adds a level', async () => {
    const { courseId } = await setup('schedule');
    const edited = await updateUnit(courseId, 3, { title: 'Natural selection', releaseAt: SEP_10 }, SEP_20);
    expect(edited).toMatchObject({ level: 3, title: 'Natural selection', releaseAt: SEP_10 });
    expect((await course(courseId)).currentLevel).toBe(3); // Sep 20 ≥ both new dates

    const cleared = await updateUnit(courseId, 3, { releaseAt: undefined }, SEP_20 + 1);
    expect('releaseAt' in cleared).toBe(false);

    const added = await appendUnit(
      courseId,
      { title: 'Ecology', summary: '', topics: ['niches'], targetCount: 8 },
      SEP_20 + 2,
    );
    expect(added.level).toBe(4);
    expect((await planForCourse(courseId))!.units).toHaveLength(4);
    await expect(updateUnit(courseId, 9, { title: 'x' }, NOW)).rejects.toThrow(/no unit at level 9/);
  });
});

describe('planProgress and createPlannedCourse', () => {
  it('reports per-unit review and item tallies', async () => {
    const { courseId, byTerm } = await setup('manual');
    await acceptProposals([byTerm('cell').id], NOW + 1);
    await rejectProposals([byTerm('membrane').id], 'meh', NOW + 2);
    const progress = (await planProgress(courseId))!;
    expect(progress.pendingTotal).toBe(2); // bad + gene
    expect(progress.units[0]).toMatchObject({
      level: 1,
      title: 'Cells',
      released: true,
      current: true,
      pending: 1,
      accepted: 1,
      rejected: 1,
      items: 1,
      passed: 0,
    });
    expect(progress.units[1]).toMatchObject({ released: false, current: false, pending: 1, items: 0 });
    expect(progress.units[2]).toMatchObject({ pending: 0, accepted: 0, rejected: 0 });
    expect(await planProgress('nope')).toBeNull();
  });

  it('createPlannedCourse builds the course through the packet path and records truncation', async () => {
    const res = await createPlannedCourse(
      {
        name: 'Chem',
        releaseMode: 'progress',
        passPercent: 80,
        itemTypes: [termType],
        units: [
          { title: 'Atoms', topics: ['protons'], items: [{ fields: { Term: 'proton', Definition: 'positive' } }] },
          { title: 'Bonds', targetCount: 10 },
        ],
        material: 'long syllabus…',
        materialTruncated: true,
      },
      NOW,
    );
    expect(res.proposalsAdded).toBe(1);
    const plan = (await planForCourse(res.courseId))!;
    expect(plan.id).toBe(res.planId);
    expect(plan.materialTruncated).toBe(true);
    expect(plan.units.map((u) => u.title)).toEqual(['Atoms', 'Bonds']);
    const c = await course(res.courseId);
    expect(c.levelConfig).toMatchObject({ passPercent: 80, autoAdvance: true });
    const pending = await proposalsForCourse(res.courseId, 'pending');
    expect(pending[0].source).toBe('ai');
  });
});
