import type { Course, SrsLadder } from '@/engine/types';
import type { Scheduler } from '@/engine/scheduler/types';
import { makeLadderScheduler } from '@/engine/scheduler/ladder';
import { db } from '@/db/db';

/** Resolve the Scheduler for a course (P1: ladder only; FSRS lands in P5). */
export async function schedulerForCourse(
  course: Course,
): Promise<{ scheduler: Scheduler; ladder: SrsLadder | null }> {
  if (course.scheduling.kind === 'ladder') {
    const ladder = await db.ladders.get(course.scheduling.ladderId);
    if (!ladder) throw new Error(`ladder not found for course ${course.name}`);
    return { scheduler: makeLadderScheduler(ladder), ladder };
  }
  throw new Error('FSRS scheduling arrives in Phase 5');
}
