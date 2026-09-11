import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourse } from '@/db/repo/courses';
import { createItem } from '@/db/repo/items';
import { basicTypeSpec, createItemType } from '@/db/repo/itemTypes';
import { dueCards } from '@/db/repo/cards';
import { teachItems as completeLessonBatch } from '@/test/study';
import { HOUR } from '@/engine/time';
import { useSession } from './sessionStore';
import { commitReview } from '@/services/commitReview';
import { undoReview } from '@/services/undo';
import { entryMatchContext } from '@/engine/question';

// The store reads due cards through this module; the race test slows one call down.
vi.mock('@/db/repo/cards', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/db/repo/cards')>();
  return { ...real, dueCards: vi.fn(real.dueCards) };
});
const mockedDueCards = vi.mocked(dueCards);
vi.mock('@/services/commitReview', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/services/commitReview')>();
  return { ...real, commitReview: vi.fn(real.commitReview) };
});
vi.mock('@/services/undo', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/services/undo')>();
  return { ...real, undoReview: vi.fn(real.undoReview) };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
const answer = () => entryMatchContext(useSession.getState().queue[0]).accepted[0];

const NOW = Date.UTC(2026, 0, 15, 10, 23);

/** A course whose items were all taught at NOW, so every card is due once 4h have passed. */
async function courseWithDueCards(name: string, count: number): Promise<string> {
  const course = await createCourse({ name, ladderPresetId: 'preset-classic' }, NOW);
  const type = await createItemType(course.id, basicTypeSpec(), NOW);
  const [front, back] = type.fields.map((f) => f.id);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const item = await createItem(
      {
        courseId: course.id,
        typeId: type.id,
        fieldValues: { [front]: `${name} ${i}`, [back]: `a${i}` },
      },
      NOW + i,
    );
    ids.push(item.id);
  }
  await completeLessonBatch(ids, 'lesson', NOW);
  return course.id;
}

const delayed = (ms: number) => async (courseId: string, t: number) => {
  const real = mockedDueCards.getMockImplementation()!;
  await new Promise((r) => setTimeout(r, ms));
  return real(courseId, t);
};

beforeEach(async () => {
  vi.restoreAllMocks();
  const [reviews, undo] = await Promise.all([
    vi.importActual<typeof import('@/services/commitReview')>('@/services/commitReview'),
    vi.importActual<typeof import('@/services/undo')>('@/services/undo'),
  ]);
  vi.mocked(commitReview).mockReset().mockImplementation(reviews.commitReview);
  vi.mocked(undoReview).mockReset().mockImplementation(undo.undoReview);
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
  useSession.getState().reset();
  mockedDueCards.mockClear();
  // every card was scheduled for NOW+4h; the store asks the clock, so move the clock
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 5 * HOUR);
});

