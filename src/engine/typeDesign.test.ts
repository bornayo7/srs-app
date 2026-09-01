import { describe, expect, it } from 'vitest';
import {
  convertFieldValue,
  diffItemType,
  migrateFieldValues,
  pruneTemplateMap,
  studyStatus,
  validateItemType,
} from './typeDesign';
import { parseRichText, richTextToPlain } from './richtext';
import { fitWithin, formatBytes } from './image';
import type { CardTemplate, FieldDef, ItemType } from './types';

const field = (id: string, name: string, kind: FieldDef['kind'] = 'text'): FieldDef => ({
  id,
  name,
  kind,
});

const tpl = (over: Partial<CardTemplate> & { id: string }): CardTemplate => ({
  name: 'Recall',
  promptFieldIds: ['f1'],
  answerFieldId: 'f2',
  hintFieldIds: [],
  grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
  ...over,
});

const type = (over: Partial<ItemType> = {}): ItemType => ({
  id: 't1',
  courseId: 'c1',
  name: 'Basic',
  color: '#fff',
  icon: '📇',
  fields: [field('f1', 'Front'), field('f2', 'Back')],
  templates: [tpl({ id: 'tpl1' })],
  updatedAt: 0,
  ...over,
});

const messages = (t: ItemType) => validateItemType(t).map((i) => i.message);

