import Dexie from 'dexie';
import { db } from '../db';
import { newId } from '@/engine/ids';
import type { Course, SrsLadder } from '@/engine/types';

export interface CreateCourseInput {
  name: string;
  description?: string;
  ladderPresetId: string;
  newPerDay?: number;
  batchSize?: number;
}

/** Create a course, copying the chosen ladder preset so the course owns it outright. */
export async function createCourse(input: CreateCourseInput, now: number): Promise<Course> {
  return db.transaction('rw', db.courses, db.ladders, async () => {
    const preset = await db.ladders.get(input.ladderPresetId);
    if (!preset) throw new Error(`ladder preset not found: ${input.ladderPresetId}`);

    const courseId = newId();
    const ladder: SrsLadder = {
      ...structuredClone(preset),
      id: newId(),
      courseId,
      isPreset: false,
      updatedAt: now,
    };
    await db.ladders.add(ladder);

    const course: Course = {
      id: courseId,
      name: input.name,
      description: input.description ?? '',
      scheduling: { kind: 'ladder', ladderId: ladder.id },
      lessons: { newPerDay: input.newPerDay ?? 15, batchSize: input.batchSize ?? 5 },
      ghosts: 'off',
      answerStyle: 'perTemplate',
      levelMode: 'flat',
      currentLevel: 1,
      createdAt: now,
      updatedAt: now,
    };
    await db.courses.add(course);
    return course;
  });
}

export async function updateCourse(course: Course, now: number): Promise<void> {
  await db.courses.put({ ...course, updatedAt: now });
}

/** Delete a course and everything it owns, including its seed-install marker. */
export async function deleteCourse(courseId: string): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.courses,
      db.ladders,
      db.itemTypes,
      db.items,
      db.cards,
      db.reviewLogs,
      db.meta,
      db.plans,
      db.proposals,
    ],
    async () => {
      // clear seed markers pointing at this course so samples can reinstall
      const seedRows = await db.meta.where('key').startsWith('seed:').toArray();
      for (const row of seedRows) {
        if ((row.value as { courseId?: string } | undefined)?.courseId === courseId) {
          await db.meta.delete(row.key);
        }
      }
      await db.cards
        .where('[courseId+state]')
        .between([courseId, Dexie.minKey], [courseId, Dexie.maxKey])
        .delete();
      await db.items.where('courseId').equals(courseId).delete();
      await db.itemTypes.where('courseId').equals(courseId).delete();
      await db.ladders.where('courseId').equals(courseId).delete();
      await db.reviewLogs
        .where('[courseId+ts]')
        .between([courseId, Dexie.minKey], [courseId, Dexie.maxKey])
        .delete();
      await db.proposals.where('courseId').equals(courseId).delete();
      await db.plans.where('courseId').equals(courseId).delete();
      await db.courses.delete(courseId);
    },
  );
}

export async function getCourseLadder(course: Course): Promise<SrsLadder | undefined> {
  if (course.scheduling.kind !== 'ladder') return undefined;
  return db.ladders.get(course.scheduling.ladderId);
}