describe('answer overrides', () => {
  it('a wrong answer can become correct without a lapse, even after repeated toggles', async () => {
    const courseId = await courseWithDueCards('OverrideCorrect', 1);
    await useSession.getState().start(courseId);
    const entry = useSession.getState().queue[0];
    const original = await db.cards.get(entry.card.id);
    await useSession.getState().submit('wrong');
    useSession.getState().overrideAnswer(true);
    useSession.getState().overrideAnswer(false);
    useSession.getState().overrideAnswer(true);
    expect(useSession.getState()).toMatchObject({
      feedback: { kind: 'correct', typo: false },
      completed: [],
      incorrectCounts: {},
    });
    expect(await db.cards.get(entry.card.id)).toEqual(original);
    expect(await db.reviewLogs.filter((log) => log.kind === 'review').count()).toBe(0);
    await useSession.getState().continueNext();
    expect(await db.cards.get(entry.card.id)).toMatchObject({
      stats: { reviews: 1, correct: 1, lapses: 0 },
    });
    expect(useSession.getState()).toMatchObject({ phase: 'summary', queue: [] });
    expect(useSession.getState().completed).toHaveLength(1);
    expect(vi.mocked(commitReview)).toHaveBeenCalledOnce();
  });

  it('correct-to-wrong does not prematurely pass the item, unlock dependents or advance levels', async () => {
    const courseId = await courseWithDueCards('OverrideWrong', 1);
    await db.courses.update(courseId, { levelMode: 'levels' });
    const card = (await db.cards.where('courseId').equals(courseId).first())!;
    const item = (await db.items.get(card.itemId))!;
    const type = (await db.itemTypes.get(item.typeId))!;
    await db.cards.update(card.id, { srs: { kind: 'ladder', stageIndex: 3 } });
    const dependent = await createItem(
      {
        courseId,
        typeId: type.id,
        fieldValues: { [type.fields[0].id]: 'Dependent', [type.fields[1].id]: 'next' },
        level: 2,
        prereqIds: [item.id],
      },
      NOW,
    );
    await useSession.getState().start(courseId);
    await useSession.getState().submit(answer());
    useSession.getState().overrideAnswer(false);
    expect((await db.items.get(item.id))!.passedAt).toBeNull();
    expect((await db.items.get(dependent.id))!.status).toBe('locked');
    expect((await db.courses.get(courseId))!.currentLevel).toBe(1);
    await useSession.getState().continueNext();
    expect(useSession.getState().incorrectCounts[card.id]).toBe(1);
    await useSession.getState().submit(answer());
    await useSession.getState().continueNext();
    expect(await db.cards.get(card.id)).toMatchObject({
      stats: { reviews: 1, correct: 0, lapses: 1 },
      srs: { stageIndex: 2 },
    });
    expect((await db.items.get(item.id))!.passedAt).toBeNull();
    expect((await db.items.get(dependent.id))!.status).toBe('locked');
    expect((await db.courses.get(courseId))!.currentLevel).toBe(1);
  });

  it('overriding a later attempt keeps earlier confirmed mistakes', async () => {
    const courseId = await courseWithDueCards('EarlierMistake', 1);
    await useSession.getState().start(courseId);
    const { card } = useSession.getState().queue[0];
    await useSession.getState().submit('wrong');
    await useSession.getState().continueNext();
    await useSession.getState().submit('still wrong');
    useSession.getState().overrideAnswer(true);
    await useSession.getState().continueNext();
    expect(useSession.getState().completed[0].incorrectCount).toBe(1);
    expect(await db.cards.get(card.id)).toMatchObject({
      stats: { reviews: 1, correct: 0, lapses: 1 },
    });
  });

  it.each([true, false])(
    'undo cancels a provisional %s result without erasing earlier mistakes',
    async (correct) => {
      const courseId = await courseWithDueCards('PendingUndo', 1);
      await useSession.getState().start(courseId);
      const { card } = useSession.getState().queue[0];
      await useSession.getState().submit('wrong');
      await useSession.getState().continueNext();
      await useSession.getState().submit(correct ? answer() : 'wrong again');
      await useSession.getState().undo();
      expect(useSession.getState()).toMatchObject({ feedback: null, completed: [] });
      expect(useSession.getState().incorrectCounts[card.id]).toBe(1);
      expect(await db.cards.get(card.id)).toEqual(card);
      expect(vi.mocked(undoReview)).not.toHaveBeenCalled();
    },
  );

  it('repeated Continue and override while saving cannot change or duplicate the accepted outcome', async () => {
    const courseId = await courseWithDueCards('BusyOverride', 1);
    await useSession.getState().start(courseId);
    await useSession.getState().submit('wrong');
    useSession.getState().overrideAnswer(true);
    const release = deferred<void>();
    const real = vi.mocked(commitReview).getMockImplementation()!;
    vi.mocked(commitReview).mockImplementationOnce(async (input) => {
      await release.promise;
      return real(input);
    });
    const pending = useSession.getState().continueNext();
    await useSession.getState().continueNext();
    useSession.getState().overrideAnswer(false);
    await useSession.getState().undo();
    expect(useSession.getState()).toMatchObject({ busy: true, feedback: { kind: 'correct' } });
    release.resolve();
    await pending;
    expect(vi.mocked(commitReview)).toHaveBeenCalledOnce();
    expect(useSession.getState().completed).toHaveLength(1);
    expect(useSession.getState().completed[0].incorrectCount).toBe(0);
    expect(await db.reviewLogs.filter((log) => log.kind === 'review').count()).toBe(1);
  });

  it('a failed save keeps the chosen override and retries without re-grading it', async () => {
    const courseId = await courseWithDueCards('RetryOverride', 1);
    await useSession.getState().start(courseId);
    await useSession.getState().submit('wrong');
    useSession.getState().overrideAnswer(true);
    vi.mocked(commitReview).mockRejectedValueOnce(new Error('Storage unavailable'));
    await useSession.getState().continueNext();
    expect(useSession.getState()).toMatchObject({
      phase: 'active',
      feedback: { kind: 'correct' },
      busy: false,
      completed: [],
      notice: expect.stringMatching(/Continue again to retry/),
    });
    await useSession.getState().continueNext();
    expect(useSession.getState()).toMatchObject({ phase: 'summary', notice: null });
    expect(useSession.getState().completed[0].incorrectCount).toBe(0);
    expect(await db.reviewLogs.filter((log) => log.kind === 'review').count()).toBe(1);
  });

  it('leaving an unconfirmed answer preserves the due card without a review', async () => {
    const courseId = await courseWithDueCards('Unconfirmed', 1);
    await useSession.getState().start(courseId);
    const { card } = useSession.getState().queue[0];
    await useSession.getState().submit(answer());
    useSession.getState().reset();
    expect(await db.cards.get(card.id)).toEqual(card);
    expect(await db.reviewLogs.filter((log) => log.kind === 'review').count()).toBe(0);
  });
});

