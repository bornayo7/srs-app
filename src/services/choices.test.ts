import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourse } from '@/db/repo/courses';
import { createItem } from '@/db/repo/items';
import { createItemType, type SimpleTypeSpec } from '@/db/repo/itemTypes';
import { buildChoiceOptions, clampChoiceCount } from '@/engine/grading/choice';
import { buildMatchContext } from '@/engine/grading/context';
import { matchTypedAnswer } from '@/engine/grading/match';
import type { Item, ItemType } from '@/engine/types';
import { buildEntryChoices, newChoiceCache } from './choices';

const NOW = Date.UTC(2026, 0, 15, 10, 23);

async function wipe() {
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
}
beforeEach(wipe);

const choiceSpec = (choices = 4): SimpleTypeSpec => ({
  name: 'Verb',
  color: '#8b5cf6',
  icon: '🇫🇷',
  fields: [
    { name: 'Verb', kind: 'text' },
    { name: 'Meaning', kind: 'text' },
  ],
  templates: [
    {
      name: 'Meaning',
      promptFieldNames: ['Verb'],
      answerFieldName: 'Meaning',
      grading: { mode: 'choice', choices },
    },
  ],
});

async function seed(
  rows: [string, string, number?][],
  choices = 4,
): Promise<{ type: ItemType; items: Item[] }> {
  const course = await createCourse({ name: 'FR', ladderPresetId: 'preset-classic' }, NOW);
  const type = await createItemType(course.id, choiceSpec(choices), NOW);
  const [verb, meaning] = type.fields.map((f) => f.id);
  const items: Item[] = [];
  for (const [v, m, level] of rows) {
    items.push(
      await createItem(
        {
          courseId: course.id,
          typeId: type.id,
          fieldValues: { [verb]: v, [meaning]: m },
          level: level ?? 1,
        },
        NOW + items.length,
      ),
    );
  }
  return { type, items };
}

const entryFor = (type: ItemType, item: Item) => ({
  item,
  itemType: type,
  template: type.templates[0],
});

describe('buildChoiceOptions (pure)', () => {
  it('always includes exactly one correct option', () => {
    const opts = buildChoiceOptions('to eat', ['to drink', 'to run', 'to sleep', 'to walk'], 4, 7);
    expect(opts).toHaveLength(4);
    expect(opts.filter((o) => o.correct).map((o) => o.text)).toEqual(['to eat']);
  });

  it('never repeats the answer as a distractor, however it is written', () => {
    const opts = buildChoiceOptions('to eat', ['To Eat!', 'to drink'], 4, 1);
    expect(opts.map((o) => o.text)).toEqual(expect.arrayContaining(['to eat', 'to drink']));
    expect(opts).toHaveLength(2);
  });

  it('dedupes distractors and shrinks when the pool is thin', () => {
    expect(buildChoiceOptions('a', ['b', 'b', ' b '], 4, 3)).toHaveLength(2);
    expect(buildChoiceOptions('a', [], 4, 3)).toHaveLength(1); // caller falls back to typing
  });

  it('is deterministic per seed and does not always put the answer first', () => {
    const a = buildChoiceOptions('x', ['1', '2', '3', '4', '5'], 5, 42);
    const b = buildChoiceOptions('x', ['1', '2', '3', '4', '5'], 5, 42);
    expect(a).toEqual(b);
    const positions = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((s) =>
        buildChoiceOptions('x', ['1', '2', '3', '4', '5'], 5, s).findIndex((o) => o.correct),
      ),
    );
    expect(positions.size).toBeGreaterThan(1);
  });

  it('clamps the requested count to a sane range', () => {
    expect(clampChoiceCount(1)).toBe(2);
    expect(clampChoiceCount(99)).toBe(6);
    expect(clampChoiceCount(Number.NaN)).toBe(4);
  });
});

describe('buildEntryChoices (against the database)', () => {
  it('takes distractors from the same question asked of sibling items', async () => {
    const { type, items } = await seed([
      ['manger', 'to eat'],
      ['boire', 'to drink'],
      ['courir', 'to run'],
      ['dormir', 'to sleep'],
      ['marcher', 'to walk'],
    ]);
    const options = await buildEntryChoices(entryFor(type, items[0]), 5);
    expect(options).toBeDefined();
    expect(options).toHaveLength(4);
    expect(options!.filter((o) => o.correct).map((o) => o.text)).toEqual(['to eat']);
    for (const o of options!.filter((o) => !o.correct)) {
      expect(['to drink', 'to run', 'to sleep', 'to walk']).toContain(o.text);
    }
  });

  it('every wrong option really grades as wrong — no synonym or typo-range twin', async () => {
    const { type, items } = await seed([
      ['attaquer', 'to attack'],
      ['attacher', 'to attach'], // one edit away: would pass typo tolerance
      ['assaillir', 'to assault'], // registered below as a synonym of the answer
      ['boire', 'to drink'],
      ['courir', 'to run'],
      ['dormir', 'to sleep'],
    ]);
    await db.items.put({
      ...items[0],
      synonyms: { [type.templates[0].id]: ['to assault'] },
    });
    const item = (await db.items.get(items[0].id))!;

    const ctx = buildMatchContext(item, type, type.templates[0]);
    const options = await buildEntryChoices(entryFor(type, item), 11);
    expect(options).toHaveLength(4);
    for (const o of options!) {
      const verdict = matchTypedAnswer(o.text, ctx).verdict;
      expect(verdict === 'correct' || verdict === 'correctWithTypo').toBe(o.correct);
    }
    expect(options!.map((o) => o.text)).not.toContain('to attach');
    expect(options!.map((o) => o.text)).not.toContain('to assault');
  });

  it('prefers siblings within one level so the odd one out is not a giveaway', async () => {
    const { type, items } = await seed([
      ['manger', 'to eat', 5],
      ['boire', 'to drink', 4],
      ['courir', 'to run', 6],
      ['dormir', 'to sleep', 5],
      ['séquestrer', 'to sequester', 40],
      ['tergiverser', 'to prevaricate', 41],
    ]);
    const options = await buildEntryChoices(entryFor(type, items[0]), 3);
    expect(options!.map((o) => o.text)).not.toContain('to sequester');
    expect(options!.map((o) => o.text)).not.toContain('to prevaricate');
  });

  it('falls back to typing when the type has nothing to compare against', async () => {
    const { type, items } = await seed([['manger', 'to eat']]);
    expect(await buildEntryChoices(entryFor(type, items[0]), 1)).toBeUndefined();
  });

  it('leaves typed templates alone', async () => {
    const course = await createCourse({ name: 'T', ladderPresetId: 'preset-classic' }, NOW);
    const spec = choiceSpec();
    spec.templates[0].grading = { mode: 'typed', answerLang: 'latin', typoTolerance: true };
    const type = await createItemType(course.id, spec, NOW);
    const [verb, meaning] = type.fields.map((f) => f.id);
    const item = await createItem(
      { courseId: course.id, typeId: type.id, fieldValues: { [verb]: 'a', [meaning]: 'b' } },
      NOW,
    );
    expect(await buildEntryChoices(entryFor(type, item), 1)).toBeUndefined();
  });

  it('reuses one query per type when a cache is passed', async () => {
    const { type, items } = await seed([
      ['manger', 'to eat'],
      ['boire', 'to drink'],
      ['courir', 'to run'],
    ]);
    const cache = newChoiceCache();
    await buildEntryChoices(entryFor(type, items[0]), 1, cache);
    await buildEntryChoices(entryFor(type, items[1]), 2, cache);
    expect(cache.byType.get(type.id)).toHaveLength(3);
  });
});
