import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { createCourse } from '@/db/repo/courses';
import { createItem } from '@/db/repo/items';
import { basicTypeSpec, createItemType } from '@/db/repo/itemTypes';
import { dueCards } from '@/db/repo/cards';
import { completeLessonBatch } from '@/services/lessons';
import { HOUR } from '@/engine/time';
import { useSession } from './sessionStore';

// The store reads due cards through this module; the race test slows one call down.
vi.mock('@/db/repo/cards', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/db/repo/cards')>();
  return { ...real, dueCards: vi.fn(real.dueCards) };
});
const mockedDueCards = vi.mocked(dueCards);

const NOW = Date.UTC(2026, 0, 15, 10, 23);

/** A course whose items were all taught at NOW, so every card is due once 4h have passed. */
async function courseWithDueCards(name: string, count: number): Promise<string> {
  const course = await createCourse({ name, ladderPresetId: 'preset-classic' }, NOW);
  const type = await createItemType(course.id, basicTypeSpec(), NOW);
  const [front, back] = type.fields.map((f) => f.id);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const item = await createItem(
      { courseId: course.id, typeId: type.id, fieldValues: { [front]: `${name} ${i}`, [back]: `a${i}` } },
      NOW + i,
    );
    ids.push(item.id);
  }
  await completeLessonBatch(ids, 'lesson', NOW);
  return course.id;
}

const delayed =
  (ms: number) =>
  async (courseId: string, t: number) => {
    const real = mockedDueCards.getMockImplementation()!;
    await new Promise((r) => setTimeout(r, ms));
    return real(courseId, t);
  };

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
  useSession.getState().reset();
  mockedDueCards.mockClear();
  // every card was scheduled for NOW+4h; the store asks the clock, so move the clock
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 5 * HOUR);
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
