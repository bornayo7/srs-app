import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourse } from '@/db/repo/courses';
import { createItem } from '@/db/repo/items';
import { basicTypeSpec, createItemType } from '@/db/repo/itemTypes';
import { teachItems } from '@/test/study';
import { prepareQuestions } from './questions';
import { entryAnswerLang, gradeQuestion } from '@/engine/question';
import { useSession } from '@/stores/sessionStore';

const NOW = Date.UTC(2026, 8, 8, 10);
beforeEach(async () => {
  vi.restoreAllMocks();
  useSession.getState().reset();
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
});

describe('one prepared-question contract', () => {
  it('Japanese choices remain available and a wrong choice produces a real lapse', async () => {
    const course = await createCourse({ name: 'Animals', ladderPresetId: 'preset-classic' }, NOW);
    const spec = basicTypeSpec();
    spec.templates[0].grading = { mode: 'choice', choices: 4 };
    const type = await createItemType(course.id, spec, NOW);
    const items = [];
    for (const answer of ['ねこ', 'いぬ', 'うま', 'さる'])
      items.push(
        await createItem(
          {
            courseId: course.id,
            typeId: type.id,
            fieldValues: { [type.fields[0].id]: `Find ${answer}`, [type.fields[1].id]: answer },
          },
          NOW,
        ),
      );
    await teachItems([items[0].id], 'lesson', NOW);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 5 * 3_600_000);
    await useSession.getState().start(course.id);
    const entry = useSession.getState().queue[0];
    expect(entry.choices).toHaveLength(4);
    await useSession.getState().submit(entry.choices!.find((o) => !o.correct)!.text);
    expect(useSession.getState().feedback?.kind).toBe('incorrect');
    useSession.getState().continueNext();
    await useSession.getState().submit(entry.choices!.find((o) => o.correct)!.text);
    expect(await db.cards.get(entry.card.id)).toMatchObject({
      stats: { reviews: 1, correct: 0, lapses: 1 },
    });
  });

  it.each([
    ['猫', '犬', 'latin'],
    ['ねこ', 'いぬ', 'kana'],
    ['ねこ cat', 'いぬ dog', 'latin'],
  ] as const)(
    'a %s cloze separates input assistance from wrong-answer grading',
    async (answer, wrong, input) => {
      const course = await createCourse({ name: 'Cloze', ladderPresetId: 'preset-classic' }, NOW);
      const spec = basicTypeSpec();
      spec.fields[1].kind = 'clozeSentences';
      spec.templates[0].grading = {
        mode: 'sentenceCloze',
        sentencesFieldId: '',
        rotation: 'sequential',
      };
      const type = await createItemType(course.id, spec, NOW);
      const item = await createItem(
        {
          courseId: course.id,
          typeId: type.id,
          fieldValues: {
            [type.fields[0].id]: 'Animal',
            [type.fields[1].id]: [{ text: `これは⟦${answer}⟧です。` }],
          },
        },
        NOW,
      );
      const prepared = await prepareQuestions(
        await db.cards.where('itemId').equals(item.id).toArray(),
        1,
      );
      expect(prepared.problems).toEqual([]);
      expect(entryAnswerLang(prepared.entries[0])).toBe(input);
      expect(gradeQuestion(prepared.entries[0], wrong).verdict).toBe('incorrect');
      expect(gradeQuestion(prepared.entries[0], answer).verdict).toBe('correct');
    },
  );

  it('legacy empty content yields a repair problem and never a successful or stuck question', async () => {
    const course = await createCourse({ name: 'Repair', ladderPresetId: 'preset-classic' }, NOW);
    const type = await createItemType(course.id, basicTypeSpec(), NOW);
    const item = await createItem(
      {
        courseId: course.id,
        typeId: type.id,
        fieldValues: { [type.fields[0].id]: 'Q', [type.fields[1].id]: 'answer' },
      },
      NOW,
    );
    await teachItems([item.id], 'lesson', NOW);
    await db.items.update(item.id, {
      fieldValues: { [type.fields[0].id]: 'Q', [type.fields[1].id]: '' },
    });
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 5 * 3_600_000);
    await useSession.getState().start(course.id);
    expect(useSession.getState()).toMatchObject({ phase: 'empty', queue: [], completed: [] });
    expect(useSession.getState().problems).toHaveLength(1);
    expect((await db.cards.where('itemId').equals(item.id).first())!.stats.reviews).toBe(0);
  });

  it('richtext answers are graded as visible text while ordinary punctuation is literal', async () => {
    const course = await createCourse({ name: 'Markup', ladderPresetId: 'preset-classic' }, NOW);
    const spec = basicTypeSpec();
    spec.fields[1].kind = 'richtext';
    const type = await createItemType(course.id, spec, NOW);
    const item = await createItem(
      {
        courseId: course.id,
        typeId: type.id,
        fieldValues: { [type.fields[0].id]: 'Q', [type.fields[1].id]: '**photosynthesis**' },
      },
      NOW,
    );
    const { entries } = await prepareQuestions(
      await db.cards.where('itemId').equals(item.id).toArray(),
      1,
    );
    expect(gradeQuestion(entries[0], 'photosynthesis').verdict).toBe('correct');
  });

  it('richtext distractors use visible answers and exact accepted answers keep priority over the fuzzy blocklist', async () => {
    const course = await createCourse({ name: 'Choices', ladderPresetId: 'preset-classic' }, NOW);
    const spec = basicTypeSpec();
    spec.fields[1].kind = 'richtext';
    spec.templates[0].grading = { mode: 'choice', choices: 2 };
    const type = await createItemType(course.id, spec, NOW);
    const items = [];
    for (const text of ['cat', 'dog'])
      items.push(
        await createItem(
          {
            courseId: course.id,
            typeId: type.id,
            fieldValues: { [type.fields[0].id]: 'Q', [type.fields[1].id]: `**${text}**` },
          },
          NOW,
        ),
      );
    const cards = await db.cards.where('itemId').equals(items[0].id).toArray();
    const first = await prepareQuestions(cards, 1);
    expect(first.entries[0].choices?.map((o) => o.text).sort()).toEqual(['cat', 'dog']);
    await db.items.update(items[0].id, { blockList: { [type.templates[0].id]: ['cat'] } });
    const blocked = await prepareQuestions(cards, 1);
    expect(gradeQuestion(blocked.entries[0], 'cat').verdict).toBe('correct');
  });

  it('missing prompt media leaves an actionable repair without presenting a blank question', async () => {
    const course = await createCourse({ name: 'Media', ladderPresetId: 'preset-classic' }, NOW);
    const spec = basicTypeSpec();
    spec.fields[0].kind = 'image';
    const type = await createItemType(course.id, spec, NOW);
    await db.media.add({
      id: 'picture',
      blob: new Blob(['x'], { type: 'image/png' }),
      mimeType: 'image/png',
      name: 'picture.png',
      createdAt: NOW,
    });
    const item = await createItem(
      {
        courseId: course.id,
        typeId: type.id,
        fieldValues: { [type.fields[0].id]: 'picture', [type.fields[1].id]: 'cat' },
      },
      NOW,
    );
    await db.media.delete('picture');
    const result = await prepareQuestions(
      await db.cards.where('itemId').equals(item.id).toArray(),
      1,
    );
    expect(result.entries).toEqual([]);
    expect(result.problems[0]).toMatchObject({
      itemId: item.id,
      message: expect.stringMatching(/file is missing/),
    });
  });
});
