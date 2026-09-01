import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { deleteCourse } from '@/db/repo/courses';
import { planForCourse } from '@/db/repo/plans';
import { pendingCount, proposalsForCourse } from '@/db/repo/proposals';
import { parsePacket, parseReleaseAt, PACKET_FORMAT, PACKET_VERSION } from './schema';
import { applyPacket } from './importPacket';

const NOW = Date.UTC(2026, 8, 1, 9, 0);

/** A three-unit plan: one populated unit, one empty scheduled unit, one with a bad item. */
const validPlan = {
  format: PACKET_FORMAT,
  version: PACKET_VERSION,
  kind: 'course-plan',
  course: { name: 'Intro Biology', description: 'BIO 101', releaseMode: 'schedule' },
  itemTypes: [
    {
      name: 'Term',
      icon: '🧬',
      fields: [{ name: 'Term' }, { name: 'Definition' }],
      templates: [{ name: 'Define', promptFields: ['Term'], answerField: 'Definition' }],
    },
    {
      name: 'Question',
      fields: [{ name: 'Question' }, { name: 'Answer' }],
      templates: [
        { name: 'Answer', promptFields: ['Question'], answerField: 'Answer', mode: 'choice' },
      ],
    },
  ],
  units: [
    {
      title: 'Cells',
      summary: 'Cell structure',
      topics: ['membrane', 'organelles'],
      releaseAt: '2026-09-01',
      items: [
        {
          type: 'Term',
          key: 'membrane',
          fields: { Term: 'cell membrane', Definition: 'lipid bilayer boundary' },
        },
        {
          type: 'Question',
          fields: { Question: 'What bounds the cell?', Answer: 'cell membrane' },
          prereqs: ['membrane'],
        },
      ],
    },
    { title: 'Genetics', releaseAt: '2026-09-15', targetCount: 12 },
    {
      title: 'Evolution',
      items: [{ type: 'Term', fields: { Term: 'allele', Nope: 'x' } }],
    },
  ],
  material: 'Week 1: cells. Week 2: genetics. Week 3: evolution.',
};

const spanishCourse = {
  format: PACKET_FORMAT,
  version: PACKET_VERSION,
  kind: 'create-course',
  course: { name: 'Spanish Kitchen' },
  itemTypes: [
    {
      name: 'Word',
      fields: [{ name: 'Spanish' }, { name: 'English' }],
      templates: [{ name: 'Meaning', promptFields: ['Spanish'], answerField: 'English' }],
    },
  ],
  items: [{ fields: { Spanish: 'la sartén', English: 'frying pan' } }],
};

/** Mutable, loosely-typed copy — the literal's inferred unions fight test edits. */
interface LoosePlan {
  course: Record<string, unknown>;
  units: { items?: unknown[]; releaseAt?: unknown }[];
}
const clonePlan = (): LoosePlan => structuredClone(validPlan) as unknown as LoosePlan;

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
});

describe('course-plan packet schema', () => {
  it('accepts a valid plan', () => {
    expect(parsePacket(validPlan).kind).toBe('course-plan');
  });

  it('requires prerequisite keys to be defined earlier, across units', () => {
    const bad = clonePlan();
    // move the dependent question into unit 3 — its key lives in unit 1, still earlier
    bad.units[2].items!.push(bad.units[0].items![1]);
    expect(() => parsePacket(bad)).not.toThrow();
    // but a reference to a key defined LATER is rejected
    const later = clonePlan();
    later.units[0].items!.unshift({
      type: 'Term',
      fields: { Term: 'x', Definition: 'y' },
      prereqs: ['membrane'],
    });
    expect(() => parsePacket(later)).toThrow(/unknown prerequisite "membrane"/);
  });

  it('rejects an unreadable release date and unknown gate types', () => {
    const badDate = clonePlan();
    badDate.units[1].releaseAt = 'next tuesday';
    expect(() => parsePacket(badDate)).toThrow(/unreadable date/);

    const badGate = clonePlan();
    badGate.course.gateTypes = ['Lecture'];
    expect(() => parsePacket(badGate)).toThrow(/unknown item type "Lecture"/);
  });

  it('parseReleaseAt reads ISO strings and epoch numbers', () => {
    expect(parseReleaseAt('2026-09-15')).toBe(Date.parse('2026-09-15'));
    expect(parseReleaseAt(123)).toBe(123);
    expect(parseReleaseAt('garbage')).toBeNull();
    expect(parseReleaseAt(undefined)).toBeNull();
  });
});

