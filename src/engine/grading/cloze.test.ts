import { describe, expect, it } from 'vitest';
import { extractBlank, parseClozeLines, pickClozeSentence, revealBlank, clozeSummary } from './cloze';
import type { CardTemplate, Item } from '../types';

const sentences = [
  { text: 'The keys are ⟦on⟧ the table.', translation: 'trans one' },
  { text: 'Her interview is ⟦on⟧ Thursday.' },
  { text: 'No blank here at all.' }, // unusable — skipped
];

function makeItem(): Item {
  return {
    id: 'i1',
    courseId: 'c1',
    typeId: 't1',
    level: 1,
    fieldValues: { sentences: sentences },
    prereqIds: [],
    status: 'active',
    unlockedAt: 0,
    passedAt: null,
    synonyms: {},
    blockList: {},
    guidance: {},
    note: '',
    createdAt: 0,
    updatedAt: 0,
  };
}

const template: CardTemplate = {
  id: 'tpl1',
  name: 'Cloze',
  promptFieldIds: [],
  answerFieldId: 'sentences',
  hintFieldIds: [],
  grading: { mode: 'sentenceCloze', sentencesFieldId: 'sentences', rotation: 'random' },
};

describe('cloze', () => {
  it('extractBlank masks all marks and returns the first blank', () => {
    const r = extractBlank({ text: 'A ⟦big⟧ and ⟦big⟧ thing' })!;
    expect(r.blank).toBe('big');
    expect(r.masked).toBe('A ＿＿＿ and ＿＿＿ thing');
    expect(extractBlank({ text: 'no blank' })).toBeNull();
  });

  it('revealBlank restores the sentence', () => {
    expect(revealBlank('The keys are ⟦on⟧ the table.')).toBe('The keys are on the table.');
    expect(clozeSummary(sentences.slice(0, 1))).toBe('The keys are on the table.');
  });

  it('pick is deterministic per seed and skips blankless sentences', () => {
    const a = pickClozeSentence(makeItem(), template, 42, 0)!;
    const b = pickClozeSentence(makeItem(), template, 42, 0)!;
    expect(a.sentenceIndex).toBe(b.sentenceIndex);
    expect(a.sentenceIndex).toBeLessThan(2); // never the blankless one
    expect(a.blank).toBe('on');
    expect(a.masked).toContain('＿＿＿');
  });

  it('sequential rotation walks sentences by review count', () => {
    const seq: CardTemplate = {
      ...template,
      grading: { mode: 'sentenceCloze', sentencesFieldId: 'sentences', rotation: 'sequential' },
    };
    const first = pickClozeSentence(makeItem(), seq, 1, 0)!;
    const second = pickClozeSentence(makeItem(), seq, 1, 1)!;
    const third = pickClozeSentence(makeItem(), seq, 1, 2)!;
    expect(first.sentenceIndex).toBe(0);
    expect(second.sentenceIndex).toBe(1);
    expect(third.sentenceIndex).toBe(0); // wraps over the 2 usable sentences
  });

  it('returns null for non-cloze templates or missing field', () => {
    const typed: CardTemplate = {
      ...template,
      grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
    };
    expect(pickClozeSentence(makeItem(), typed, 1, 0)).toBeNull();
    const item = makeItem();
    item.fieldValues = {};
    expect(pickClozeSentence(item, template, 1, 0)).toBeNull();
  });

  it('parseClozeLines parses sentence :: translation and rejects missing blanks', () => {
    const ok = parseClozeLines('The cat sat ⟦on⟧ the mat. :: translation\nHang ⟦on⟧!');
    expect(ok.error).toBeNull();
    expect(ok.sentences).toHaveLength(2);
    expect(ok.sentences[0].translation).toBe('translation');
    expect(ok.sentences[1].translation).toBeUndefined();

    const bad = parseClozeLines('There is no blank here');
    expect(bad.error).toMatch(/Line 1/);
  });

  it('degenerate blanks (whitespace/punctuation-only) are unanswerable → rejected', () => {
    expect(extractBlank({ text: 'Hang ⟦ ⟧ a second' })).toBeNull();
    expect(extractBlank({ text: 'Wait⟦.⟧ here' })).toBeNull();
    expect(parseClozeLines('Hang ⟦ ⟧ a second').error).toMatch(/Line 1/);
  });

  it('multi-blank with DIFFERENT texts masks only the first, revealing the rest', () => {
    const r = extractBlank({ text: 'From ⟦Tokyo⟧ to ⟦Osaka⟧ by train' })!;
    expect(r.blank).toBe('Tokyo');
    expect(r.masked).toBe('From ＿＿＿ to Osaka by train');
    // identical texts still mask everywhere (repeated-word drill)
    const same = extractBlank({ text: 'A ⟦big⟧ and ⟦big⟧ thing' })!;
    expect(same.masked).toBe('A ＿＿＿ and ＿＿＿ thing');
  });

  it("unspaced '::' inside sentences survives; only the spaced ' :: ' splits", () => {
    const r = parseClozeLines('Use ⟦std⟧::vector for arrays :: standard library');
    expect(r.error).toBeNull();
    expect(r.sentences[0].text).toBe('Use ⟦std⟧::vector for arrays');
    expect(r.sentences[0].translation).toBe('standard library');
  });
});
