import { nextRevision } from '@/engine/revision';
import { db } from '@/db/db';
import { newId } from '@/engine/ids';
import type { Card, Item, ReviewLog } from '@/engine/types';
import { lessonPool } from '@/db/repo/items';
import { todayLessonItemCount, todayLessonItemIds } from '@/db/repo/logs';
import { schedulerForCourse } from './schedulers';
import { requireStudyRevision, StudyConflict, type StudyRevision } from './studyRevision';
import { studyStatus } from '@/engine/typeDesign';
import { localDayKey } from '@/engine/time';

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
 * Activate only the exact cards taught, with one lesson log per card and
 * durable daily consumption per item. Untaught cards remain in lessons.
 * The lesson quiz is a gate only; it is never an SRS review.
 */
export interface TaughtCard {
  cardId: string;
  expected: StudyRevision;
}

export async function completeLessonBatch(
  taught: TaughtCard[],
  sessionId: string,
  now: number,
): Promise<void> {
  await db.transaction(
    'rw',
    [db.items, db.itemTypes, db.cards, db.courses, db.ladders, db.reviewLogs, db.dailyLessons],
    async () => {
      const observed = new Map(taught.map((t) => [t.cardId, t.expected]));
      const cards = await db.cards.bulkGet([...observed.keys()]);
      const itemIds = new Set<string>();
      const byCourse = new Map<string, Set<string>>();
      for (const card of cards) {
        if (!card || card.isGhost || card.state !== 'new')
          throw new StudyConflict('These lessons changed. Reload the batch.');
        const { item } = await requireStudyRevision(card, observed.get(card.id)!);
        if (item.status !== 'lesson')
          throw new StudyConflict('This item is no longer available for lessons.');
        itemIds.add(item.id);
        const ids = byCourse.get(item.courseId) ?? new Set<string>();
        ids.add(item.id);
        byCourse.set(item.courseId, ids);
      }
      for (const [courseId, ids] of byCourse) {
        const course = await db.courses.get(courseId);
        if (!course) throw new StudyConflict('This course no longer exists.');
        // Item quota and activation share this transaction: parallel batches
        // cannot both consume the same remaining daily allowance.
        const already = await todayLessonItemIds(courseId, now);
        const additional = [...ids].filter((id) => !already.has(id)).length;
        if (already.size + additional > course.lessons.newPerDay)
          throw new StudyConflict(
            "Today's lesson allowance is used. Keep this batch for the next day.",
          );
        const day = localDayKey(now);
        await db.dailyLessons.put({
          id: `${courseId}:${day}`,
          courseId,
          day,
          itemIds: [...new Set([...already, ...ids])],
        });
      }
      for (const itemId of itemIds) {
        const item = (await db.items.get(itemId))!;
        const course = await db.courses.get(item.courseId);
        if (!course) throw new StudyConflict('This course no longer exists.');
        const { scheduler } = await schedulerForCourse(course);
        for (const card of cards) {
          if (!card || card.itemId !== itemId) continue;
          const init = scheduler.initialState(now);
          const updated: Card = {
            ...card,
            rev: nextRevision(card.rev),
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
        const real = (await db.cards.where('itemId').equals(itemId).toArray()).filter(
          (c) => !c.isGhost,
        );
        await db.items.put({ ...item, status: studyStatus(item.status, real), updatedAt: now });
      }
    },
  );
}
