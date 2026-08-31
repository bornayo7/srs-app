import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { dueCount, scheduledCards } from '@/db/repo/cards';
import { lessonAvailability } from '@/services/lessons';
import type { Course } from '@/engine/types';

export function useCourses(): Course[] | undefined {
  return useLiveQuery(() => db.courses.orderBy('updatedAt').reverse().toArray(), []);
}

/** undefined = still loading, null = course does not exist. */
export function useCourse(courseId: string | undefined) {
  return useLiveQuery(
    async () => (courseId ? ((await db.courses.get(courseId)) ?? null) : null),
    [courseId],
  );
}

export function useCourseLadder(course: Course | null | undefined) {
  return useLiveQuery(async () => {
    if (!course || course.scheduling.kind !== 'ladder') return null;
    return (await db.ladders.get(course.scheduling.ladderId)) ?? null;
  }, [course?.id, course?.scheduling]);
}

export function useDueCount(courseId: string, now: number): number | undefined {
  return useLiveQuery(() => dueCount(courseId, now), [courseId, now]);
}

export function useLessonAvailability(courseId: string, now: number) {
  return useLiveQuery(() => lessonAvailability(courseId, now), [courseId, now]);
}

/** All scheduled cards across every course — forecast input. */
export function useAllScheduledCards() {
  return useLiveQuery(async () => {
    const courses = await db.courses.toArray();
    const all = await Promise.all(courses.map((c) => scheduledCards(c.id)));
    return all.flat();
  }, []);
}
