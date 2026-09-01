import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { planForCourse } from '@/db/repo/plans';
import { proposalsForCourse } from '@/db/repo/proposals';
import type { ItemType, Proposal } from '@/engine/types';
import { createPlannedCourse } from '@/services/plans';
import { acceptProposals, rejectProposals } from '@/services/proposals';
import { aiGenerateObject } from './client';
import {
  MATERIAL_CHAR_CAP,
  generateUnitItems,
  outlineProblems,
  outlineToPlannedCourse,
  planCourse,
  truncateMaterial,
  unitItemsToPacketItems,
  unitRequest,
  type PlannedOutline,
} from './plan';

vi.mock('./client', () => ({
  aiGenerateObject: vi.fn(),
  aiGenerateText: vi.fn(),
  aiErrorMessage: (err: unknown) => String(err),
}));
const mockedAi = vi.mocked(aiGenerateObject);

const NOW = Date.UTC(2026, 8, 1, 9, 0);

const outline: PlannedOutline = {
  courseName: 'Intro Biology',
  description: 'Cells to evolution.',
  itemTypes: [
    {
      name: 'Term',
      icon: '🧬',
      fields: [{ name: 'Term' }, { name: 'Definition' }],
      templates: [{ name: 'Define', promptFields: ['Term'], answerField: 'Definition', mode: 'typed' }],
    },
    {
      name: 'Question',
      icon: '❓',
      fields: [{ name: 'Question' }, { name: 'Answer' }],
      templates: [{ name: 'Answer', promptFields: ['Question'], answerField: 'Answer', mode: 'choice' }],
    },
  ],
  units: [
    { title: 'Cells', summary: 'Structure.', topics: ['membrane', ' organelles '], targetCount: 12, date: '2026-09-02' },
    { title: 'Genetics', summary: '', topics: [], targetCount: 0, date: '' },
  ],
};

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
  mockedAi.mockReset();
});

describe('pure helpers', () => {
  it('truncateMaterial trims and cuts at the cap with a flag', () => {
    expect(truncateMaterial('  hello  ')).toEqual({ material: 'hello', truncated: false });
    const long = 'x'.repeat(MATERIAL_CHAR_CAP + 5);
    const cut = truncateMaterial(long);
    expect(cut.truncated).toBe(true);
    expect(cut.material).toHaveLength(MATERIAL_CHAR_CAP);
  });

  it('outlineToPlannedCourse maps types, modes, dates, and defaults', () => {
    const input = outlineToPlannedCourse(outline, 'notes', true, {
      releaseMode: 'schedule',
      passPercent: 80,
    });
    expect(input.name).toBe('Intro Biology');
    expect(input.itemTypes[1].templates[0]).toMatchObject({ mode: 'choice' });
    expect(input.itemTypes[0].templates[0]).not.toHaveProperty('mode');
    expect(input.units[0]).toMatchObject({
      title: 'Cells',
      topics: ['membrane', 'organelles'],
      targetCount: 12,
      releaseAt: Date.parse('2026-09-02'),
    });
    expect(input.units[1]).toEqual({ title: 'Genetics', summary: '', topics: [], targetCount: 10 });
    expect(input.materialTruncated).toBe(true);
    expect(input.passPercent).toBe(80);
  });

  it('outlineProblems catches dangling field references and self-revealing templates', () => {
    expect(outlineProblems(outline)).toEqual([]);
    const broken: PlannedOutline = structuredClone(outline);
    broken.itemTypes[0].templates[0].answerField = 'Meaning';
    broken.itemTypes[1].templates[0].promptFields = ['Answer'];
    const problems = outlineProblems(broken);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/no field called "Meaning"/);
    expect(problems[1]).toMatch(/show its own answer/);
  });
});

