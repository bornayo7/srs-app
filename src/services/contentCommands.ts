import { db } from '@/db/db';
import { createCourse, type CreateCourseInput } from '@/db/repo/courses';
import { basicTypeSpec, createItemType } from '@/db/repo/itemTypes';
import { createItem, type CreateItemInput } from '@/db/repo/items';
import type { Course, Item } from '@/engine/types';
import { assertLessonSettings } from '@/engine/lessonSettings';
import { recomputeUnlocks } from './gating';

/** One intent: a usable course, never a half-created course without a type. */
export async function createCourseWithType(input: CreateCourseInput, now: number): Promise<Course> {
  return db.transaction('rw', db.tables, async () => {
    const course = await createCourse(input, now);
    await createItemType(course.id, basicTypeSpec(), now);
    return course;
  });
}

/** The capture is consumed only if creation succeeds; a retry cannot duplicate it. */
export async function convertCapture(
  captureId: string,
  input: CreateItemInput,
  now: number,
): Promise<Item> {
  return db.transaction('rw', db.tables, async () => {
    if (!(await db.captures.get(captureId)))
      throw new Error('This capture has already been converted or deleted.');
    const item = await createItem(input, now);
    await db.captures.delete(captureId);
    return item;
  });
}

export type CourseSettingsPatch = Partial<
  Pick<Course, 'name' | 'description' | 'lessons' | 'ghosts' | 'answerStyle' | 'levelMode'>
> & {
  levelConfig?: Partial<NonNullable<Course['levelConfig']>>;
};

/** Merge only editable fields against the latest course and settle gating together. */
export async function saveCourseSettings(
  courseId: string,
  patch: CourseSettingsPatch,
  now: number,
): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    const current = await db.courses.get(courseId);
    if (!current) throw new Error('course not found');
    const next: Course = {
      ...current,
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      lessons: patch.lessons ?? current.lessons,
      ghosts: patch.ghosts ?? current.ghosts,
      answerStyle: patch.answerStyle ?? current.answerStyle,
      levelMode: patch.levelMode ?? current.levelMode,
      updatedAt: now,
      levelConfig: patch.levelConfig
        ? {
            gateTypeIds: patch.levelConfig.gateTypeIds ?? current.levelConfig?.gateTypeIds ?? [],
            passPercent: patch.levelConfig.passPercent ?? current.levelConfig?.passPercent ?? 90,
            autoAdvance: patch.levelConfig.autoAdvance ?? current.levelConfig?.autoAdvance,
          }
        : current.levelConfig,
    };
    next.name = next.name.trim();
    if (!next.name) throw new Error('Give the course a name.');
    assertLessonSettings(next.lessons);
    if (next.answerStyle !== 'perTemplate')
      throw new Error('Reveal-style study is not supported yet. Choose per-template answers.');
    if (next.levelConfig) {
      if (
        !Number.isFinite(next.levelConfig.passPercent) ||
        next.levelConfig.passPercent < 1 ||
        next.levelConfig.passPercent > 100
      )
        throw new Error('The pass threshold must be between 1 and 100 percent.');
      const owned = new Set(await db.itemTypes.where('courseId').equals(courseId).primaryKeys());
      if (next.levelConfig.gateTypeIds.some((id) => !owned.has(id)))
        throw new Error('A selected gate type no longer belongs to this course.');
      next.levelConfig.gateTypeIds = [...new Set(next.levelConfig.gateTypeIds)];
    }
    if (await db.plans.where('courseId').equals(courseId).count()) {
      if (next.levelMode !== 'levels')
        throw new Error('A planned course uses levels for its units.');
      if (
        patch.levelConfig?.autoAdvance !== undefined &&
        patch.levelConfig.autoAdvance !== current.levelConfig?.autoAdvance
      )
        throw new Error('Change release mode on the course plan.');
    }
    await db.courses.put(next);
    await recomputeUnlocks(courseId, now);
  });
}
