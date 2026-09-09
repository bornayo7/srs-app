import type { Course } from './types';

/** Shared by setup, settings, and persistence so invalid counts fail before paid work. */
export function assertLessonSettings(lessons: Course['lessons']): void {
  if (
    !Number.isInteger(lessons.newPerDay) ||
    lessons.newPerDay < 0 ||
    !Number.isInteger(lessons.batchSize) ||
    lessons.batchSize < 1
  )
    throw new Error(
      'Lesson limits must be whole numbers: daily limit at least zero and batch size at least one.',
    );
}