describe('validateItemType', () => {
  it('accepts a well-formed type', () => {
    expect(validateItemType(type())).toEqual([]);
  });

  it('rejects a type with no templates — its items would never be reviewed', () => {
    expect(messages(type({ templates: [] }))[0]).toMatch(/at least one card template/);
  });

  it('rejects a prompt field that is also the answer', () => {
    const t = type({ templates: [tpl({ id: 'tpl1', promptFieldIds: ['f1', 'f2'] })] });
    expect(messages(t).join()).toMatch(/both prompt and answer/);
  });

  it('rejects a dangling answer/prompt/hint field', () => {
    expect(messages(type({ templates: [tpl({ id: 'x', answerFieldId: 'gone' })] })).join()).toMatch(
      /Pick an answer field/,
    );
    expect(
      messages(type({ templates: [tpl({ id: 'x', promptFieldIds: ['gone'] })] })).join(),
    ).toMatch(/prompt field no longer exists/);
    expect(messages(type({ templates: [tpl({ id: 'x', hintFieldIds: ['gone'] })] })).join()).toMatch(
      /hint field no longer exists/,
    );
  });

  it('an image field cannot be a typed answer, but reveal mode accepts it', () => {
    const fields = [field('f1', 'Front'), field('f2', 'Picture', 'image')];
    expect(messages(type({ fields })).join()).toMatch(/can't be typed as an answer/);
    expect(
      validateItemType(
        type({ fields, templates: [tpl({ id: 'tpl1', grading: { mode: 'self' } })] }),
      ),
    ).toEqual([]);
  });

  it('sentence-cloze must point at a clozeSentences field', () => {
    const fields = [field('f1', 'Word'), field('f2', 'Examples')];
    const cloze = tpl({
      id: 'tpl1',
      grading: { mode: 'sentenceCloze', sentencesFieldId: 'f2', rotation: 'random' },
    });
    expect(messages(type({ fields, templates: [cloze] })).join()).toMatch(/must be a clozeSentences/);
    const ok = type({
      fields: [field('f1', 'Word'), field('f2', 'Examples', 'clozeSentences')],
      templates: [cloze],
    });
    expect(validateItemType(ok)).toEqual([]);
  });

  it('catches duplicate names and out-of-range choice counts', () => {
    expect(
      messages(type({ fields: [field('f1', 'Front'), field('f2', 'front')] })).join(),
    ).toMatch(/Duplicate field name/);
    expect(
      messages(type({ templates: [tpl({ id: 'a' }), tpl({ id: 'b' })] })).join(),
    ).toMatch(/Duplicate template name/);
    expect(
      messages(type({ templates: [tpl({ id: 'a', grading: { mode: 'choice', choices: 1 } })] })).join(),
    ).toMatch(/between 2 and 6/);
  });
});

describe('diffItemType', () => {
  it('reports added/removed templates and fields, and kind changes', () => {
    const prev = type();
    const next = type({
      fields: [field('f1', 'Front'), field('f3', 'Reading', 'list')],
      templates: [tpl({ id: 'tpl2', name: 'Reading', answerFieldId: 'f3' })],
    });
    const d = diffItemType(prev, next);
    expect(d.addedTemplates.map((t) => t.id)).toEqual(['tpl2']);
    expect(d.removedTemplateIds).toEqual(['tpl1']);
    expect(d.removedFieldIds).toEqual(['f2']);
    expect(d.kindChanges).toEqual([]);

    const kindOnly = diffItemType(prev, type({ fields: [field('f1', 'Front'), field('f2', 'Back', 'list')] }));
    expect(kindOnly.kindChanges).toEqual([{ id: 'f2', from: 'text', to: 'list' }]);
    expect(kindOnly.removedFieldIds).toEqual([]);
  });
});

describe('field value conversion', () => {
  it('text ↔ list round-trips through commas', () => {
    expect(convertFieldValue('to attack, to assault', 'text', 'list')).toEqual([
      'to attack',
      'to assault',
    ]);
    expect(convertFieldValue(['to attack', 'to assault'], 'list', 'text')).toBe(
      'to attack, to assault',
    );
  });

  it('cloze sentences degrade to their revealed text', () => {
    const sentences = [{ text: 'The cat sat ⟦on⟧ the mat', translation: 'x' }];
    expect(convertFieldValue(sentences, 'clozeSentences', 'text')).toBe('The cat sat on the mat');
    expect(convertFieldValue(sentences, 'clozeSentences', 'list')).toEqual(['The cat sat on the mat']);
  });

  it('unmarked text converted to cloze keeps only parsable sentences', () => {
    expect(convertFieldValue('no blank here', 'text', 'clozeSentences')).toEqual([]);
    expect(convertFieldValue('Hang ⟦on⟧ a second', 'text', 'clozeSentences')).toEqual([
      { text: 'Hang ⟦on⟧ a second' },
    ]);
  });

  it('media conversions always clear — an id is not text and text is not an id', () => {
    expect(convertFieldValue('media-uuid', 'image', 'text')).toBe('');
    expect(convertFieldValue('hello', 'text', 'image')).toBe('');
  });

  it('migrateFieldValues drops removed fields and seeds new ones empty', () => {
    const prev = [field('f1', 'Front'), field('f2', 'Back')];
    const next = [field('f1', 'Front', 'list'), field('f9', 'Extra')];
    const out = migrateFieldValues({ f1: 'a, b', f2: 'gone' }, prev, next);
    expect(out).toEqual({ f1: ['a', 'b'], f9: '' });
  });
});

describe('studyStatus', () => {
  const c = (...states: ('new' | 'review' | 'burned' | 'suspended')[]) =>
    states.map((state) => ({ state }));

  it('sends an active item back to lessons when it gains an untaught card', () => {
    expect(studyStatus('active', c('review', 'new'))).toBe('lesson');
    expect(studyStatus('active', c('review'))).toBe('active');
  });

  it('promotes a lesson item that has nothing left to teach', () => {
    expect(studyStatus('lesson', c('review'))).toBe('active');
    expect(studyStatus('lesson', c('new', 'review'))).toBe('lesson');
  });

  it('never touches locked items or items with no cards', () => {
    expect(studyStatus('locked', c('review'))).toBe('locked');
    expect(studyStatus('lesson', [])).toBe('lesson');
  });
});

describe('pruneTemplateMap', () => {
  it('drops per-template entries whose template is gone', () => {
    expect(pruneTemplateMap({ a: ['x'], b: ['y'] }, ['b'])).toEqual({ a: ['x'] });
    const same = { a: ['x'] };
    expect(pruneTemplateMap(same, [])).toBe(same);
  });
});

describe('richtext', () => {
  it('parses the four inline marks and keeps line structure', () => {
    expect(parseRichText('**bold** and *soft*\n`code` ==hi==')).toEqual([
      [
        { kind: 'bold', text: 'bold' },
        { kind: 'text', text: ' and ' },
        { kind: 'italic', text: 'soft' },
      ],
      [
        { kind: 'code', text: 'code' },
        { kind: 'text', text: ' ' },
        { kind: 'mark', text: 'hi' },
      ],
    ]);
  });

  it('loose markers stay literal — arithmetic is not italics', () => {
    expect(parseRichText('2 * 3 * 4')).toEqual([[{ kind: 'text', text: '2 * 3 * 4' }]]);
    expect(richTextToPlain('a ** b')).toBe('a ** b');
    expect(richTextToPlain('**bold** stays')).toBe('bold stays');
  });
});

describe('image sizing', () => {
  it('scales the long edge down and never up', () => {
    expect(fitWithin(4000, 3000, 1024)).toEqual({ width: 1024, height: 768 });
    expect(fitWithin(300, 200, 1024)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(0, 0)).toEqual({ width: 1, height: 1 });
  });

  it('formats sizes for the UI', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
