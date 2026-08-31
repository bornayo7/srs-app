import { db } from '@/db/db';
import { newId } from '@/engine/ids';
import type { Card, Item, ReviewLog } from '@/engine/types';
import { lessonPool } from '@/db/repo/items';
import { todayLessonItemCount } from '@/db/repo/logs';
import { schedulerForCourse } from './schedulers';

export interface LessonAvailability {
  poolSize: number;
  remainingToday: number;
  available: number; // min of the two
}

export async function lessonAvailability(
  courseId: string,
  now: number,
): Promise<LessonAvailability> {
  const course = await db.courses.get(courseId);
  if (!course) throw new Error(`course not found: ${courseId}`);
  const pool = await lessonPool(courseId);
  const doneToday = await todayLessonItemCount(courseId, now);
  const remainingToday = Math.max(0, course.lessons.newPerDay - doneToday);
  return {
    poolSize: pool.length,
    remainingToday,
    available: Math.min(pool.length, remainingToday),
  };
}

/** The next batch of items to teach (respects the daily limit). */
export async function nextLessonBatch(courseId: string, now: number): Promise<Item[]> {
  const course = await db.courses.get(courseId);
  if (!course) throw new Error(`course not found: ${courseId}`);
  const { available } = await lessonAvailability(courseId, now);
  if (available === 0) return [];
  const pool = await lessonPool(courseId);
  return pool.slice(0, Math.min(course.lessons.batchSize, available));
}

/**
 * A completed lesson batch: per item — status 'active', every card enters the
 * review cycle at the scheduler's initial state, one 'lesson' log per card.
 * The lesson quiz is a gate only; it is never an SRS review.
 */
export async function completeLessonBatch(
  itemIds: string[],
  sessionId: string,
  now: number,
): Promise<void> {
  await db.transaction(
    'rw',
    [db.items, db.cards, db.courses, db.ladders, db.reviewLogs],
    async () => {
      for (const itemId of itemIds) {
        const item = await db.items.get(itemId);
        if (!item || item.status !== 'lesson') continue;
        const course = await db.courses.get(item.courseId);
        if (!course) continue;
        const { scheduler } = await schedulerForCourse(course);

        await db.items.put({ ...item, status: 'active', updatedAt: now });

        const cards = await db.cards.where('itemId').equals(itemId).toArray();
        for (const card of cards) {
          if (card.state !== 'new') continue;
          const init = scheduler.initialState(now);
          const updated: Card = {
            ...card,
            state: 'review',
            srs: init.srs,
            dueAt: init.dueAt,
            updatedAt: now,
          };
          await db.cards.put(updated);
          const log: ReviewLog = {
            id: newId(),
            cardId: card.id,
            itemId,
            courseId: item.courseId,
            ts: now,
            sessionId,
            kind: 'lesson',
            prev: {
              state: card.state,
              srs: null,
              stats: { ...card.stats },
            },
          };
          await db.reviewLogs.add(log);
        }
      }
    },
  );
}