describe('applyPacket course-plan', () => {
  it('creates a levelled course with one level per unit and parks items as proposals', async () => {
    const res = await applyPacket(parsePacket(validPlan), NOW);
    expect(res.itemsAdded).toBe(0);
    expect(res.proposalsAdded).toBe(3);
    expect(res.warnings.some((w) => /no release date/.test(w))).toBe(true); // unit 3

    const course = (await db.courses.get(res.courseId))!;
    expect(course.levelMode).toBe('levels');
    expect(course.currentLevel).toBe(1);
    expect(course.levelConfig?.gateTypeIds).toEqual([]); // all types count
    // schedule mode owns the level — the engine must not advance on its own
    expect(course.levelConfig?.autoAdvance).toBe(false);
    expect(await db.itemTypes.where('courseId').equals(res.courseId).count()).toBe(2);
    // nothing became a real item
    expect(await db.items.where('courseId').equals(res.courseId).count()).toBe(0);

    const plan = (await planForCourse(res.courseId))!;
    expect(plan.releaseMode).toBe('schedule');
    expect(plan.material).toBe(validPlan.material);
    expect(plan.units.map((u) => u.level)).toEqual([1, 2, 3]);
    expect(plan.units[0]).toMatchObject({
      title: 'Cells',
      summary: 'Cell structure',
      topics: ['membrane', 'organelles'],
      targetCount: 2, // defaults to the items supplied
      releaseAt: Date.parse('2026-09-01'),
    });
    expect(plan.units[1]).toMatchObject({ targetCount: 12, releaseAt: Date.parse('2026-09-15') });
    expect(plan.units[2].releaseAt).toBeUndefined();

    const proposals = await proposalsForCourse(res.courseId);
    expect(proposals.map((p) => p.level)).toEqual([1, 1, 3]);
    expect(proposals.every((p) => p.status === 'pending' && p.planId === plan.id)).toBe(true);
    expect(proposals[0].error).toBeNull();
    expect(proposals[0].item.key).toBe('membrane');
    expect(proposals[1].item.prereqs).toEqual(['membrane']);
    // the bad row is kept, flagged, and reviewable — not dropped
    expect(proposals[2].error).toMatch(/unknown field "Nope"/);
    expect(await pendingCount(res.courseId)).toBe(3);
  });

  it('progress mode leaves the level engine in charge', async () => {
    const pkt = clonePlan();
    pkt.course.releaseMode = 'progress';
    const res = await applyPacket(parsePacket(pkt), NOW);
    const course = (await db.courses.get(res.courseId))!;
    expect(course.levelConfig?.autoAdvance).toBe(true);
    expect(res.warnings).toEqual([]);
  });

  it('manual mode holds the level, and an explicit autoAdvance wins', async () => {
    const manual = clonePlan();
    manual.course.releaseMode = 'manual';
    const r1 = await applyPacket(parsePacket(manual), NOW);
    expect((await db.courses.get(r1.courseId))!.levelConfig?.autoAdvance).toBe(false);

    const explicit = clonePlan();
    explicit.course.autoAdvance = true;
    const r2 = await applyPacket(parsePacket(explicit), NOW + 1);
    expect((await db.courses.get(r2.courseId))!.levelConfig?.autoAdvance).toBe(true);
  });
});

describe('applyPacket propose-items', () => {
  it('queues items for an existing course, flags duplicates, and honours unit/level', async () => {
    const created = await applyPacket(parsePacket(spanishCourse), NOW);
    const existing = (await db.items.where('courseId').equals(created.courseId).toArray())[0];

    const res = await applyPacket(
      parsePacket({
        format: PACKET_FORMAT,
        version: PACKET_VERSION,
        kind: 'propose-items',
        courseName: 'spanish kitchen',
        items: [
          { fields: { Spanish: 'La Sartén', English: 'pan' } }, // dup, case-insensitive
          { fields: { Spanish: 'el vaso', English: 'glass' } },
          { fields: { Spanish: 'el plato', English: 'plate' }, level: 3 },
        ],
      }),
      NOW + 1,
      { source: 'ai' },
    );
    expect(res.proposalsAdded).toBe(3);
    expect(res.itemsAdded).toBe(0);
    expect(await db.items.where('courseId').equals(created.courseId).count()).toBe(1);

    const proposals = await proposalsForCourse(created.courseId, 'pending');
    expect(proposals).toHaveLength(3);
    expect(proposals.every((p) => p.source === 'ai' && p.planId === null)).toBe(true);
    const dup = proposals.find((p) => p.item.fields.Spanish === 'La Sartén')!;
    expect(dup.duplicateOf).toBe(existing.id);
    expect(dup.error).toBeNull();
    const vaso = proposals.find((p) => p.item.fields.Spanish === 'el vaso')!;
    expect(vaso.duplicateOf).toBeNull();
    expect(vaso.level).toBe(1); // default = the course's current level
    const plato = proposals.find((p) => p.item.fields.Spanish === 'el plato')!;
    expect(plato.level).toBe(3);
    expect(plato.item.level).toBe(3);
  });

  it('uses the packet unit as the default level and warns past the plan', async () => {
    const planned = await applyPacket(parsePacket(validPlan), NOW);
    const res = await applyPacket(
      parsePacket({
        format: PACKET_FORMAT,
        version: PACKET_VERSION,
        kind: 'propose-items',
        courseId: planned.courseId,
        unit: 2,
        items: [
          { type: 'Term', fields: { Term: 'gene', Definition: 'unit of heredity' } },
          { type: 'Term', fields: { Term: 'fitness', Definition: 'reproductive success' }, level: 9 },
        ],
      }),
      NOW + 1,
    );
    expect(res.proposalsAdded).toBe(2);
    expect(res.warnings[0]).toMatch(/past the plan's 3/);
    const plan = (await planForCourse(planned.courseId))!;
    const mine = (await proposalsForCourse(planned.courseId)).filter((p) => p.level >= 2);
    expect(mine.map((p) => p.level).sort()).toEqual([2, 3, 9]);
    expect(mine.every((p) => p.planId === plan.id)).toBe(true);
  });

  it('fails cleanly when the course does not exist', async () => {
    await expect(
      applyPacket(
        parsePacket({
          format: PACKET_FORMAT,
          version: PACKET_VERSION,
          kind: 'propose-items',
          courseName: 'Nope',
          items: [{ fields: { A: 'b' } }],
        }),
        NOW,
      ),
    ).rejects.toThrow(/Course not found/);
    expect(await db.proposals.count()).toBe(0);
  });
});

describe('deleteCourse', () => {
  it('removes the plan and its proposals with the course', async () => {
    const res = await applyPacket(parsePacket(validPlan), NOW);
    expect(await db.plans.count()).toBe(1);
    expect(await db.proposals.count()).toBe(3);
    await deleteCourse(res.courseId);
    expect(await db.plans.count()).toBe(0);
    expect(await db.proposals.count()).toBe(0);
    expect(await db.courses.count()).toBe(0);
  });
});
