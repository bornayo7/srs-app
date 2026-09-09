import { db } from '../db';
import { newId } from '@/engine/ids';
import type { CoursePlan, PlanReleaseMode, PlanUnit } from '@/engine/types';
import { parseReleaseAt } from '@/services/releaseDates';

export function validateUnit(unit: Omit<PlanUnit, 'level'>): void {
  if (!unit.title.trim()) throw new Error('A unit needs a title.');
  if (!Number.isInteger(unit.targetCount) || unit.targetCount < 0 || unit.targetCount > 60) {
    throw new Error('Target count must be a whole number between 0 and 60.');
  }
  if (unit.releaseAt !== undefined && parseReleaseAt(unit.releaseAt) === null) {
    throw new Error('Release date must be a valid ISO date.');
  }
}

export interface CreatePlanInput {
  courseId: string;
  title: string;
  material: string;
  materialTruncated?: boolean;
  releaseMode: PlanReleaseMode;
  /** Units in course order — levels are assigned 1..N here, never by the caller. */
  units: Omit<PlanUnit, 'level'>[];
}

/**
 * A plan's units map 1:1 onto the course's levels (unit 3 = level 3), so the
 * existing level engine — locking, lesson order, "unlocks at level N" — does
 * the progressive release without a second gating system.
 */
export async function createPlan(input: CreatePlanInput, now: number): Promise<CoursePlan> {
  return db.transaction('rw', [db.courses, db.plans], async () => {
    if (!(await db.courses.get(input.courseId))) throw new Error('course not found');
    if (await planForCourse(input.courseId)) throw new Error('This course already has a plan.');
    if (input.units.length === 0) throw new Error('a plan needs at least one unit');
    input.units.forEach(validateUnit);
    const plan: CoursePlan = {
      id: newId(),
      courseId: input.courseId,
      title: input.title,
      material: input.material,
      materialTruncated: input.materialTruncated ?? false,
      releaseMode: input.releaseMode,
      units: input.units.map((u, i) => ({ ...u, level: i + 1 })),
      createdAt: now,
      updatedAt: now,
    };
    await db.plans.add(plan);
    return plan;
  });
}

/** A course has at most one plan. */
export async function planForCourse(courseId: string): Promise<CoursePlan | undefined> {
  return db.plans.where('courseId').equals(courseId).first();
}

/** Read and mutate the current row under one lock; callers cannot put stale plans. */
export async function mutatePlan(
  id: string,
  change: (current: CoursePlan) => CoursePlan,
  now: number,
): Promise<CoursePlan> {
  return db.transaction('rw', db.plans, async () => {
    const current = await db.plans.get(id);
    if (!current) throw new Error('plan not found');
    const next = change(current);
    next.units.forEach(validateUnit);
    if (next.units.length === 0 || next.units.some((unit, index) => unit.level !== index + 1)) {
      throw new Error('Plan units must have consecutive levels.');
    }
    const saved = {
      ...next,
      id: current.id,
      courseId: current.courseId,
      createdAt: current.createdAt,
      updatedAt: now,
    };
    await db.plans.put(saved);
    return saved;
  });
}
