import { describe, expect, it } from 'vitest';
import { assertItemContent, assertValidItemType, validateItemContent } from './contentValidation';
import { convertFieldValue } from './typeDesign';
import type { ItemType } from './types';

const type: ItemType = {
  id: 'type',
  courseId: 'course',
  name: 'Basic',
  icon: '',
  color: '#000',
  rev: 0,
  generation: 'legacy',
  updatedAt: 0,
  fields: [
    { id: 'front', name: 'Front', kind: 'text' },
    { id: 'back', name: 'Back', kind: 'text' },
  ],
  templates: [
    {
      id: 'recall',
      name: 'Recall',
      promptFieldIds: ['front'],
      answerFieldId: 'back',
      hintFieldIds: [],
      grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
    },
  ],
};

describe('canonical content contract', () => {
  it('requires both a prompt and an answer and rejects an unknown field', () => {
    expect(validateItemContent({ back: 'answer' }, type).problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldId: 'front' })]),
    );
    expect(() => assertItemContent({ front: 'question', back: '   ' }, type)).toThrow(/Back/);
    expect(() => assertItemContent({ front: 'q', back: 'a', typo: 'lost data' }, type)).toThrow(
      /unknown field/i,
    );
  });

  it('keeps field shapes explicit and rejects partially invalid sentence arrays', () => {
    expect(() => assertItemContent({ front: ['q'], back: 'a' }, type)).toThrow(/text/);
    const cloze: ItemType = {
      ...type,
      fields: [type.fields[0], { id: 'back', name: 'Examples', kind: 'clozeSentences' }],
      templates: [
        {
          ...type.templates[0],
          grading: { mode: 'sentenceCloze', sentencesFieldId: 'back', rotation: 'random' },
        },
      ],
    };
    expect(() =>
      assertItemContent(
        { front: 'q', back: [{ text: 'A ⟦valid⟧ line.' }, { text: 'No blank.' }] },
        cloze,
      ),
    ).toThrow(/blank/);
    expect(
      assertItemContent({ front: 'q', back: [{ text: 'A ⟦valid⟧ line.' }] }, cloze).back,
    ).toEqual([{ text: 'A ⟦valid⟧ line.' }]);
  });

  it('rejects name collisions, identity collisions and unsupported grading', () => {
    expect(() => assertValidItemType({ ...type, id: 'second', name: ' basic ' }, [type])).toThrow(
      /already exists/,
    );
    expect(() =>
      assertValidItemType({
        ...type,
        fields: [type.fields[0], { ...type.fields[1], id: 'front' }],
      }),
    ).toThrow(/field id/i);
    expect(() =>
      assertValidItemType({
        ...type,
        templates: [{ ...type.templates[0], grading: { mode: 'self' } }],
      }),
    ).toThrow(/not supported/i);
  });

  it('refuses lossy cloze conversion while preserving commas in valid sentences', () => {
    expect(() =>
      convertFieldValue('Keep ⟦this⟧.\nNo blank here.', 'text', 'clozeSentences'),
    ).toThrow(/original|blank/i);
    expect(convertFieldValue('First, use ⟦this⟧.', 'text', 'clozeSentences')).toEqual([
      { text: 'First, use ⟦this⟧.' },
    ]);
  });
});