describe('unitItemsToPacketItems', () => {
  const types: ItemType[] = [
    {
      id: 't1',
      courseId: 'c',
      name: 'Term',
      color: '#000',
      icon: '',
      fields: [
        { id: 'f1', name: 'Term', kind: 'text' },
        { id: 'f2', name: 'Definition', kind: 'text' },
      ],
      templates: [
        {
          id: 'tpl1',
          name: 'Define',
          promptFieldIds: ['f1'],
          answerFieldId: 'f2',
          hintFieldIds: [],
          grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
        },
      ],
      updatedAt: 0,
    },
    {
      id: 't2',
      courseId: 'c',
      name: 'Question',
      color: '#000',
      icon: '',
      fields: [
        { id: 'f3', name: 'Question', kind: 'text' },
        { id: 'f4', name: 'Answer', kind: 'text' },
      ],
      templates: [
        {
          id: 'tpl2',
          name: 'Answer',
          promptFieldIds: ['f3'],
          answerFieldId: 'f4',
          hintFieldIds: [],
          grading: { mode: 'choice', choices: 4 },
        },
      ],
      updatedAt: 0,
    },
  ];

  it('maps an unknown type onto the only type of a single-type course', () => {
    const items = unitItemsToPacketItems(
      {
        items: [
          {
            type: 'Lecture',
            key: '',
            prereqs: [],
            fields: [{ name: 'Term', value: 'x', alternates: [] }],
            note: '',
          },
        ],
      },
      [types[0]],
    );
    expect(items[0].type).toBe('Term');
  });

  it('scopes alternates to the answering template, dedupes keys, keeps prereqs, passes unknown types through', () => {
    const items = unitItemsToPacketItems(
      {
        items: [
          {
            type: 'term',
            key: 'cell',
            prereqs: [],
            fields: [
              { name: 'Term', value: 'cell', alternates: ['the cell'] },
              { name: 'Definition', value: 'basic unit', alternates: ['unit of life', ''] },
            ],
            note: 'tiny room',
          },
          {
            type: 'Term',
            key: 'cell', // repeated handle — dropped, not fatal
            prereqs: [' cell ', ''],
            fields: [
              { name: 'Term', value: 'membrane', alternates: [] },
              { name: 'Definition', value: 'boundary', alternates: [] },
            ],
            note: '',
          },
          {
            type: 'Lecture',
            key: '',
            prereqs: [],
            fields: [{ name: 'Term', value: 'x', alternates: [] }],
            note: '',
          },
        ],
      },
      types,
    );
    expect(items[0]).toEqual({
      type: 'Term',
      key: 'cell',
      fields: { Term: 'cell', Definition: 'basic unit' },
      synonyms: { Define: ['unit of life'] }, // Term alternates have no template answering Term
      note: 'tiny room',
    });
    expect(items[1]).toEqual({
      type: 'Term',
      prereqs: ['cell'],
      fields: { Term: 'membrane', Definition: 'boundary' },
    });
    expect(items[2].type).toBe('Lecture');
    expect(items[2]).not.toHaveProperty('key');
  });
});

describe('planCourse', () => {
  it('sends the material as the cacheable block, the hint in the request, and returns the outline', async () => {
    mockedAi.mockResolvedValueOnce(outline);
    const res = await planCourse('  Week 1: cells… ', { hint: '12 weeks' });
    expect(res).toEqual({ outline, material: 'Week 1: cells…', materialTruncated: false });
    const call = mockedAi.mock.calls[0][1];
    expect(call.cacheableSystem).toContain('Week 1: cells…');
    expect(call.user).toContain('Notes from the learner: 12 weeks');
    expect(call.user).not.toMatch(/length cap/);
  });

  it('flags truncation in the request and refuses empty material', async () => {
    mockedAi.mockResolvedValueOnce(outline);
    const res = await planCourse('y'.repeat(MATERIAL_CHAR_CAP + 1));
    expect(res.materialTruncated).toBe(true);
    expect(mockedAi.mock.calls[0][1].user).toMatch(/length cap/);
    await expect(planCourse('   ')).rejects.toThrow(/Paste some course material/);
    expect(mockedAi).toHaveBeenCalledTimes(1);
  });
});