describe('session start', () => {
  it("loads a course's due cards into an active session", async () => {
    const courseId = await courseWithDueCards('Solo', 3);
    await useSession.getState().start(courseId);
    const s = useSession.getState();
    expect(s.phase).toBe('active');
    expect(s.courseId).toBe(courseId);
    expect(s.queue).toHaveLength(3);
    expect(s.queue.every((e) => e.card.courseId === courseId)).toBe(true);
  });

  it('a slow load that finishes after a newer start never overwrites the newer session', async () => {
    const slowCourse = await courseWithDueCards('Slow', 4);
    const fastCourse = await courseWithDueCards('Fast', 1);
    const realDueCards = mockedDueCards.getMockImplementation()!;
    // the first course's query stalls, as a busy IndexedDB would
    mockedDueCards.mockImplementationOnce(async (courseId, t) => {
      await new Promise((r) => setTimeout(r, 40));
      return realDueCards(courseId, t);
    });

    const slow = useSession.getState().start(slowCourse); // user opens course A
    useSession.getState().reset(); // leaves before it loads
    await useSession.getState().start(fastCourse); // and opens course B
    await slow;

    const s = useSession.getState();
    expect(s.courseId).toBe(fastCourse);
    expect(s.phase).toBe('active');
    expect(s.queue).toHaveLength(1);
    expect(s.queue[0].card.courseId).toBe(fastCourse);
  });

  it('a load that finishes after reset() stays idle', async () => {
    const courseId = await courseWithDueCards('Gone', 2);
    mockedDueCards.mockImplementationOnce(delayed(20));
    const pending = useSession.getState().start(courseId);
    useSession.getState().reset();
    await pending;
    expect(useSession.getState().phase).toBe('idle');
    expect(useSession.getState().queue).toEqual([]);
  });
});

describe('session response lifetimes', () => {
  it('a delayed successful save cannot put feedback into a newer session', async () => {
    const first = await courseWithDueCards('First', 1);
    const second = await courseWithDueCards('Second', 1);
    await useSession.getState().start(first);
    const saved = deferred<void>();
    const release = deferred<void>();
    const real = vi.mocked(commitReview).getMockImplementation()!;
    vi.mocked(commitReview).mockImplementationOnce(async (input) => {
      const result = await real(input);
      saved.resolve();
      await release.promise;
      return result;
    });
    await useSession.getState().submit(answer());
    const pending = useSession.getState().continueNext();
    await saved.promise;
    useSession.getState().reset();
    await useSession.getState().start(second);
    release.resolve();
    await pending;
    expect(useSession.getState()).toMatchObject({
      courseId: second,
      feedback: null,
      busy: false,
      completed: [],
    });
    expect(
      await db.reviewLogs
        .where('courseId')
        .equals(first)
        .filter((l) => l.kind === 'review')
        .count(),
    ).toBe(1);
  });

  it('a delayed undo cannot resurrect its queue after reset', async () => {
    const courseId = await courseWithDueCards('Undo', 1);
    await useSession.getState().start(courseId);
    await useSession.getState().submit(answer());
    await useSession.getState().continueNext();
    const saved = deferred<void>();
    const release = deferred<void>();
    const real = vi.mocked(undoReview).getMockImplementation()!;
    vi.mocked(undoReview).mockImplementationOnce(async (logId) => {
      const result = await real(logId);
      saved.resolve();
      await release.promise;
      return result;
    });
    const pending = useSession.getState().undo();
    await saved.promise;
    useSession.getState().reset();
    release.resolve();
    await pending;
    expect(useSession.getState()).toMatchObject({
      phase: 'idle',
      queue: [],
      completed: [],
      feedback: null,
      busy: false,
    });
  });

  it('undo restores a fresh revision that can be answered again', async () => {
    const courseId = await courseWithDueCards('UndoAgain', 1);
    await useSession.getState().start(courseId);
    const initialRev = useSession.getState().queue[0].card.rev;
    await useSession.getState().submit(answer());
    await useSession.getState().continueNext();
    await useSession.getState().undo();
    expect(useSession.getState().queue[0].card.rev).toBe(initialRev + 2);
    await useSession.getState().submit(answer());
    await useSession.getState().continueNext();
    expect(useSession.getState().completed).toHaveLength(1);
    expect(useSession.getState().problems).toEqual([]);
  });

  it('a stale question is recoverable and is not counted as completed', async () => {
    const courseId = await courseWithDueCards('Changed', 1);
    await useSession.getState().start(courseId);
    const entry = useSession.getState().queue[0];
    await db.items.update(entry.item.id, { rev: entry.item.rev + 1 });
    await useSession.getState().submit(answer());
    await useSession.getState().continueNext();
    expect(useSession.getState()).toMatchObject({
      phase: 'empty',
      completed: [],
      totalCards: 0,
      busy: false,
    });
    expect(useSession.getState().problems).toMatchObject([{ itemId: entry.item.id }]);
  });

  it('wrap-up counts the current correct answer once through the feedback transition', async () => {
    const courseId = await courseWithDueCards('Wrap', 12);
    await useSession.getState().start(courseId);
    await useSession.getState().submit(answer());
    useSession.getState().enterWrapUp();
    const s = useSession.getState();
    expect(s.totalCards).toBe(s.completed.length + s.queue.length);
    const total = s.totalCards;
    await useSession.getState().continueNext();
    expect(useSession.getState().totalCards).toBe(total);
    expect(total).toBe(useSession.getState().completed.length + useSession.getState().queue.length);
  });
});
