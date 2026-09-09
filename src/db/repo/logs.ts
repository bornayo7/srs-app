import { db } from '../db';
import { localDayKey, startOfLocalDay, startOfNextLocalDay } from '@/engine/time';

/** Distinct items that went through a lesson today (local day) — daily-limit input. */
export async function todayLessonItemCount(courseId: string, now: number): Promise<number> {
  return (await todayLessonItemIds(courseId, now)).size;
}

export async function todayLessonItemIds(courseId: string, now: number): Promise<Set<string>> {
  const daily = await db.dailyLessons.get(`${courseId}:${localDayKey(now)}`);
  const logs = await db.reviewLogs
    .where('[courseId+ts]')
    .between([courseId, startOfLocalDay(now)], [courseId, startOfNextLocalDay(now)], true, false)
    .toArray();
  return new Set([
    ...(daily?.itemIds ?? []),
    ...logs.filter((l) => l.kind === 'lesson').map((l) => l.itemId),
  ]);
}