describe('generateUnitItems', () => {
  async function plannedCourse() {
    const res = await createPlannedCourse(
      outlineToPlannedCourse(outline, 'Week 1: the cell membrane…', false, { releaseMode: 'manual' }),
      NOW,
    );
    return res.courseId;
  }

  it('queues a unit’s items as pending AI proposals at that level and stamps the unit', async () => {
    const courseId = await plannedCourse();
    mockedAi.mockResolvedValueOnce({
      items: [
        {
          type: 'Term',
          key: 'gene',
          prereqs: [],
          fields: [
            { name: 'Term', value: 'gene', alternates: [] },
            { name: 'Definition', value: 'unit of heredity', alternates: ['heredity unit'] },
          ],
          note: '',
        },
        {
          type: 'Question',
          key: '',
          prereqs: ['gene'],
          fields: [
            { name: 'Question', value: 'What carries hereditary information?', alternates: [] },
            { name: 'Answer', value: 'DNA', alternates: [] },
          ],
          note: 'D-N-A: does nature’s archiving',
        },
      ],
    });
    const res = await generateUnitItems(courseId, 2, { count: 2 }, NOW + 5);
    expect(res.proposalsAdded).toBe(2);
    const pending = await proposalsForCourse(courseId, 'pending');
    expect(pending).toHaveLength(2);
    expect(pending.every((p) => p.level === 2 && p.source === 'ai' && p.error === null)).toBe(true);
    expect(pending[0].item).toMatchObject({ type: 'Term', key: 'gene', synonyms: { Define: ['heredity unit'] } });
    expect(pending[1].item).toMatchObject({ type: 'Question', prereqs: ['gene'], note: expect.stringContaining('archiving') });
    expect((await planForCourse(courseId))!.units[1].generatedAt).toBe(NOW + 5);
    expect((await planForCourse(courseId))!.units[0].generatedAt).toBeUndefined();

    const call = mockedAi.mock.calls[0][1];
    expect(call.system).toContain('Intro Biology');
    expect(call.system).toContain('Item type "Term"');
    expect(call.cacheableSystem).toContain('Week 1: the cell membrane…');
    expect(call.user).toContain('Write exactly 2 items for unit 2: "Genetics"');
    expect(call.maxTokens).toBeGreaterThan(0);
  });

  it('tells the model what exists (with keys) and what was rejected (with reasons)', async () => {
    const courseId = await plannedCourse();
    // one accepted item with a key, one rejected proposal with a reason
    mockedAi.mockResolvedValueOnce({
      items: [
        {
          type: 'Term',
          key: 'membrane',
          prereqs: [],
          fields: [
            { name: 'Term', value: 'membrane', alternates: [] },
            { name: 'Definition', value: 'boundary', alternates: [] },
          ],
          note: '',
        },
        {
          type: 'Term',
          key: '',
          prereqs: [],
          fields: [
            { name: 'Term', value: 'cytoplasm', alternates: [] },
            { name: 'Definition', value: 'cell filling', alternates: [] },
          ],
          note: '',
        },
      ],
    });
    await generateUnitItems(courseId, 1, {}, NOW + 1);
    const pending = await proposalsForCourse(courseId, 'pending');
    const membrane = pending.find((p) => p.item.fields.Term === 'membrane')!;
    const cytoplasm = pending.find((p) => p.item.fields.Term === 'cytoplasm')!;
    await acceptProposals([membrane.id], NOW + 2);
    await rejectProposals([cytoplasm.id], 'too vague', NOW + 3);

    mockedAi.mockResolvedValueOnce({
      items: [
        {
          type: 'Term',
          key: '',
          prereqs: ['membrane'],
          fields: [
            { name: 'Term', value: 'osmosis', alternates: [] },
            { name: 'Definition', value: 'water diffusion', alternates: [] },
          ],
          note: '',
        },
      ],
    });
    const res = await generateUnitItems(courseId, 1, { instruction: 'focus on transport' }, NOW + 4);
    expect(res.proposalsAdded).toBe(1);
    const user = mockedAi.mock.calls[1][1].user;
    expect(user).toContain('Write exactly 12 items'); // the unit's targetCount
    expect(user).toContain('[membrane] membrane');
    expect(user).toContain('cytoplasm — "too vague"');
    expect(user).toContain('Extra instructions: focus on transport');
    // the same system prompt both times — the cached prefix must not drift
    expect(mockedAi.mock.calls[1][1].system).toBe(mockedAi.mock.calls[0][1].system);
    expect(mockedAi.mock.calls[1][1].cacheableSystem).toBe(mockedAi.mock.calls[0][1].cacheableSystem);

    // and accepting the new one resolves its prerequisite to the accepted item
    const osmosis = (await proposalsForCourse(courseId, 'pending')).find((p) => p.item.fields.Term === 'osmosis')!;
    const accepted = await acceptProposals([osmosis.id], NOW + 5);
    const membraneItemId = (await db.proposals.get(membrane.id))!.acceptedItemId;
    expect((await db.items.get(accepted.itemIds[0]))!.prereqIds).toEqual([membraneItemId]);
  });

  it('unitRequest omits empty sections and caps the lists', () => {
    const types: ItemType[] = [];
    const text = unitRequest(
      { level: 3, title: 'Evolution', summary: '', topics: [], targetCount: 5 },
      5,
      { existing: [], types, rejected: [] as Proposal[] },
    );
    expect(text).toBe('Write exactly 5 items for unit 3: "Evolution".');
  });

  it('refuses an unknown unit', async () => {
    const courseId = await plannedCourse();
    await expect(generateUnitItems(courseId, 9, {}, NOW)).rejects.toThrow(/unit not found/);
    expect(mockedAi).not.toHaveBeenCalled();
  });
});
