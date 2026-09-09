import { beforeEach, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { parsePacket } from './schema';
import { applyPacket } from './importPacket';
import { exportCoursePackage } from './exportPackage';

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
  await ensurePresets();
});

it('round-trips media, rich text, hints, grading, custom intervals, and a manual release plan', async () => {
  const source = parsePacket({
    format: 'srs-packet',
    version: 2,
    kind: 'create-course',
    course: { name: 'Visual Japanese', ghosts: 'minimal', levelMode: 'levels', autoAdvance: false },
    ladder: {
      name: 'Custom',
      stages: [
        { name: 'First', intervalMinutes: 0.5 },
        { name: 'Second', intervalMinutes: 87 },
      ],
      passesAtIndex: 1,
      burnEnabled: false,
    },
    itemTypes: [
      {
        name: 'Picture',
        fields: [
          { name: 'Photo', kind: 'image' },
          { name: 'Caption', kind: 'richtext' },
          { name: 'Answer', kind: 'text' },
        ],
        templates: [
          {
            name: 'Name',
            promptFields: ['Photo'],
            hintFields: ['Caption'],
            answerField: 'Answer',
            answerLang: 'kana',
            typoTolerance: false,
          },
        ],
      },
      {
        name: 'Grammar',
        fields: [{ name: 'Rule' }, { name: 'Examples', kind: 'clozeSentences' }],
        templates: [
          {
            name: 'Complete',
            promptFields: ['Rule'],
            answerField: 'Examples',
            mode: 'sentenceCloze',
            rotation: 'sequential',
          },
        ],
      },
    ],
    media: [
      {
        key: 'photo',
        name: 'cat.png',
        mimeType: 'image/png',
        data: btoa('synthetic picture bytes'),
      },
    ],
    items: [
      {
        type: 'Picture',
        key: 'cat',
        fields: { Photo: 'photo', Caption: '<b>Animal</b>', Answer: 'ねこ' },
        synonyms: { Name: ['ネコ'] },
        blockList: { Name: ['いぬ'] },
        guidance: { Name: [{ text: '猫', message: 'Use kana.' }] },
        note: 'Cat mnemonic',
      },
      {
        type: 'Grammar',
        prereqs: ['cat'],
        level: 2,
        fields: {
          Rule: 'Location',
          Examples: [{ text: '学校⟦に⟧いる', translation: 'At school', hint: 'Location' }],
        },
      },
    ],
    plan: {
      title: 'Japanese units',
      material: 'Source notes',
      materialTruncated: false,
      releaseMode: 'manual',
      units: [
        { title: 'Animals', targetCount: 10 },
        { title: 'Grammar', targetCount: 5, releaseAt: '2026-10-01' },
      ],
    },
  });
  const first = await applyPacket(source, 100);
  const exported = await exportCoursePackage(first.courseId);
  const second = await applyPacket(exported, 200);
  const roundtrip = await exportCoursePackage(second.courseId);
  expect(roundtrip.ladder).toEqual(exported.ladder);
  expect(roundtrip.plan).toEqual(exported.plan);
  expect(roundtrip.itemTypes).toEqual(exported.itemTypes);
  expect(roundtrip.course).toMatchObject({ ghosts: 'minimal', autoAdvance: false });
  expect(roundtrip.media?.[0].data).toBe(exported.media?.[0].data);
  expect(roundtrip.media?.[0].key).not.toBe(exported.media?.[0].key);
  expect(roundtrip.items[0]).toMatchObject({
    synonyms: { Name: ['ネコ'] },
    blockList: { Name: ['いぬ'] },
    guidance: { Name: [{ text: '猫', message: 'Use kana.' }] },
    fields: { Caption: '<b>Animal</b>' },
  });
  expect(roundtrip.items[1].prereqs).toEqual([roundtrip.items[0].key]);
  expect(await db.reviewLogs.count()).toBe(0);
});

it('converts generated cloze strings before the canonical content gate', async () => {
  const result = await applyPacket(
    parsePacket({
      format: 'srs-packet',
      version: 2,
      kind: 'create-course',
      course: { name: 'Cloze' },
      itemTypes: [
        {
          name: 'Grammar',
          fields: [{ name: 'Rule' }, { name: 'Examples', kind: 'clozeSentences' }],
          templates: [{ name: 'Complete', promptFields: ['Rule'], answerField: 'Examples' }],
        },
      ],
      items: [{ fields: { Rule: 'Preposition', Examples: 'It is ⟦on⟧ the desk. :: Location' } }],
    }),
    100,
  );
  const item = (await db.items.where('courseId').equals(result.courseId).toArray())[0];
  expect(Object.values(item.fieldValues)).toContainEqual([
    { text: 'It is ⟦on⟧ the desk.', translation: 'Location' },
  ]);
});

it('fails atomically when packaged media is missing', async () => {
  const packet = parsePacket({
    format: 'srs-packet',
    version: 2,
    kind: 'create-course',
    course: { name: 'Bad' },
    itemTypes: [
      {
        name: 'Photo',
        fields: [{ name: 'Image', kind: 'image' }, { name: 'Name' }],
        templates: [{ name: 'Recall', promptFields: ['Image'], answerField: 'Name' }],
      },
    ],
    items: [{ fields: { Image: 'missing', Name: 'cat' } }],
  });
  await expect(applyPacket(packet, 100)).rejects.toThrow(/missing packaged media/);
  expect(await db.courses.count()).toBe(0);
  expect(await db.media.count()).toBe(0);
});
