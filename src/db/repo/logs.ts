import { db } from '../db';
import { startOfLocalDay } from '@/engine/time';

/** Distinct items that went through a lesson today (local day) — daily-limit input. */
export async function todayLessonItemCount(courseId: string, now: number): Promise<number> {
  const logs = await db.reviewLogs
    .where('[courseId+ts]')
    .between([courseId, startOfLocalDay(now)], [courseId, now], true, true)
    .toArray();
  const itemIds = new Set(logs.filter((l) => l.kind === 'lesson').map((l) => l.itemId));
  return itemIds.size;
}
